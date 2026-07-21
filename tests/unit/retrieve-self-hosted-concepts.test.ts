import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { retrieveContext } from '../../src/runtime/retrieve.js'
import { buildMadarSelfRetrievalFixture } from '../fixtures/madar-self-retrieval.js'

interface RegressionCase {
  name: string
  question: string
  expected: string[]
  relevant: string[]
}

const CASES: RegressionCase[] = [
  {
    name: 'graph generation',
    question: 'How does graph generation extract source files?',
    expected: ['src/infrastructure/generate.ts', 'src/pipeline/extract.ts'],
    relevant: ['src/infrastructure/generate.ts', 'src/pipeline/detect.ts', 'src/pipeline/extract.ts'],
  },
  {
    name: 'automatic refresh',
    question: 'How is the graph kept updated while an agent edits?',
    expected: ['src/infrastructure/watch.ts'],
    relevant: ['src/infrastructure/watch.ts', 'src/infrastructure/watcher-state.ts'],
  },
  {
    name: 'confidence scoring',
    question: 'Where is evidence quality decided?',
    expected: ['src/runtime/mcp-response-evidence.ts'],
    relevant: ['src/runtime/mcp-response-evidence.ts', 'src/runtime/context-pack-diagnostics.ts'],
  },
  {
    name: 'install profiles',
    question: 'How do install profiles control available MCP tools?',
    expected: ['src/infrastructure/install.ts'],
    relevant: [
      'src/infrastructure/install.ts',
      'src/infrastructure/install-routing-guidance.ts',
      'src/runtime/stdio/tools.ts',
    ],
  },
  {
    name: 'impact direction',
    question: 'How does impact analysis follow dependency direction?',
    expected: ['src/runtime/impact.ts', 'src/domain/graph/directed-multigraph.ts'],
    relevant: ['src/runtime/impact.ts', 'src/domain/graph/directed-multigraph.ts'],
  },
]

function selectedFiles(question: string): { files: Set<string>; answerable: boolean; tokens: number; elapsedMs: number; debug: unknown } {
  const started = performance.now()
  const result = retrieveContext(buildMadarSelfRetrievalFixture(), {
    question,
    budget: 1200,
  })
  const elapsedMs = performance.now() - started
  return {
    files: new Set(result.matched_nodes.map((node) => node.source_file)),
    answerable: result.matched_nodes.length > 0 && result.relationships.length > 0,
    tokens: result.token_count,
    elapsedMs,
    debug: {
      labels: result.matched_nodes.map((node) => node.label),
      relationships: result.relationships,
      plan: result.retrieval_plan,
    },
  }
}

describe('Madar self-hosted conceptual retrieval regressions', () => {
  it.each(CASES)('recovers the $name workflow with bounded precision and latency', (regression) => {
    const result = selectedFiles(regression.question)
    const recall = regression.expected.filter((file) => result.files.has(file)).length / regression.expected.length
    const selectedRelevant = [...result.files].filter((file) => regression.relevant.includes(file)).length
    const precision = selectedRelevant / Math.max(result.files.size, 1)

    expect(recall).toBe(1)
    expect(result.answerable, JSON.stringify(result.debug)).toBe(true)
    expect(precision).toBeGreaterThanOrEqual(0.5)
    expect(result.tokens).toBeLessThanOrEqual(1200)
    expect(result.elapsedMs).toBeLessThan(500)
  })

  it.each(CASES)('does not lose $name recall when unrelated keywords are appended', (regression) => {
    const clean = selectedFiles(regression.question)
    const noisy = selectedFiles(`${regression.question} quasar marmalade`)
    const cleanRecall = regression.expected.filter((file) => clean.files.has(file)).length / regression.expected.length
    const noisyRecall = regression.expected.filter((file) => noisy.files.has(file)).length / regression.expected.length
    const noisyRelevant = [...noisy.files].filter((file) => regression.relevant.includes(file)).length
    const noisyPrecision = noisyRelevant / Math.max(noisy.files.size, 1)

    expect(noisyRecall).toBeGreaterThanOrEqual(cleanRecall)
    expect(noisyPrecision, JSON.stringify(noisy.debug)).toBeGreaterThanOrEqual(0.5)
    expect(noisy.tokens).toBeLessThanOrEqual(1200)
    expect(noisy.elapsedMs).toBeLessThan(500)
  })
})
