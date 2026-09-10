import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  estimateRetrieveEntryTokens,
  withRetrieveSnippetBudget,
  type CompactRetrieveResult,
  type RetrieveRelationship,
  type RetrieveResult,
  type RetrieveSnippetOptions,
} from '../../src/runtime/retrieve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import * as retrieveRuntime from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

const firstEight = [0, 1, 2, 3, 4, 5, 6, 7]

function makeResult(count = 12, question = 'explain the allocation'): RetrieveResult {
  const matchedNodes: RetrieveResult['matched_nodes'] = Array.from({ length: count }, (_, index) => ({
    node_id: `node-${index}`,
    label: `Node${index}.run()`,
    source_file: `/src/node-${index}.ts`,
    line_number: index + 1,
    node_kind: 'function',
    file_type: 'code',
    snippet: `export function node${index}() { return ${index} }`,
    snippet_line_number: index + 1,
    snippet_scope: 'symbol',
    match_score: count - index,
    relevance_band: index === 0 ? 'direct' : 'related',
    community: 0,
    community_label: 'allocation',
  }))

  return {
    question,
    token_count: matchedNodes.reduce(
      (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
      0,
    ),
    matched_nodes: matchedNodes,
    relationships: [],
    community_context: [{ id: 0, label: 'allocation', node_count: count }],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
  }
}

function call(result: RetrieveResult, fromIndex: number, toIndex: number): RetrieveRelationship {
  const fromNode = result.matched_nodes[fromIndex]!
  const toNode = result.matched_nodes[toIndex]!
  return {
    from_id: fromNode.node_id!,
    from: fromNode.label,
    to_id: toNode.node_id!,
    to: toNode.label,
    relation: 'calls',
  }
}

function snippetIndexes(result: Pick<CompactRetrieveResult, 'matched_nodes'> | RetrieveResult): number[] {
  return result.matched_nodes.flatMap((node, index) => (
    typeof node.snippet === 'string' && node.snippet.trim().length > 0 ? [index] : []
  ))
}

function snippetTokens(result: Pick<CompactRetrieveResult, 'matched_nodes'>): number {
  return result.matched_nodes.reduce((total, node) => (
    total + (typeof node.snippet === 'string' && node.snippet.trim().length > 0
      ? estimateQueryTokens(node.snippet)
      : 0)
  ), 0)
}

function matchedNodeTokens(result: Pick<CompactRetrieveResult, 'matched_nodes'>): number {
  return result.matched_nodes.reduce(
    (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
    0,
  )
}

interface AllocationCase {
  name: string
  edges: Array<readonly [number, number]>
  expected: number[]
}

const allocationCases: AllocationCase[] = [
  {
    name: 'zero usable relationships preserves the positional fallback',
    edges: [],
    expected: firstEight,
  },
  {
    name: 'one preferred self-call consumes one position',
    edges: [[8, 8]],
    expected: [0, 1, 2, 3, 4, 5, 6, 8],
  },
  {
    name: 'endpoints before, at, and after the eighth position form a stable union',
    edges: [[7, 9], [0, 7]],
    expected: [0, 1, 2, 3, 4, 5, 7, 9],
  },
  {
    name: 'exactly eight preferred nodes use node order rather than edge order',
    edges: [[10, 9], [8, 7], [5, 4], [2, 1]],
    expected: [1, 2, 4, 5, 7, 8, 9, 10],
  },
  {
    name: 'more than eight preferred nodes are capped with stable node-order ties',
    edges: [[10, 9], [8, 7], [6, 5], [4, 3], [2, 1]],
    expected: [1, 2, 3, 4, 5, 6, 7, 8],
  },
]

it.each(allocationCases)('A1 uses a bounded, stable preferred union: $name', ({ edges, expected }) => {
  const result = makeResult()
  result.relationships = edges.map(([fromIndex, toIndex]) => call(result, fromIndex, toIndex))
  result.matched_nodes[1] = {
    ...result.matched_nodes[1]!,
    label: 'A name that sorts after every other name',
    snippet: 'identical source text is not a ranking key',
  }
  result.matched_nodes[10] = {
    ...result.matched_nodes[10]!,
    label: 'A name that sorts before every other name',
    snippet: 'identical source text is not a ranking key',
  }

  const compact = compactRetrieveResult(result, { snippetBudget: 100_000 })

  expect(compact.matched_nodes.map((node) => node.node_id)).toEqual(
    result.matched_nodes.map((node) => node.node_id),
  )
  expect(snippetIndexes(compact)).toEqual(expected)
})

it('A2 resolves same-label nodes by exact distinct IDs and does not normalize IDs', () => {
  const result = makeResult(10)
  result.matched_nodes[8] = { ...result.matched_nodes[8]!, label: 'Shared.run()' }
  result.matched_nodes[9] = { ...result.matched_nodes[9]!, label: 'Shared.run()' }
  result.relationships = [call(result, 8, 9)]

  const sameLabel = compactRetrieveResult(result, { snippetBudget: 100_000 })
  expect(snippetIndexes(sameLabel)).toEqual([0, 1, 2, 3, 4, 5, 8, 9])

  const spaced = makeResult(10)
  spaced.matched_nodes[8] = { ...spaced.matched_nodes[8]!, node_id: ' node-8 ' }
  spaced.relationships = [call(spaced, 8, 9)]
  expect(snippetIndexes(compactRetrieveResult(spaced, { snippetBudget: 100_000 }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])

  spaced.relationships = [{
    ...call(spaced, 8, 9),
    from_id: 'node-8',
  }]
  expect(snippetIndexes(compactRetrieveResult(spaced, { snippetBudget: 100_000 }))).toEqual(firstEight)
})

it.each([
  {
    name: 'duplicate node IDs are ambiguous',
    arrange: (result: RetrieveResult): void => {
      result.matched_nodes[8] = { ...result.matched_nodes[8]!, node_id: 'duplicate' }
      result.matched_nodes[9] = { ...result.matched_nodes[9]!, node_id: 'duplicate' }
      result.relationships = [{
        from_id: 'duplicate',
        from: result.matched_nodes[8]!.label,
        to_id: result.matched_nodes[0]!.node_id!,
        to: result.matched_nodes[0]!.label,
        relation: 'calls',
      }]
    },
  },
  {
    name: 'label-only edges have no explicit identities',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{
        from: result.matched_nodes[8]!.label,
        to: result.matched_nodes[9]!.label,
        relation: 'calls',
      }]
    },
  },
  {
    name: 'empty endpoint IDs are invalid',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{ ...call(result, 8, 9), from_id: '' }]
    },
  },
  {
    name: 'whitespace endpoint IDs are invalid',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{ ...call(result, 8, 9), to_id: '   ' }]
    },
  },
  {
    name: 'one missing endpoint ID is invalid',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{
        from_id: result.matched_nodes[8]!.node_id!,
        from: result.matched_nodes[8]!.label,
        to: result.matched_nodes[9]!.label,
        relation: 'calls',
      }]
    },
  },
  {
    name: 'dangling endpoint IDs do not resolve',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{ ...call(result, 8, 9), to_id: 'not-retained' }]
    },
  },
  {
    name: 'non-calls relationships are not usable',
    arrange: (result: RetrieveResult): void => {
      result.relationships = [{ ...call(result, 8, 9), relation: 'imports' }]
    },
  },
])('A2 rejects identities that cannot unambiguously resolve: $name', ({ arrange }) => {
  const result = makeResult(10)
  arrange(result)

  expect(snippetIndexes(compactRetrieveResult(result, { snippetBudget: 100_000 }))).toEqual(firstEight)
})

