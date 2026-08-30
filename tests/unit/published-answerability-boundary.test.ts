import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve as resolvePath, join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { MadarAnswerabilityState } from '../../src/contracts/context-recovery.js'
import { readinessRank } from '../../src/contracts/context-recovery.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { runContextPackCommand } from '../../src/infrastructure/context-pack-command.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import {
  finalizePublishedAnswerability,
  scanPublishedAnswerability,
} from '../../src/shared/graph-integrity-answerability.js'

/**
 * The publication boundary.
 *
 * Three separate published answerability channels were found in this issue, one
 * at a time, by three different means. Enumerating seams by inspection failed
 * every time, so this suite does not enumerate: it walks the real serialized
 * response and requires that NO answerability-bearing field anywhere in it
 * exceeds the canonical final answerability, and that no such field is
 * unrecognised.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * A workspace whose only integrity degradation is an unsupported relation.
 *
 * That produces a rejected record carrying no verification target, so the
 * receipt is `degraded` WITHOUT bounded targets and the ceiling is
 * `insufficient` -- strictly below the `verify_targets` that retrieval reaches
 * on its own. A missing-endpoint degradation would put the ceiling exactly
 * where retrieval already sits and every assertion here would hold vacuously.
 */
function degradedWorkspace(): string {
  const parent = resolvePath('out', 'test-runtime')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'madar-659-boundary-'))
  roots.push(root)
  writeFileSync(join(root, 'auth.ts'), 'export function AuthService() {\n  return new HttpClient()\n}\n', 'utf8')
  writeFileSync(join(root, 'client.ts'), 'export class HttpClient {\n  request() {\n    return new Transport()\n  }\n}\n', 'utf8')
  writeFileSync(join(root, 'transport.ts'), 'export class Transport {}\n', 'utf8')

  const graph = buildFromJson({
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code' },
      { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code' },
      { id: 'transport', label: 'Transport', source_file: 'transport.ts', source_location: '1', file_type: 'code' },
    ],
    edges: [
      { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
      { source: 'client', target: 'transport', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' },
      { source: 'auth', target: 'transport', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'auth.ts' },
    ],
  }, { directed: true, accounting: 'normalized_extraction_boundary' })

  const graphPath = join(root, 'graph.madar')
  writeFileSync(graphPath, serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev-659-boundary',
    generationMode: 'full',
    generatedAt: '2026-08-30T00:00:00.000Z',
  }))
  return graphPath
}

