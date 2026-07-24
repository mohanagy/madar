import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import {
  type BenchmarkSuccessResult,
  loadBenchmarkQuestions,
  printBenchmark,
  queryEvidenceTokens,
  runBenchmark,
} from '../../src/infrastructure/benchmark.js'
import { runBenchmarkPrompt } from '../../src/infrastructure/benchmark/runner.js'
import { evaluateBenchmarkQuestion } from '../../src/infrastructure/benchmark/questions.js'

const sandboxes: string[] = []

function requireSynchronousResult<T>(result: T | Promise<T>): T {
  if (result instanceof Promise) {
    throw new Error('Expected the local benchmark path to complete synchronously')
  }
  return result
}

function printedBenchmark(result: BenchmarkSuccessResult | { error: string }): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  printBenchmark(result)
  return log.mock.calls.flat().join('\n')
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

  it('distinguishes an explicitly empty question file from an unmatched question', () => {
    const { graphPath } = workspace()
    expect(runBenchmark(graphPath, 10_000, [])).toEqual({
      error: 'Question file did not include any benchmark questions. Add at least one question or omit --questions to use the sample set.',
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

  it.each([
    ['object', { question: 'x' }, 'must contain an array'],
    ['null entry', [null], 'must be an object'],
    ['blank id', [{ id: ' ', question: 'x' }], 'id must be a non-empty string'],
    ['blank description', [{ description: ' ', question: 'x' }], 'description must be a non-empty string'],
    ['invalid labels', [{ question: 'x', expected_labels: [1] }], 'must be an array of strings'],
  ])('rejects malformed question-file shape: %s', (_name, payload, message) => {
    const { root } = workspace()
    const path = join(root, 'bad-questions.json')
    writeFileSync(path, JSON.stringify(payload), 'utf8')
    expect(() => loadBenchmarkQuestions(path)).toThrow(message)
  })

  it('runs a structured provider-backed benchmark and writes local and share-safe receipts', async () => {
    const { root, graphPath } = workspace()
    const graph = loadGraphArtifact(graphPath)
    const run = await runBenchmarkPrompt({
      graphPath,
      graph,
      question: 'How does processOrder call persistOrder?',
      execTemplate: 'runner --prompt {prompt_file} --output {output_file}',
      outputDir: join(root, 'out', 'benchmark'),
      now: new Date('2026-07-24T08:00:00.000Z'),
      runner: async (execution) => {
        expect(execution.command).toContain('madar-prompt.txt')
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            result: 'provider answer',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 10,
            },
          }),
          stderr: '',
          elapsedMs: 42,
        }
      },
    })

    expect(run).toMatchObject({
      query_tokens: 115,
      effective_query_tokens: 105,
      reused_context_tokens: 10,
      total_tokens: 135,
      prompt_token_source: 'claude_reported_input',
      answer_text: 'provider answer',
      elapsed_ms: 42,
    })
    expect(readFileSync(run.artifacts.answer, 'utf8')).toBe('provider answer')
    expect(JSON.parse(readFileSync(run.artifacts.report, 'utf8'))).toMatchObject({
      question: 'How does processOrder call persistOrder?',
      prompt_token_source: 'claude_reported_input',
    })
    expect(JSON.parse(readFileSync(run.artifacts.share_safe_report, 'utf8')))
      .toMatchObject({ share_safe_report: true })
  })

  it('preserves a runner-written answer and creates a unique same-second output directory', async () => {
    const { root, graphPath } = workspace()
    const graph = loadGraphArtifact(graphPath)
    const options = {
      graphPath,
      graph,
      question: 'How does processOrder call persistOrder?',
      execTemplate: 'runner {prompt_file} {output_file}',
      outputDir: join(root, 'out', 'benchmark'),
      now: new Date('2026-07-24T08:00:00.000Z'),
      runner: async (execution: { outputFile: string }) => {
        writeFileSync(execution.outputFile, 'file answer', 'utf8')
        return {
          exitCode: 0,
          stdout: 'stdout answer',
          stderr: '',
          elapsedMs: 5,
        }
      },
    }
    const first = await runBenchmarkPrompt(options)
    const second = await runBenchmarkPrompt(options)
    expect(readFileSync(first.artifacts.answer, 'utf8')).toBe('file answer')
    expect(readFileSync(second.artifacts.answer, 'utf8')).toBe('file answer')
    expect(join(first.artifacts.answer, '..')).not.toBe(join(second.artifacts.answer, '..'))
    expect(first.prompt_token_source).toBe('estimated_cl100k_base')
  })

  it('rejects unsafe prompt substitution and reports runner failures with stderr', async () => {
    const { root, graphPath } = workspace()
    const graph = loadGraphArtifact(graphPath)
    const base = {
      graphPath,
      graph,
      question: 'How does processOrder call persistOrder?',
      outputDir: join(root, 'out', 'benchmark'),
    }
    await expect(runBenchmarkPrompt({
      ...base,
      execTemplate: 'runner $(cat {prompt_file})',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 }),
    })).rejects.toThrow('must not expand')
    await expect(runBenchmarkPrompt({
      ...base,
      execTemplate: 'runner {prompt_file}',
      runner: async () => ({
        exitCode: 7,
        stdout: '',
        stderr: 'provider failed',
        elapsedMs: 1,
      }),
    })).rejects.toThrow(/exit 7.*provider failed/)
  })

  it('runs the provider path through the public benchmark caller and converts runner errors', async () => {
    const { root, graphPath } = workspace()
    const success = await runBenchmark(
      graphPath,
      10_000,
      ['process order'],
      {
        execTemplate: 'runner {prompt_file}',
        outputDir: join(root, 'out', 'benchmark'),
        retrievalBudget: 2_000,
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [{
              content: {
                parts: [{ text: 'provider answer' }],
              },
            }],
            usageMetadata: {
              promptTokenCount: 80,
              candidatesTokenCount: 10,
              cachedContentTokenCount: 20,
              totalTokenCount: 90,
            },
          }),
          stderr: '',
          elapsedMs: 8,
        }),
      },
    )
    expect(success).toEqual(expect.objectContaining({
      matched_question_count: 1,
      avg_query_tokens: 80,
      avg_effective_query_tokens: 80,
      avg_reused_context_tokens: 0,
      avg_total_tokens: 90,
      provider_proof: expect.objectContaining({
        input_tokens_basis: 'provider_reported',
        effective_tokens_basis: 'provider_input_minus_zero_cache',
        total_tokens_basis: 'provider_reported',
        providers: ['gemini'],
      }),
    }))

    const failure = await runBenchmark(
      graphPath,
      10_000,
      ['process order'],
      {
        execTemplate: 'runner {prompt_file}',
        outputDir: join(root, 'out', 'benchmark-failure'),
        runner: async () => {
          throw 'runner unavailable'
        },
      },
    )
    expect(failure).toEqual({ error: 'runner unavailable' })
  })

  it('prints error, missing evidence, cache, and provider-proof variants', () => {
    expect(printedBenchmark({ error: 'graph missing' })).toContain('Benchmark error: graph missing')

    const { graphPath } = workspace()
    const base = requireSynchronousResult(runBenchmark(
      graphPath,
      10_000,
      [{
        question: 'process order',
        expected_labels: ['processOrder()', 'MissingSymbol()'],
      }],
    ))
    if ('error' in base) throw new Error(base.error)

    const localOutput = printedBenchmark({
      ...base,
      unmatched_questions: ['unmatched flow'],
      avg_effective_query_tokens: base.avg_query_tokens - 1,
      avg_reused_context_tokens: 1,
    })
    expect(localOutput).toContain('Unmatched: unmatched flow')
    expect(localOutput).toContain('Missing evidence for process order: MissingSymbol()')
    expect(localOutput).toContain('Avg effective input tokens (cache-adjusted)')
    expect(localOutput).toContain('local cl100k_base estimate')

    const entry = base.per_question[0]
    if (!entry) throw new Error('Expected benchmark evidence')
    const geminiOutput = printedBenchmark({
      ...base,
      avg_total_tokens: 120,
      provider_proof: {
        input_tokens_basis: 'provider_reported',
        effective_tokens_basis: 'provider_cache_read_tokens',
        total_tokens_basis: 'provider_reported',
        usage_runs: 1,
        total_runs: 1,
        providers: ['gemini'],
      },
      per_question: [{
        ...entry,
        query_tokens: 100,
        effective_query_tokens: 75,
        reused_context_tokens: 25,
        total_tokens: 120,
        prompt_token_source: 'gemini_reported_input',
        usage: {
          provider: 'gemini',
          source: 'structured_stdout',
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 25,
          cache_creation_input_tokens: 0,
          input_total_tokens: 125,
          total_tokens: 120,
        },
      }],
    })
    expect(geminiOutput).toContain('Gemini reported input, cache, and total tokens')
    expect(geminiOutput).toContain('Gemini reported')

    const claudeOutput = printedBenchmark({
      ...base,
      avg_total_tokens: 120,
      provider_proof: {
        input_tokens_basis: 'provider_reported',
        effective_tokens_basis: 'provider_input_minus_zero_cache',
        total_tokens_basis: 'provider_reported',
        usage_runs: 1,
        total_runs: 1,
        providers: ['claude'],
      },
      per_question: [{
        ...entry,
        total_tokens: 120,
        prompt_token_source: 'claude_reported_input',
        usage: {
          provider: 'claude',
          source: 'structured_stdout',
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          input_total_tokens: 100,
          total_tokens: 120,
        },
      }],
    })
    expect(claudeOutput).toContain('no provider cache-read tokens were reported')
    expect(claudeOutput).toContain('Claude reported')

    const mixedOutput = printedBenchmark({
      ...base,
      avg_total_tokens: null,
      provider_proof: {
        input_tokens_basis: 'mixed',
        effective_tokens_basis: 'mixed',
        total_tokens_basis: 'mixed',
        usage_runs: 1,
        total_runs: 2,
        providers: ['claude'],
      },
      per_question: [
        {
          ...entry,
          usage: {
            provider: 'claude',
            source: 'structured_stdout',
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            input_total_tokens: 100,
            total_tokens: 120,
          },
        },
        { ...entry, question: 'second run' },
      ],
    })
    expect(mixedOutput).toContain('Usage capture: Claude reported usage for 1/2 matched questions')
    expect(mixedOutput).toContain('mixed provider-reported usage')
  })

  it('prints the retained benchmark metrics', () => {
    const { graphPath } = workspace()
    const result = requireSynchronousResult(
      runBenchmark(graphPath, 10_000, ['process order']),
    )
    if ('error' in result) throw new Error(result.error)
    expect(printedBenchmark(result)).toContain('madar runner-backed benchmark')
  })
})
