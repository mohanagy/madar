/**
 * #660-B -- production independence from qualification-repository knowledge.
 *
 * The forbidden-knowledge scanner owns the literal half of this guarantee and
 * cannot own the rest: a rule keyed on prompt vocabulary, or one that forces a
 * candidate into the result, encodes a qualification task without containing
 * any name a scanner could look for. That class is owned here, behaviourally.
 *
 * The sharpest control in this file is the pair C/D: two graphs with identical
 * structure and completely different names must rank identically, and two
 * graphs with identical names and different structure must not. Together they
 * say retrieval follows the evidence, not the vocabulary.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ContextPackNode } from '../../src/contracts/context-pack.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  classifyTaskContract,
  compileContextPack,
  type ContextPackNodeCandidate,
} from '../../src/runtime/context-pack.js'
import { planConceptualFallback } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import {
  analyzeForbiddenKnowledge,
  buildProductionSourceIndex,
  decodeEscapes,
  loadForbiddenKnowledgeManifest,
} from '../../scripts/lib/forbidden-knowledge.mjs'
import { productionSourceFiles } from '../../scripts/lib/grader-boundary.mjs'

/**
 * The production index, built ONCE for this suite.
 *
 * Every assertion below reads the same index rather than re-parsing the tree,
 * which is the point of the one-pass design and also what keeps this file
 * inside the protected control's time budget under coverage instrumentation.
 */
let cachedIndex: ReturnType<typeof buildProductionSourceIndex> | null = null
const readProductionFile = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8')
function sharedIndex(): ReturnType<typeof buildProductionSourceIndex> {
  cachedIndex ??= buildProductionSourceIndex({
    files: productionSourceFiles(process.cwd()),
    readFile: readProductionFile,
  })
  return cachedIndex
}

/** Claim prefixes that were produced by fixed, repository-keyed builders. */
const REMOVED_FIXED_CLAIM_PREFIXES = [
  'public runtime provenance:',
  'public payload divergence:',
  'failure detection:',
  'cross-runtime handoff:',
]

interface NodeSpec {
  id: string
  label: string
  source: string
  snippet?: string
  frameworkRole?: string
}

interface EdgeSpec {
  from: string
  to: string
  relation: string
}

function buildGraph(nodes: readonly NodeSpec[], edges: readonly EdgeSpec[]): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  for (const node of nodes) {
    graph.addNode(node.id, {
      label: node.label,
      source_file: node.source,
      source_location: 'L1-L3',
      file_type: 'code',
      node_kind: 'function',
      type: 'function',
      ...(node.snippet !== undefined ? { snippet: node.snippet } : {}),
      ...(node.frameworkRole !== undefined ? { framework_role: node.frameworkRole } : {}),
    })
  }
  for (const edge of edges) {
    graph.addEdge(edge.from, edge.to, { relation: edge.relation })
  }
  return graph
}

const LOW_QUALITY = {
  selected_nodes: 0,
  workflow_coherence: 0,
  missing_required_evidence: 2,
  missing_semantic_categories: 2,
  direct_nodes: 0,
  source_files: 0,
} as never

function boostOrder(graph: KnowledgeGraph, question: string): string[] {
  const proposal = planConceptualFallback(graph, {
    question,
    initialQuality: LOW_QUALITY,
    selectedNodes: [],
  })
  return [...(proposal?.nodeBoosts ?? new Map<string, number>())]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id]) => id)
}

function candidate(
  entry: ContextPackNode,
  tokenCost: number,
): ContextPackNodeCandidate<ContextPackNode> {
  return {
    label: entry.label,
    ...(typeof entry.node_id === 'string' ? { node_id: entry.node_id } : {}),
    community: entry.community ?? null,
    source_file: entry.source_file,
    line_number: entry.line_number,
    ...(typeof entry.file_type === 'string' ? { file_type: entry.file_type } : {}),
    ...(typeof entry.snippet === 'string' ? { snippet: entry.snippet } : {}),
    evidence_class: 'primary',
    estimate_tokens: () => tokenCost,
    build_entry: () => ({ ...entry, evidence_class: 'primary' }),
  }
}