async function callTool(graphPath: string, name: string, args: Record<string, unknown>, profile: string): Promise<Record<string, unknown>> {
  const previous = process.env.MADAR_TOOL_PROFILE
  process.env.MADAR_TOOL_PROFILE = profile
  try {
    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }, {
      logLevel: 'info' as const,
      subscribedResourceUris: new Set<string>(),
      resourceVersions: new Map<string, string>(),
      resourceListSignature: null,
    }))
    const text = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text
    expect(text, `tool ${name} returned no text: ${JSON.stringify(response)}`).toBeTruthy()
    return JSON.parse(text!) as Record<string, unknown>
  } finally {
    if (previous === undefined) delete process.env.MADAR_TOOL_PROFILE
    else process.env.MADAR_TOOL_PROFILE = previous
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

describe('659 — the motivating MCP retrieve defect', () => {
  it('reproduces an uncapped top-level recovery beside a capped evidence', async () => {
    const graphPath = degradedWorkspace()
    const payload = await callTool(graphPath, 'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full')

    const evidence = payload.evidence as Record<string, unknown> | undefined
    const answerability = (evidence?.answerability as { state?: string } | undefined)?.state
    const evidenceRecovery = (evidence?.recovery as { final_state?: string } | undefined)?.final_state
    const topLevelRecovery = (payload.recovery as { final_state?: string, initial_state?: string } | undefined)

    // The reproduction is only meaningful if the channel is actually present
    // and the cap actually engaged on the evidence side.
    expect(topLevelRecovery, 'top-level recovery channel absent; reproduction would be vacuous').toBeDefined()
    expect(answerability, 'integrity cap did not engage; reproduction would be vacuous').toBe('insufficient')
    expect(evidenceRecovery).toBe('insufficient')

    // Retained for the record: the exact serialized response and its digest.
    writeFileSync(
      join(roots[0] ?? '.', 'retrieve-response.json'),
      JSON.stringify({ payload, digest: digest(payload) }, null, 2),
    )

    // MCP_RETRIEVE_RECOVERY_EXCEEDS_FINAL_ANSWERABILITY guards this.
    for (const [field, value] of [
      ['recovery.final_state', topLevelRecovery?.final_state],
      ['recovery.initial_state', topLevelRecovery?.initial_state],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) continue
      expect(
        readinessRank(value as MadarAnswerabilityState),
        `MCP_RETRIEVE_RECOVERY_EXCEEDS_FINAL_ANSWERABILITY: top-level ${field}=${value} exceeds evidence.answerability=${answerability}`,
      ).toBeLessThanOrEqual(readinessRank(answerability as MadarAnswerabilityState))
    }
  }, 120_000)
})

/**
 * The structural inventory required of every #659 public output.
 *
 * Records what was found, at which path, whether the contract recognised it,
 * and whether it ended up bounded. The point is not that a remembered list of
 * fields is capped -- it is that nothing unrecognised is present at all.
 */
interface ChannelRow {
  readonly path: string
  readonly carrier: string
  readonly bounded: boolean
  readonly finalized: MadarAnswerabilityState | null
  readonly finalTopLevel: MadarAnswerabilityState
  readonly withinBound: boolean
}

function inventory(response: unknown, finalTopLevel: MadarAnswerabilityState): {
  rows: ChannelRow[]
  unclassified: readonly string[]
} {
  const scan = scanPublishedAnswerability(response)
  const rows = scan.channels.map((channel): ChannelRow => ({
    path: channel.path,
    carrier: channel.carrier,
    bounded: channel.bounded,
    finalized: channel.value,
    finalTopLevel,
    withinBound: channel.value === null || !channel.bounded
      || readinessRank(channel.value) <= readinessRank(finalTopLevel),
  }))
  return { rows, unclassified: scan.unclassified }
}

function finalAnswerabilityOf(payload: Record<string, unknown>): MadarAnswerabilityState {
  const evidence = payload.evidence as Record<string, unknown> | undefined
  const state = (evidence?.answerability as { state?: string } | undefined)?.state
  expect(state, 'response carries no canonical final answerability').toBeTruthy()
  return state as MadarAnswerabilityState
}

/** Graph shapes reaching each integrity state a real artifact can carry. */
const ARTIFACT_STATES: ReadonlyArray<readonly [string, Record<string, unknown>[]]> = [
  ['valid_with_warnings (clean)', [
    { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
    { source: 'client', target: 'transport', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' },
  ]],
  ['degraded with bounded targets', [
    { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
    { source: 'client', target: 'transport', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' },
    { source: 'auth', target: 'vanished', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'auth.ts' },
  ]],
  ['degraded without bounded targets', [
    { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
    { source: 'client', target: 'transport', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' },
    { source: 'auth', target: 'transport', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'auth.ts' },
  ]],
]

function workspaceWith(edges: Record<string, unknown>[], legacy = false): string {
  const parent = resolvePath('out', 'test-runtime')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'madar-659-scan-'))
  roots.push(root)
  writeFileSync(join(root, 'auth.ts'), 'export function AuthService() {\n  return new HttpClient()\n}\n', 'utf8')
  writeFileSync(join(root, 'client.ts'), 'export class HttpClient {\n  request() {\n    return new Transport()\n  }\n}\n', 'utf8')
  writeFileSync(join(root, 'transport.ts'), 'export class Transport {}\n', 'utf8')
  const graph = buildFromJson({
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code' },
      { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code' },
      { id: 'transport', label: 'Transport', source_file: 'transport.ts', source_location: '1', file_type: 'code' },
    ],
    edges,
  }, { directed: true, accounting: 'normalized_extraction_boundary' })

  if (legacy) {
    // A v1 workspace carries no receipt at all.
    const graphPath = join(root, 'graph.json')
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 1,
      directed: true,
      root_path: root,
      nodes: graph.graph.nodes,
      links: [],
    }))
    return graphPath
  }
  const graphPath = join(root, 'graph.madar')
  writeFileSync(graphPath, serializeGraphArtifactV2({
    graph, repositoryRevision: 'rev-scan', generationMode: 'full', generatedAt: '2026-08-30T00:00:00.000Z',
  }))
  return graphPath
}

describe('659 — published answerability channel inventory across every public output', () => {
  const surfaces: ReadonlyArray<readonly [string, string, Record<string, unknown>, string]> = [
    ['MCP retrieve', 'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full'],
    ['MCP context_pack', 'context_pack', { prompt: 'How does AuthService reach Transport?', task: 'explain' }, 'strict'],
  ]

  for (const [stateLabel, edges] of ARTIFACT_STATES) {
    for (const [surfaceLabel, tool, args, profile] of surfaces) {
      it(`${surfaceLabel} / ${stateLabel}: every channel is classified and bounded`, async () => {
        const payload = await callTool(workspaceWith([...edges]), tool, args, profile)
        const finalState = finalAnswerabilityOf(payload)
        const { rows, unclassified } = inventory(payload, finalState)

        expect(unclassified, `PUBLISHED_ANSWERABILITY_CHANNEL_UNCLASSIFIED: ${unclassified.join(', ')}`).toEqual([])
        expect(rows.length, 'no answerability channel found; the scan would be vacuous').toBeGreaterThan(0)

        const exceeding = rows.filter((row) => !row.withinBound)
        expect(exceeding.map((row) => `${row.path}=${row.finalized}`),
          `channel exceeds final ${finalState}`).toEqual([])

        // Deterministic identity: no path reported twice.
        expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length)
      }, 120_000)
    }
  }

  it('absent receipt: channels stay classified and no integrity is fabricated', async () => {
    const payload = await callTool(
      workspaceWith([...(ARTIFACT_STATES[0]?.[1] ?? [])], true),
      'retrieve',
      { question: 'How does AuthService reach Transport?', budget: 1500 },
      'full',
    )
    const finalState = finalAnswerabilityOf(payload)
    const { rows, unclassified } = inventory(payload, finalState)
    expect(unclassified).toEqual([])
    expect(rows.every((row) => row.withinBound)).toBe(true)
    expect((payload.evidence as Record<string, unknown>).graph_integrity).toBeUndefined()
  }, 120_000)

  it('the scan is deterministic across repeated runs of the same response', async () => {
    const graphPath = workspaceWith([...(ARTIFACT_STATES[2]?.[1] ?? [])])
    const payload = await callTool(graphPath, 'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full')
    const finalState = finalAnswerabilityOf(payload)
    expect(inventory(payload, finalState).rows).toEqual(inventory(payload, finalState).rows)
  }, 120_000)
})

describe('659 — finalization cases', () => {
  const plan = (state: MadarAnswerabilityState) => ({
    version: 1, status: 'not_needed',
    budget: { max_attempts: 2, max_candidate_nodes: 64, max_elapsed_ms: 750, output_token_budget: 1800 },
    initial_state: state, final_state: state, attempts: [], improved: false,
  })
  const response = (recovery: MadarAnswerabilityState, top: MadarAnswerabilityState) => ({
    recovery: plan(recovery),
    pack: { recovery: plan(recovery), matched_nodes: [{ node_id: 'a' }], token_count: 12 },
    evidence: {
      answerability: { state: top, caveats: [], verification_targets: [] },
      recovery: plan(recovery),
    },
    governance: { directive: { answerability: recovery } },
  })

  it('Case B — bounded by the final answer, not by any single upstream factor', () => {
    // Integrity would permit ready_with_caveat; another factor already lowered
    // the answer to verify_targets. Every channel follows the answer.
    const finalized = finalizePublishedAnswerability(response('ready_with_caveat', 'verify_targets'), 'verify_targets')
    for (const row of inventory(finalized, 'verify_targets').rows) expect(row.withinBound).toBe(true)
    expect(finalized.recovery.final_state).toBe('verify_targets')
    expect(finalized.pack.recovery.final_state).toBe('verify_targets')
    expect(finalized.evidence.recovery.final_state).toBe('verify_targets')
    expect(finalized.governance.directive.answerability).toBe('verify_targets')
  })

  it('Case C — a ready recovery beside an insufficient answer becomes insufficient', () => {
    const finalized = finalizePublishedAnswerability(response('ready', 'insufficient'), 'insufficient')
    for (const row of inventory(finalized, 'insufficient').rows) expect(row.withinBound).toBe(true)
    expect(JSON.stringify(finalized)).not.toContain('"ready"')
  })

  it('Case D — an already lower channel is preserved, never raised', () => {
    const finalized = finalizePublishedAnswerability(response('insufficient', 'ready'), 'ready')
    expect(finalized.recovery.final_state).toBe('insufficient')
    expect(finalized.evidence.recovery.final_state).toBe('insufficient')
  })

  it('Case E — an absent channel is not fabricated', () => {
    const bare = { evidence: { answerability: { state: 'insufficient' as const } }, pack: { matched_nodes: [] } }
    const finalized = finalizePublishedAnswerability(bare, 'insufficient')
    expect(finalized).toEqual(bare)
    expect('recovery' in finalized).toBe(false)
    expect('recovery' in finalized.pack).toBe(false)
  })

  it('Case F — a valid ceiling raises nothing', () => {
    const finalized = finalizePublishedAnswerability(response('verify_targets', 'ready'), 'ready')
    expect(finalized.recovery.final_state).toBe('verify_targets')
    expect(finalized.evidence.answerability.state).toBe('ready')
  })

  it('Case H — finalization is idempotent, byte-identically', () => {
    for (const [recovery, top] of [
      ['ready', 'insufficient'], ['ready_with_caveat', 'verify_targets'],
      ['insufficient', 'ready'], ['verify_targets', 'verify_targets'],
    ] as Array<[MadarAnswerabilityState, MadarAnswerabilityState]>) {
      const once = finalizePublishedAnswerability(response(recovery, top), top)
      const twice = finalizePublishedAnswerability(once, top)
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
      expect(twice).toEqual(once)
    }
  })

  it('leaves every non-answerability field structurally untouched', () => {
    const before = response('ready', 'insufficient')
    const after = finalizePublishedAnswerability(before, 'insufficient')
    expect(after.pack.matched_nodes).toEqual(before.pack.matched_nodes)
    expect(after.pack.token_count).toBe(before.pack.token_count)
    expect(after.recovery.attempts).toEqual(before.recovery.attempts)
    expect(after.recovery.improved).toBe(before.recovery.improved)
    expect(after.recovery.budget).toEqual(before.recovery.budget)
    expect(after.recovery.status).toBe(before.recovery.status)
  })

  it('classifies the integrity ceiling as a diagnostic and leaves it alone', () => {
    // `max_answerability` states what integrity permits, not what is answered.
    // A ceiling above the final answer is correct and must survive.
    const withDiagnostic = {
      evidence: {
        answerability: { state: 'verify_targets' as const },
        graph_integrity: { status: 'valid_with_warnings', reasons: [], max_answerability: 'ready_with_caveat', verification_targets: [] },
      },
    }
    const scan = scanPublishedAnswerability(withDiagnostic)
    expect(scan.unclassified).toEqual([])
    const ceiling = scan.channels.find((channel) => channel.carrier === 'integrity_ceiling')
    expect(ceiling?.bounded).toBe(false)
    const finalized = finalizePublishedAnswerability(withDiagnostic, 'verify_targets')
    expect(finalized.evidence.graph_integrity.max_answerability).toBe('ready_with_caveat')
  })

  it('fails closed on an answerability value at a field it does not recognise', () => {
    const rogue = {
      evidence: { answerability: { state: 'insufficient' as const } },
      trust_summary: { overall_readiness: 'ready' },
    }
    const scan = scanPublishedAnswerability(rogue)
    expect(scan.unclassified, 'PUBLISHED_ANSWERABILITY_CHANNEL_UNCLASSIFIED')
      .toContain('.trust_summary.overall_readiness')
  })

  it('does not mistake a status or plan field for an answerability', () => {
    // `status` values are deliberately outside the readiness union, and the
    // scanner must not widen to every state-ish property.
    const benign = {
      evidence: { answerability: { state: 'ready' as const } },
      pack: {
        retrieval_plan: { status: 'recovered', state: 'applied' },
        recovery: { status: 'exhausted', initial_state: 'ready', final_state: 'ready', attempts: [] },
      },
    }
    const scan = scanPublishedAnswerability(benign)
    expect(scan.unclassified).toEqual([])
    expect(scan.channels.map((channel) => channel.path).sort()).toEqual([
      '.evidence.answerability.state',
      '.pack.recovery.final_state',
      '.pack.recovery.initial_state',
    ])
  })
})

describe('659 — CLI context-pack output is inside the same boundary', () => {
  for (const [stateLabel, edges] of ARTIFACT_STATES) {
    it(`CLI context pack / ${stateLabel}: every channel is classified and bounded`, async () => {
      const graphPath = workspaceWith([...edges])
      const raw = await runContextPackCommand({
        prompt: 'How does AuthService reach Transport?',
        budget: 1_500,
        task: 'explain',
        graphPath,
        graphPathIntent: 'explicit' as const,
        format: 'json',
      })
      const payload = JSON.parse(raw) as Record<string, unknown>
      const finalState = finalAnswerabilityOf(payload)
      const { rows, unclassified } = inventory(payload, finalState)

      expect(unclassified, `PUBLISHED_ANSWERABILITY_CHANNEL_UNCLASSIFIED: ${unclassified.join(', ')}`).toEqual([])
      expect(rows.length, 'no answerability channel found; the scan would be vacuous').toBeGreaterThan(0)
      expect(rows.filter((row) => !row.withinBound).map((row) => `${row.path}=${row.finalized}`),
        `channel exceeds final ${finalState}`).toEqual([])
      expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length)
    }, 120_000)
  }
})

