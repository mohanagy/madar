import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'
import { describe, expect, it, vi } from 'vitest'

import type {
  HydratedEntity, HydratedEvidenceResult, HydratedExcerpt, HydratedFile,
  HydratedProof, WorkflowSelection,
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

import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'

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
    controls: new Map(),
    excerpts: new Map([[
      'report-declaration',
      ['x0', 'f0', range, 'b'.repeat(64), 'export function report() {}'] as const,
    ]]),
    proofs: new Map([['symbol:report', ['p0', 'declaration', 'e0', 'x0'] as const]]),
    entities: new Map([[
      'symbol:report', ['e0', 'symbol', 'report()', 'function', 'f0'] as const,
    ]]),
  }
}

function oversizedHydration(fileCount: number, excerptCount: number): HydratedEvidenceResult {
  const files = new Map<string, HydratedFile>()
  for (let index = 0; index < fileCount; index += 1) {
    files.set(
      index === 0 ? 'report.ts' : `extra-${index}.ts`,
      [`f${index}`, index.toString(16).padStart(64, '0')],
    )
  }
  const excerpts = new Map<string, HydratedExcerpt>()
  for (let index = 0; index < excerptCount; index += 1) {
    excerpts.set(`excerpt:${index}`, [
      `x${index}`, 'f0', range, index.toString(16).padStart(64, '0'),
      `export const evidence${index} = ${index}`,
    ])
  }
  return {
    state: 'ready', files, controls: new Map(), excerpts,
    proofs: new Map([[
      'symbol:report', ['p0', 'declaration', 'e0', 'x0'] as const,
    ]]),
    entities: new Map([[
      'symbol:report', ['e0', 'symbol', 'report()', 'function', 'f0'] as const,
    ]]),
  }
}

function wrapperSelection(withParallelPublisher: boolean): WorkflowSelection {
  const edges = [
    { id: 'call', fromId: 'entry', toId: 'wrapper', relation: 'calls' as const },
    { id: 'wrapper-publish', fromId: 'wrapper', toId: 'queue', relation: 'publishes_to' as const },
    { id: 'consume', fromId: 'queue', toId: 'terminal', relation: 'consumed_by' as const },
    ...(withParallelPublisher ? [{
      id: 'entry-publish', fromId: 'entry', toId: 'queue',
      relation: 'publishes_to' as const,
    }] : []),
  ]
  return {
    complete: true,
    symbolIds: ['entry', 'wrapper', 'terminal', 'queue'], operationIds: [],
    rootSymbolIds: ['entry'], terminalSymbolIds: ['terminal'], edges,
    links: [
      {
        fromId: 'entry', toId: 'wrapper', kind: 'direct',
        edgeIds: ['call'], operationIds: [],
      },
      {
        fromId: 'wrapper', toId: 'terminal', kind: 'channel',
        edgeIds: ['wrapper-publish', 'consume'], operationIds: [],
      },
      ...(withParallelPublisher ? [{
        fromId: 'entry', toId: 'terminal', kind: 'channel' as const,
        edgeIds: ['entry-publish', 'consume'], operationIds: [],
      }] : []),
    ],
    controlGroups: [],
    obligations: [{
      id: 'o1', kind: 'handoff', target: 'report handoff', mandatory: true,
      proven: true, symbolIds: ['entry', 'wrapper', 'terminal'], operationIds: [],
      edgeIds: edges.map(({ id }) => id),
    }],
    missing: [], metrics: { ...metrics, causalRelationHops: edges.length },
  }
}

function wrapperHydration(withParallelPublisher: boolean): HydratedEvidenceResult {
  const proofs = new Map<string, HydratedProof>([
    ['call', ['p0', 'edge', 'e0', 'e1', 'calls', 'x0']],
    ['wrapper-publish', [
      'p1', 'edge_range', 'e1', 'e3', 'publishes_to', 'f0', range,
    ]],
    ['consume', ['p2', 'edge_range', 'e3', 'e2', 'consumed_by', 'f0', range]],
  ])
  if (withParallelPublisher) proofs.set('entry-publish', [
    'p3', 'edge_range', 'e0', 'e3', 'publishes_to', 'f0', range,
  ])
  const entities = new Map<string, HydratedEntity>([
    ['entry', ['e0', 'symbol', 'generateReport()', 'function', 'f0']],
    ['wrapper', ['e1', 'symbol', 'enqueueReport()', 'function', 'f0']],
    ['terminal', ['e2', 'symbol', 'persistReport()', 'function', 'f0']],
    ['queue', ['e3', 'channel', 'queue', 'bullmq', 'reports', undefined, undefined]],
  ])
  return {
    state: 'ready',
    files: new Map([['report.ts', ['f0', 'a'.repeat(64)] as const]]),
    controls: new Map(), entities, proofs,
    excerpts: new Map([[
      'call', ['x0', 'f0', range, 'b'.repeat(64), 'return enqueueReport()'] as const,
    ]]),
  }
}

