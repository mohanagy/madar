import { describe, expect, it, vi } from 'vitest'

import type {
  HydratedEvidenceResult, WorkflowSelection,
} from '../../src/domain/query/types.js'

const mocks = vi.hoisted(() => ({
  hydration: null as HydratedEvidenceResult | null,
  selection: null as WorkflowSelection | null,
}))

vi.mock('../../src/application/evidence-hydrator.js', () => ({
  hydrateEvidence: () => mocks.hydration,
}))
vi.mock('../../src/domain/query/workflow.js', () => ({
  selectWorkflow: () => mocks.selection,
}))

import { retrieveContext } from '../../src/application/retrieve-context.js'

const range = {
  start: { line: 1, column: 1 }, end: { line: 1, column: 20 },
}
const metrics = {
  candidateCount: 1, rootCandidateCount: 1, actualNodeCount: 1,
  causalRelationHops: 0, recoveryPasses: 0 as const,
  recoveryFrontierCount: 0, bounded: false,
}
const obligation = {
  id: 'o1' as const, kind: 'subject' as const, target: 'report', mandatory: true,
  proven: true, symbolIds: ['symbol:report'], operationIds: [], edgeIds: [],
}

function selection(): WorkflowSelection {
  return {
    complete: true, symbolIds: ['symbol:report'], operationIds: [],
    rootSymbolIds: ['symbol:report'], terminalSymbolIds: [], edges: [], links: [],
    controlGroups: [], obligations: [obligation], missing: [], metrics,
  }
}

function hydratedReport(): HydratedEvidenceResult {
  return {
    state: 'ready',
    files: new Map([['report.ts', ['f0', 'a'.repeat(64)] as const]]),
    excerpts: new Map(),
    proofs: new Map([['symbol:report', ['p0', 'declaration', 'e0', 'x0'] as const]]),
    entities: new Map([[
      'symbol:report', ['e0', 'symbol', 'report()', 'function', 'f0'] as const,
    ]]),
  }
}

describe('retrieve dossier eviction failures', () => {
  it('returns required_proof_missing when a required declaration proof is evicted', () => {
    mocks.selection = selection()
    mocks.hydration = {
      state: 'ready',
      files: new Map([['report.ts', ['f0', 'a'.repeat(64)] as const]]),
      excerpts: new Map(), proofs: new Map(),
      entities: new Map([[
        'symbol:report', ['e0', 'symbol', 'report()', 'function', 'f0'] as const,
      ]]),
    }

    expect(retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })).toMatchObject({
      state: 'incomplete',
      missing: [{ code: 'required_proof_missing', obligation_id: 'o1', target: 'report' }],
      metrics: { required_obligations: 1, proven_obligations: 0 },
    })
  })

  it('returns required_reference_missing when a channel parent is evicted', () => {
    mocks.selection = selection()
    mocks.hydration = {
      state: 'ready', files: new Map(), excerpts: new Map(), proofs: new Map(),
      entities: new Map([[
        'channel:job',
        ['e0', 'channel', 'job', 'bullmq', 'assemble', 'channel:missing', undefined] as const,
      ]]),
    }

    expect(retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })).toMatchObject({
      state: 'incomplete',
      missing: [{ code: 'required_reference_missing', target: 'channel:missing' }],
      metrics: { required_obligations: 1, proven_obligations: 0 },
    })
  })

  it('keeps every bounded missing-obligation identity at the minimum budget', () => {
    mocks.selection = {
      ...selection(), complete: false,
      missing: Array.from({ length: 7 }, (_, index) => ({
        code: 'behavior_unproven' as const,
        obligationId: `o${index}`,
        target: `symbol:${index}:${'x'.repeat(256)}`,
      })),
    }
    mocks.hydration = {
      state: 'ready', files: new Map(), excerpts: new Map(),
      entities: new Map(), proofs: new Map(),
    }

    const result = retrieveContext({ state: 'ready' } as never, {
      question: 'How does report work?', budget: 256,
    })
    expect(result.state).toBe('incomplete')
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(256)
    if (result.state !== 'incomplete') return
    expect(result.missing).toEqual(Array.from({ length: 7 }, (_, index) => ({
      code: 'behavior_unproven', obligation_id: `o${index}`,
    })))
  })

  it('returns corrupt when forged terminal diagnostics cannot fit the minimum budget', () => {
    mocks.selection = {
      ...selection(), complete: false,
      missing: Array.from({ length: 500 }, (_, index) => ({
        code: 'behavior_unproven' as const,
        obligationId: `o${index}`,
        target: `symbol:${index}:${'x'.repeat(256)}`,
      })),
    }
    mocks.hydration = {
      state: 'ready', files: new Map(), excerpts: new Map(),
      entities: new Map(), proofs: new Map(),
    }

    const result = retrieveContext({ state: 'ready' } as never, {
      question: 'How does report work?', budget: 256,
    })

    expect(result).toMatchObject({
      state: 'corrupt',
      failures: [{ state: 'corrupt', subject: 'terminal result budget' }],
      metrics: { serialized_tokens: expect.any(Number) },
    })
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(256)
  })

  it('returns corrupt for a forged control-group controller', () => {
    mocks.selection = {
      ...selection(),
      controlGroups: [{
        kind: 'branch', controllerOperationId: 'operation:forged',
        operationIds: [], symbolIds: ['symbol:report'],
      }],
    }
    mocks.hydration = hydratedReport()

    expect(retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })).toMatchObject({
      state: 'corrupt',
      failures: [{ state: 'corrupt', subject: 'operation:forged' }],
    })
  })

  it('returns corrupt for an unselected root or control-group member', () => {
    mocks.hydration = hydratedReport()
    for (const candidate of [
      { ...selection(), rootSymbolIds: ['symbol:missing'] },
      {
        ...selection(), controlGroups: [{
          kind: 'branch' as const, operationIds: [], symbolIds: ['symbol:missing'],
        }],
      },
    ]) {
      mocks.selection = candidate
      expect(retrieveContext({ state: 'ready' } as never, {
        question: 'Where is report defined?', budget: 4_000,
      })).toMatchObject({
        state: 'corrupt',
        failures: [{ state: 'corrupt', subject: 'symbol:missing' }],
      })
    }
  })

  it.each([
    ['symbolIds', { symbolIds: ['symbol:missing'] }],
    ['operationIds', { operationIds: ['operation:missing'] }],
    ['edgeIds', { edgeIds: ['edge:missing'] }],
  ] as const)('returns corrupt for missing obligation %s', (_field, reference) => {
    mocks.selection = {
      ...selection(), obligations: [{ ...obligation, ...reference }],
    }
    mocks.hydration = hydratedReport()

    const target = Object.values(reference)[0]![0]!
    expect(retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })).toMatchObject({
      state: 'corrupt', failures: [{ state: 'corrupt', subject: target }],
    })
  })
})
