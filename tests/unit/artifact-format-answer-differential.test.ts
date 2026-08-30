import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import type { MadarAnswerabilityAssessment, MadarAnswerabilityState } from '../../src/contracts/context-recovery.js'
import { detailRetention, emptyTerminalCounts, type CandidateTerminalCounts, type EndpointIdentityFactMatrix } from '../../src/contracts/graph-integrity.js'
import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityStatus } from '../../src/contracts/endpoint-identity.js'
import { buildNormalizedIntegrityReceipt } from '../../src/contracts/graph-integrity-receipt.js'
import { GRAPH_ARTIFACT_V2_TOMBSTONE, readGraphArtifactMetadata } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  applyGraphIntegrityCap,
  capPublishedRecoveryByFinalAnswerability,
  graphIntegrityCap,
  graphIntegrityDiagnostic,
} from '../../src/shared/graph-integrity-answerability.js'
import { readGeneratedGraphJson } from './helpers/generated-graph.js'

/**
 * The cutover must change which artifact is read, not what the product answers
 * -- with one deliberate exception.
 *
 * Complete answer neutrality between `graph.json` and `graph.madar` was the
 * right contract while the two carried the same information. #659 ended that:
 * the v2 artifact carries a graph-integrity receipt that v1 cannot, and the
 * product is required to use it. Demanding identical answers would now mean
 * demanding that the product ignore evidence it has.
 *
 * So the contract is narrower and sharper. Graph content, retrieval, ranking,
 * coverage, evidence selection, recovery execution and token budgets must still
 * be identical -- those are the things a storage format has no business
 * touching. Only the published trust fields may differ, only through the single
 * #659 policy owner, and only to a value this suite RE-DERIVES from the real
 * receipt. A difference anywhere else, or a differing field this contract does
 * not name, fails.
 *
 * The cause must be the receipt, never the file extension. Nothing here is
 * keyed on `.madar` versus `.json`.
 */

const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['src/auth.ts', [
    "import { findUser } from './users.js'",
    '',
    'export function login(name: string) {',
    '  const user = findUser(name)',
    '  return authorize(user)',
    '}',
    '',
    'export function authorize(user: unknown) {',
    '  return Boolean(user)',
    '}',
    '',
  ].join('\n')],
  ['src/users.ts', [
    'export function findUser(name: string) {',
    '  return { name }',
    '}',
    '',
    'export function listUsers() {',
    '  return [findUser("a")]',
    '}',
    '',
  ].join('\n')],
]

/** Commands compared across the two artifact formats. */
const COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ['summary', ['summary']],
  ['query', ['query', 'login']],
  ['explain', ['explain', 'login']],
  ['path', ['path', 'login', 'findUser']],
  ['pack', ['pack', 'how does login work?']],
  ['prompt', ['prompt', 'how does login work?', '--provider', 'claude']],
]

interface Answer {
  readonly exitCode: number
  readonly text: string
}

/**
 * The closed set of leaf paths whose value may differ between the two formats.
 *
 * Every one of these is derived from the final answerability by the #659 owner.
 * Deliberately exact paths: a prefix such as `evidence.*` would let a genuine
 * retrieval regression hide inside the same object as a trust field.
 */
const INTEGRITY_DERIVED_PATHS: ReadonlySet<string> = new Set([
  '.evidence.answerability.state',
  '.evidence.answerability.answer_scope',
  '.evidence.answerability.broad_search_fallback',
  '.evidence.pack_confidence',
  '.evidence.agent_directive',
  '.evidence.recovery.initial_state',
  '.evidence.recovery.final_state',
  '.pack.recovery.initial_state',
  '.pack.recovery.final_state',
  '.governance.directive.answerability',
  '.governance.directive.pack_confidence',
  '.governance.directive.agent_directive',
])