it('A2 duplicate edges cannot consume additional eligibility positions', () => {
  const result = makeResult(10)
  const relationship = call(result, 8, 9)
  result.relationships = [relationship, { ...relationship }, { ...relationship }]

  expect(snippetIndexes(compactRetrieveResult(result, { snippetBudget: 100_000 }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])
})

it.each([null, '', '   '] as const)(
  'A3 rejects a call when either endpoint has a non-source snippet: %j',
  (missingSnippet) => {
    const result = makeResult(10)
    result.matched_nodes[8] = { ...result.matched_nodes[8]!, snippet: missingSnippet }
    result.relationships = [call(result, 8, 9)]

    const compact = compactRetrieveResult(result, { snippetBudget: 100_000 })

    expect(snippetIndexes(compact)).toEqual(firstEight)
    expect(compact.matched_nodes[8]).toEqual(expect.objectContaining({
      snippet: null,
      snippet_truncated: false,
    }))
    expect(compact.matched_nodes[9]).toEqual(expect.objectContaining({
      snippet: null,
      snippet_truncated: false,
    }))
  },
)

it('A3 preserves missing-source positional slots and does not merge repeated source text', () => {
  const fallback = makeResult(10)
  fallback.matched_nodes[0] = { ...fallback.matched_nodes[0]!, snippet: null }
  const fallbackCompact = compactRetrieveResult(fallback, { snippetBudget: 100_000 })
  expect(snippetIndexes(fallbackCompact)).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(fallbackCompact.matched_nodes[8]?.snippet).toBeNull()

  const repeated = makeResult(10)
  repeated.matched_nodes[8] = { ...repeated.matched_nodes[8]!, snippet: 'shared source text' }
  repeated.matched_nodes[9] = { ...repeated.matched_nodes[9]!, snippet: 'shared source text' }
  repeated.relationships = [call(repeated, 8, 9)]

  const repeatedCompact = compactRetrieveResult(repeated, { snippetBudget: 100_000 })
  expect(repeatedCompact.matched_nodes[8]?.snippet).toBe('shared source text')
  expect(repeatedCompact.matched_nodes[9]?.snippet).toBe('shared source text')
})

it('A4 distinguishes omitted defaults from every explicit native top-N control', () => {
  const result = makeResult(10)
  result.relationships = [call(result, 8, 9)]
  const expectedDefault = [0, 1, 2, 3, 4, 5, 8, 9]

  const defaultCalls = [
    compactRetrieveResult(result),
    compactRetrieveResult(result, {}),
    compactRetrieveResult(result, { snippetBudget: 100_000 }),
    compactRetrieveResult(result, {
      snippetBudget: 100_000,
      topNWithSnippet: undefined,
    } as unknown as RetrieveSnippetOptions),
  ]
  for (const compact of defaultCalls) {
    expect(snippetIndexes(compact)).toEqual(expectedDefault)
  }

  const inheritedFinite = Object.assign(
    Object.create({ topNWithSnippet: 2 }) as object,
    { snippetBudget: 100_000 },
  ) as RetrieveSnippetOptions
  const inheritedUndefined = Object.assign(
    Object.create({ topNWithSnippet: undefined }) as object,
    { snippetBudget: 100_000 },
  ) as RetrieveSnippetOptions
  expect(snippetIndexes(compactRetrieveResult(result, inheritedFinite))).toEqual([0, 1])
  expect(snippetIndexes(compactRetrieveResult(result, inheritedUndefined))).toEqual(expectedDefault)

  const explicitCases: Array<{ name: string; value: unknown; expected: number[] }> = [
    { name: 'eight', value: 8, expected: firstEight },
    { name: 'zero', value: 0, expected: [] },
    { name: 'two', value: 2, expected: [0, 1] },
    { name: 'fractional', value: 2.9, expected: [0, 1] },
    { name: 'negative', value: -2, expected: [] },
    { name: 'NaN', value: Number.NaN, expected: firstEight },
    { name: 'positive infinity', value: Number.POSITIVE_INFINITY, expected: firstEight },
    { name: 'negative infinity', value: Number.NEGATIVE_INFINITY, expected: firstEight },
    { name: 'out-of-type string', value: '2', expected: firstEight },
  ]

  for (const { name, value, expected } of explicitCases) {
    const compact = compactRetrieveResult(result, {
      snippetBudget: 100_000,
      topNWithSnippet: value as number,
    })
    expect(snippetIndexes(compact), name).toEqual(expected)
  }
})

interface StdioEnvelope {
  result?: { content?: Array<{ text?: string }> }
  error?: { code?: number; message?: string }
}

function parseStdioPayload(response: unknown): CompactRetrieveResult {
  const text = (response as StdioEnvelope).result?.content?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error('retrieve stdio response did not contain text')
  }
  return JSON.parse(text) as CompactRetrieveResult
}