describe('retrieve dossier eviction failures', () => {
  it.each([
    ['files', 13, 0, 'required_file_limit', 13, 12],
    ['excerpts', 1, 26, 'required_excerpt_limit', 26, 25],
  ] as const)('fails closed when authenticated %s exceed the table cap', (
    _kind, fileCount, excerptCount, code, required, limit,
  ) => {
    mocks.selection = selection()
    mocks.hydration = oversizedHydration(fileCount, excerptCount)

    const result = retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })

    expect(result).toMatchObject({
      state: 'incomplete',
      missing: [{ code, required, limit }],
    })
    expect(result).not.toHaveProperty('dossier')
  })

  it('reports the full ready dossier token count without returning a partial dossier', () => {
    mocks.selection = selection()
    mocks.hydration = hydratedReport()
    const full = retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 4_000,
    })
    expect(full.state).toBe('ready')
    if (full.state !== 'ready') return

    const constrained = retrieveContext({ state: 'ready' } as never, {
      question: 'Where is report defined?', budget: 256,
    })

    expect(constrained).toMatchObject({
      state: 'incomplete',
      missing: [{
        code: 'required_token_budget',
        required: expect.any(Number),
        limit: 256,
      }],
    })
    expect(constrained).not.toHaveProperty('dossier')
    if (constrained.state !== 'incomplete') return
    const required = constrained.missing[0]?.required
    expect(required).toBeTypeOf('number')
    const fullAtLimit = structuredClone(full)
    fullAtLimit.metrics.budget_tokens = 256
    fullAtLimit.metrics.serialized_tokens = required!
    expect(countTokens(serializeRetrieveContextResult(fullAtLimit))).toBe(required)
    expect(required).toBeGreaterThan(256)
  })

  it('returns required_proof_missing when a required declaration proof is evicted', () => {
    mocks.selection = selection()
    mocks.hydration = {
      state: 'ready',
      files: new Map([['report.ts', ['f0', 'a'.repeat(64)] as const]]),
      controls: new Map(), excerpts: new Map(), proofs: new Map(),
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
      state: 'ready', files: new Map(), controls: new Map(), excerpts: new Map(),
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
      state: 'ready', files: new Map(), controls: new Map(), excerpts: new Map(),
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

  it('folds only a sole wrapper channel and preserves its complete proof chain', () => {
    mocks.selection = wrapperSelection(false)
    mocks.hydration = wrapperHydration(false)

    const result = retrieveContext({ state: 'ready' } as never, {
      question: 'How does the report handoff work?', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.dossier.flow.links).toEqual([{
      id: 'l1', kind: 'channel', from: 'e0', to: 'e2',
      proofs: ['p0', 'p1', 'p2'],
    }])
    expect(result.dossier.evidence.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'e1', kind: 'symbol' }),
      expect.objectContaining({ id: 'e3', kind: 'channel' }),
    ]))
  })

  it('does not fold a wrapper channel beside a direct parallel publisher', () => {
    mocks.selection = wrapperSelection(true)
    mocks.hydration = wrapperHydration(true)

    const result = retrieveContext({ state: 'ready' } as never, {
      question: 'How does the report handoff work?', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.dossier.flow.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'direct', from: 'e0', to: 'e1' }),
      expect.objectContaining({ kind: 'channel', from: 'e1', to: 'e2' }),
      expect.objectContaining({ kind: 'channel', from: 'e0', to: 'e2' }),
    ]))
    expect(result.dossier.flow.links).toHaveLength(3)
  })

})