function packFor(
  nodes: ReadonlyArray<{ id: string; label: string; source: string; snippet: string; frameworkRole?: string }>,
  relationships: ReadonlyArray<{ from: string; to: string; relation: string }>,
  prompt: string,
) {
  return compileContextPack({
    task_contract: classifyTaskContract('explain', { budget: 240, prompt }),
    nodes: nodes.map((node, index) => candidate({
      node_id: node.id,
      label: node.label,
      source_file: node.source,
      line_number: 10 + index,
      snippet: node.snippet,
      file_type: 'code',
      match_score: 9 - index,
      relevance_band: 'direct',
      community: 0,
      ...(node.frameworkRole !== undefined ? { framework_role: node.frameworkRole } : {}),
    }, 20)),
    relationships: relationships.map((edge) => ({
      from_id: edge.from,
      from: nodes.find((node) => node.id === edge.from)?.label ?? edge.from,
      to_id: edge.to,
      to: nodes.find((node) => node.id === edge.to)?.label ?? edge.to,
      relation: edge.relation,
    })),
  })
}

/* ------------------------------------------------------------------ *
 * The two structures used by controls C and D.
 *
 * `QUALIFICATION_NAMES` uses the exact vocabulary of a qualification target.
 * `UNRELATED_NAMES` is the same structure with every identifier replaced.
 * `SAME_NAMES_OTHER_STRUCTURE` keeps the qualification names but wires them
 * into a different shape.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The fixtures used by controls C and D.
 *
 * D is an exact isomorphism: every identifier AND every question word is
 * substituted one-for-one (monitor->probe, check->scan, status->health,
 * incident->entry, notification->alert, page->panel), so the lexical
 * relationship between the question and the code is preserved. Ordinary
 * query-term matching is therefore held constant and the only thing that could
 * make the two rank differently is a rule that knows one of these vocabularies.
 * ------------------------------------------------------------------ */

const QUALIFICATION_NAMES: NodeSpec[] = [
  { id: 'n1', label: '.HTTPCheckerHandler()', source: '/apps/checker/handlers/checker.go' },
  { id: 'n2', label: 'UpdateStatus()', source: '/apps/checker/checker/update.go' },
  { id: 'n3', label: 'createIncident()', source: '/apps/workflows/src/checker/incident.ts' },
  { id: 'n4', label: 'triggerNotifications()', source: '/apps/workflows/src/checker/alerting.ts' },
  { id: 'n5', label: 'statusPage.ts', source: '/packages/api/src/router/statusPage.ts' },
]

const SUBSTITUTED_NAMES: NodeSpec[] = [
  { id: 'n1', label: '.HTTPScannerHandler()', source: '/apps/scanner/handlers/scanner.go' },
  { id: 'n2', label: 'UpdateHealth()', source: '/apps/scanner/scanner/update.go' },
  { id: 'n3', label: 'createEntry()', source: '/apps/workflows/src/scanner/entry.ts' },
  { id: 'n4', label: 'triggerAlerts()', source: '/apps/workflows/src/scanner/alerting.ts' },
  { id: 'n5', label: 'healthPanel.ts', source: '/packages/api/src/router/healthPanel.ts' },
]

const SHARED_EDGES: EdgeSpec[] = [
  { from: 'n1', to: 'n2', relation: 'calls' },
  { from: 'n2', to: 'n3', relation: 'calls' },
  { from: 'n3', to: 'n4', relation: 'calls' },
  { from: 'n3', to: 'n5', relation: 'updates_slice' },
]

const QUALIFICATION_QUESTION = 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status.'
// `state` is deliberately avoided as a substitute: it is already in the
// pre-existing QUERY_DIRECTIVE_TERMS list, so using it would strip a term on
// one side only and break the isomorphism for a reason unrelated to naming.
const SUBSTITUTED_QUESTION = 'Trace how a failed probe scan becomes an entry, triggers alerts, and affects the public health-panel health.'