function createGraphPath(): { graphPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-snippet-allocation-'))
  const out = join(root, 'out')
  mkdirSync(out)
  const graphPath = join(out, 'graph.json')
  writeFileSync(graphPath, JSON.stringify({
    directed: true,
    root_path: root,
    nodes: [],
    edges: [],
    hyperedges: [],
  }), 'utf8')
  return { graphPath, root }
}

it('A4 validates both stdio aliases and forwards valid explicit controls positionally', async () => {
  const { graphPath, root } = createGraphPath()
  const result = makeResult(10)
  result.relationships = [call(result, 8, 9)]
  const previousToolProfile = process.env.MADAR_TOOL_PROFILE
  process.env.MADAR_TOOL_PROFILE = 'full'
  vi.spyOn(retrieveRuntime, 'retrieveContext').mockImplementation(() => result as never)

  const request = async (id: number, toolArguments: Record<string, unknown>): Promise<unknown> => (
    Promise.resolve(handleStdioRequest(graphPath, {
      id,
      method: 'tools/call',
      params: {
        name: 'retrieve',
        arguments: { question: result.question, budget: 1_000, ...toolArguments },
      },
    }))
  )

  try {
    const omitted = parseStdioPayload(await request(1, { snippet_budget: 100_000 }))
    expect(snippetIndexes(omitted)).toEqual([0, 1, 2, 3, 4, 5, 8, 9])

    const snakeCase = parseStdioPayload(await request(2, {
      snippet_budget: 100_000,
      top_n_with_snippet: 2,
    }))
    expect(snippetIndexes(snakeCase)).toEqual([0, 1])

    const camelCase = parseStdioPayload(await request(3, {
      snippet_budget: 100_000,
      topNWithSnippet: 2.9,
    }))
    expect(snippetIndexes(camelCase)).toEqual([0, 1])

    const snakePreferred = parseStdioPayload(await request(4, {
      snippet_budget: 100_000,
      top_n_with_snippet: 2,
      topNWithSnippet: 4,
    }))
    expect(snippetIndexes(snakePreferred)).toEqual([0, 1])
    const camelFallback = parseStdioPayload(await request(5, {
      snippet_budget: 100_000,
      top_n_with_snippet: 'invalid',
      topNWithSnippet: 2,
    }))
    expect(snippetIndexes(camelFallback)).toEqual([0, 1])

    const invalidCases: Array<Record<string, unknown>> = [
      { top_n_with_snippet: '2' },
      { topNWithSnippet: -1 },
      { top_n_with_snippet: Number.NaN },
      { topNWithSnippet: Number.POSITIVE_INFINITY },
      { top_n_with_snippet: undefined },
    ]
    for (const [index, invalidArguments] of invalidCases.entries()) {
      const response = await request(10 + index, invalidArguments) as StdioEnvelope
      expect(response.error).toEqual(expect.objectContaining({
        code: -32602,
        message: 'top_n_with_snippet must be a non-negative number',
      }))
    }
  } finally {
    if (previousToolProfile === undefined) {
      delete process.env.MADAR_TOOL_PROFILE
    } else {
      process.env.MADAR_TOOL_PROFILE = previousToolProfile
    }
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  }
})