/** Path prefixes that carry graph content, retrieval or budget -- never trust. */
const NEUTRAL_PREFIXES: readonly string[] = [
  '.pack.matched_nodes',
  '.pack.relationships',
  '.pack.community_context',
  '.pack.graph_signals',
  '.pack.retrieval_plan',
  '.pack.retrieval_gate',
  '.pack.snippet_budget',
  '.pack.token_count',
  '.serialized_budget.max_tokens',
  '.serialized_budget.enforced',
  '.pack.question',
  '.pack.shared_file_type',
  '.pack.retrieval_strategy',
  '.plan',
  '.coverage',
  '.claims',
  '.expandable',
  '.evidence.evidence_strength',
  '.evidence.coverage',
  '.evidence.covered_workflow_owners',
  '.evidence.missing_phases',
  '.workflow_centers',
  '.recommended_first_read',
  '.likely_edit_files',
  '.likely_test_files',
  '.public_contracts',
  '.why_explanation',
  '.pack.recovery.attempts',
  '.pack.recovery.improved',
  '.pack.recovery.budget',
  '.pack.recovery.status',
  '.evidence.recovery.attempts',
  '.evidence.recovery.improved',
  '.evidence.recovery.budget',
  '.evidence.recovery.status',
  '.governance.graph_freshness',
  '.governance.request',
]

/** Additive integrity diagnostic. Present on v2, absent on v1, never on both. */
const DIAGNOSTIC_ROOT = '.evidence.graph_integrity'
/**
 * The response envelope's own size.
 *
 * Not neutral and not a trust field: it is a measurement OF the payload, and
 * the payload legitimately carries one additional object. Listing it as neutral
 * would demand that an additive field weigh nothing; ignoring it would hide a
 * budget regression. It is classified separately and proven below by
 * reconstruction.
 */
const ENVELOPE_SIZE_PATH = '.serialized_budget.token_count'
const CAVEATS_ROOT = '.evidence.answerability.caveats'

function normalize(text: string): string {
  return text
    .replaceAll('graph.madar', '<artifact>')
    .replaceAll('graph.json', '<artifact>')
    .replace(/\b[0-9a-f]{12,64}\b/g, '<digest>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<timestamp>')
    .replace(/[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/g, '<http-date>')
    .replace(/\b\d+ ?ms\b/g, '<duration>')
}

/** Every token count in a response, in order. */
function tokenCounts(text: string): number[] {
  return [...text.matchAll(/"token_count":(\d+)/g)].map((match) => Number(match[1]))
}

/**
 * Rewrites the artifact's own filename inside string values.
 *
 * The payload records the path it was built from, and one workspace being read
 * as `graph.madar` rather than `graph.json` is not a difference in the answer.
 * Only that substitution: everything else must survive to be compared.
 */
function normalizeArtifactNames(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('graph.madar', '<artifact>').replaceAll('graph.json', '<artifact>')
  }
  if (Array.isArray(value)) return value.map(normalizeArtifactNames)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, normalizeArtifactNames(entry)]))
  }
  return value
}

/** Leaf paths of a JSON value, so two payloads compare field by field. */
function leafPaths(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '[]')
    value.forEach((entry, index) => {
      for (const [path, leaf] of leafPaths(entry, `${prefix}[${index}]`)) out.set(path, leaf)
    })
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) out.set(prefix, '{}')
    for (const [key, entry] of entries) {
      for (const [path, leaf] of leafPaths(entry, `${prefix}.${key}`)) out.set(path, leaf)
    }
  } else {
    out.set(prefix, value)
  }
  return out
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))
}

interface Classified {
  readonly integrityDerived: string[]
  readonly diagnosticOnly: string[]
  readonly caveatOnly: string[]
  readonly neutralViolations: string[]
  readonly unclassified: string[]
  readonly envelopeSize: string[]
}

/**
 * Splits the differing leaf paths into the classes this contract recognises.
 *
 * A difference in a neutral field and a difference in a field nobody declared
 * are separate failures on purpose: the first says the storage format changed
 * the product's reasoning, the second says the contract has drifted from the
 * payload and must be re-read rather than widened.
 */
