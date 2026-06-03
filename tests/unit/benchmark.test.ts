import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadBenchmarkQuestions, runBenchmark, printBenchmark, querySubgraphTokens, type BenchmarkQuestionInput } from '../../src/infrastructure/benchmark.js'
import { corpusTokensFromWords } from '../../src/infrastructure/benchmark/corpus.js'
import { evaluateRetrievalQuality, formatQualityReport } from '../../src/infrastructure/benchmark/quality.js'
import { toJson } from '../../src/pipeline/export.js'
import { estimateQueryTokens, loadGraph, queryGraph } from '../../src/runtime/serve.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')
const DEMO_REPO_DIR = join(process.cwd(), 'examples', 'demo-repo')
const DEMO_QUESTIONS_PATH = join(DEMO_REPO_DIR, 'benchmark-questions.json')

function withTempDir(callback: (tempDir: string) => void | Promise<void>): void | Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-benchmark-'))
  const finalize = () => rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback(tempDir)
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(finalize)
    }
    finalize()
  } catch (error) {
    finalize()
    throw error
  }
}

function copyFixtureCorpus(fixtureName: string, tempDir: string): string {
  const fixtureRoot = join(FIXTURES_DIR, fixtureName)
  const targetRoot = join(tempDir, fixtureName)
  cpSync(fixtureRoot, targetRoot, { recursive: true })
  return targetRoot
}

function copyDemoRepo(tempDir: string): string {
  const targetRoot = join(tempDir, 'demo-repo')
  cpSync(DEMO_REPO_DIR, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = relative(DEMO_REPO_DIR, source)
      return relativePath !== 'out' && !relativePath.startsWith(`out${sep}`)
    },
  })
  return targetRoot
}

function readWorkspaceParityQuestions(): BenchmarkQuestionInput[] {
  return loadBenchmarkQuestions(join(FIXTURES_DIR, 'workspace-parity-questions.json'))
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'authentication', source_file: 'auth.py', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('n2', { label: 'api_handler', source_file: 'api.py', source_location: 'L5', community: 0, file_type: 'code' })
  graph.addNode('n3', { label: 'main_entry', source_file: 'main.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n4', { label: 'error_handler', source_file: 'errors.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n5', { label: 'database_layer', source_file: 'db.py', source_location: 'L1', community: 2, file_type: 'code' })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'INFERRED', source_file: 'auth.py' })
  graph.addEdge('n2', 'n3', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'api.py' })
  graph.addEdge('n3', 'n4', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'main.py' })
  graph.addEdge('n5', 'n2', { relation: 'provides', confidence: 'EXTRACTED', source_file: 'db.py' })
  return graph
}

function makeWorkspaceGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph(true)
  graph.addNode('a', { label: 'authentication', source_file: 'auth.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('b', { label: 'api_handler', source_file: 'api.ts', source_location: 'L5', community: 0, file_type: 'code' })
  graph.addNode('c', { label: 'main_entry', source_file: 'main.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('d', { label: 'database_layer', source_file: 'db.ts', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('e', { label: 'queue_worker', source_file: 'worker.ts', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('f', { label: 'toHtml()', source_file: 'export.ts', source_location: 'L1', community: 2, file_type: 'code' })
  graph.addNode('file', { label: 'auth.ts', source_file: 'auth.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('concept', { label: 'Shared infra', source_file: 'concept.md', source_location: 'L1', community: 3, file_type: 'document' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' })
  graph.addEdge('b', 'c', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'api.ts' })
  graph.addEdge('d', 'e', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'db.ts' })
  graph.addEdge('f', 'concept', { relation: 'references', confidence: 'EXTRACTED', source_file: 'export.ts' })
  graph.addEdge('file', 'a', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'auth.ts' })
  return graph
}

