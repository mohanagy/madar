import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { existsSync } from 'node:fs'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { evaluateRetrievalQuality, formatQualityReport, GOLD_QUESTIONS, type GoldQuestion } from '../../src/infrastructure/benchmark/quality.js'
import { type BenchmarkQuestionSpec } from '../../src/infrastructure/benchmark/questions.js'
import { build } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { loadGraph } from '../../src/runtime/serve.js'

function buildTestGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth_module', { label: 'AuthModule', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L1' })
  graph.addNode('login_handler', { label: 'loginHandler', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L10' })
  graph.addNode('database', { label: 'Database', file_type: 'code', source_file: 'src/db.ts', source_location: 'L1' })
  graph.addNode('user_model', { label: 'UserModel', file_type: 'code', source_file: 'src/models/user.ts', source_location: 'L1' })
  graph.addEdge('auth_module', 'login_handler', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('login_handler', 'database', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('database', 'user_model', { relation: 'references', confidence: 'EXTRACTED', source_file: 'src/db.ts' })
  return graph
}

function stripFileNodes(extraction: ReturnType<typeof extractJs>): ReturnType<typeof extractJs> {
  const semanticNodeIds = new Set(extraction.nodes.filter((node) => String(node.node_kind ?? '') !== '').map((node) => node.id))
  return {
    ...extraction,
    nodes: extraction.nodes.filter((node) => semanticNodeIds.has(node.id)),
    edges: extraction.edges.filter((edge) => semanticNodeIds.has(edge.source) && semanticNodeIds.has(edge.target)),
  }
}

function buildFrameworkSupportGraph(): KnowledgeGraph {
  const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
  return build(
    [
      stripFileNodes(extractJs(join(fixturesDir, 'express-namespace-module-parent.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'express-namespace-module-child.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'redux-retrieve-auth-slice.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'redux-retrieve-auth-store.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'react-router-imported-router.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'nest-auth.module.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'nest-auth.controller.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'nest-auth.service.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'middleware.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'layout.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'page.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'template.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'loading.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'error.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'not-found.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', '@modal', 'default.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'actions.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'ClientTeamPanel.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-app', 'app', 'api', 'teams', '[team]', 'route.ts'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-pages', 'pages', 'account.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-pages', 'pages', '_app.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-pages', 'pages', '_document.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-pages', 'pages', '_error.tsx'))),
      stripFileNodes(extractJs(join(fixturesDir, 'next-pages', 'pages', 'api', 'auth', '[...nextauth].ts'))),
    ],
    { directed: true },
  )
}

const RUNNER_GRAPH_PATH = join(process.cwd(), 'graphify-out', 'graph.json')
const RUNNER_OUTPUT_DIR = join(process.cwd(), 'graphify-out', 'benchmark-quality-test-output')
const SHARED_PACK_QUALITY_GATES_PATH = join(process.cwd(), 'docs', 'benchmarks', 'govalidate-suite', 'quality-gates.json')

interface SharedPackQualityGate {
  required_labels: string[]
  forbidden_labels: string[]
  max_pack_tokens: number
  max_matched_nodes: number
  max_relationships: number
}

function resetRunnerOutputDir(): void {
  rmSync(RUNNER_OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(RUNNER_OUTPUT_DIR, { recursive: true })
}

// @ts-expect-error GoldQuestion must require expected_labels for built-in eval sets.
const invalidGoldQuestion: GoldQuestion = { question: 'missing labels' }

describe('retrieval quality benchmark', () => {
  afterAll(() => {
    rmSync(RUNNER_OUTPUT_DIR, { recursive: true, force: true })
  })

  it('computes precision, recall, and MRR for gold questions with exact matching', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['authmodule', 'loginhandler'] },
      { question: 'what is the database layer', expected_labels: ['database'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.total_questions).toBe(2)
    expect(report.avg_recall).toBeGreaterThan(0)
    expect(report.mrr).toBeGreaterThan(0)
    expect(report.questions).toHaveLength(2)
    for (const q of report.questions) {
      expect(q.expected_labels.length).toBeGreaterThan(0)
    }
  })

  it('does not over-credit partial matches', () => {
    const graph = buildTestGraph()
    // 'auth' is a substring of 'authmodule' but should NOT match with exact matching
    const questions: GoldQuestion[] = [{ question: 'authentication module', expected_labels: ['auth'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(0)
  })

  it('matches normalized shared question labels while preserving original expected labels', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['Auth Module', 'login-handler()'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(1)
    expect(report.questions[0]!.matched_labels).toEqual(['Auth Module', 'login-handler()'])
    expect(report.questions[0]!.missing_labels).toEqual([])
  })

  it('raises reciprocal rank when the expected direct node appears before supporting context', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['loginhandler'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.mrr).toBe(1)
  })

  it('keeps recall while reducing unnecessary returned labels for narrow symbol queries', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(
      graph,
      [{ question: 'login handler', expected_labels: ['loginhandler'] }],
      3000,
    )

    expect(report.questions[0]?.recall).toBe(1)
    expect(report.questions[0]?.returned_labels.length).toBeLessThanOrEqual(3)
  })

  it('reports zero recall when no expected labels match', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'quantum entanglement physics', expected_labels: ['quantumprocessor'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(0)
    expect(report.questions[0]!.reciprocal_rank).toBe(0)
    expect(report.questions_with_hits).toBe(0)
  })

  it('uses token_count from retrieve result, not snippet length', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'auth module', expected_labels: ['authmodule'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    // token_count comes from retrieveContext result, which is always >= 0
    expect(report.questions[0]!.tokens_used).toBeGreaterThanOrEqual(0)
    expect(typeof report.questions[0]!.tokens_used).toBe('number')
  })

  it('handles empty question list', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(graph, [], 3000)

    expect(report.total_questions).toBe(0)
    expect(report.avg_precision).toBe(0)
    expect(report.avg_recall).toBe(0)
    expect(report.mrr).toBe(0)
  })

  it('skips unlabeled shared questions when computing eval metrics', () => {
    const graph = buildTestGraph()
    const questions: BenchmarkQuestionSpec[] = [
      { question: 'how does authentication work', expected_labels: ['authmodule'] },
      { question: 'benchmark-only prompt', expected_labels: [] },
      { question: 'missing labels prompt' },
    ]
    const report = evaluateRetrievalQuality(
      graph,
      questions,
      3000,
    )

    expect(report.total_questions).toBe(1)
    expect(report.skipped_questions).toBe(2)
    expect(report.questions).toHaveLength(1)
    expect(report.questions[0]?.question).toBe('how does authentication work')
  })

  it('reports when unlabeled shared questions were skipped', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule'] },
        { question: 'benchmark-only prompt' },
      ],
      3000,
    )

    expect(formatQualityReport(report)).toContain('Skipped:      1 unlabeled question(s) missing expected_labels')
  })

  it('formatQualityReport returns a string for io.log', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'auth', expected_labels: ['authmodule'] }]
    const report = evaluateRetrievalQuality(graph, questions, 3000)

    const output = formatQualityReport(report)

    expect(typeof output).toBe('string')
    expect(output).toContain('retrieval quality benchmark')
    expect(output).toContain('Recall:')
    expect(output).toContain('MRR:')
  })

  it('reports snippet coverage separately from label recall so null-snippet regressions stay visible', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'auth module', expected_labels: ['authmodule'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)
    const output = formatQualityReport(report)

    expect(report.questions[0]?.recall).toBe(1)
    expect(report.questions[0]?.snippet_coverage).toBe(0)
    expect(report.avg_snippet_coverage).toBe(0)
    expect(output).toContain('Snippet coverage:')
    expect(output).toContain('0.0%')
  })

  it('reports grounded match rate and query buckets alongside label metrics', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'graphify-benchmark-quality-'))
    const routeFile = join(tempDir, 'auth-route.ts')
    writeFileSync(routeFile, ['export function AuthRoute() {', '  return true', '}'].join('\n'), 'utf8')

    try {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_route', {
        label: 'AuthRoute',
        file_type: 'code',
        source_file: routeFile,
        source_location: 'L1',
      })
      graph.addNode('auth_slice', {
        label: 'AuthSlice',
        file_type: 'code',
        source_file: join(tempDir, 'missing-slice.ts'),
        source_location: 'L1',
      })

      const report = evaluateRetrievalQuality(
        graph,
        [
          { question: 'which route handles auth', expected_labels: ['AuthRoute'] },
          { question: 'which slice owns auth state', expected_labels: ['AuthSlice'] },
        ],
        3000,
      )
      const output = formatQualityReport(report)

      expect(report.questions[0]?.grounded_match_rate).toBe(1)
      expect(report.questions[1]?.grounded_match_rate).toBe(0)
      expect(report.avg_grounded_match_rate).toBe(0.5)
      expect(report.bucket_summaries.map((summary) => summary.bucket)).toEqual(['routing', 'state'])
      expect(output).toContain('Grounded match rate:')
      expect(output).toContain('Query buckets:')
      expect(output).toContain('routing')
      expect(output).toContain('state')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps framework-aware retrieval accurate and compact across the five supported JS/TS frameworks', () => {
    const graph = buildFrameworkSupportGraph()
    const questions: GoldQuestion[] = [
      { question: 'where is GET /api/users/:id defined', expected_labels: ['GET /api/users/:id'] },
      { question: 'which slice owns auth state', expected_labels: ['auth slice'] },
      { question: 'which route renders settings page', expected_labels: ['/settings'] },
      { question: 'which nest controller calls AuthService', expected_labels: ['AuthController'] },
      { question: 'which next route owns the team settings page', expected_labels: ['/dashboard/[team]'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 4000)
    const crossPlatformSlack = { returned: 1, tokens: 75, lowLevel: 1 }
    const expectedCeilings = new Map([
      ['where is GET /api/users/:id defined', { returned: 12, tokens: 650, lowLevel: 4 }],
      ['which slice owns auth state', { returned: 17, tokens: 850, lowLevel: 10 }],
      ['which route renders settings page', { returned: 17, tokens: 900, lowLevel: 12 }],
      ['which nest controller calls AuthService', { returned: 12, tokens: 650, lowLevel: 6 }],
      ['which next route owns the team settings page', { returned: 25, tokens: 1400, lowLevel: 20 }],
    ])

    expect(report.total_questions).toBe(5)
    expect(report.avg_recall).toBeGreaterThanOrEqual(0.9)
    expect(report.mrr).toBe(1)
    for (const question of report.questions) {
      const ceilings = expectedCeilings.get(question.question)
      expect(ceilings).toBeDefined()
      expect(question.reciprocal_rank).toBe(1)
      expect(question.returned_labels.length).toBeLessThanOrEqual(ceilings!.returned + crossPlatformSlack.returned)
      expect(question.tokens_used).toBeLessThanOrEqual(ceilings!.tokens + crossPlatformSlack.tokens)
    }

    const lowLevelNodeCounts = [
      retrieveContext(graph, { question: 'where is GET /api/users/:id defined', budget: 4000, fileType: 'code' }),
      retrieveContext(graph, { question: 'which slice owns auth state', budget: 4000, fileType: 'code' }),
      retrieveContext(graph, { question: 'which route renders settings page', budget: 4000, fileType: 'code' }),
      retrieveContext(graph, { question: 'which nest controller calls AuthService', budget: 4000, fileType: 'code' }),
      retrieveContext(graph, { question: 'which next route owns the team settings page', budget: 4000, fileType: 'code' }),
    ].map((result) => ({
      question: result.question,
      lowLevel: result.matched_nodes.filter(
        (node) =>
          node.node_kind !== 'route' &&
          node.node_kind !== 'slice' &&
          node.node_kind !== 'store' &&
          node.framework_role !== 'express_route' &&
          node.framework_role !== 'react_router_route' &&
          node.framework_role !== 'nest_controller' &&
          node.framework_role !== 'next_route' &&
          node.framework_role !== 'next_page',
      ).length,
    }))

    for (const result of lowLevelNodeCounts) {
      expect(result.lowLevel).toBeLessThanOrEqual(expectedCeilings.get(result.question)!.lowLevel + crossPlatformSlack.lowLevel)
    }
  })

  it('executes each labeled eval question through the runner and reports provider usage averages', async () => {
    resetRunnerOutputDir()
    const graph = buildTestGraph()
    const executions: Array<{ question: string; mode: string; command: string; promptFile: string; outputFile: string }> = []
    const report = await evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule', 'loginhandler'] },
        { question: 'benchmark-only prompt' },
        { question: 'what is the database layer', expected_labels: ['database'] },
      ],
      3000,
      {
        graphPath: RUNNER_GRAPH_PATH,
        execTemplate: "runner --mode '{mode}' --prompt {prompt_file} --output {output_file}",
        outputDir: RUNNER_OUTPUT_DIR,
        now: new Date('2024-03-04T05:06:07.000Z'),
        runner: async (execution) => {
          executions.push(execution)
          const inputTokens = execution.question.includes('authentication') ? 320 : 180
          const totalTokens = execution.question.includes('authentication') ? 360 : 210
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              result: `Answer for ${execution.question}\n`,
              usage: {
                input_tokens: inputTokens,
                output_tokens: totalTokens - inputTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            }),
            stderr: '',
            elapsedMs: execution.question.includes('authentication') ? 11 : 17,
          }
        },
      },
    )

    expect(executions.map((execution) => execution.question)).toEqual([
      'how does authentication work',
      'what is the database layer',
    ])
    expect(executions.map((execution) => execution.mode)).toEqual(['graphify', 'graphify'])
    expect(executions[0]?.command).toContain('graphify-prompt.txt')
    expect(report.total_questions).toBe(2)
    expect(report.skipped_questions).toBe(1)
    expect(report.avg_recall).toBeGreaterThanOrEqual(0.9)
    expect(report.mrr).toBe(1)
    expect(report.avg_tokens_used).toBe(250)
    expect(report.avg_total_tokens).toBe(285)
    expect(report.questions[0]?.usage?.provider).toBe('claude')
    expect(report.questions[0]?.artifacts?.prompt).toContain('graphify-prompt.txt')
    expect(readFileSync(report.questions[0]!.artifacts!.answer, 'utf8')).toBe('Answer for how does authentication work\n')

    const output = formatQualityReport(report)

    expect(output).toContain('Recall:       100.0%')
    expect(output).toContain('MRR:          1.000')
    expect(output).toContain('Avg input tokens (Claude reported): ~250')
    expect(output).toContain('Avg total tokens (Claude reported): ~285')
    expect(output).not.toContain('estimate fallback')
  })

  it('labels fallback estimates only when structured runner usage is unavailable', async () => {
    resetRunnerOutputDir()
    const graph = buildTestGraph()
    const report = await evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule'] },
        { question: 'what is the database layer', expected_labels: ['database'] },
      ],
      3000,
      {
        graphPath: RUNNER_GRAPH_PATH,
        execTemplate: "runner --mode '{mode}' --prompt {prompt_file} --output {output_file}",
        outputDir: RUNNER_OUTPUT_DIR,
        now: new Date('2024-03-04T05:06:08.000Z'),
        runner: async (execution) => {
          if (execution.question.includes('authentication')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                result: `Answer for ${execution.question}\n`,
                usage: {
                  input_tokens: 400,
                  output_tokens: 70,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 10,
                },
              }),
              stderr: '',
              elapsedMs: 11,
            }
          }

          return {
            exitCode: 0,
            stdout: `Plain answer for ${execution.question}\n`,
            stderr: '',
            elapsedMs: 7,
          }
        },
      },
    )

    expect(report.avg_total_tokens).toBeNull()
    expect(report.questions[0]?.usage?.provider).toBe('claude')
    expect(report.questions[1]?.prompt_token_source).toBe('estimated_cl100k_base')
    expect(readFileSync(report.questions[1]!.artifacts!.answer, 'utf8')).toBe('Plain answer for what is the database layer\n')

    const output = formatQualityReport(report)

    expect(output).toContain(`Avg input tokens (Claude reported where available; cl100k_base estimate fallback): ~${report.avg_tokens_used.toLocaleString()}`)
    expect(output).toContain('Usage capture: Claude reported usage for 1/2 evaluated questions; remaining runs used local estimate fallback')
    expect(output).not.toContain('Avg total tokens (Claude reported)')
  })

  const graphPath = 'graphify-out/graph.json'
  const hasGraph = existsSync(graphPath)
  const demoGraphPath = join(process.cwd(), 'examples', 'demo-repo', 'graphify-out', 'graph.json')
  const demoQuestionsPath = join(process.cwd(), 'examples', 'demo-repo', 'benchmark-questions.json')
  const hasDemoGraph = existsSync(demoGraphPath) && existsSync(demoQuestionsPath)

  it.skipIf(!hasGraph)('every built-in gold label resolves in the repo graph', () => {
    const graph = loadGraph(graphPath)
    const normalize = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '')
    const allNormalized = new Set(graph.nodeEntries().map(([, a]) => normalize(String(a.label ?? ''))))

    for (const gold of GOLD_QUESTIONS) {
      for (const expected of gold.expected_labels) {
        const norm = normalize(expected)
        expect(allNormalized.has(norm), `Gold label "${expected}" (normalized: "${norm}") not found in graph for question: "${gold.question}"`).toBe(true)
      }
    }
  })

  it.skipIf(!hasDemoGraph)('keeps demo benchmark MRR above the CI regression floor', () => {
    const graph = loadGraph(demoGraphPath)
    const questions = JSON.parse(readFileSync(demoQuestionsPath, 'utf8')) as GoldQuestion[]
    const report = evaluateRetrievalQuality(
      graph,
      questions,
      3000,
      { graphPath: realpathSync(demoGraphPath) },
    )

    expect(report.avg_recall).toBeGreaterThanOrEqual(0.9)
    expect(report.avg_snippet_coverage).toBe(1)
    expect(report.mrr).toBeGreaterThanOrEqual(0.95)
  })
})

describe('shared GoValidate pack-quality gate config', () => {
  it('defines explicit label allow/deny lists and pack ceilings for each shared gate entry', () => {
    const gateConfig = JSON.parse(readFileSync(SHARED_PACK_QUALITY_GATES_PATH, 'utf8')) as Record<string, SharedPackQualityGate>
    const entries = Object.entries(gateConfig)

    expect(entries.length).toBeGreaterThan(0)

    for (const [gateName, gate] of entries) {
      expect(gateName.length).toBeGreaterThan(0)
      expect(gate.required_labels.length).toBeGreaterThan(0)
      expect(Array.isArray(gate.forbidden_labels)).toBe(true)
      expect(Number.isFinite(gate.max_pack_tokens)).toBe(true)
      expect(gate.max_pack_tokens).toBeGreaterThan(0)
      expect(Number.isInteger(gate.max_matched_nodes)).toBe(true)
      expect(gate.max_matched_nodes).toBeGreaterThan(0)
      expect(Number.isInteger(gate.max_relationships)).toBe(true)
      expect(gate.max_relationships).toBeGreaterThanOrEqual(0)
    }
  })
})