describe('A5 allocator budgets and accounting', () => {
  it.each(['zero', 'tiny', 'exact-fit', 'ample'] as const)(
    'keeps original-order spending, counters, attribution, and truncation for %s budgets',
    (budgetKind) => {
      const result = makeResult(10)
      result.matched_nodes = result.matched_nodes.map((node, index) => ({
        ...node,
        snippet: `function node${index}() {\n  return '${'word '.repeat(30).trim()}'\n}`,
      }))
      result.relationships = [call(result, 8, 8)]
      result.token_count = result.matched_nodes.reduce(
        (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
        0,
      )

      const eligible = [0, 1, 2, 3, 4, 5, 6, 8]
      const exactFit = eligible.reduce(
        (total, index) => total + estimateQueryTokens(result.matched_nodes[index]!.snippet!),
        0,
      )
      const budget = budgetKind === 'zero'
        ? 0
        : budgetKind === 'tiny'
          ? 1
          : budgetKind === 'exact-fit'
            ? exactFit
            : exactFit + 25

      const full = compactRetrieveResult(result, {
        snippetBudget: 1_000_000,
        topNWithSnippet: 100,
      })
      const compact = compactRetrieveResult(result, { snippetBudget: budget })
      const actualSnippetTokens = snippetTokens(compact)

      expect(actualSnippetTokens).toBeLessThanOrEqual(budget)
      expect(compact.snippet_budget_tokens_used).toBe(actualSnippetTokens)
      expect(compact.snippet_budget_tokens_remaining).toBe(budget - actualSnippetTokens)
      expect(compact.token_count).toBe(
        full.token_count - matchedNodeTokens(full) + matchedNodeTokens(compact),
      )
      expect(compact.matched_nodes.map((node) => ({
        node_id: node.node_id,
        source_file: node.source_file,
        line_number: node.line_number,
        snippet_line_number: node.snippet_line_number,
        snippet_scope: node.snippet_scope,
      }))).toEqual(result.matched_nodes.map((node) => ({
        node_id: node.node_id,
        source_file: node.source_file,
        line_number: node.line_number,
        snippet_line_number: node.snippet_line_number,
        snippet_scope: node.snippet_scope,
      })))
      expect(compact.matched_nodes[7]).toEqual(expect.objectContaining({
        snippet: null,
        snippet_truncated: false,
      }))

      if (budgetKind === 'zero') {
        expect(snippetIndexes(compact)).toEqual([])
        expect(compact.matched_nodes[0]?.snippet_truncated).toBe(true)
        expect(compact.matched_nodes[8]?.snippet_truncated).toBe(true)
      } else if (budgetKind === 'tiny') {
        expect(compact.matched_nodes[0]?.snippet_truncated).toBe(true)
        expect(compact.matched_nodes[8]).toEqual(expect.objectContaining({
          snippet: null,
          snippet_truncated: true,
        }))
      } else {
        expect(snippetIndexes(compact)).toEqual(eligible)
        for (const index of eligible) {
          expect(compact.matched_nodes[index]?.snippet_truncated).toBe(false)
        }
      }
    },
  )
})

function sliceMetadata(anchors: unknown[]): NonNullable<RetrieveResult['slice']> {
  return { anchors, selected_paths: [] } as unknown as NonNullable<RetrieveResult['slice']>
}

it('A6 keeps ordinary compact defaults distinct from verbose and non-promoted slice metadata', () => {
  const ordinary = makeResult(10, 'trace how these functions execute')
  ordinary.relationships = [call(ordinary, 8, 9)]

  expect(snippetIndexes(compactRetrieveResult(ordinary, { snippetBudget: 100_000 }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])
  expect(snippetIndexes(withRetrieveSnippetBudget(ordinary, { snippetBudget: 100_000 }))).toEqual(firstEight)

  const strategyOnly = { ...ordinary, retrieval_strategy: 'slice-v1' as const }
  expect(snippetIndexes(compactRetrieveResult(strategyOnly, { snippetBudget: 100_000 }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])

  const metadataWithoutPromotion: RetrieveResult = {
    ...strategyOnly,
    slice: sliceMetadata([{
      node_id: ordinary.matched_nodes[0]!.node_id,
      label: ordinary.matched_nodes[0]!.label,
      reason: 'related path',
    }]),
  }
  expect(snippetIndexes(compactRetrieveResult(metadataWithoutPromotion, { snippetBudget: 100_000 }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])

  const executionSliceObjectOnly: RetrieveResult = {
    ...strategyOnly,
    execution_slice: {
      status: 'complete',
      steps: [],
    },
  }
  expect(snippetIndexes(compactRetrieveResult(executionSliceObjectOnly, {
    snippetBudget: 100_000,
  }))).toEqual([
    0, 1, 2, 3, 4, 5, 8, 9,
  ])
})

it('A6 leaves actual promoted ID and label branches positional', () => {
  const question = 'Trace the runtime request pipeline through Node0.run()'
  const promotedById = makeResult(10, question)
  promotedById.retrieval_strategy = 'slice-v1'
  promotedById.matched_nodes = promotedById.matched_nodes.map((node) => ({
    ...node,
    relevance_band: 'direct',
  }))
  promotedById.relationships = [call(promotedById, 8, 9)]
  promotedById.slice = sliceMetadata([{
    node_id: promotedById.matched_nodes[0]!.node_id,
    label: promotedById.matched_nodes[0]!.label,
    reason: 'symbol mention',
  }])

  const idCompact = compactRetrieveResult(promotedById, { snippetBudget: 100_000 })
  expect(idCompact.matched_nodes.map((node) => node.node_id)).toEqual(
    promotedById.matched_nodes.map((node) => node.node_id),
  )
  expect(snippetIndexes(idCompact)).toEqual(firstEight)

  const promotedByLabel = makeResult(10, question)
  promotedByLabel.retrieval_strategy = 'slice-v1'
  promotedByLabel.matched_nodes = promotedByLabel.matched_nodes.map((node) => ({
    ...node,
    relevance_band: 'related',
  }))
  promotedByLabel.relationships = [call(promotedByLabel, 8, 9)]
  promotedByLabel.slice = sliceMetadata(promotedByLabel.matched_nodes.map((node) => ({
    label: node.label,
    reason: 'symbol mention',
  })))

  const labelCompact = compactRetrieveResult(promotedByLabel, { snippetBudget: 100_000 })
  expect(labelCompact.matched_nodes.map((node) => node.label)).toEqual(
    promotedByLabel.matched_nodes.map((node) => node.label),
  )
  expect(snippetIndexes(labelCompact)).toEqual(firstEight)
})

it('A7 preserves claim support and relationship endpoints when stdio pressure selects a stricter profile', () => {
  const result = makeResult(48)
  result.matched_nodes = result.matched_nodes.map((node, index) => ({
    ...node,
    snippet: `export function pressureNode${index}() { return '${'payload '.repeat(30).trim()}' }`,
  }))
  result.relationships = Array.from({ length: 47 }, (_, index) => call(result, index, index + 1))
  result.claims = Array.from({ length: 24 }, (_, index) => {
    const node = result.matched_nodes[index + 12]!
    return {
      evidence_class: 'primary' as const,
      text: `${node.label} supports pressure claim ${index}`,
      node_labels: [node.label],
    }
  })

  const compact = compactRetrieveResultForStdio(result, {
    snippetBudget: 100_000,
    maxOutputTokens: 2_000,
  })
  const retainedIds = new Set(compact.matched_nodes.flatMap((node) => (
    typeof node.node_id === 'string' ? [node.node_id] : []
  )))
  const retainedLabels = new Set(compact.matched_nodes.map((node) => node.label))

  expect(estimateQueryTokens(JSON.stringify(compact))).toBeLessThanOrEqual(2_000)
  expect(compact.matched_nodes.length).toBeLessThan(result.matched_nodes.length)
  expect(compact.relationships.length).toBeGreaterThan(0)
  expect(compact.relationships.length).toBeLessThan(result.relationships.length)
  expect(compact.claims?.length ?? 0).toBeGreaterThan(0)
  expect(compact.claims?.length ?? 0).toBeLessThan(result.claims.length)

  for (const relationship of compact.relationships) {
    if (typeof relationship.from_id === 'string') {
      expect(retainedIds.has(relationship.from_id)).toBe(true)
    }
    if (typeof relationship.to_id === 'string') {
      expect(retainedIds.has(relationship.to_id)).toBe(true)
    }
  }
  for (const claim of compact.claims ?? []) {
    for (const label of claim.node_labels) {
      expect(retainedLabels.has(label)).toBe(true)
    }
  }
})