function classifyDifferences(v2: Map<string, unknown>, v1: Map<string, unknown>): Classified {
  const result: Classified = {
    integrityDerived: [], diagnosticOnly: [], caveatOnly: [], neutralViolations: [], unclassified: [], envelopeSize: [],
  }
  for (const path of new Set([...v2.keys(), ...v1.keys()])) {
    if (v2.get(path) === v1.get(path) && v2.has(path) === v1.has(path)) continue
    if (path === DIAGNOSTIC_ROOT || path.startsWith(`${DIAGNOSTIC_ROOT}.`) || path.startsWith(`${DIAGNOSTIC_ROOT}[`)) {
      result.diagnosticOnly.push(path)
    } else if (path === CAVEATS_ROOT || path.startsWith(`${CAVEATS_ROOT}[`)) {
      result.caveatOnly.push(path)
    } else if (path === ENVELOPE_SIZE_PATH) {
      result.envelopeSize.push(path)
    } else if (INTEGRITY_DERIVED_PATHS.has(path)) {
      result.integrityDerived.push(path)
    } else if (startsWithAny(path, NEUTRAL_PREFIXES)) {
      result.neutralViolations.push(path)
    } else {
      result.unclassified.push(path)
    }
  }
  return result
}

function identityMatrix(cells: Partial<Record<EndpointIdentityStatus, Partial<Record<EndpointIdentityStatus, number>>>>): EndpointIdentityFactMatrix {
  const built = {} as Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>>
  for (const source of ENDPOINT_IDENTITY_STATUSES) {
    built[source] = {} as Record<EndpointIdentityStatus, number>
    for (const target of ENDPOINT_IDENTITY_STATUSES) built[source][target] = cells[source]?.[target] ?? 0
  }
  return built
}

/** A block around a producer-built receipt, in the shape a reader receives. */
function wireBlockAround(counts: Partial<CandidateTerminalCounts>): Record<string, unknown> {
  const receipt = buildNormalizedIntegrityReceipt({
    emittedCandidates: 3,
    counts: { ...emptyTerminalCounts(), retained_new_fact: 3, ...counts },
    terminalReasonCounts: {},
    factsRetained: 3,
    occurrencesRetained: 3,
    uniqueEndpointPairs: 3,
    endpointFactPairCounts: identityMatrix({ stable: { stable: 3 } }),
    endpointReasonFactCounts: {},
    unresolvedRetention: detailRetention(0, 0),
    rejectedRetention: detailRetention(0, 0),
    conflictingRetention: detailRetention(0, 0),
    strictModeResult: 'not_run',
  })
  return {
    accounting_scope: 'normalized_extraction_boundary',
    status: receipt.status,
    reasons: [],
    endpoint_identity: {},
    storage_admission: {},
    reserved: {},
    normalized_accounting: JSON.parse(JSON.stringify({
      receipt,
      unresolved_records: [],
      rejected_records: [],
      conflict_records: [],
      scope_failures: [],
      scope_failure_retention: detailRetention(0, 0),
      reserved: {},
    })),
  }
}

