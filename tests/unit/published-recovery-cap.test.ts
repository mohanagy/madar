import { describe, expect, it, vi } from 'vitest'

import type { MadarAnswerabilityState } from '../../src/contracts/context-recovery.js'
import { MADAR_ANSWERABILITY_STATES, minByReadinessRank, readinessRank } from '../../src/contracts/context-recovery.js'
import { runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../../src/runtime/retrieve.js'
import { capPublishedRecoveryByFinalAnswerability } from '../../src/shared/graph-integrity-answerability.js'
import { buildCrossLayerMonitorFlowFixture } from '../fixtures/cross-layer-monitor-flow.js'

/**
 * `pack.recovery` and `evidence.recovery` are two serialisations of one plan.
 * The pack is assembled before the answer is assessed, so the published copy is
 * bounded at the publication seam, where the final answerability first exists
 * beside it. These controls prove that on the real response paths, and prove it
 * for the ordinary response rather than relying on the pressure-compaction path
 * that only runs when a response is over budget.
 */

const PROMPT = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every distinct overall-status computation. Read-only: do not modify files.'

const STATES = MADAR_ANSWERABILITY_STATES

function recoveryPlan(state: MadarAnswerabilityState): NonNullable<RetrieveResult['recovery']> {
  return {
    version: 1,
    status: 'not_needed',
    budget: { max_attempts: 2, max_candidate_nodes: 64, max_elapsed_ms: 750, output_token_budget: 1_800 },
    initial_state: state,
    final_state: state,
    attempts: [],
    improved: false,
  }
}

interface CliPayload {
  evidence?: {
    answerability?: { state?: string }
    recovery?: { initial_state?: string, final_state?: string }
  }
  pack?: {
    recovery?: { initial_state?: string, final_state?: string, attempts?: unknown[], improved?: boolean, budget?: unknown }
    matched_nodes?: Array<{ label: string, source_file: string, node_id?: string }>
    relationships?: unknown[]
    retrieval_plan?: unknown
  }
  serialized_budget?: { enforced?: boolean }
}

/**
 * Drives the real CLI response path with an injected retrieval whose recovery
 * plan is deliberately more optimistic than the answer will turn out to be.
 */
async function cliResponse(options: {
  recoveryState: MadarAnswerabilityState
  budget?: number
  omitObligations?: boolean
}): Promise<CliPayload> {
  const budget = options.budget ?? 1_800
  const graph = buildCrossLayerMonitorFlowFixture()
  const retrieval = retrieveContext(graph, {
    question: PROMPT,
    budget,
    taskKind: 'explain',
    retrievalStrategy: 'slice-v1',
  })
  const compact = compactRetrieveResult(retrieval)

  // Dropping the checker nodes leaves the serialized pack unable to cover every
  // prompt obligation, which is what lowers the final answer independently of
  // graph integrity.
  const omitted = new Set(
    compact.matched_nodes
      .filter((node) => /apps\/workflows\/src\/checker\/(?:index|alerting|utils)\.ts$/.test(node.source_file))
      .flatMap((node) => (node.node_id ? [node.node_id] : [])),
  )
  const serialized = options.omitObligations === false ? compact : {
    ...compact,
    matched_nodes: compact.matched_nodes.filter((node) => !node.node_id || !omitted.has(node.node_id)),
    relationships: compact.relationships.filter((relationship) => (
      (!relationship.from_id || !omitted.has(relationship.from_id))
      && (!relationship.to_id || !omitted.has(relationship.to_id))
    )),
  }

  const plan = recoveryPlan(options.recoveryState)
  const optimistic: RetrieveResult = { ...retrieval, recovery: plan }
  // The compact pack is a second serialisation of the same plan. Injecting it
  // here is what makes the published duplicate observable; leaving the
  // fixture's own recovery in place would silently test a different object.
  const serializedWithPlan = { ...serialized, recovery: plan }
  const dependencies: ContextPackCommandDependencies = {
    loadGraph: vi.fn().mockReturnValue(graph),
    retrieveContext: vi.fn().mockReturnValue(optimistic),
    compactRetrieveResult: vi.fn().mockReturnValue(serializedWithPlan),
    analyzePrImpact: vi.fn(),
    compactPrImpactResult: vi.fn(),
    analyzeImpact: vi.fn(),
    compactImpactResult: vi.fn(),
  }

  return JSON.parse(await runContextPackCommand({
    prompt: PROMPT,
    budget,
    task: 'explain',
    graphPath: 'out/graph.json',
    graphPathIntent: 'explicit' as const,
    retrievalStrategy: 'slice-v1',
    format: 'json',
  }, dependencies)) as CliPayload
}

describe('659 — the publication cap helper', () => {
  it('equals the lower-ranked input in every cell of the 4x4 matrix', () => {
    for (const recoveryState of STATES) {
      for (const finalState of STATES) {
        const published = capPublishedRecoveryByFinalAnswerability(recoveryPlan(recoveryState), finalState)
        // Expected values are derived through the one ordering owner, never
        // from a second table maintained beside it.
        const expected = minByReadinessRank(recoveryState, finalState)
        expect(published.final_state).toBe(expected)
        expect(published.initial_state).toBe(expected)
        expect(readinessRank(published.final_state)).toBeLessThanOrEqual(readinessRank(recoveryState))
      }
    }
  })

  it('covers each focused case the ruling names', () => {
    const published = (recovery: MadarAnswerabilityState, final: MadarAnswerabilityState) =>
      capPublishedRecoveryByFinalAnswerability(recoveryPlan(recovery), final).final_state

    expect(published('ready', 'insufficient')).toBe('insufficient')
    expect(published('ready', 'verify_targets')).toBe('verify_targets')
    expect(published('ready_with_caveat', 'verify_targets')).toBe('verify_targets')
    expect(published('verify_targets', 'ready_with_caveat')).toBe('verify_targets')
    expect(published('insufficient', 'ready')).toBe('insufficient')
    expect(published('verify_targets', 'verify_targets')).toBe('verify_targets')
  })

  it('preserves an absent plan rather than fabricating one', () => {
    for (const absent of [undefined, null]) {
      expect(capPublishedRecoveryByFinalAnswerability(absent, 'insufficient')).toBe(absent)
    }
  })

  it('alters only the two state fields and leaves recovery metadata intact', () => {
    const original = { ...recoveryPlan('ready'), attempts: [{ attempt: 1 }], improved: true, extra: 'kept' }
    const published = capPublishedRecoveryByFinalAnswerability(original, 'insufficient')
    expect(published.final_state).toBe('insufficient')
    expect(published.initial_state).toBe('insufficient')
    expect(published.attempts).toEqual(original.attempts)
    expect(published.improved).toBe(true)
    expect(published.extra).toBe('kept')
    expect(published.budget).toEqual(original.budget)
    expect(published.status).toBe(original.status)
  })

  it('is idempotent, and returns the original reference when nothing moves', () => {
    for (const recoveryState of STATES) {
      for (const finalState of STATES) {
        const once = capPublishedRecoveryByFinalAnswerability(recoveryPlan(recoveryState), finalState)
        expect(capPublishedRecoveryByFinalAnswerability(once, finalState)).toEqual(once)
      }
    }
    const unchanged = recoveryPlan('insufficient')
    expect(capPublishedRecoveryByFinalAnswerability(unchanged, 'ready')).toBe(unchanged)
  })

  it('leaves a plan whose states are not answerability values alone', () => {
    const odd = { initial_state: 'something_else', final_state: 42, attempts: [] }
    expect(capPublishedRecoveryByFinalAnswerability(odd, 'insufficient')).toBe(odd)
  })
})

describe('659 — PACK_RECOVERY_UNCAPPED_IN_NORMAL_RESPONSE', () => {
  it('bounds published pack.recovery in an ordinary non-pressure response', async () => {
    const payload = await cliResponse({ recoveryState: 'ready' })

    // The probe: this is the normal path, not the pressure path. If the budget
    // had forced compaction, `pack.recovery` would have been deleted as a
    // duplicate and this control would prove nothing about the normal owner.
    expect(payload.pack?.recovery).toBeDefined()

    const finalState = payload.evidence?.answerability?.state
    expect(finalState).toBe('verify_targets')
    expect(payload.pack?.recovery?.final_state).toBe('verify_targets')
    expect(payload.pack?.recovery?.initial_state).toBe('verify_targets')
  })

  it('keeps every other recovery field on the published pack', async () => {
    const payload = await cliResponse({ recoveryState: 'ready' })
    expect(payload.pack?.recovery?.attempts).toEqual([])
    expect(payload.pack?.recovery?.improved).toBe(false)
    expect(payload.pack?.recovery?.budget).toBeDefined()
  })
})

describe('659 — PACK_RECOVERY_EXCEEDS_FINAL_ANSWERABILITY', () => {
  it('bounds pack.recovery by the final answer, not by any single upstream factor', async () => {
    // The final answer here is lowered by serialized coverage, with no graph
    // integrity involved at all. A cap that consulted only the integrity
    // ceiling would leave `ready` published beside a `verify_targets` answer.
    const payload = await cliResponse({ recoveryState: 'ready_with_caveat' })
    const finalState = payload.evidence?.answerability?.state as MadarAnswerabilityState

    expect(finalState).toBe('verify_targets')
    expect(payload.pack?.recovery?.final_state).toBe('verify_targets')
    expect(readinessRank(payload.pack!.recovery!.final_state as MadarAnswerabilityState))
      .toBeLessThanOrEqual(readinessRank(finalState))
  })
})

describe('659 — published channel agreement', () => {
  it('leaves no published channel more optimistic than the final answerability', async () => {
    const payload = await cliResponse({ recoveryState: 'ready' })
    const finalState = payload.evidence?.answerability?.state as MadarAnswerabilityState
    const ceiling = readinessRank(finalState)

    const channels: Array<[string, string | undefined]> = [
      ['evidence.answerability.state', payload.evidence?.answerability?.state],
      ['evidence.recovery.final_state', payload.evidence?.recovery?.final_state],
      ['evidence.recovery.initial_state', payload.evidence?.recovery?.initial_state],
      ['pack.recovery.final_state', payload.pack?.recovery?.final_state],
      ['pack.recovery.initial_state', payload.pack?.recovery?.initial_state],
    ]
    for (const [name, value] of channels) {
      if (value === undefined) continue
      expect(readinessRank(value as MadarAnswerabilityState), `${name} is more optimistic than ${finalState}`)
        .toBeLessThanOrEqual(ceiling)
    }
  })

  it('never reports ready anywhere once the final answer is lowered', async () => {
    const payload = await cliResponse({ recoveryState: 'ready' })
    expect(payload.evidence?.answerability?.state).not.toBe('ready')
    const serialized = JSON.stringify(payload)
    // The optimistic plan went in as `ready`; nothing may publish it back out.
    expect(serialized).not.toContain('"final_state":"ready"')
    expect(serialized).not.toContain('"initial_state":"ready"')
  })
})

describe('659 — normal and pressure paths independently', () => {
  it('publishes a bounded recovery answerability under pressure compaction too', async () => {
    const payload = await cliResponse({ recoveryState: 'ready', budget: 800 })
    expect(payload.serialized_budget?.enforced).toBe(true)
    // Distinct from the normal path: compaction dropped the duplicate.
    expect(payload.pack?.recovery).toBeUndefined()

    const finalState = payload.evidence?.answerability?.state as MadarAnswerabilityState
    // Under pressure the pack copy is dropped as a duplicate, so the bounded
    // value travels on `evidence.recovery`. Either way, nothing published is
    // more optimistic than the answer.
    for (const value of [
      payload.pack?.recovery?.final_state,
      payload.evidence?.recovery?.final_state,
    ]) {
      if (value === undefined) continue
      expect(readinessRank(value as MadarAnswerabilityState)).toBeLessThanOrEqual(readinessRank(finalState))
    }
    expect(JSON.stringify(payload)).not.toContain('"final_state":"ready"')
  })

  it('agrees between the two paths for the same semantic input', async () => {
    const normal = await cliResponse({ recoveryState: 'ready' })
    const pressured = await cliResponse({ recoveryState: 'ready', budget: 800 })
    const bounded = (payload: CliPayload) =>
      payload.pack?.recovery?.final_state ?? payload.evidence?.recovery?.final_state
    expect(bounded(normal)).toBe(bounded(pressured))
  })
})

describe('659 — retrieval non-regression', () => {
  it('changes nothing but the published recovery state', async () => {
    // Same retrieval, two different published recovery plans. Everything the
    // retrieval produced must be identical; only the recovery states may differ.
    const optimistic = await cliResponse({ recoveryState: 'ready' })
    const alreadyLow = await cliResponse({ recoveryState: 'insufficient' })

    expect(optimistic.pack?.matched_nodes).toEqual(alreadyLow.pack?.matched_nodes)
    expect(optimistic.pack?.relationships).toEqual(alreadyLow.pack?.relationships)
    expect(optimistic.pack?.retrieval_plan).toEqual(alreadyLow.pack?.retrieval_plan)
    expect(optimistic.evidence?.answerability?.state).toBe(alreadyLow.evidence?.answerability?.state)

    // Recovery execution metadata is untouched by the cap.
    expect(optimistic.pack?.recovery?.attempts).toEqual(alreadyLow.pack?.recovery?.attempts)
    expect(optimistic.pack?.recovery?.improved).toEqual(alreadyLow.pack?.recovery?.improved)
  })

  it('leaves an already-lower recovery exactly where it was', async () => {
    const payload = await cliResponse({ recoveryState: 'insufficient' })
    expect(payload.pack?.recovery?.final_state).toBe('insufficient')
    expect(payload.evidence?.recovery?.final_state).toBe('insufficient')
  })
})

describe('659 — MCP publication seam', () => {
  it('bounds published pack.recovery in a real stdio context_pack response', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync: write } = await import('node:fs')
    const { join: joinPath, resolve: resolvePath } = await import('node:path')
    const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')
    const { serializeGraphArtifactV2 } = await import('../../src/contracts/graph-artifact.js')
    const { buildFromJson } = await import('../../src/pipeline/build.js')

    const parent = resolvePath('out', 'test-runtime')
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(joinPath(parent, 'madar-659-mcp-'))
    write(joinPath(root, 'auth.ts'), 'export function AuthService() {\n  return new HttpClient()\n}\n', 'utf8')
    write(joinPath(root, 'client.ts'), 'export class HttpClient {\n  request() {\n    return new Transport()\n  }\n}\n', 'utf8')
    write(joinPath(root, 'transport.ts'), 'export class Transport {}\n', 'utf8')

    // The degradation is an unsupported relation, which produces a rejected
    // record carrying no verification target. That makes the receipt `degraded`
    // WITHOUT bounded targets, so the ceiling is `insufficient` -- strictly
    // below whatever retrieval's own recovery reports. Choosing a
    // missing-endpoint degradation instead would land the ceiling on
    // `verify_targets`, which is exactly where retrieval already sits, and the
    // control would hold vacuously against an uncapped implementation.
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

    const graphPath = joinPath(root, 'graph.madar')
    write(graphPath, serializeGraphArtifactV2({
      graph,
      repositoryRevision: 'rev-659-mcp',
      generationMode: 'full',
      generatedAt: '2026-08-30T00:00:00.000Z',
    }))

    // context_pack lives in the bounded strict profile.
    const previousProfile = process.env.MADAR_TOOL_PROFILE
    process.env.MADAR_TOOL_PROFILE = 'strict'
    let response
    try {
      response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          // The strict profile accepts only prompt and task.
          arguments: { prompt: 'How does AuthService reach Transport?', task: 'explain' },
        },
      }, {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }))
    } finally {
      if (previousProfile === undefined) delete process.env.MADAR_TOOL_PROFILE
      else process.env.MADAR_TOOL_PROFILE = previousProfile
    }

    const text = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text
    expect(text, JSON.stringify(response)).toBeTruthy()
    const payload = JSON.parse(text!) as CliPayload & { evidence?: { graph_integrity?: { status?: string } } }

    // The probe: integrity was read through the MCP path and did cap the answer.
    expect(payload.evidence?.graph_integrity?.status).toBe('degraded')
    const finalState = payload.evidence?.answerability?.state as MadarAnswerabilityState
    expect(finalState).toBe('insufficient')
    // The duplicate really is published on this path, so the assertion below
    // has something to bind.
    expect(payload.pack?.recovery).toBeDefined()

    for (const [name, value] of [
      ['pack.recovery.final_state', payload.pack?.recovery?.final_state],
      ['pack.recovery.initial_state', payload.pack?.recovery?.initial_state],
      ['evidence.recovery.final_state', payload.evidence?.recovery?.final_state],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) continue
      expect(readinessRank(value as MadarAnswerabilityState), `${name} exceeds ${finalState}`)
        .toBeLessThanOrEqual(readinessRank(finalState))
    }
  })
})