async function runRunnerBackedBenchmark(
  graphPath: string,
  corpusWords: number | null | undefined,
  questions: BenchmarkQuestionInput[] | undefined,
  options: Record<string, unknown>,
) {
  return await (runBenchmark as unknown as (
    graphPath: string,
    corpusWords: number | null | undefined,
    questions: BenchmarkQuestionInput[] | undefined,
    options: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<typeof runBenchmark>>>)(graphPath, corpusWords, questions, options)
}

describe('querySubgraphTokens', () => {
  test('returns positive tokens for matching questions', () => {
    expect(querySubgraphTokens(makeGraph(), 'how does authentication work')).toBeGreaterThan(0)
  })

  test('matches the runtime query output sizing path', () => {
    const output = queryGraph(makeGraph(), 'how does authentication work')
    expect(querySubgraphTokens(makeGraph(), 'how does authentication work')).toBe(estimateQueryTokens(output))
  })

  test('returns zero for missing matches', () => {
    expect(querySubgraphTokens(makeGraph(), 'xyzzy plugh zorkmid')).toBe(0)
  })
})

describe('runBenchmark', () => {
  const expectedDemoQuestions: Exclude<BenchmarkQuestionInput, string>[] = [
    {
      question: 'how does password policy login create a tenant session',
      expected_labels: ['AuthService', 'TenantContext', 'SessionStore', '.loginWithPassword()', '.createSession()'],
    },
    {
      question: 'which module sends invoice receipt emails',
      expected_labels: ['InvoiceService', 'EmailNotifier', '.sendInvoiceReceipt()', '.sendReceiptEmail()'],
    },
    {
      question: 'what runs the monthly billing close',
      expected_labels: ['runMonthlyCloseJob()', 'InvoiceService', 'RevenueReport'],
    },
    {
      question: 'how is the monthly revenue report built',
      expected_labels: ['RevenueReport', '.buildMonthlyRevenueReport()', 'revenue-report.ts'],
    },
    {
      question: 'where is tenant context defined for billing and auth',
      expected_labels: ['TenantContext', 'tenant-context.ts'],
    },
  ]

  test('loads shared question files', () => {
    expect(loadBenchmarkQuestions(join(FIXTURES_DIR, 'workspace-parity-questions.json'))).toEqual([
      { question: 'create session login', expected_labels: ['default()', 'loginUser()', '.login()'] },
      { question: 'login user session', expected_labels: ['loginUser()', 'default()', 'session.ts'] },
      { question: 'shared auth helper', expected_labels: ['default()', 'auth.ts', 'index.ts'] },
      { question: 'reindex workspace', expected_labels: ['reindexWorkspace()', 'jobs.ts'] },
      { question: 'workspace architecture docs', expected_labels: ['Workspace Architecture', 'architecture.md'] },
      { question: 'billing flow', expected_labels: [] },
    ])
  })

  test('preserves prompt metadata from shared question files', () => {
    withTempDir((tempDir) => {
      const questionsPath = join(tempDir, 'benchmark-questions.json')
      writeFileSync(
        questionsPath,
        `${JSON.stringify([
          {
            id: 'report-generation',
            description: 'Trace how report generation is assembled end to end.',
            question: 'How is the report generated?',
            expected_labels: [],
          },
        ], null, 2)}\n`,
        'utf8',
      )

      expect(loadBenchmarkQuestions(questionsPath)).toEqual([
        {
          id: 'report-generation',
          description: 'Trace how report generation is assembled end to end.',
          question: 'How is the report generated?',
          expected_labels: [],
        },
      ])
    })
  })

  test('rejects blank prompt ids when present in shared question files', () => {
    withTempDir((tempDir) => {
      const questionsPath = join(tempDir, 'benchmark-questions.json')
      writeFileSync(
        questionsPath,
        `${JSON.stringify([
          {
            id: '   ',
            question: 'How is the report generated?',
            expected_labels: [],
          },
        ], null, 2)}\n`,
        'utf8',
      )

      expect(() => loadBenchmarkQuestions(questionsPath)).toThrow(
        'Question file entry 1 id must be a non-empty string when provided',
      )
    })
  })

  test('rejects blank prompt descriptions when present in shared question files', () => {
    withTempDir((tempDir) => {
      const questionsPath = join(tempDir, 'benchmark-questions.json')
      writeFileSync(
        questionsPath,
        `${JSON.stringify([
          {
            id: 'report-generation',
            description: '   ',
            question: 'How is the report generated?',
            expected_labels: [],
          },
        ], null, 2)}\n`,
        'utf8',
      )

      expect(() => loadBenchmarkQuestions(questionsPath)).toThrow(
        'Question file entry 1 description must be a non-empty string when provided',
      )
    })
  })

  test('preserves prompt metadata in benchmark per-question results', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)

      const result = runBenchmark(graphPath, 10_000, [
        {
          id: 'auth-flow',
          description: 'Trace the authentication path.',
          question: 'how does authentication work',
          expected_labels: ['authentication'],
        },
      ])

      expect('reduction_ratio' in result).toBe(true)
      if (!('reduction_ratio' in result)) {
        return
      }

      expect(result.per_question).toEqual([
        expect.objectContaining({
          id: 'auth-flow',
          description: 'Trace the authentication path.',
          question: 'how does authentication work',
          expected_labels: ['authentication'],
        }),
      ])
    })
  })

  test('returns reduction metrics', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)
      const result = runBenchmark(graphPath, 10_000)
      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.reduction_ratio).toBeGreaterThan(1)
        expect(result.nodes).toBe(5)
        expect(result.edges).toBe(4)
      }
    })
  })

  test('returns an error for empty graphs', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(new KnowledgeGraph(), {}, graphPath)
      const result = runBenchmark(graphPath, 1_000)
      expect(result).toEqual(expect.objectContaining({ error: expect.stringMatching(/no matching nodes/i) }))
    })
  })

  test('returns a specific error for an empty custom question set', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)

      const result = runBenchmark(graphPath, 1_000, [])

      expect(result).toEqual(
        expect.objectContaining({
          error: 'Question file did not include any benchmark questions. Add at least one question or omit --questions to use the sample set.',
        }),
      )
    })
  })

  test('returns a custom-question error when supplied questions do not match the graph', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)

      const result = runBenchmark(graphPath, 1_000, ['quantum entanglement physics'])

      expect(result).toEqual(
        expect.objectContaining({
          error: 'No matching nodes found for the supplied questions. Check the graph path or question file.',
        }),
      )
    })
  })

  test('does not emit extraction warnings for exported graph json nodes without source_file', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })

      const graph = new KnowledgeGraph()
      graph.addNode('n1', { label: 'authentication', file_type: 'code', community: 0 })
      graph.addNode('n2', { label: 'api_handler', file_type: 'code', community: 0 })
      graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED' })
      toJson(graph, { 0: ['n1', 'n2'] }, graphPath)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const result = runBenchmark(graphPath, 1_000, ['how does authentication work'])

      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.structure_signals).toBeNull()
      }
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  test('treats partially-provenanced graph artifacts as unavailable for structure signals', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })

      const graph = new KnowledgeGraph()
      graph.addNode('n1', { label: 'authentication', file_type: 'code', community: 0, source_file: 'auth.ts' })
      graph.addNode('n2', { label: 'api_handler', file_type: 'code', community: 0 })
      graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' })
      toJson(graph, { 0: ['n1', 'n2'] }, graphPath)

      const result = runBenchmark(graphPath, 1_000, ['how does authentication work'])

      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.structure_signals).toBeNull()
      }
    })
  })

  test('returns workspace parity structure signals on the shared entity basis', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeWorkspaceGraph(), { 0: ['a', 'b', 'c'], 1: ['d', 'e'], 2: ['f'], 3: ['concept'] }, graphPath)

      const result = runBenchmark(graphPath, 12_000, ['how does authentication work'])

      expect('structure_signals' in result).toBe(true)
      if ('structure_signals' in result) {
        expect(result.structure_signals).toEqual({
          total_nodes: 7,
          total_edges: 4,
          weakly_connected_components: 3,
          singleton_components: 0,
          isolated_nodes: 0,
          largest_component_nodes: 3,
          largest_component_ratio: 3 / 7,
          low_cohesion_communities: 0,
          largest_low_cohesion_community_nodes: 0,
          largest_low_cohesion_community_score: 0,
        })
      }
    })
  })

  test('uses the checked-in mixed-workspace fixture as a reproducible parity baseline', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const benchmark = runBenchmark(generation.graphPath, null, ['create session login'])

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(generation.totalFiles).toBe(6)
      expect(generation.codeFiles).toBe(5)
      expect(generation.nonCodeFiles).toBe(1)
      expect(benchmark.structure_signals).toEqual({
        total_nodes: 6,
        total_edges: 3,
        weakly_connected_components: 3,
        singleton_components: 2,
        isolated_nodes: 2,
        largest_component_nodes: 4,
        largest_component_ratio: 2 / 3,
        low_cohesion_communities: 0,
        largest_low_cohesion_community_nodes: 0,
        largest_low_cohesion_community_score: 0,
      })

      const report = readFileSync(generation.reportPath, 'utf8')
      expect(report).toContain('## Structure Signals')
      expect(report).toContain('Weakly connected components: 3')
      expect(report).toContain('Singleton components: 2')
      expect(report).toContain('Isolated nodes: 2')
      expect(report).toContain('Largest component: 4 node(s) (67% of the entity graph basis)')
    })
  }, 15_000)

  test('tracks fixture-backed question coverage for the mixed-workspace baseline', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const questions = readWorkspaceParityQuestions()
      const benchmark = runBenchmark(generation.graphPath, null, questions)

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(benchmark.question_count).toBe(6)
      expect(benchmark.matched_question_count).toBe(5)
      expect(benchmark.unmatched_questions).toEqual(['billing flow'])
      expect(benchmark.expected_label_count).toBe(13)
      expect(benchmark.matched_expected_label_count).toBe(13)
      expect(benchmark.missing_expected_labels).toEqual([])
      expect(benchmark.per_question.map((entry) => entry.question)).toEqual([
        'create session login',
        'login user session',
        'shared auth helper',
        'reindex workspace',
        'workspace architecture docs',
      ])
      expect(benchmark.per_question[0]).toMatchObject({
        question: 'create session login',
        expected_labels: ['default()', 'loginUser()', '.login()'],
        matched_expected_labels: ['default()', 'loginUser()', '.login()'],
        missing_expected_labels: [],
      })
    })
  }, 15_000)

  test('copies the demo repo without pre-generated graph artifacts', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyDemoRepo(tempDir)

      expect(existsSync(join(workspaceRoot, 'out'))).toBe(false)
    })
  })

  test('keeps the checked-in demo repo free of pre-generated graph artifacts', () => {
    expect(existsSync(DEMO_REPO_DIR)).toBe(true)
    const trackedFiles = execFileSync('git', ['ls-files', '--', 'examples/demo-repo'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean)

    expect(trackedFiles.some((file) => file === 'examples/demo-repo/out' || file.startsWith('examples/demo-repo/out/'))).toBe(false)
  })

  test('uses the checked-in demo repo as a reproducible benchmark and eval proof kit', () => {
    expect(existsSync(DEMO_REPO_DIR)).toBe(true)
    expect(existsSync(DEMO_QUESTIONS_PATH)).toBe(true)
    expect(loadBenchmarkQuestions(DEMO_QUESTIONS_PATH)).toEqual(expectedDemoQuestions)

    withTempDir((tempDir) => {
      const workspaceRoot = copyDemoRepo(tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const questions = loadBenchmarkQuestions(join(workspaceRoot, 'benchmark-questions.json'))
      const graph = loadGraph(generation.graphPath)
      const graphLabels = new Set(graph.nodeEntries().map(([, attributes]) => String(attributes.label ?? '')))
      const benchmark = runBenchmark(generation.graphPath, null, questions)
      const quality = evaluateRetrievalQuality(graph, questions, 3000, { graphPath: generation.graphPath })
      const qualityReport = formatQualityReport(quality)

      expect(generation.totalFiles).toBeGreaterThanOrEqual(10)
      expect(generation.codeFiles).toBeGreaterThanOrEqual(10)
      expect(questions.length).toBe(5)
      expect(
        expectedDemoQuestions.flatMap((question) => question.expected_labels ?? []).every((label) => graphLabels.has(label)),
      ).toBe(true)
      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(benchmark.question_count).toBe(questions.length)
      expect(benchmark.corpus_source).toBe('manifest')
      expect(benchmark.corpus_words).toBe(generation.totalWords)
      expect(benchmark.corpus_tokens).toBe(corpusTokensFromWords(generation.totalWords))
      expect(benchmark.matched_question_count).toBe(questions.length)
      expect(benchmark.unmatched_questions).toEqual([])
      expect(benchmark.expected_label_count).toBe(17)
      expect(benchmark.matched_expected_label_count).toBe(benchmark.expected_label_count)
      expect(benchmark.missing_expected_labels).toEqual([])
      expect(benchmark.reduction_ratio).toBeGreaterThan(1)
      expect(benchmark.per_question).toHaveLength(questions.length)
      expect(
        benchmark.per_question.map((entry) => ({
          question: entry.question,
          expected_labels: entry.expected_labels,
          matched_expected_labels: entry.matched_expected_labels,
          missing_expected_labels: entry.missing_expected_labels,
        })),
      ).toEqual(
        expectedDemoQuestions.map((question) => ({
          question: question.question,
          expected_labels: question.expected_labels,
          matched_expected_labels: question.expected_labels,
          missing_expected_labels: [],
        })),
      )
      expect(quality.total_questions).toBe(questions.length)
      expect(quality.corpus_source).toBe('manifest')
      expect(quality.corpus_tokens).toBe(corpusTokensFromWords(generation.totalWords))
      expect(quality.questions_with_hits).toBe(questions.length)
      expect(quality.avg_recall).toBeGreaterThanOrEqual(0.9)
      expect(quality.mrr).toBeGreaterThan(0.3)
      expect(quality.avg_tokens_used).toBeGreaterThan(0)
      expect(quality.compression_ratio).toBeGreaterThan(1)
      expect(
        quality.questions.map((entry) => entry.question),
      ).toEqual(expectedDemoQuestions.map((question) => question.question))
      expect(quality.questions.every((entry) => entry.matched_labels.length > 0)).toBe(true)
      expect(quality.questions.every((entry) => entry.recall >= 0.5)).toBe(true)
      expect(qualityReport).toContain('retrieval quality benchmark')
      expect(qualityReport).toContain('Per question:')
      expect(qualityReport).toContain('which module sends invoice receipt emails')
    })
  })

  test('normalizes expected labels for benchmark matching', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const benchmark = runBenchmark(generation.graphPath, null, [
        { question: 'shared auth helper', expected_labels: ['DEFAULT', 'auth ts', 'index-ts'] },
      ])

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(benchmark.expected_label_count).toBe(3)
      expect(benchmark.matched_expected_label_count).toBe(3)
      expect(benchmark.missing_expected_labels).toEqual([])
      expect(benchmark.per_question[0]).toMatchObject({
        question: 'shared auth helper',
        expected_labels: ['DEFAULT', 'auth ts', 'index-ts'],
        matched_expected_labels: ['DEFAULT', 'auth ts', 'index-ts'],
        missing_expected_labels: [],
      })
    })
  })

  test('executes each matched question through the shared runner and captures reported usage', async () => {
    await withTempDir(async (tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      const benchmarkOutputDir = join(tempDir, 'out', 'benchmark')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)

      const executions: Array<{
        question: string
        mode: string
        command: string
        promptFile: string
        outputFile: string
      }> = []

      const benchmark = await runRunnerBackedBenchmark(
        graphPath,
        10_000,
        [
          { question: 'how does authentication work', expected_labels: ['authentication'] },
          'xyzzy plugh zorkmid',
          { question: 'what is the main entry point', expected_labels: ['main_entry'] },
        ],
        {
          execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
          outputDir: benchmarkOutputDir,
          now: new Date('2026-04-28T10:15:00.000Z'),
          runner: async (execution: {
            question: string
            mode: string
            command: string
            promptFile: string
            outputFile: string
          }) => {
            executions.push(execution)
            const inputTokens = execution.question.includes('authentication') ? 280 : 170
            const cacheReadTokens = execution.question.includes('authentication') ? 40 : 10
            const totalTokens = execution.question.includes('authentication') ? 360 : 210
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: `Answer for ${execution.question}\n`,
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: totalTokens - inputTokens - cacheReadTokens,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: cacheReadTokens,
                },
              }),
              stderr: '',
              elapsedMs: execution.question.includes('authentication') ? 11 : 17,
            }
          },
        },
      )

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(executions).toHaveLength(2)
      expect(executions.map((execution) => execution.question)).toEqual([
        'how does authentication work',
        'what is the main entry point',
      ])
      expect(executions.map((execution) => execution.mode)).toEqual(['madar', 'madar'])
      expect(executions[0]?.command).toMatch(/--mode ['"]madar['"]/)
      expect(readFileSync(executions[0]!.promptFile, 'utf8')).toContain('Retrieved graph context:')
      expect(readFileSync(executions[0]!.promptFile, 'utf8')).toContain('Question:\nhow does authentication work')
      expect(readFileSync(executions[1]!.promptFile, 'utf8')).toContain('Session delta:')
      expect(readFileSync(executions[1]!.promptFile, 'utf8')).toContain('Question:\nwhat is the main entry point')
      expect(readFileSync(executions[1]!.promptFile, 'utf8')).not.toContain('Retrieved graph context:')
      expect(readFileSync(executions[0]!.outputFile, 'utf8')).toBe('Answer for how does authentication work\n')
      expect(readFileSync(executions[1]!.outputFile, 'utf8')).toBe('Answer for what is the main entry point\n')

      const run = benchmark.per_question[0]
      expect(run?.artifacts).toBeDefined()
      expect(run?.artifacts).toEqual(
        expect.objectContaining({
          prompt: executions[0]!.promptFile,
          answer: executions[0]!.outputFile,
          report: join(dirname(executions[0]!.promptFile), 'report.json'),
          share_safe_report: join(dirname(executions[0]!.promptFile), 'report.share-safe.json'),
        }),
      )
      const localReport = JSON.parse(readFileSync(run!.artifacts!.report, 'utf8')) as Record<string, unknown>
      const shareSafePath = run!.artifacts!.share_safe_report
      const shareSafeReport = JSON.parse(readFileSync(shareSafePath, 'utf8')) as Record<string, unknown>

      expect(localReport).toEqual(
        expect.objectContaining({
          question: 'how does authentication work',
          artifacts: {
            prompt: relative(process.cwd(), executions[0]!.promptFile),
            answer: relative(process.cwd(), executions[0]!.outputFile),
            report: relative(process.cwd(), run!.artifacts!.report),
          },
        }),
      )
      expect((localReport.artifacts as Record<string, unknown>)?.share_safe_report).toBeUndefined()
      expect(shareSafeReport).toEqual(
        expect.objectContaining({
          question: 'how does authentication work',
          share_safe_report: true,
          artifacts: expect.objectContaining({
            prompt: '<artifact-root>/madar-prompt.txt',
            answer: '<artifact-root>/madar-answer.txt',
            report: '<artifact-root>/report.json',
            share_safe_report: '<artifact-root>/report.share-safe.json',
          }),
        }),
      )
      expect(benchmark.matched_question_count).toBe(2)
      expect(benchmark.unmatched_questions).toEqual(['xyzzy plugh zorkmid'])
      expect(benchmark.avg_query_tokens).toBe(250)
      expect(benchmark.avg_effective_query_tokens).toBe(225)
      expect(benchmark.avg_reused_context_tokens).toBe(25)
      expect(benchmark.avg_total_tokens).toBe(285)
      expect(benchmark.effective_reduction_ratio).toBe(Number((benchmark.corpus_tokens / 225).toFixed(1)))
      expect(benchmark.provider_proof).toEqual({
        input_tokens_basis: 'provider_reported',
        effective_tokens_basis: 'provider_cache_read_tokens',
        total_tokens_basis: 'provider_reported',
        usage_runs: 2,
        total_runs: 2,
        providers: ['claude'],
      })
      const firstRun = benchmark.per_question[0]
      expect(benchmark.per_question).toEqual([
        expect.objectContaining({
          question: 'how does authentication work',
          query_tokens: 320,
          effective_query_tokens: 280,
          reused_context_tokens: 40,
          total_tokens: 360,
          prompt_token_source: 'claude_reported_input',
          usage: expect.objectContaining({
            provider: 'claude',
            input_total_tokens: 320,
            total_tokens: 360,
          }),
          artifacts: expect.objectContaining({
            prompt: executions[0]!.promptFile,
            answer: executions[0]!.outputFile,
          }),
        }),
        expect.objectContaining({
          question: 'what is the main entry point',
          query_tokens: 180,
          effective_query_tokens: 170,
          reused_context_tokens: 10,
          total_tokens: 210,
          prompt_token_source: 'claude_reported_input',
          session_diagnostics: expect.objectContaining({
            mode: 'follow_up',
            previous_revision: 1,
            reused_refs: ['__stable_prefix:instructions', '__stable_prefix:title'],
            added_refs: [],
            updated_refs: ['explain_pack_payload'],
            invalidated_refs: [],
          }),
          usage: expect.objectContaining({
            provider: 'claude',
            input_total_tokens: 180,
            total_tokens: 210,
          }),
          artifacts: expect.objectContaining({
            prompt: executions[1]!.promptFile,
            answer: executions[1]!.outputFile,
          }),
        }),
      ])
      expect(shareSafeReport).toEqual(expect.objectContaining({
        session_diagnostics: {
          mode: 'initial',
          previous_revision: null,
          reused_refs: [],
          added_refs: ['__stable_prefix:instructions', '__stable_prefix:title', 'explain_pack_payload'],
          updated_refs: [],
          invalidated_refs: [],
          reused_context_tokens: firstRun?.reused_context_tokens ?? 0,
          effective_token_count: firstRun?.effective_query_tokens ?? 0,
        },
      }))
      expect(firstRun?.session_diagnostics).toEqual({
        mode: 'initial',
        previous_revision: null,
        reused_refs: [],
        added_refs: ['__stable_prefix:instructions', '__stable_prefix:title', 'explain_pack_payload'],
        updated_refs: [],
        invalidated_refs: [],
        reused_context_tokens: firstRun?.reused_context_tokens ?? 0,
        effective_token_count: firstRun?.effective_query_tokens ?? 0,
      })
      const followUpRun = benchmark.per_question[1]
      expect(followUpRun?.session_diagnostics?.reused_context_tokens).toBeGreaterThan(0)
      expect(followUpRun?.session_diagnostics?.reused_context_tokens).toBe(followUpRun?.reused_context_tokens)
      expect(followUpRun?.session_diagnostics?.effective_token_count).toBe(followUpRun?.effective_query_tokens)
    })
  })
})