describe('production independence from qualification repositories', () => {
  /* ---------------- A. unrelated repository with similar names ------------- */

  it('A. gives a repository with qualification-like names but no typed evidence no fixed claim', () => {
    // Every name below is one the removed rules keyed on. None of them may
    // produce a claim, because nothing structural connects these nodes.
    const pack = packFor(
      [
        { id: 'a', label: 'statusPage', source: 'src/statusPage.ts', snippet: 'export const statusPage = 1' },
        { id: 'b', label: 'publicPage', source: 'src/publicPage.ts', snippet: 'export const publicPage = 2' },
        { id: 'c', label: 'UpdateStatus', source: 'src/UpdateStatus.ts', snippet: 'export function UpdateStatus() {}' },
        { id: 'd', label: 'CreateTask', source: 'src/CreateTask.ts', snippet: 'export function CreateTask() {}' },
        { id: 'e', label: 'HTTPCheckerHandler', source: 'src/checker.ts', snippet: 'export function HTTPCheckerHandler() {}' },
        { id: 'f', label: 'incident', source: 'src/incident.ts', snippet: 'export const incident = 3' },
      ],
      [],
      'Explain the router, checker and incident handling.',
    )

    for (const prefix of REMOVED_FIXED_CLAIM_PREFIXES) {
      expect(
        pack.claims.some((claim) => claim.text.startsWith(prefix)),
        `a repository that merely uses these names received the claim "${prefix}"`,
      ).toBe(false)
    }
    // With no typed relationship and no framework role, no structural claim is
    // earned at all.
    expect(pack.claims.some((claim) => claim.text.startsWith('queue handoff:'))).toBe(false)
    expect(pack.claims.some((claim) => claim.text.startsWith('runtime boundary:'))).toBe(false)
  })

  /* ---------------- B. renamed implementation ----------------------------- */

  it('B. recovers the producer/consumer relationship after every name is changed', () => {
    const pack = packFor(
      [
        { id: 'producer', label: 'SyncRecord()', source: 'apps/ledger/sync.go', snippet: 'queueClient.Dispatch(ctx, req)' },
        { id: 'consumer', label: 'RecordSyncWorker.run()', source: 'apps/workflows/src/record-sync.ts', snippet: 'await persistRecord(payload)' },
      ],
      [{ from: 'producer', to: 'consumer', relation: 'enqueues_job' }],
      'Trace a failed check into the workflow.',
    )

    expect(pack.claims.some((claim) => claim.text === (
      'queue handoff: apps/ledger/sync.go SyncRecord() enqueues_job apps/workflows/src/record-sync.ts RecordSyncWorker.run()'
    ))).toBe(true)
  })

  it('B2. recovers a framework-declared route handler after every name is changed', () => {
    // POSITIVE half. Every identifier is unrelated to any qualification target
    // and the role is one an extractor declares from framework structure, so a
    // passing assertion means the claim was earned by that declared role rather
    // than by any name. Asserting the exact text matters: an earlier version of
    // this control supplied no role and asserted only the negative below, which
    // meant deleting the claim builder outright left it green.
    const pack = packFor(
      [
        {
          id: 'route',
          label: 'listCatalogEntries()',
          source: 'apps/portal/src/routes/catalog.ts',
          snippet: 'export async function listCatalogEntries() {}',
          frameworkRole: 'fastify_route',
        },
      ],
      [],
      'Explain the public catalog endpoint.',
    )

    expect(pack.claims.map((claim) => claim.text)).toContain(
      'runtime boundary: apps/portal/src/routes/catalog.ts listCatalogEntries() is a framework-declared fastify_route',
    )
  })

  it('B2b. claims no runtime boundary from a route-shaped path with no declared role', () => {
    // NEGATIVE half, kept separate. A path that looks like a route is not
    // evidence; the role has to come from an extractor.
    const pack = packFor(
      [
        { id: 'route', label: 'GET()', source: 'apps/portal/src/app/api/summary/route.ts', snippet: 'export async function GET() {}' },
      ],
      [],
      'Explain the public summary endpoint.',
    )
    expect(pack.claims.some((claim) => claim.text.startsWith('runtime boundary:'))).toBe(false)
  })

  /* ---------------- C / D. names vs structure ----------------------------- */

  it('D. ranks a one-for-one substituted repository exactly as it ranks the original', () => {
    const qualification = boostOrder(buildGraph(QUALIFICATION_NAMES, SHARED_EDGES), QUALIFICATION_QUESTION)
    const substituted = boostOrder(buildGraph(SUBSTITUTED_NAMES, SHARED_EDGES), SUBSTITUTED_QUESTION)

    // Node ids are shared between the two fixtures on purpose: only the labels,
    // paths and question words differ, and they differ by the same substitution.
    // An identical ordering means ranking followed structure and generic
    // question-to-code matching. Any rule that recognises one vocabulary breaks
    // this, which is exactly what the removed rules did.
    expect(substituted, `qualification ${JSON.stringify(qualification)} vs substituted ${JSON.stringify(substituted)}`)
      .toEqual(qualification)
  })

  it('C. does not give the qualification names their former treatment under a different structure', () => {
    const connected = boostOrder(buildGraph(QUALIFICATION_NAMES, SHARED_EDGES), QUALIFICATION_QUESTION)
    // Same names, no edges at all: a name-driven rule would rank them the same
    // way regardless. A structural one cannot.
    const disconnected = boostOrder(buildGraph(QUALIFICATION_NAMES, []), QUALIFICATION_QUESTION)

    expect(disconnected).not.toEqual(connected)
  })

  /* ---------------- D2. the same isomorphism, end to end ------------------ */

  it('D2. selects the same nodes end-to-end for a one-for-one substituted repository', () => {
    // D observes conceptual boosts. This observes what retrieval actually
    // RETURNS, under a requested slice-v1, so a forced selection or a slice
    // bypass added anywhere on the retrieval path is caught here and not only
    // in the fallback planner.
    //
    // The assertion is on final MEMBERSHIP, not ordering. A reorder that leaves
    // the selected set intact is not evidence of contamination, and treating it
    // as such would make this control fire on noise.
    const observe = (nodes: readonly NodeSpec[], question: string) => {
      const result = retrieveContext(buildGraph(nodes, SHARED_EDGES), {
        question,
        budget: 5000,
        retrievalStrategy: 'slice-v1',
      })
      return {
        ids: result.matched_nodes.map((node) => node.node_id ?? node.label),
        membership: [...new Set(result.matched_nodes.map((node) => node.node_id ?? node.label))].sort(),
        strategy: result.retrieval_strategy,
        obligations: result.retrieval_plan?.query_obligations?.total ?? 0,
        covered: result.retrieval_plan?.query_obligations?.finally_covered ?? 0,
      }
    }

    const qualification = observe(QUALIFICATION_NAMES, QUALIFICATION_QUESTION)
    const substituted = observe(SUBSTITUTED_NAMES, SUBSTITUTED_QUESTION)

    // Measurement seam for the semantic falsifiability harness. It needs the
    // SET this control actually observed, so that "the injection changed final
    // membership" is a measured premise rather than an assumption. Written
    // before the assertions so a failing run still reports what it saw.
    const membershipOut = process.env.MADAR_D2_MEMBERSHIP_OUT
    if (membershipOut !== undefined && membershipOut.length > 0) {
      writeFileSync(membershipOut, JSON.stringify({ qualification, substituted }), 'utf8')
    }

    // Explicit, truthful baseline. These are the measured values on a clean
    // tree; they are asserted so that a mutation cannot quietly satisfy the
    // comparison below by emptying both sides.
    expect(qualification.strategy).toBe('slice-v1')
    expect(substituted.strategy).toBe('slice-v1')
    // Measured, not hoped for. n5 (the cross-package router node) is dropped by
    // the requested slice now that no recovery mode opts out of slicing, and n1
    // is never selected. Both are asserted so the comparison below cannot be
    // satisfied by a mutation that empties both sides.
    expect(qualification.membership).toEqual(['n2', 'n3', 'n4'])
    expect(qualification.obligations).toBe(4)
    expect(qualification.membership).not.toContain('n1')
    expect(substituted.membership).not.toContain('n1')
    expect(qualification.membership).not.toContain('n5')
    // Nothing may pin an entry into the payload because of a repository path.
    // The falsifiability harness injects exactly this id, so a clean tree must
    // not contain it and the injected tree must.
    expect(qualification.membership).not.toContain('h4-forced-membership')

    expect(
      substituted.membership,
      `qualification ${JSON.stringify(qualification)} vs substituted ${JSON.stringify(substituted)}`,
    ).toEqual(qualification.membership)
    expect(substituted.obligations).toBe(qualification.obligations)
    expect(substituted.covered).toBe(qualification.covered)
  })

  /* ---------------- E. qualification strings alone ------------------------ */

  it('E. produces no fixed claim from the historical strings without supporting evidence', () => {
    // The exact snippets the removed builders matched on, with no relationships.
    const pack = packFor(
      [
        {
          id: 'x',
          label: 'unresolvedIncidents()',
          source: 'apps/status-page/src/content/status-json.ts',
          snippet: [
            'type Page = NonNullable<RouterOutputs["statusPage"]["get"]>;',
            'status: pageIndicator(page.status),',
            'return page.statusReports.filter((report) => report.status !== "resolved")',
          ].join('\n'),
        },
        {
          id: 'y',
          label: 'statusPage.ts',
          source: 'packages/api/src/router/statusPage.ts',
          snippet: 'events.some((e) => e.type === "incident" && !e.to) && barType !== "manual" ? "error" : activeReportStatus(events)',
        },
        {
          id: 'z',
          label: 'UpdateStatus()',
          source: 'apps/checker/checker/update.go',
          snippet: 'client, err := cloudtasks.NewClient(ctx)\n_, err = client.CreateTask(ctx, req)',
        },
      ],
      [],
      'Identify inconsistent public status computation paths.',
    )

    for (const prefix of REMOVED_FIXED_CLAIM_PREFIXES) {
      expect(
        pack.claims.some((claim) => claim.text.startsWith(prefix)),
        `the historical strings alone still produced "${prefix}"`,
      ).toBe(false)
    }
  })

  /* ---------------- F. source attribution --------------------------------- */

  it('F. cites a node the pack actually carries for every claim it emits', () => {
    const pack = packFor(
      [
        { id: 'producer', label: 'SyncRecord()', source: 'apps/ledger/sync.go', snippet: 'queueClient.Dispatch(ctx, req)' },
        { id: 'consumer', label: 'RecordSyncWorker.run()', source: 'apps/workflows/src/record-sync.ts', snippet: 'await persistRecord(payload)' },
      ],
      [{ from: 'producer', to: 'consumer', relation: 'enqueues_job' }],
      'Trace a failed check into the workflow.',
    )

    const packLabels = new Set(pack.nodes.map((node) => node.label))
    expect(pack.claims.length).toBeGreaterThan(0)
    for (const claim of pack.claims) {
      expect(claim.node_labels.length, `claim cites nothing: ${claim.text}`).toBeGreaterThan(0)
      for (const label of claim.node_labels) {
        expect(packLabels, `claim cites a node absent from the pack: ${claim.text}`).toContain(label)
      }
    }
  })

  /* ---------------- G. the literal scanner runs on every lane ------------- */

  describe('G. forbidden-knowledge scanner', () => {
    it('accepts a valid manifest and reports rules from both the file and the frozen contract', () => {
      const manifest = loadForbiddenKnowledgeManifest(process.cwd())
      expect(manifest.problems).toEqual([])
      expect(manifest.ok).toBe(true)
      expect(manifest.rules.length).toBeGreaterThan(0)
      // Rules imported from the frozen contract keep the manifest in step with
      // the pinned corpus instead of drifting from it.
      expect(manifest.rules.some((rule: { origin: string }) => rule.origin.includes('corpus.json'))).toBe(true)
      expect(manifest.exceptions).toEqual([])
    })

    // #660-B1. The scan used to renormalize every site for every rule, which
    // cost sites x rules string transformations and timed the control out at
    // 15s on CI. These four assertions are the standing proof that the one-pass
    // index is real: sources are read, parsed and normalized once, and the rule
    // count no longer drives the work.
    it('parses each production file exactly once, whatever the rule count', () => {
      const files = productionSourceFiles(process.cwd())
      const index = sharedIndex()
      const manifest = loadForbiddenKnowledgeManifest(process.cwd())

      expect(new Set(files).size).toBe(files.length)
      expect(index.stats.parseCalls).toBe(files.length)
      expect(index.stats.indexedFiles).toBe(files.length)

      // The same index answers both scans, and halving the rules changes
      // neither the source work done nor the verdict. Rules are applied to the
      // index; they never drive another pass over the tree.
      const full = analyzeForbiddenKnowledge({ root: process.cwd(), index })
      const halved = analyzeForbiddenKnowledge({
        root: process.cwd(),
        index,
        manifest: { ...manifest, rules: manifest.rules.slice(0, Math.floor(manifest.rules.length / 2)) },
      })
      expect(halved.stats).toEqual(full.stats)
      expect(halved.stats.parseCalls).toBe(files.length)
      expect(full.violations).toEqual([])
      expect(halved.violations).toEqual([])
    })

    it('never parses a file twice, even when the file list repeats one', () => {
      // A small slice is enough: de-duplication is a property of the index, not
      // of how many files it was handed.
      const files = productionSourceFiles(process.cwd()).slice(0, 5)
      const duplicated = [...files, ...files]
      const index = buildProductionSourceIndex({ files: duplicated, readFile: readProductionFile })
      expect(duplicated.length).toBe(files.length * 2)
      expect(index.stats.parseCalls).toBe(files.length)
      expect(index.byFile.size).toBe(files.length)
    })

    it('represents every production file in the index', () => {
      const files = productionSourceFiles(process.cwd())
      const index = sharedIndex()
      for (const file of files) {
        expect(index.byFile.has(file), `missing from index: ${file}`).toBe(true)
      }
    })

    it('reports the same result whatever order the rules are declared in', () => {
      const manifest = loadForbiddenKnowledgeManifest(process.cwd())
      const reversed = { ...manifest, rules: [...manifest.rules].reverse() }
      const index = sharedIndex()
      const forward = analyzeForbiddenKnowledge({ root: process.cwd(), index, manifest })
      const backward = analyzeForbiddenKnowledge({ root: process.cwd(), index, manifest: reversed })
      expect(backward.ok).toBe(forward.ok)
      expect(backward.violations).toEqual(forward.violations)
    })

    // #660-B1. A legacy octal escape is executable inside a regex:
    // /\163tatusPage/ runs as /statusPage/. Both directions are asserted, so a
    // decoder that silently stopped working could not pass this.
    it('decodes a legacy octal escape that the raw spelling hides', () => {
      const raw = String.raw`/\163tatusPage/i`
      expect(raw).not.toContain('statusPage')
      expect(decodeEscapes(raw)).toContain('statusPage')

      const result = analyzeForbiddenKnowledge({
        root: process.cwd(),
        files: ['probe.ts'],
        readFile: () => `const probe = ${raw}\n`,
      })
      const hit = result.violations.find((violation: { rule: string }) => violation.rule === 'openstatus/symbol-status-page')
      expect(hit, 'legacy octal escape was not classified').toBeDefined()
      expect(hit?.raw).toContain('163')
      expect(hit?.decoded).toContain('statusPage')
    })

    it('leaves a regex backreference alone rather than inventing a name', () => {
      // \1..\9 decode to control characters, not printable text, so they stay
      // backreferences. Resolving the ambiguity the other way would fabricate
      // matches in ordinary regexes.
      expect(decodeEscapes(String.raw`(status)\1`)).not.toContain('statusPage')
    })

    it('finds no qualification-repository knowledge in production source', () => {
      const result = analyzeForbiddenKnowledge({ root: process.cwd(), index: sharedIndex() })
      const detail = result.violations
        .map((violation: { file: string; line: number; rule: string; raw: string }) => (
          `${violation.file}:${violation.line} [${violation.rule}] ${violation.raw}`
        ))
        .join('\n')
      expect(result.violations.length, detail).toBe(0)
      expect(result.unusedExceptions).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.filesScanned).toBeGreaterThan(0)
    })
  })
})
