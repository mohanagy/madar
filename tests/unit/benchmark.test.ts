import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import {
  loadBenchmarkQuestions,
  printBenchmark,
  queryEvidenceTokens,
  runBenchmark,
} from '../../src/infrastructure/benchmark.js'
import { evaluateBenchmarkQuestion } from '../../src/infrastructure/benchmark/questions.js'

const sandboxes: string[] = []

function requireSynchronousResult<T>(result: T | Promise<T>): T {
  if (result instanceof Promise) {
    throw new Error('Expected the local benchmark path to complete synchronously')
  }
  return result
}

function workspace(): { root: string; graphPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-benchmark-core-'))
  sandboxes.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'repository.ts'),
    'export function persistOrder(id: string): string { return `stored:${id}` }\n',
    'utf8',
  )
  writeFileSync(
    join(root, 'src', 'service.ts'),
    [
      "import { persistOrder } from './repository.js'",
      'export function processOrder(id: string): string {',
      '  return persistOrder(id)',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  return { root, graphPath: generateIndex(root).graphPath }
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('Core Reset benchmark caller', () => {
  it('measures the serialized authenticated evidence result', () => {
    const { graphPath } = workspace()
    const graph = loadGraphArtifact(graphPath)
    const question = 'How does process order call persist order?'

    expect(queryEvidenceTokens(graph, graphPath, question)).toBeGreaterThan(0)

    const evaluation = evaluateBenchmarkQuestion(
      graph,
      graphPath,
      {
        id: 'order-flow',
        description: 'Trace the write path.',
        question,
        expected_labels: ['processOrder()', 'persistOrder()'],
      },
      10_000,
    )

    expect(evaluation.result).toEqual(expect.objectContaining({
      id: 'order-flow',
      question,
      matched_expected_labels: ['processOrder()', 'persistOrder()'],
      missing_expected_labels: [],
    }))
    expect(evaluation.result?.query_tokens).toBeGreaterThan(0)
  })

  it('runs every local question through the one evidence query', () => {
    const { graphPath } = workspace()
    const result = requireSynchronousResult(runBenchmark(graphPath, 10_000, [
      {
        question: 'How does process order call persist order?',
        expected_labels: ['processOrder()', 'persistOrder()'],
      },
    ]))

    expect(result).toEqual(expect.objectContaining({
      question_count: 1,
      matched_question_count: 1,
      expected_label_count: 2,
      matched_expected_label_count: 2,
    }))
    if ('error' in result) throw new Error(result.error)
    expect(result.per_question).toHaveLength(1)
    expect(result.per_question[0]?.query_tokens).toBeGreaterThan(0)
  })

  it('reports an unmatched question instead of falling back to another query engine', () => {
    const { graphPath } = workspace()
    expect(runBenchmark(graphPath, 10_000, ['quantum photon collider'])).toEqual({
      error: 'No matching nodes found for the supplied questions. Check the graph path or question file.',
    })
  })

  it('loads strict question files and rejects malformed entries', () => {
    const { root } = workspace()
    const valid = join(root, 'questions.json')
    writeFileSync(valid, JSON.stringify([{
      id: 'order-flow',
      question: 'Trace order persistence',
      expected_labels: ['persistOrder()'],
    }]), 'utf8')
    expect(loadBenchmarkQuestions(valid)).toEqual([{
      id: 'order-flow',
      question: 'Trace order persistence',
      expected_labels: ['persistOrder()'],
    }])

    const invalid = join(root, 'invalid.json')
    writeFileSync(invalid, JSON.stringify([{ expected_labels: [] }]), 'utf8')
    expect(() => loadBenchmarkQuestions(invalid)).toThrow('must include a non-empty question')
  })

  it('prints the retained benchmark metrics', () => {
    const { graphPath } = workspace()
    const result = requireSynchronousResult(
      runBenchmark(graphPath, 10_000, ['process order']),
    )
    if ('error' in result) throw new Error(result.error)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark(result)
    expect(log.mock.calls.flat().join('\n')).toContain('madar runner-backed benchmark')
  })
})