describe('printBenchmark', () => {
  test('prints a human readable report', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 5,
      edges: 4,
      structure_signals: {
        total_nodes: 5,
        total_edges: 4,
        weakly_connected_components: 2,
        singleton_components: 1,
        isolated_nodes: 1,
        largest_component_nodes: 4,
        largest_component_ratio: 0.8,
        low_cohesion_communities: 1,
        largest_low_cohesion_community_nodes: 15,
        largest_low_cohesion_community_score: 0.14,
      },
      question_count: 6,
      matched_question_count: 5,
      unmatched_questions: ['billing flow'],
      expected_label_count: 2,
      matched_expected_label_count: 1,
      missing_expected_labels: [{ question: 'how does authentication work', labels: ['api_handler'] }],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: ['authentication', 'api_handler'],
          matched_expected_labels: ['authentication'],
          missing_expected_labels: ['api_handler'],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Question coverage: 5/6 matched')
    expect(output).toContain('Unmatched: billing flow')
    expect(output).toContain('Expected evidence: 1/2 labels found')
    expect(output).toContain('Missing evidence for how does authentication work: api_handler')
    expect(output).toContain('Structure signals:')
    expect(output).toContain('entity basis: 5 nodes, 4 edges')
    expect(output).toContain('components: 2 weakly connected, 1 singleton, 1 isolated')
    expect(output).toContain('largest component: 4 nodes (80% of entity graph)')
    expect(output).toContain('low cohesion: 1 communities, largest 15 nodes (cohesion 0.14)')
    spy.mockRestore()
  })

  test('prints an unavailable note when structure signals cannot be derived safely', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'estimated',
      nodes: 5,
      edges: 4,
      structure_signals: null,
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Corpus baseline:')
    expect(output).toContain('estimated from graph size')
    expect(output).not.toContain('naive corpus')
    expect(output).toContain('Structure signals: unavailable for graph artifacts without source_file provenance')
    spy.mockRestore()
  })

  test('prints runner-backed usage summaries without estimate fallback when usage is reported for every match', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 5,
      edges: 4,
      structure_signals: null,
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 410,
      avg_effective_query_tokens: 400,
      avg_reused_context_tokens: 10,
      avg_total_tokens: 480,
      reduction_ratio: 2.4,
      effective_reduction_ratio: 2.5,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 410,
          effective_query_tokens: 400,
          reused_context_tokens: 10,
          total_tokens: 480,
          reduction: 2.4,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
          prompt_token_source: 'claude_reported_input',
          usage: {
            provider: 'claude',
            source: 'structured_stdout',
            input_tokens: 400,
            output_tokens: 70,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            input_total_tokens: 410,
            total_tokens: 480,
          },
        },
      ],
    } as any)
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('madar runner-backed benchmark')
    expect(output).toContain('Avg input tokens (Claude reported): ~410')
    expect(output).toContain('Avg effective input tokens (cache-adjusted): ~400')
    expect(output).toContain('Avg total tokens (Claude reported): ~480')
    expect(output).toContain('Provider/runtime proof: Claude reported input, cache, and total tokens for 1/1 matched questions')
    expect(output).not.toContain('estimate fallback')
    expect(output).not.toContain('madar token reduction benchmark')
    expect(output).not.toContain('naive corpus')
    spy.mockRestore()
  })

  test('does not claim provider cache reporting when structured usage has no cache-read tokens', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 5,
      edges: 4,
      structure_signals: null,
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 410,
      avg_effective_query_tokens: 410,
      avg_reused_context_tokens: 0,
      avg_total_tokens: 480,
      reduction_ratio: 2.4,
      effective_reduction_ratio: 2.4,
      provider_proof: {
        input_tokens_basis: 'provider_reported',
        effective_tokens_basis: 'provider_input_minus_zero_cache',
        total_tokens_basis: 'provider_reported',
        usage_runs: 1,
        total_runs: 1,
        providers: ['gemini'],
      },
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 410,
          effective_query_tokens: 410,
          reused_context_tokens: 0,
          total_tokens: 480,
          reduction: 2.4,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
          prompt_token_source: 'gemini_reported_input',
          usage: {
            provider: 'gemini',
            source: 'structured_stdout',
            input_tokens: 410,
            output_tokens: 70,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_total_tokens: 410,
            total_tokens: 480,
          },
        },
      ],
    } as any)
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Avg input tokens (Gemini reported): ~410')
    expect(output).toContain('Avg total tokens (Gemini reported): ~480')
    expect(output).toContain('Provider/runtime proof: Gemini reported input and total tokens; no provider cache-read tokens were reported for 1/1 matched questions')
    spy.mockRestore()
  })

  test('labels estimate fallback only when structured usage is unavailable', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 5,
      edges: 4,
      structure_signals: null,
      question_count: 2,
      matched_question_count: 2,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 255,
      avg_total_tokens: null,
      reduction_ratio: 3.9,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 410,
          total_tokens: 480,
          reduction: 2.4,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
          prompt_token_source: 'claude_reported_input',
          usage: {
            provider: 'claude',
            source: 'structured_stdout',
            input_tokens: 400,
            output_tokens: 70,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            input_total_tokens: 410,
            total_tokens: 480,
          },
        },
        {
          question: 'what is the main entry point',
          query_tokens: 100,
          total_tokens: null,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
          prompt_token_source: 'estimated_cl100k_base',
          usage: null,
        },
      ],
    } as any)
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Avg input tokens (Claude reported where available; cl100k_base estimate fallback): ~255')
    expect(output).toContain('Usage capture: Claude reported usage for 1/2 matched questions; remaining runs used local estimate fallback')
    expect(output).not.toContain('Avg total tokens (Claude reported)')
    expect(output).toContain('Provider/runtime proof: mixed provider-reported usage (1/2 matched questions) with local estimate fallback')
    spy.mockRestore()
  })

  test('prints an explicit no-low-cohesion note when no such communities exist', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 5,
      edges: 4,
      structure_signals: {
        total_nodes: 5,
        total_edges: 4,
        weakly_connected_components: 2,
        singleton_components: 1,
        isolated_nodes: 1,
        largest_component_nodes: 4,
        largest_component_ratio: 0.8,
        low_cohesion_communities: 0,
        largest_low_cohesion_community_nodes: 0,
        largest_low_cohesion_community_score: 0,
      },
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('low cohesion: 0 communities, none on the entity basis')
    spy.mockRestore()
  })
})