describe('artifact format preserves semantic retrieval while integrity evidence may lower published trust', () => {
  let root: string
  let canonicalAnswers: Map<string, Answer>
  let legacyAnswers: Map<string, Answer>
  let canonicalState: string
  let legacyState: string
  let nodeCounts: { canonical: number, legacy: number }
  let receiptCap: ReturnType<typeof graphIntegrityCap>

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'artifact-differential-'))
    for (const [relativePath, contents] of SOURCE_FILES) {
      const target = join(root, relativePath)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, contents)
    }
    generateGraph(root, { noHtml: true })

    const outputDir = join(root, 'out')
    const canonicalBytes = readFileSync(join(outputDir, 'graph.madar'))
    const derivedV1 = readGeneratedGraphJson(outputDir)

    // The real receipt this fixture actually carries, read through the same
    // production reader the product uses. Every expected difference below is
    // derived from this, not from the artifact's name.
    receiptCap = graphIntegrityCap(readGraphArtifactMetadata(join(outputDir, 'graph.madar')).integrityReceipt)

    const originalCwd = process.cwd()
    const collect = async (): Promise<Map<string, Answer>> => {
      const answers = new Map<string, Answer>()
      process.chdir(root)
      try {
        for (const [name, argv] of COMMANDS) {
          const lines: string[] = []
          const io = {
            log: (message: string) => lines.push(String(message)),
            error: (message: string) => lines.push(String(message)),
          }
          answers.set(name, { exitCode: await executeCli([...argv], io), text: lines.join('\n') })
        }
      } finally {
        process.chdir(originalCwd)
      }
      return answers
    }

    canonicalState = classifyWorkspaceGraph(outputDir).state
    canonicalAnswers = await collect()
    nodeCounts = { canonical: derivedV1.nodes.length, legacy: 0 }

    unlinkSync(join(outputDir, 'graph.madar'))
    writeFileSync(join(outputDir, 'graph.json'), JSON.stringify({ ...derivedV1, root_path: root }))
    legacyState = classifyWorkspaceGraph(outputDir).state
    legacyAnswers = await collect()
    nodeCounts = {
      ...nodeCounts,
      legacy: (JSON.parse(readFileSync(join(outputDir, 'graph.json'), 'utf8')) as { nodes: unknown[] }).nodes.length,
    }

    writeFileSync(join(outputDir, 'graph.madar'), canonicalBytes)
    writeFileSync(join(outputDir, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
  }, 180_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function payloads(name: string): { v2: Map<string, unknown>, v1: Map<string, unknown>, v2Raw: Record<string, unknown>, v1Raw: Record<string, unknown> } {
    // Parsed from the raw text, then normalized structurally. The textual
    // normalizer rewrites digest-like runs, which corrupts numeric literals such
    // as a match score, so it cannot run before JSON.parse.
    const v2Raw = normalizeArtifactNames(JSON.parse(canonicalAnswers.get(name)?.text ?? '{}')) as Record<string, unknown>
    const v1Raw = normalizeArtifactNames(JSON.parse(legacyAnswers.get(name)?.text ?? '{}')) as Record<string, unknown>
    return { v2: leafPaths(v2Raw), v1: leafPaths(v1Raw), v2Raw, v1Raw }
  }

  it('compares a cut-over workspace against one that never cut over', () => {
    expect(canonicalState).toBe('current_v2')
    expect(legacyState).toBe('legacy_v1_only')
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    expect(nodeCounts.canonical).toBeGreaterThan(0)
    expect(nodeCounts.legacy).toBe(nodeCounts.canonical)
  })

  it('records the integrity reasons this generated fixture actually carries', () => {
    // Measured, not assumed. If generation stops emitting these, the recorded
    // consequence below stops applying and this control says so.
    expect(receiptCap.status).toBe('valid_with_warnings')
    expect([...receiptCap.reasons].sort()).toEqual([
      'full_emission_accounting_not_available',
      'legacy_endpoint_identity',
      'partial_discriminator_retained',
    ])
    // The cap follows from the approved policy for that status, and no reason
    // is discarded or exempted on the way.
    expect(receiptCap.ceiling).toBe('ready_with_caveat')
    expect(receiptCap.reason).toBe('graph_integrity_valid_with_warnings')
  })

  it.each(COMMANDS)('%s: artifact format changes no non-integrity output', (name) => {
    const fromCanonical = canonicalAnswers.get(name)
    const fromLegacy = legacyAnswers.get(name)
    expect(fromCanonical?.exitCode).toBe(0)
    expect(fromLegacy?.exitCode).toBe(0)
    expect(fromCanonical?.text.length ?? 0).toBeGreaterThan(0)

    const canonicalText = normalize(fromCanonical?.text ?? '')
    const legacyText = normalize(fromLegacy?.text ?? '')
    if (canonicalText === legacyText) return

    if (process.env.ARTIFACT_DIFF_OUT !== undefined) {
      appendFileSync(process.env.ARTIFACT_DIFF_OUT, `\n[${name}]\n  v2: ${canonicalText}\n  v1: ${legacyText}\n`)
    }

    // A differing answer must be JSON this contract can classify. A differing
    // text-only surface would mean an integrity value reached a rendering the
    // closed field set cannot describe.
    const { v2, v1 } = payloads(name)
    const classified = classifyDifferences(v2, v1)

    expect(
      classified.neutralViolations,
      `ARTIFACT_FORMAT_CHANGED_NON_INTEGRITY_OUTPUT (${name}): ${classified.neutralViolations.join(', ')}`,
    ).toEqual([])
    expect(
      classified.unclassified,
      `ARTIFACT_DIFFERENTIAL_FIELD_UNCLASSIFIED (${name}): ${classified.unclassified.join(', ')}`,
    ).toEqual([])
  })

  it.each(COMMANDS)('%s: pack token accounting is unchanged by the artifact format', (name) => {
    const canonicalText = normalize(canonicalAnswers.get(name)?.text ?? '')
    const legacyText = normalize(legacyAnswers.get(name)?.text ?? '')
    if (canonicalText === legacyText) return

    const { v2, v1 } = payloads(name)
    // Every token count EXCEPT the response envelope measures pack content, and
    // pack content is not the artifact format's to change. Compared by path
    // rather than by position, so an added field cannot shift the alignment and
    // silently compare two different counters.
    for (const [path, value] of v2) {
      if (!path.endsWith('.token_count') || path === ENVELOPE_SIZE_PATH) continue
      expect(value, `ARTIFACT_FORMAT_CHANGED_NON_INTEGRITY_OUTPUT (${name} ${path})`).toBe(v1.get(path))
    }
  })

  it('Case A — every permitted difference equals what the real receipt derives', () => {
    const { v2Raw, v1Raw } = payloads('pack')
    const v1Evidence = (v1Raw.evidence ?? {}) as Record<string, unknown>
    const v2Evidence = (v2Raw.evidence ?? {}) as Record<string, unknown>

    // INTEGRITY_DIFFERENTIAL_NOT_APPLIED guards this: the v2 answerability must
    // be exactly what the production cap owner produces from the v1 answer plus
    // the real receipt -- not merely "lower", and not a hard-coded transition.
    const derived = applyGraphIntegrityCap(v1Evidence.answerability as MadarAnswerabilityAssessment, receiptCap)
    expect(v2Evidence.answerability, 'INTEGRITY_DIFFERENTIAL_NOT_APPLIED').toEqual(derived)

    // The diagnostic is the projection of the same receipt, not a second story.
    expect(v2Evidence.graph_integrity).toEqual(graphIntegrityDiagnostic(receiptCap))
    expect(v1Evidence.graph_integrity).toBeUndefined()

    // Both published recovery copies equal the derived bound.
    const finalState = derived.state as MadarAnswerabilityState
    for (const [label, v1Recovery, v2Recovery] of [
      ['evidence.recovery', v1Evidence.recovery, v2Evidence.recovery],
      ['pack.recovery', (v1Raw.pack as Record<string, unknown>)?.recovery, (v2Raw.pack as Record<string, unknown>)?.recovery],
    ] as Array<[string, unknown, unknown]>) {
      if (v1Recovery === undefined) continue
      expect(v2Recovery, `${label} does not equal the derived bound`)
        .toEqual(capPublishedRecoveryByFinalAnswerability(v1Recovery, finalState))
    }
  })

  it('Case A — v2 reduces to v1 when exactly the classified differences are undone', () => {
    // The strongest form of the contract. Enumerating permitted paths says what
    // MAY differ; this says nothing else DOES, without trusting the enumeration
    // to be complete.
    const { v2Raw, v1Raw } = payloads('pack')
    const reduced = JSON.parse(JSON.stringify(v2Raw)) as Record<string, unknown>
    const evidence = reduced.evidence as Record<string, unknown>
    const v1Evidence = v1Raw.evidence as Record<string, unknown>

    delete evidence.graph_integrity
    evidence.answerability = v1Evidence.answerability
    evidence.pack_confidence = v1Evidence.pack_confidence
    evidence.agent_directive = v1Evidence.agent_directive
    evidence.recovery = v1Evidence.recovery
    ;(reduced.pack as Record<string, unknown>).recovery = (v1Raw.pack as Record<string, unknown>).recovery
    ;(reduced.governance as Record<string, unknown>).directive = (v1Raw.governance as Record<string, unknown>).directive
    // A measurement of the payload, restored because the payload it measured
    // just lost the object that grew it.
    ;(reduced.serialized_budget as Record<string, unknown>).token_count =
      (v1Raw.serialized_budget as Record<string, unknown>).token_count

    expect(reduced).toEqual(v1Raw)
  })

  it('Case A — the envelope grew only by the additive integrity evidence', () => {
    const { v2Raw, v1Raw } = payloads('pack')
    const v2Size = ((v2Raw.serialized_budget as Record<string, unknown>).token_count ?? 0) as number
    const v1Size = ((v1Raw.serialized_budget as Record<string, unknown>).token_count ?? 0) as number
    // It grew, and it grew because something was added rather than because the
    // pack was rebuilt: the pack's own accounting is asserted equal above.
    expect(v2Size).toBeGreaterThan(v1Size)
    const addition = JSON.stringify((v2Raw.evidence as Record<string, unknown>).graph_integrity ?? {})
    // A crude but honest upper bound: the growth cannot exceed the serialized
    // additions themselves, so it cannot be hiding re-serialized pack content.
    expect(v2Size - v1Size).toBeLessThanOrEqual(addition.length)
  })

  it('Case A — the cause is the receipt, not the artifact name', () => {
    // Feeding the same receipt to the owner reproduces the ceiling with no file
    // path involved at all, so nothing here is keyed on `.madar` vs `.json`.
    const outputDir = join(root, 'out')
    const cap = graphIntegrityCap(readGraphArtifactMetadata(join(outputDir, 'graph.madar')).integrityReceipt)
    expect(cap.ceiling).toBe(receiptCap.ceiling)
    expect(cap.status).toBe(receiptCap.status)
  })

  it('Case B — a valid receipt applies no cap and fabricates no caveat', () => {
    // Policy-level, and deliberately so: current production generation retains
    // inherited warnings, so a valid receipt is asserted against the contract
    // rather than claimed of the generated corpus.
    const cap = graphIntegrityCap(wireBlockAround({}))
    expect(cap.status).toBe('valid')
    expect(cap.ceiling).toBeNull()
    expect(cap.reason).toBeNull()

    for (const state of ['ready', 'ready_with_caveat', 'verify_targets', 'insufficient'] as MadarAnswerabilityState[]) {
      const before: MadarAnswerabilityAssessment = {
        state,
        answer_scope: state === 'ready' ? 'complete' : 'none',
        caveats: [],
        missing_obligations: [],
        verification_targets: [],
        broad_search_fallback: 'not_needed',
      }
      const after = applyGraphIntegrityCap(before, cap)
      expect(after).toEqual(before)
      // valid never raises a lower pre-existing state either.
      expect(after.state).toBe(state)
    }
    // A truthful valid diagnostic may be published; it claims nothing more.
    expect(graphIntegrityDiagnostic(cap)?.max_answerability).toBeNull()
  })

  it('Case C — a degraded receipt caps, and only the trust fields move', () => {
    const cap = graphIntegrityCap(wireBlockAround({ retained_new_fact: 2, invariant_failed: 1 }))
    expect(cap.status).toBe('invalid')
    expect(cap.ceiling).toBe('insufficient')

    const before: MadarAnswerabilityAssessment = {
      state: 'ready',
      answer_scope: 'complete',
      caveats: [],
      missing_obligations: [],
      verification_targets: [],
      broad_search_fallback: 'not_needed',
    }
    const after = applyGraphIntegrityCap(before, cap)
    expect(after.state).toBe('insufficient')
    expect(after.missing_obligations).toEqual(before.missing_obligations)
  })

  it('Case D — an absent receipt caps nothing and fabricates no integrity', () => {
    const cap = graphIntegrityCap(undefined)
    expect(cap.ceiling).toBeNull()
    expect(cap.status).toBeNull()
    expect(graphIntegrityDiagnostic(cap)).toBeUndefined()
    // Absence is not silently reinterpreted as one of the inherited warnings.
    expect(cap.reasons).toEqual([])
  })

  it('Case E — a non-integrity difference is reported as such', () => {
    const { v2, v1 } = payloads('pack')
    for (const injected of ['.pack.matched_nodes[0].node_id', '.pack.token_count', '.coverage.available_relationships']) {
      const tampered = new Map(v2)
      tampered.set(injected, '__injected__')
      const classified = classifyDifferences(tampered, v1)
      expect(classified.neutralViolations, `expected ${injected} to be reported neutral-violating`)
        .toContain(injected)
    }
  })

  it('Case F — a differing field nobody classified fails rather than passing', () => {
    const { v2, v1 } = payloads('pack')
    const tampered = new Map(v2)
    tampered.set('.evidence.some_future_trust_field', 'surprise')
    const classified = classifyDifferences(tampered, v1)
    expect(classified.unclassified).toContain('.evidence.some_future_trust_field')
    expect(classified.neutralViolations).toEqual([])
  })

  it('does not exempt the inherited warning reasons', () => {
    // INHERITED_INTEGRITY_WARNING_WAS_UNSAFELY_EXEMPTED guards this. The three
    // reasons are real integrity reasons owned upstream; #659 caps on them and
    // does not carve them out.
    for (const reason of ['full_emission_accounting_not_available', 'legacy_endpoint_identity', 'partial_discriminator_retained']) {
      expect(receiptCap.reasons, 'INHERITED_INTEGRITY_WARNING_WAS_UNSAFELY_EXEMPTED').toContain(reason)
    }
    expect(receiptCap.ceiling, 'INHERITED_INTEGRITY_WARNING_WAS_UNSAFELY_EXEMPTED').toBe('ready_with_caveat')

    // At the current implementation head, the exercised generated v2 fixtures
    // retain universal inherited warnings and therefore cannot publish `ready`.
    // Restoring `ready` requires the receipt to become valid through its owning
    // upstream work, not a downstream answerability exception.
    const { v2Raw } = payloads('pack')
    const evidence = (v2Raw.evidence ?? {}) as Record<string, unknown>
    expect((evidence.answerability as { state?: string })?.state).not.toBe('ready')
  })

  it.each([
    ['a selected node', 'auth_login', 'auth_LOGIN'],
    ['a relationship', 'calls', 'imports_from'],
    ['a claim', 'primary evidence', 'secondary evidence'],
    ['a matched label', 'login()', 'logout()'],
    ['the logical graph path', 'out/<artifact>', 'out/elsewhere'],
    ['a community label', 'Src Auth', 'Src Elsewhere'],
  ])('still fails when %s differs', (_label, from, to) => {
    const answer = normalize(canonicalAnswers.get('pack')?.text ?? '')
    const tampered = answer.replace(from, to)
    expect(tampered).not.toBe(answer)
    expect(normalize(tampered)).not.toBe(answer)
  })

  it('normalizes only the volatile mtime representation, not every date-like string', () => {
    expect(normalize('"graph_modified_at":"Mon, 17 Aug 2026 20:14:18 GMT"'))
      .toBe('"graph_modified_at":"<http-date>"')
    expect(normalize('"label":"release 2026-08-17 notes"')).toBe('"label":"release 2026-08-17 notes"')
  })

  it('proves the comparison can fail', () => {
    expect(normalize(canonicalAnswers.get('query')?.text ?? ''))
      .not.toBe(normalize(canonicalAnswers.get('explain')?.text ?? ''))
  })
})