describe('659 — the boundary changes nothing but published answerability', () => {
  it('leaves every retrieval-derived field identical across integrity states', async () => {
    // Same source tree, two artifacts whose only difference is the integrity
    // receipt they carry. Everything retrieval produced must be identical; only
    // the published readiness values may move.
    const clean = await callTool(
      workspaceWith([...(ARTIFACT_STATES[0]?.[1] ?? [])]),
      'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full',
    )
    const degraded = await callTool(
      workspaceWith([...(ARTIFACT_STATES[2]?.[1] ?? [])]),
      'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full',
    )

    const neutral = (payload: Record<string, unknown>) => {
      const recovery = payload.recovery as Record<string, unknown> | undefined
      return {
        matched_nodes: payload.matched_nodes,
        relationships: payload.relationships,
        retrieval_plan: payload.retrieval_plan,
        retrieval_strategy: payload.retrieval_strategy,
        community_context: payload.community_context,
        graph_signals: payload.graph_signals,
        token_count: payload.token_count,
        snippet_budget_tokens_used: payload.snippet_budget_tokens_used,
        snippet_budget_tokens_remaining: payload.snippet_budget_tokens_remaining,
        // Recovery EXECUTION, as distinct from its published readiness.
        recovery_attempts: recovery?.attempts,
        recovery_improved: recovery?.improved,
        recovery_status: recovery?.status,
        recovery_budget: recovery?.budget,
      }
    }

    // The degraded arm carries one extra unsupported-relation edge that is
    // rejected before it becomes a fact, so the traversable graph is the same.
    expect(neutral(degraded)).toEqual(neutral(clean))

    // And the published readiness genuinely differs, or the comparison above
    // would be proving nothing.
    expect((degraded.evidence as Record<string, unknown>)).toBeDefined()
    expect(finalAnswerabilityOf(degraded)).not.toBe(finalAnswerabilityOf(clean))
  }, 120_000)

  it('is idempotent on a real response', async () => {
    const payload = await callTool(
      workspaceWith([...(ARTIFACT_STATES[2]?.[1] ?? [])]),
      'retrieve', { question: 'How does AuthService reach Transport?', budget: 1500 }, 'full',
    )
    const finalState = finalAnswerabilityOf(payload)
    const once = finalizePublishedAnswerability(payload, finalState)
    expect(JSON.stringify(once)).toBe(JSON.stringify(payload))
    expect(JSON.stringify(finalizePublishedAnswerability(once, finalState))).toBe(JSON.stringify(once))
  }, 120_000)
})
