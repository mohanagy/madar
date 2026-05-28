import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { type CliDependencies, executeCli, formatHelp } from '../../src/cli/main.js'
import {
  parseAddArgs,
  parseBenchSuiteArgs,
  parseBenchmarkArgs,
  parseCompareArgs,
  parseDoctorArgs,
  parsePackArgs,
  parseDiffArgs,
  parseExplainArgs,
  parseGenerateArgs,
  parseHookArgs,
  parseInstallArgs,
  parsePathArgs,
  parsePlatformActionArgs,
  parsePromptArgs,
  parseQueryArgs,
  parseReviewCompareArgs,
  parseSaveResultArgs,
  parseSummaryArgs,
  parseServeArgs,
  parseTimeTravelArgs,
  parseWatchArgs,
} from '../../src/cli/parser.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'

type GraphSummaryPayload = {
  graph_version?: string
  generated_at?: string
  node_count: number
  edge_count: number
  file_count: number
  community_count: number
  source_domains: Record<string, number>
  top_modules: Array<{ label: string; degree: number }>
  entrypoints: Array<{ label: string; source_file: string }>
  frameworks: string[]
  runtime_paths: Array<{ from: string; to: string; hops: number }>
}

type CliTestDependencies = CliDependencies & {
  runGraphSummary?: (graphPath: string) => GraphSummaryPayload
}

function createIo() {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    io: {
      log(message?: string) {
        logs.push(String(message ?? ''))
      },
      error(message?: string) {
        errors.push(String(message ?? ''))
      },
    },
  }
}

function loadPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: string }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json is missing version')
  }
  return packageJson.version
}

function createDependencies(): CliTestDependencies {
  return {
    loadGraph: (graphPath) => {
      const graph = new KnowledgeGraph()
      if (graphPath.includes('baseline')) {
        graph.addNode('auth', { label: 'AuthService', source_file: graphPath, file_type: 'code', community: 0 })
        graph.addNode('client', { label: 'HttpClient', source_file: graphPath, file_type: 'code', community: 0 })
        graph.addEdge('auth', 'client', { relation: 'calls', confidence: 'EXTRACTED' })
        return graph
      }
      graph.addNode('auth', { label: 'AuthService', source_file: graphPath, file_type: 'code', community: 0 })
      graph.addNode('client', { label: 'HttpClient', source_file: graphPath, file_type: 'code', community: 0 })
      graph.addNode('transport', { label: 'Transport', source_file: graphPath, file_type: 'code', community: 1 })
      graph.addEdge('auth', 'client', { relation: 'calls', confidence: 'EXTRACTED' })
      graph.addEdge('client', 'transport', { relation: 'uses', confidence: 'EXTRACTED' })
      return graph
    },
    queryGraph: (_graph, question, options) => `${question} :: ${options?.mode ?? 'bfs'} :: ${options?.tokenBudget ?? 2000}`,
    saveQueryResult: (question, _answer, memoryDir) => `${memoryDir}/${question}.md`,
    ingest: async (url, targetDir) => `${resolve(targetDir)}/${url.includes('arxiv') ? 'paper.md' : 'page.md'}`,
    runBenchmark: (context) => {
      const resolvedGraphPath = context.options.graphPath
      return {
      corpus_tokens: 1000,
      corpus_words: 750,
      corpus_source: 'manifest',
      nodes: 10,
      edges: 20,
      structure_signals: {
        total_nodes: 10,
        total_edges: 20,
        weakly_connected_components: 2,
        singleton_components: 0,
        isolated_nodes: 0,
        largest_component_nodes: 9,
        largest_component_ratio: 0.9,
        low_cohesion_communities: 1,
        largest_low_cohesion_community_nodes: 10,
        largest_low_cohesion_community_score: 0.12,
      },
      question_count: 5,
      matched_question_count: 5,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: resolvedGraphPath ?? 'out/graph.json',
          query_tokens: 100,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
        },
      ],
      }
    },
    runEval: () => 'madar retrieval quality benchmark\nRecall: 100.0%\ncreate session login',
    runBenchSuite: async () => 'bench suite command is not implemented yet',
    runCompare: async () => 'compare command is not implemented yet',
    runReviewCompare: async () => 'review compare command is not implemented yet',
    runTimeTravel: async () => 'time-travel command is not implemented yet',
    runContextPack: async () => 'context pack command is not implemented yet',
    runContextPrompt: async () => 'context prompt command is not implemented yet',
    runDoctor: (graphPath) => `doctor check for ${graphPath}`,
    runStatus: (graphPath) => `status check for ${graphPath}`,
    confirm: async () => true,
    printBenchmark: () => {},
    installHooks: () => 'hooks installed',
    uninstallHooks: () => 'hooks removed',
    hookStatus: () => 'post-commit: installed\npost-checkout: installed',
    geminiInstall: () => 'gemini local rules installed',
    geminiUninstall: () => 'gemini local rules removed',
    installSkill: (platform) => `installed ${platform}`,
    uninstallSkill: (platform) => `removed ${platform}`,
    cursorInstall: () => 'cursor local rules installed',
    cursorUninstall: () => 'cursor local rules removed',
    installCopilotMcp: () => 'copilot mcp installed',
    uninstallCopilotMcp: () => 'copilot mcp removed',
    pushGraphToNeo4j: async (_graph, options) => ({
      uri: options.uri,
      database: options.database ?? 'neo4j',
      nodes: 3,
      edges: 2,
    }),
    generateGraph: (rootPath = '.', options = {}) => ({
      mode: options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate',
      rootPath: resolve(rootPath),
      outputDir: resolve(rootPath, 'out'),
      graphPath: resolve(rootPath, 'out', 'graph.json'),
      reportPath: resolve(rootPath, 'out', 'GRAPH_REPORT.md'),
      htmlPath: options.noHtml ? null : resolve(rootPath, 'out', 'graph.html'),
      wikiPath: options.wiki ? resolve(rootPath, 'out', 'wiki') : null,
      obsidianPath: options.obsidian ? resolve(options.obsidianDir ?? resolve(rootPath, 'out', 'obsidian')) : null,
      svgPath: options.svg ? resolve(rootPath, 'out', 'graph.svg') : null,
      graphmlPath: options.graphml ? resolve(rootPath, 'out', 'graph.graphml') : null,
      cypherPath: options.neo4j ? resolve(rootPath, 'out', 'cypher.txt') : null,
      docsPath: null,
      totalFiles: 3,
      codeFiles: 2,
      nonCodeFiles: 1,
      extractableFiles: 3,
      extractedFiles: options.useSpi ? 2 : 3,
      totalWords: 120,
      nodeCount: 5,
      edgeCount: 4,
      communityCount: 2,
      semanticAnomalyCount: 2,
      changedFiles: options.update ? 1 : 0,
      deletedFiles: 0,
      cache: options.useSpi ? { strategy: 'spi', hit: false, reason: 'no-cache', fileCount: 2 } : null,
      warning: null,
      notes: ['test note'],
    }),
    watchGraph: async () => {},
    serveGraph: async () => {},
    serveGraphStdio: async () => {},
    claudeInstall: () => 'claude local rules installed',
    claudeUninstall: () => 'claude local rules removed',
    agentsInstall: (_projectDir, platform) => `${platform} local rules installed`,
    agentsUninstall: (_projectDir, platform) => `${platform} local rules removed`,
  }
}

function withGraphPathSandbox(testName: string, run: (paths: { relativeGraphPath: string; resolvedGraphPath: string }) => void) {
  const originalCwd = process.cwd()
  const sandboxRoot = resolve('out', 'test-runtime', testName)
  const relativeGraphPath = 'out/custom.json'
  const graphPath = resolve(sandboxRoot, relativeGraphPath)

  rmSync(sandboxRoot, { recursive: true, force: true })
  mkdirSync(resolve(sandboxRoot, 'out'), { recursive: true })
  writeFileSync(graphPath, '{}\n', 'utf8')

  try {
    process.chdir(sandboxRoot)
    run({
      relativeGraphPath,
      resolvedGraphPath: realpathSync(graphPath),
    })
  } finally {
    process.chdir(originalCwd)
    rmSync(sandboxRoot, { recursive: true, force: true })
  }
}

describe('cli parser', () => {
  it('parses query args with defaults and overrides', () => {
    expect(parseQueryArgs(['how does auth work'])).toEqual({
      question: 'how does auth work',
      mode: 'bfs',
      tokenBudget: 2000,
      graphPath: 'out/graph.json',
      rankBy: 'relevance',
      community: null,
      fileType: null,
    })

    expect(
      parseQueryArgs(['show flow', '--dfs', '--budget', '1500', '--graph', 'custom.json', '--rank-by', 'degree', '--community', '0', '--file-type', 'code']),
    ).toEqual({
      question: 'show flow',
      mode: 'dfs',
      tokenBudget: 1500,
      graphPath: 'custom.json',
      rankBy: 'degree',
      community: 0,
      fileType: 'code',
    })
  })

  it('rejects invalid query args', () => {
    expect(() => parseQueryArgs([])).toThrow('Usage: madar query')
    expect(() => parseQueryArgs(['test', '--budget', 'abc'])).toThrow('error: --budget must be a positive integer')
    expect(() => parseQueryArgs(['test', '--budget', '100001'])).toThrow('error: --budget must be <= 100000')
    expect(() => parseQueryArgs(['test', '--rank-by', 'centrality'])).toThrow('error: --rank-by must be one of relevance, degree')
    expect(() => parseQueryArgs(['test', '--community', '-1'])).toThrow('error: --community must be a non-negative integer')
    expect(() => parseQueryArgs(['test', '--wat'])).toThrow('error: unknown option for query: --wat')
  })

  it('parses pack args with defaults and overrides', () => {
    expect(parsePackArgs(['how does auth work', '--budget', '1800', '--task', 'explain'])).toEqual({
      prompt: 'how does auth work',
      budget: 1800,
      task: 'explain',
      taskExplicit: true,
      graphPath: 'out/graph.json',
    })
  })

  it('parses explicit implement task selection for pack', () => {
    expect(parsePackArgs(['implement auth session invalidation', '--task', 'implement'])).toEqual({
      prompt: 'implement auth session invalidation',
      budget: 3000,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
    })
  })

  it('parses pack args with --why', () => {
    expect(parsePackArgs(['how does auth work', '--why'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      why: true,
    })
  })

  it('parses pack args with generic and agent-specific formats', () => {
    expect(parsePackArgs(['how does auth work', '--format', 'text'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      format: 'text',
    })
    expect(parsePackArgs(['how does auth work', '--format', 'markdown'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      format: 'markdown',
    })
    expect(parsePackArgs(['how does auth work', '--format', 'claude'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      format: 'claude',
    })
    expect(parsePackArgs(['how does auth work', '--format', 'copilot'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      format: 'copilot',
    })
    expect(parsePackArgs(['how does auth work', '--format=json'])).toEqual({
      prompt: 'how does auth work',
      budget: 3000,
      task: 'explain',
      graphPath: 'out/graph.json',
      format: 'json',
    })
  })

  it('rejects invalid pack args', () => {
    expect(() => parsePackArgs([])).toThrow('Usage: madar pack')
    expect(() => parsePackArgs(['how does auth work', '--budget', '0'])).toThrow('error: --budget must be a positive integer')
    expect(() => parsePackArgs(['how does auth work', '--budget', '100001'])).toThrow('error: --budget must be <= 100000')
    expect(() => parsePackArgs(['how does auth work', '--task', 'summarize'])).toThrow('error: --task must be one of explain, implement, review, impact')
    expect(() => parsePackArgs(['how does auth work', '--format', 'yaml'])).toThrow('error: --format must be one of json, text, markdown, claude, copilot')
    expect(() => parsePackArgs(['how does auth work', '--wat'])).toThrow('error: unknown option for pack: --wat')
  })

  it('parses prompt args with defaults and overrides', () => {
    expect(parsePromptArgs(['how does auth work', '--provider', 'claude'])).toEqual({
      prompt: 'how does auth work',
      provider: 'claude',
      graphPath: 'out/graph.json',
    })
  })

  it('rejects invalid prompt args', () => {
    expect(() => parsePromptArgs([])).toThrow('Usage: madar prompt')
    expect(() => parsePromptArgs(['how does auth work'])).toThrow('error: --provider is required')
    expect(() => parsePromptArgs(['how does auth work', '--provider', 'openai'])).toThrow('error: --provider must be one of claude, gemini')
    expect(() => parsePromptArgs(['how does auth work', '--wat'])).toThrow('error: unknown option for prompt: --wat')
  })

  it('validates explicit graph paths for pack and prompt commands with the shared graph helper', () => {
    withGraphPathSandbox('context-cli-graph-paths', ({ relativeGraphPath, resolvedGraphPath }) => {
      expect(parsePackArgs(['review current diff', '--task=review', '--graph', relativeGraphPath])).toEqual({
        prompt: 'review current diff',
        budget: 3000,
        task: 'review',
        taskExplicit: true,
        graphPath: resolvedGraphPath,
      })

      expect(parsePromptArgs(['review current diff', '--provider=gemini', '--graph', relativeGraphPath])).toEqual({
        prompt: 'review current diff',
        provider: 'gemini',
        graphPath: resolvedGraphPath,
      })

      expect(() => parsePackArgs(['review current diff', '--graph', '../../../outside/graph.json'])).toThrow(
        'Only paths inside out/ are permitted',
      )
      expect(() => parsePromptArgs(['review current diff', '--provider', 'claude', '--graph', '../../../outside/graph.json'])).toThrow(
        'Only paths inside out/ are permitted',
      )
    })
  })

  it('parses path args with defaults and overrides', () => {
    expect(parsePathArgs(['AuthService', 'Transport'])).toEqual({
      source: 'AuthService',
      target: 'Transport',
      graphPath: 'out/graph.json',
      maxHops: 8,
    })

    expect(parsePathArgs(['AuthService', 'Transport', '--graph', 'custom.json', '--max-hops', '4'])).toEqual({
      source: 'AuthService',
      target: 'Transport',
      graphPath: 'custom.json',
      maxHops: 4,
    })

    expect(() => parsePathArgs(['AuthService'])).toThrow('Usage: madar path')
    expect(() => parsePathArgs(['AuthService', 'Transport', '--wat'])).toThrow('error: unknown option for path: --wat')
    expect(() => parsePathArgs(['AuthService', 'Transport', '--max-hops', '99'])).toThrow('error: --max-hops must be <= 20')
  })

  it('parses explain args', () => {
    expect(parseExplainArgs(['HttpClient'])).toEqual({
      label: 'HttpClient',
      graphPath: 'out/graph.json',
      relation: '',
    })

    expect(parseExplainArgs(['HttpClient', '--graph=custom.json', '--relation', 'calls'])).toEqual({
      label: 'HttpClient',
      graphPath: 'custom.json',
      relation: 'calls',
    })

    expect(() => parseExplainArgs([])).toThrow('Usage: madar explain')
    expect(() => parseExplainArgs(['HttpClient', '--wat'])).toThrow('error: unknown option for explain: --wat')
    expect(() => parseExplainArgs([`H${'x'.repeat(512)}`])).toThrow('error: label exceeds maximum length of 512 characters')
  })

  it('parses diff args', () => {
    expect(parseDiffArgs(['baseline.json'])).toEqual({
      baselineGraphPath: 'baseline.json',
      graphPath: 'out/graph.json',
      limit: 10,
    })

    expect(parseDiffArgs(['baseline.json', '--graph', 'current.json', '--limit', '5'])).toEqual({
      baselineGraphPath: 'baseline.json',
      graphPath: 'current.json',
      limit: 5,
    })

    expect(() => parseDiffArgs([])).toThrow('Usage: madar diff')
    expect(() => parseDiffArgs(['baseline.json', '--limit', '0'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseDiffArgs(['baseline.json', '--limit', '1.5'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseDiffArgs(['baseline.json', '--limit', '1e2'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseDiffArgs(['baseline.json', '--limit=0x10'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseDiffArgs(['baseline.json', '--limit=5abc'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseDiffArgs([`/${'nested/'.repeat(700)}baseline.json`])).toThrow('error: baseline graph path exceeds maximum length')
    expect(() => parseDiffArgs(['baseline.json', '--wat'])).toThrow('error: unknown option for diff: --wat')
  })

  it('parses add args', () => {
    expect(parseAddArgs(['https://example.com/post'])).toEqual({
      url: 'https://example.com/post',
      path: '.',
      followSymlinks: false,
      noHtml: false,
    })

    expect(parseAddArgs(['https://example.com/post', 'docs', '--follow-symlinks', '--no-html'])).toEqual({
      url: 'https://example.com/post',
      path: 'docs',
      followSymlinks: true,
      noHtml: true,
    })

    expect(() => parseAddArgs([])).toThrow('Usage: madar add')
    expect(() => parseAddArgs(['https://example.com/post', 'docs', 'extra'])).toThrow('Usage: madar add')
    expect(() => parseAddArgs(['https://example.com/post', '--wat'])).toThrow('error: unknown option for add: --wat')
  })

  it('parses save-result args', () => {
    expect(parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--type', 'explain', '--nodes', 'n1', 'n2', '--memory-dir', 'out/mem'])).toEqual({
      question: 'Q',
      answer: 'A',
      queryType: 'explain',
      sourceNodes: ['n1', 'n2'],
      memoryDir: resolve('out/mem'),
    })
  })

  it('rejects invalid save-result args', () => {
    expect(() => parseSaveResultArgs(['--question', 'Q'])).toThrow('Usage: madar save-result')
    expect(() => parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--wat'])).toThrow('error: unknown option for save-result: --wat')
    expect(() => parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--memory-dir', '../tmp'])).toThrow('Only paths inside out/ are permitted')
  })

  it('parses benchmark args', () => {
    expect(parseBenchmarkArgs(['--exec', 'claude -p "$(cat {prompt_file})"'])).toEqual({
      graphPath: 'out/graph.json',
      questionsPath: null,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      yes: false,
    })
    expect(parseBenchmarkArgs(['custom.json', '--exec', 'claude -p "$(cat {prompt_file})"'])).toEqual({
      graphPath: 'custom.json',
      questionsPath: null,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      yes: false,
    })
    expect(parseBenchmarkArgs(['custom.json', '--questions', 'tests/fixtures/workspace-parity-questions.json', '--exec', 'claude -p "$(cat {prompt_file})"', '--yes'])).toEqual({
      graphPath: 'custom.json',
      questionsPath: 'tests/fixtures/workspace-parity-questions.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      yes: true,
    })
    expect(parseBenchmarkArgs(['--questions=tests/fixtures/workspace-parity-questions.json', '--exec=claude -p "$(cat {prompt_file})"'])).toEqual({
      graphPath: 'out/graph.json',
      questionsPath: 'tests/fixtures/workspace-parity-questions.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      yes: false,
    })
    expect(() => parseBenchmarkArgs([])).toThrow('error: --exec is required')
    expect(() => parseBenchmarkArgs([], 'eval')).toThrow('error: --exec is required')
    expect(() => parseBenchmarkArgs(['one.json', 'two.json', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('Usage: madar benchmark')
    expect(() => parseBenchmarkArgs(['--questions', '--wat'])).toThrow('error: --questions requires a value')
    expect(() => parseBenchmarkArgs(['--exec', '--wat'])).toThrow('error: --exec requires a value')
    expect(() => parseBenchmarkArgs(['custom.json', '--wat'])).toThrow('error: unknown option for benchmark: --wat')
  })

  it('parses bench:suite args', () => {
    expect(parseBenchSuiteArgs(['--dry-run'])).toEqual({
      repo: null,
      task: null,
      mode: 'all',
      trials: 3,
      outputDir: resolve('docs/benchmarks/suite/results'),
      execTemplate: '',
      dryRun: true,
      yes: false,
    })
    expect(parseBenchSuiteArgs([
      '--exec',
      'claude -p "$(cat {prompt_file})"',
      '--repo',
      'nestjs-mid',
      '--task',
      'explain-runtime',
      '--mode',
      'warm',
      '--trials',
      '5',
      '--output-dir',
      'docs/benchmarks/suite/results/custom',
      '--yes',
    ])).toEqual({
      repo: 'nestjs-mid',
      task: 'explain-runtime',
      mode: 'warm',
      trials: 5,
      outputDir: resolve('docs/benchmarks/suite/results/custom'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      dryRun: false,
      yes: true,
    })
    expect(() => parseBenchSuiteArgs([])).toThrow('error: --exec is required unless --dry-run is set')
    expect(() => parseBenchSuiteArgs(['--mode', 'weird', '--dry-run'])).toThrow('error: --mode must be one of cold, warm, all')
    expect(() => parseBenchSuiteArgs(['--trials', '0', '--dry-run'])).toThrow('error: --trials must be a positive integer')
    expect(() => parseBenchSuiteArgs(['--wat', '--dry-run'])).toThrow('error: unknown option for bench:suite: --wat')
  })

  it('parses compare args with a question or question file', () => {
    expect(parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"'])).toEqual({
      question: 'how does login work',
      graphPath: 'out/graph.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      questionsPath: null,
      outputDir: resolve('out/compare'),
      baselineMode: 'full',
      perArmTimeoutSeconds: 600,
      heartbeatIntervalMs: 30000,
      strictMadarFirst: false,
      allowNoInstall: false,
      yes: false,
      limit: null,
    })

    expect(parseCompareArgs(['--questions', 'benchmark-questions.json', '--exec', 'gemini -p "$(cat {prompt_file})"'])).toEqual({
      question: null,
      graphPath: 'out/graph.json',
      execTemplate: 'gemini -p "$(cat {prompt_file})"',
      questionsPath: 'benchmark-questions.json',
      outputDir: resolve('out/compare'),
      baselineMode: 'full',
      perArmTimeoutSeconds: 600,
      heartbeatIntervalMs: 30000,
      strictMadarFirst: false,
      allowNoInstall: false,
      yes: false,
      limit: null,
    })
  })

  it('parses compare args with optional overrides', () => {
    expect(
      parseCompareArgs([
        'how does login work',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
        '--graph',
        'custom.json',
        '--output-dir',
        'out/compare/custom',
        '--baseline-mode',
        'bounded',
        '--per-arm-timeout',
        '900',
        '--heartbeat-interval-ms',
        '15000',
        '--strict-madar-first',
        '--allow-no-install',
        '--yes',
        '--limit',
        '5',
      ]),
    ).toEqual({
      question: 'how does login work',
      graphPath: 'custom.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      questionsPath: null,
      outputDir: resolve('out/compare/custom'),
      baselineMode: 'bounded',
      perArmTimeoutSeconds: 900,
      heartbeatIntervalMs: 15000,
      strictMadarFirst: true,
      allowNoInstall: true,
      yes: true,
      limit: 5,
    })
  })

  it('parses compare args with pack_only baseline mode', () => {
    expect(
      parseCompareArgs([
        'how does login work',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
        '--baseline-mode',
        'pack_only',
      ]),
    ).toEqual({
      question: 'how does login work',
      graphPath: 'out/graph.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      questionsPath: null,
      outputDir: resolve('out/compare'),
      baselineMode: 'pack_only',
      perArmTimeoutSeconds: 600,
      heartbeatIntervalMs: 30000,
      strictMadarFirst: false,
      allowNoInstall: false,
      yes: false,
      limit: null,
    })
  })

  it('parses compare args with --why', () => {
    expect(
    parseCompareArgs([
      'how does login work',
      '--exec',
      'claude -p "$(cat {prompt_file})"',
      '--why',
    ]),
    ).toEqual({
    question: 'how does login work',
    graphPath: 'out/graph.json',
    execTemplate: 'claude -p "$(cat {prompt_file})"',
    questionsPath: null,
    outputDir: resolve('out/compare'),
    baselineMode: 'full',
    perArmTimeoutSeconds: 600,
    heartbeatIntervalMs: 30000,
    strictMadarFirst: false,
    allowNoInstall: false,
    yes: false,
    limit: null,
    why: true,
    })
  })

  it('rejects invalid compare args', () => {
    expect(() => parseCompareArgs(['how does login work'])).toThrow('error: --exec is required')
    expect(() => parseCompareArgs(['how does login work', '--questions', 'benchmark-questions.json', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow(
      'error: compare accepts either a positional question or --questions, but not both',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--limit', '1.5'])).toThrow(
      'error: --limit must be a positive integer',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--limit', '1e2'])).toThrow(
      'error: --limit must be a positive integer',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--limit=0x10'])).toThrow(
      'error: --limit must be a positive integer',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--limit=5abc'])).toThrow(
      'error: --limit must be a positive integer',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--output-dir', '../outside'])).toThrow(
      'Only paths inside out/ are permitted',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--per-arm-timeout', '0'])).toThrow(
      'error: --per-arm-timeout must be a positive integer',
    )
    expect(() => parseCompareArgs(['how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--heartbeat-interval-ms', '-1'])).toThrow(
      'error: --heartbeat-interval-ms must be a non-negative integer',
    )
    expect(() => parseCompareArgs(['   ', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('--allow-no-install')
    expect(() => parseCompareArgs(['--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('--allow-no-install')
  })

  it('parses review-compare args with optional overrides', () => {
    const externalOutputDir = resolve('/tmp', 'madar-review-compare-external')

    expect(parseReviewCompareArgs(['--exec', 'claude -p "$(cat {prompt_file})"'])).toEqual({
      graphPath: 'out/graph.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      outputDir: resolve('out/review-compare'),
      baseBranch: null,
      budget: null,
      yes: false,
    })

    expect(parseReviewCompareArgs([
      'custom.json',
      '--exec',
      'gemini -p "$(cat {prompt_file})"',
      '--output-dir',
      'out/review-compare/custom',
      '--base-branch',
      'origin/main',
      '--budget',
      '1800',
      '--yes',
    ])).toEqual({
      graphPath: 'custom.json',
      execTemplate: 'gemini -p "$(cat {prompt_file})"',
      outputDir: resolve('out/review-compare/custom'),
      baseBranch: 'origin/main',
      budget: 1800,
      yes: true,
    })

    expect(parseReviewCompareArgs([
      '/tmp/graph.json',
      '--exec',
      'gemini -p "$(cat {prompt_file})"',
      '--output-dir',
      externalOutputDir,
    ])).toEqual({
      graphPath: '/tmp/graph.json',
      execTemplate: 'gemini -p "$(cat {prompt_file})"',
      outputDir: externalOutputDir,
      baseBranch: null,
      budget: null,
      yes: false,
    })
  })

  it('rejects invalid review-compare args', () => {
    expect(() => parseReviewCompareArgs([])).toThrow('error: --exec is required')
    expect(() => parseReviewCompareArgs(['one.json', 'two.json', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('Usage: madar review-compare')
    expect(() => parseReviewCompareArgs(['--budget', '1.5', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('error: --budget must be a positive integer')
    expect(() => parseReviewCompareArgs(['--budget', '100001', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('error: --budget must be <= 100000')
    expect(() => parseReviewCompareArgs(['--output-dir', '../outside', '--exec', 'claude -p "$(cat {prompt_file})"'])).toThrow('Only paths inside out/ are permitted')
  })

  it.each([
    { args: ['main', 'HEAD'], view: 'summary' as const },
    { args: ['main', 'HEAD', '--view', 'risk'], view: 'risk' as const },
    { args: ['main', 'HEAD', '--view=drift'], view: 'drift' as const },
    { args: ['main', 'HEAD', '--view=timeline'], view: 'timeline' as const },
  ])('parses time-travel args for $view view', ({ args, view }) => {
    expect(parseTimeTravelArgs(args)).toEqual({
      fromRef: 'main',
      toRef: 'HEAD',
      view,
      json: false,
      refresh: false,
      limit: 10,
    })
  })

  it('parses time-travel args with equals syntax for view and limit', () => {
    expect(parseTimeTravelArgs(['main', 'HEAD', '--view=risk', '--json', '--refresh', '--limit=3'])).toEqual({
      fromRef: 'main',
      toRef: 'HEAD',
      view: 'risk',
      json: true,
      refresh: true,
      limit: 3,
    })
  })

  it('rejects invalid time-travel args', () => {
    expect(() => parseTimeTravelArgs([])).toThrow('Usage: madar time-travel <from> <to>')
    expect(() => parseTimeTravelArgs(['main'])).toThrow('Usage: madar time-travel <from> <to>')
    expect(() => parseTimeTravelArgs(['  ', 'HEAD'])).toThrow('Usage: madar time-travel <from> <to>')
    expect(() => parseTimeTravelArgs(['main', 'HEAD', 'extra'])).toThrow('Usage: madar time-travel <from> <to>')
    expect(() => parseTimeTravelArgs(['main', 'HEAD', '--view', 'weird'])).toThrow(
      'error: --view must be one of summary, risk, drift, timeline',
    )
    expect(() => parseTimeTravelArgs(['main', 'HEAD', '--limit', '-1'])).toThrow(
      'error: --limit must be a positive integer',
    )
    expect(() => parseTimeTravelArgs(['main', 'HEAD', '--limit=0'])).toThrow('error: --limit must be a positive integer')
    expect(() => parseTimeTravelArgs(['main', 'HEAD', '--limit', 'abc'])).toThrow(
      'error: --limit must be a positive integer',
    )
  })

  it('parses generate args', () => {
    expect(parseGenerateArgs([])).toEqual({
      path: '.',
      update: false,
      clusterOnly: false,
      watch: false,
      directed: false,
      followSymlinks: false,
      debounceSeconds: 3,
      noHtml: false,
      wiki: false,
      obsidian: false,
      obsidianDir: null,
      svg: false,
      graphml: false,
      neo4j: false,
      neo4jPushUri: null,
      neo4jUser: null,
      neo4jPassword: null,
      neo4jDatabase: null,
      includeDocs: false,
      docs: false,
      useSpi: false,
    })

    expect(
      parseGenerateArgs([
        'src',
        '--update',
        '--watch',
        '--directed',
        '--follow-symlinks',
        '--debounce',
        '1.5',
        '--no-html',
        '--wiki',
        '--obsidian',
        '--obsidian-dir',
        'vault',
        '--svg',
        '--graphml',
        '--neo4j',
        '--neo4j-push',
        'bolt://localhost:7687',
        '--neo4j-user',
        'neo4j',
        '--neo4j-password',
        'secret',
        '--neo4j-database',
        'madar',
      ]),
    ).toEqual({
      path: 'src',
      update: true,
      clusterOnly: false,
      watch: true,
      directed: true,
      followSymlinks: true,
      debounceSeconds: 1.5,
      noHtml: true,
      wiki: true,
      obsidian: true,
      obsidianDir: 'vault',
      svg: true,
      graphml: true,
      neo4j: true,
      neo4jPushUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'secret',
      neo4jDatabase: 'madar',
      includeDocs: false,
      docs: false,
      useSpi: false,
    })

    expect(() => parseGenerateArgs(['src', 'other'])).toThrow('Usage: madar generate')
    expect(() => parseGenerateArgs(['--update', '--cluster-only'])).toThrow('cannot be used together')
  })

  it('parses watch args', () => {
    expect(parseWatchArgs(['src', '--follow-symlinks', '--debounce=2', '--no-html'])).toEqual({
      path: 'src',
      followSymlinks: true,
      debounceSeconds: 2,
      noHtml: true,
    })

    expect(() => parseWatchArgs(['src', 'other'])).toThrow('Usage: madar watch')
  })

  it('parses serve args', () => {
    expect(parseServeArgs([])).toEqual({
      graphPath: 'out/graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'http',
    })

    expect(parseServeArgs(['custom.json', '--host', '0.0.0.0', '--port', '8080'])).toEqual({
      graphPath: 'custom.json',
      host: '0.0.0.0',
      port: 8080,
      transport: 'http',
    })

    expect(parseServeArgs(['graph.json', '--mcp'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'stdio',
    })

    expect(parseServeArgs(['graph.json', '--transport', 'stdio'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'stdio',
    })

    expect(parseServeArgs(['graph.json', '--http'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'http',
    })

    expect(() => parseServeArgs(['--port', '70000'])).toThrow('must be between 0 and 65535')
    expect(() => parseServeArgs(['--transport', 'socket'])).toThrow('error: --transport must be one of http, stdio')
  })

  it('parses doctor and status args', () => {
    expect(parseDoctorArgs([])).toEqual({ graphPath: 'out/graph.json' })
    expect(parseDoctorArgs(['out/custom.json'])).toEqual({ graphPath: 'out/custom.json' })
    expect(parseDoctorArgs(['--graph', 'out/runtime.json'])).toEqual({ graphPath: 'out/runtime.json' })
    expect(parseDoctorArgs(['--graph=out/runtime.json'], 'status')).toEqual({ graphPath: 'out/runtime.json' })
    expect(() => parseDoctorArgs(['--wat'])).toThrow('error: unknown option for doctor: --wat')
    expect(() => parseDoctorArgs(['--wat'], 'status')).toThrow('error: unknown option for status: --wat')
  })

  it('parses hook args', () => {
    expect(parseHookArgs(['install'])).toEqual({ action: 'install' })
    expect(parseHookArgs(['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parseHookArgs(['status'])).toEqual({ action: 'status' })
    expect(() => parseHookArgs([])).toThrow('Usage: madar hook <install|uninstall|status>')
  })

  it('parses install args and platform actions', () => {
    expect(parseInstallArgs([], 'claude')).toEqual({ platform: 'claude' })
    expect(parseInstallArgs(['--platform', 'aider'], 'claude')).toEqual({ platform: 'aider' })
    expect(parseInstallArgs(['--platform', 'gemini'], 'claude')).toEqual({ platform: 'gemini' })
    expect(parseInstallArgs(['--platform', 'codex'], 'claude')).toEqual({ platform: 'codex' })
    expect(parseInstallArgs(['--platform=copilot'], 'claude')).toEqual({ platform: 'copilot' })
    expect(parseInstallArgs(['--platform=cursor'], 'claude')).toEqual({ platform: 'cursor' })
    expect(parseInstallArgs(['--platform=windows'], 'claude')).toEqual({ platform: 'windows' })
    expect(() => parseInstallArgs(['--platform', 'unknown'], 'claude')).toThrow("error: unknown platform 'unknown'")

    expect(parsePlatformActionArgs('claude', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('claude', ['install', '--profile', 'full'])).toEqual({ action: 'install', profile: 'full' })
    expect(parsePlatformActionArgs('claude', ['install', '--profile', 'strict'])).toEqual({ action: 'install', profile: 'strict' })
    expect(parsePlatformActionArgs('aider', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('gemini', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('gemini', ['install', '--profile', 'strict'])).toEqual({ action: 'install', profile: 'strict' })
    expect(parsePlatformActionArgs('copilot', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parsePlatformActionArgs('cursor', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parsePlatformActionArgs('codex', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(() => parsePlatformActionArgs('claude', ['install', '--profile', 'wide'])).toThrow('error: --profile must be one of core, full, strict')
    expect(() => parsePlatformActionArgs('claude', ['uninstall', '--profile', 'full'])).toThrow('Usage: madar claude <install|uninstall> [--profile core|full|strict]')
    expect(() => parsePlatformActionArgs('trae', [])).toThrow('Usage: madar trae <install|uninstall>')
  })
})

describe('cli main', () => {
  it('prints help for empty args', async () => {
    const { io, logs, errors } = createIo()

    const exitCode = await executeCli([], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(errors).toHaveLength(0)
    expect(logs[0]).toContain('Usage: madar <command>')
  })

  it('prints the package version for --version and -v', async () => {
    const expectedVersion = loadPackageVersion()
    const longFlag = createIo()
    const shortFlag = createIo()

    await expect(executeCli(['--version'], longFlag.io, createDependencies())).resolves.toBe(0)
    await expect(executeCli(['-v'], shortFlag.io, createDependencies())).resolves.toBe(0)

    expect(longFlag.errors).toHaveLength(0)
    expect(shortFlag.errors).toHaveLength(0)
    expect(longFlag.logs).toEqual([expectedVersion])
    expect(shortFlag.logs).toEqual([expectedVersion])
  })

  it('returns a controlled error when resolving the installed version fails', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies() as CliDependencies & { readInstalledVersion: () => string }

    dependencies.readInstalledVersion = () => {
      throw new Error('missing package metadata')
    }

    const exitCode = await executeCli(['--version'], io, dependencies)

    expect(exitCode).toBe(1)
    expect(logs).toEqual([])
    expect(errors).toEqual(['error: missing package metadata'])
  })

  it('prints an available update notice before normal command output', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies() as CliDependencies & { notifyUpdate: () => Promise<string | null> }

    dependencies.notifyUpdate = async () => 'A newer madar is available: 0.22.8 -> 0.22.9'

    const exitCode = await executeCli(['query', 'how does auth work'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(errors).toEqual([])
    expect(logs[0]).toBe('A newer madar is available: 0.22.8 -> 0.22.9')
    expect(logs[1]).toBe('how does auth work :: bfs :: 2000')
  })

  it('skips the update notifier for help, version, and --json output', async () => {
    const help = createIo()
    const version = createIo()
    const json = createIo()
    const dependencies = createDependencies() as CliDependencies & { notifyUpdate: () => Promise<string | null> }
    let notifyCalls = 0

    dependencies.notifyUpdate = async () => {
      notifyCalls += 1
      return 'A newer madar is available: 0.22.8 -> 0.22.9'
    }

    await expect(executeCli(['--help'], help.io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['--version'], version.io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['time-travel', 'HEAD~1', 'HEAD', '--json'], json.io, dependencies)).resolves.toBe(0)

    expect(notifyCalls).toBe(0)
    expect(help.logs[0]).toContain('Usage: madar <command>')
    expect(version.logs).toEqual([loadPackageVersion()])
  })

  it('formats help text with supported commands', () => {
    const help = formatHelp()
    expect(help).toContain('--help')
    expect(help).toContain('--version')
    expect(help).toContain('generate [path]')
    expect(help).toContain('watch [path]')
    expect(help).toContain('serve [graph.json]')
    expect(help).toContain('--directed')
    expect(help).toContain('--wiki')
    expect(help).toContain('--obsidian')
    expect(help).toContain('--svg')
    expect(help).toContain('--graphml')
    expect(help).toContain('--allow-no-install')
    expect(help).toContain('--neo4j')
    expect(help).toContain('--neo4j-push')
    expect(help).toContain('--transport')
    expect(help).toContain('--http')
    expect(help).toContain('--stdio')
    expect(help).toContain('--mcp')
    expect(help).toContain('query "<question>"')
    expect(help).toContain('diff <baseline-graph.json>')
    expect(help).toContain('--rank-by MODE')
    expect(help).toContain('--community ID')
    expect(help).toContain('--file-type TYPE')
    expect(help).toContain('path <source> <target>')
    expect(help).toContain('explain <label>')
    expect(help).toContain('add <url> [path]')
    expect(help).toContain('save-result')
    expect(help).toContain('benchmark [graph.json]')
    expect(help).toContain('benchmark/eval runner. This may consume paid model tokens.')
    expect(help).toContain('    --exec TEMPLATE       required command template; supports {prompt_file}, {question}, {mode}, and {output_file}')
    expect(help).toContain('--questions PATH')
    expect(help).toContain('    --yes                 skip confirmation before running the paid benchmark/eval prompts')
    expect(help).toContain('bench:suite')
    expect(help).toContain('docs/benchmarks/suite/results/')
    expect(help).toContain('    --dry-run             list planned and runnable suite cells without executing prompts')
    expect(help).toContain('eval [graph.json]')
    expect(help).toContain('compare [question]    run a real baseline vs madar prompt comparison')
    expect(help).toContain('    --format MODE       json|text|markdown|claude|copilot (default json)')
    expect(help).toContain('    --graph <path>        path to graph.json (default out/graph.json)')
    expect(help).toContain('    --exec TEMPLATE       required command template; supports {prompt_file}, {question}, {mode}, and {output_file}')
    expect(help).toContain('    --questions PATH      load questions from a JSON file instead of a positional question')
    expect(help).toContain('    --output-dir DIR      compare output directory (default out/compare)')
    expect(help).toContain('    --baseline-mode MODE  full | bounded | pack_only | native_agent (default full; pack_only compares one bounded raw-context prompt against one compiled madar pack; native_agent runs --exec twice, uses Anthropic JSON usage when available, and otherwise saves answer-only artifacts)')
    expect(help).toContain('      For Claude MCP attribution in native_agent mode, include --verbose with --output-format json')
    expect(help).toContain('    --per-arm-timeout S   per-arm timeout seconds for native_agent runs (default 600)')
    expect(help).toContain('    --heartbeat-interval-ms N  stderr heartbeat interval for native_agent runs (default 30000; 0 disables)')
    expect(help).toContain('    --strict-madar-first  treat pre-Madar broad exploration as degraded/non-winning in native_agent mode')
    expect(help).toContain('    --yes                 skip confirmation before running the paid prompt comparison')
    expect(help).toContain('    --limit N             cap processed prompts/questions for the comparison run')
    expect(help).toContain('    --why                 include retrieval-routing debug metadata in the compare summary and reports')
    expect(help).toContain('review-compare [graph.json] compare full vs compact pr_impact review prompts on the current git diff')
    expect(help).toContain('    --output-dir DIR      review compare output directory (default out/review-compare)')
    expect(help).toContain('time-travel <from> <to> compare two refs using on-demand cached graph snapshots')
    expect(help).toContain('    --view MODE          summary|risk|drift|timeline (default summary)')
    expect(help).toContain('    --json               emit machine-readable JSON')
    expect(help).toContain('    --refresh            rebuild snapshots instead of using cache')
    expect(help).toContain('    --limit N            cap view items (default 10)')
    expect(help).toContain('doctor [graph.json]')
    expect(help).toContain('status [graph.json]')
    expect(help).toContain('check graph freshness, agent config, and MCP wiring')
    expect(help).toContain('question coverage')
    expect(help).toContain('hook <action>')
    expect(help).toContain('install [--platform P]')
    expect(help).toContain('If you update madar, re-run your platform install command to refresh local agent rules:')
    expect(help).toContain('madar install --platform <platform>')
    expect(help).toContain('aider <install|uninstall>')
    expect(help).toContain('claude <install|uninstall> [--profile core|full|strict]')
    expect(help).toContain('cursor <install|uninstall> [--profile core|full|strict]')
    expect(help).toContain('gemini <install|uninstall> [--profile core|full|strict]')
    expect(help).toContain('copilot <install|uninstall> [--profile core|full|strict]')
    expect(help).toContain('codex <install|uninstall>')
    expect(help).toContain('opencode <install|uninstall>')
    expect(help).toContain('summary [graph.json]')
  })

  it('routes compare through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    let capturedRequest: unknown
    let confirmCalls = 0

    dependencies.runCompare = async (request) => {
      capturedRequest = request
      return 'compare result'
    }
    dependencies.confirm = async () => {
      confirmCalls += 1
      return true
    }

    const exitCode = await executeCli(
      [
        'compare',
        '--questions',
        'benchmark-questions.json',
        '--exec',
        'gemini -p "$(cat {prompt_file})"',
        '--graph',
        'custom.json',
        '--output-dir',
        'out/compare/custom',
        '--baseline-mode',
        'bounded',
        '--per-arm-timeout',
        '900',
        '--heartbeat-interval-ms',
        '15000',
        '--strict-madar-first',
        '--yes',
        '--limit',
        '5',
        '--why',
        ],
        io,
        dependencies,
    )

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['compare result'])
    expect(errors).toEqual([])
    const compareRequest = capturedRequest as {
      options: ReturnType<typeof parseCompareArgs>
      io: typeof io
      confirm: (message: string) => Promise<boolean>
    }
    expect(compareRequest.options).toEqual({
      question: null,
      graphPath: 'custom.json',
      execTemplate: 'gemini -p "$(cat {prompt_file})"',
      questionsPath: 'benchmark-questions.json',
      outputDir: resolve('out/compare/custom'),
      baselineMode: 'bounded',
      perArmTimeoutSeconds: 900,
      heartbeatIntervalMs: 15000,
      strictMadarFirst: true,
      allowNoInstall: false,
      yes: true,
      limit: 5,
      why: true,
    })
    expect(compareRequest.io).toBe(io)
    await expect(compareRequest.confirm('Proceed?')).resolves.toBe(true)
    expect(confirmCalls).toBe(1)
  })

  it('routes bench:suite through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    let capturedRequest: unknown

    dependencies.runBenchSuite = async (request) => {
      capturedRequest = request
      return 'bench suite result'
    }

    const exitCode = await executeCli(
      [
        'bench:suite',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
        '--repo',
        'nestjs-mid',
        '--task',
        'explain-runtime',
        '--mode',
        'warm',
        '--trials',
        '5',
        '--output-dir',
        'docs/benchmarks/suite/results/custom',
        '--yes',
      ],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['bench suite result'])
    expect(errors).toEqual([])
    const benchSuiteRequest = capturedRequest as {
      options: ReturnType<typeof parseBenchSuiteArgs>
      io: typeof io
    }
    expect(benchSuiteRequest.options).toEqual({
      repo: 'nestjs-mid',
      task: 'explain-runtime',
      mode: 'warm',
      trials: 5,
      outputDir: resolve('docs/benchmarks/suite/results/custom'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      dryRun: false,
      yes: true,
    })
    expect(benchSuiteRequest.io).toBe(io)
  })

  it('runs bench:suite dry-run without confirmation', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    let confirmCalls = 0
    let benchSuiteCalls = 0

    dependencies.confirm = async () => {
      confirmCalls += 1
      return true
    }
    dependencies.runBenchSuite = async () => {
      benchSuiteCalls += 1
      return 'bench suite dry run'
    }

    const exitCode = await executeCli(['bench:suite', '--dry-run'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(benchSuiteCalls).toBe(1)
    expect(confirmCalls).toBe(0)
    expect(logs).toEqual(['bench suite dry run'])
    expect(errors).toEqual([])
  })

  it('routes review-compare through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    let capturedRequest: unknown
    let confirmCalls = 0

    dependencies.runReviewCompare = async (request) => {
      capturedRequest = request
      return 'review compare result'
    }
    dependencies.confirm = async () => {
      confirmCalls += 1
      return true
    }

    const exitCode = await executeCli(
      [
        'review-compare',
        'custom.json',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
        '--output-dir',
        'out/review-compare/custom',
        '--base-branch',
        'origin/main',
        '--budget',
        '1800',
        '--yes',
      ],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['review compare result'])
    expect(errors).toEqual([])
    const reviewCompareRequest = capturedRequest as {
      options: ReturnType<typeof parseReviewCompareArgs>
      io: typeof io
      confirm: (message: string) => Promise<boolean>
    }
    expect(reviewCompareRequest.options).toEqual({
      graphPath: 'custom.json',
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      outputDir: resolve('out/review-compare/custom'),
      baseBranch: 'origin/main',
      budget: 1800,
      yes: true,
    })
    expect(reviewCompareRequest.io).toBe(io)
    await expect(reviewCompareRequest.confirm('Proceed?')).resolves.toBe(true)
    expect(confirmCalls).toBe(1)
  })

  it('warns and confirms before running compare without --yes', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    const prompts: string[] = []

    dependencies.confirm = async (message) => {
      prompts.push(message)
      return true
    }
    dependencies.runCompare = async () => {
      return 'compare result'
    }

    const exitCode = await executeCli(
      ['compare', 'how does login work', '--exec', 'claude -p "$(cat {prompt_file})"'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(prompts).toEqual([
      'compare will execute a baseline prompt and a madar prompt for each question. This may consume paid model tokens.',
    ])
    expect(logs).toEqual([
      'Warning: compare will execute a baseline prompt and a madar prompt for each question. This may consume paid model tokens.',
      'compare result',
    ])
    expect(errors).toEqual([])
  })

  it('cancels compare when confirmation is declined', async () => {
    const { io, logs, errors } = createIo()
    const dependencies = createDependencies()
    let compareCalls = 0

    dependencies.confirm = async () => false
    dependencies.runCompare = async () => {
      compareCalls += 1
      return 'compare result'
    }

    const exitCode = await executeCli(
      ['compare', 'how does login work', '--exec', 'claude -p "$(cat {prompt_file})"'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(1)
    expect(compareCalls).toBe(0)
    expect(logs).toEqual([
      'Warning: compare will execute a baseline prompt and a madar prompt for each question. This may consume paid model tokens.',
      'Compare cancelled.',
    ])
    expect(errors).toEqual([])
  })

  it('fails fast when compare is run without --yes in non-interactive mode', async () => {
    const { io, logs, errors } = createIo()
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })

    try {
      const exitCode = await executeCli(['compare', 'how does login work', '--exec', 'claude -p "$(cat {prompt_file})"'], io)

      expect(exitCode).toBe(2)
      expect(logs).toEqual(['Warning: compare will execute a baseline prompt and a madar prompt for each question. This may consume paid model tokens.'])
      expect(errors).toEqual(['error: compare requires --yes in non-interactive mode.'])
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty })
    }
  })

  it('fails fast when benchmark is run without --yes in non-interactive mode', async () => {
    const { io, logs, errors } = createIo()
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })

    try {
      const exitCode = await executeCli(['benchmark', '--exec', 'claude -p "$(cat {prompt_file})"'], io)

      expect(exitCode).toBe(2)
      expect(logs).toEqual(['Warning: benchmark will execute the benchmark/eval runner. This may consume paid model tokens.'])
      expect(errors).toEqual(['error: benchmark requires --yes in non-interactive mode.'])
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty })
    }
  })

  it('fails fast when eval is run without --yes in non-interactive mode', async () => {
    const { io, logs, errors } = createIo()
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })

    try {
      const exitCode = await executeCli(['eval', '--exec', 'claude -p "$(cat {prompt_file})"'], io)

      expect(exitCode).toBe(2)
      expect(logs).toEqual(['Warning: eval will execute the benchmark/eval runner. This may consume paid model tokens.'])
      expect(errors).toEqual(['error: eval requires --yes in non-interactive mode.'])
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty })
    }
  })

  it('fails fast when bench:suite is run without --yes in non-interactive mode', async () => {
    const { io, logs, errors } = createIo()
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })

    try {
      const exitCode = await executeCli(['bench:suite', '--exec', 'claude -p "$(cat {prompt_file})"'], io)

      expect(exitCode).toBe(2)
      expect(logs).toEqual(['Warning: bench:suite will execute baseline, madar, and SPI suite prompts. This may consume paid model tokens.'])
      expect(errors).toEqual(['error: bench:suite requires --yes in non-interactive mode.'])
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty })
    }
  })

  it('returns a usage error when compare args are incomplete', async () => {
    const { io, logs, errors } = createIo()

    const exitCode = await executeCli(['compare'], io, createDependencies())

    expect(exitCode).toBe(2)
    expect(logs).toEqual([])
    expect(errors).toEqual(['Usage: madar compare [question] --exec TEMPLATE [--graph path] [--questions PATH] [--output-dir DIR] [--baseline-mode MODE] [--per-arm-timeout S] [--heartbeat-interval-ms N] [--strict-madar-first] [--allow-no-install] [--yes] [--limit N] [--why]'])
  })

  it('prefers the explicit compare command over an implicit generate path match', async () => {
    const { io, logs, errors } = createIo()
    const originalCwd = process.cwd()
    const sandboxRoot = resolve('out', 'test-runtime', 'compare-shadow-command')
    const dependencies = createDependencies()
    let called = false

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(resolve(sandboxRoot, 'compare'), { recursive: true })

    dependencies.runCompare = async () => {
      called = true
      return 'compare result from cwd shadow test'
    }

    try {
      process.chdir(sandboxRoot)

      const exitCode = await executeCli(
        ['compare', 'how does login work', '--exec', 'claude -p "$(cat {prompt_file})"', '--yes'],
        io,
        dependencies,
      )

      expect(exitCode).toBe(0)
      expect(logs).toEqual(['compare result from cwd shadow test'])
      expect(errors).toEqual([])
      expect(called).toBe(true)
    } finally {
      process.chdir(originalCwd)
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })

  it('routes time-travel through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const runTimeTravel = vi.fn<NonNullable<CliDependencies['runTimeTravel']>>().mockResolvedValue('time-travel result')
    const dependencies: CliDependencies = {
      ...createDependencies(),
      runTimeTravel,
    }

    await expect(executeCli(['time-travel', 'main', 'HEAD'], io, dependencies)).resolves.toBe(0)

    expect(runTimeTravel).toHaveBeenCalledWith({
      options: {
        fromRef: 'main',
        toRef: 'HEAD',
        view: 'summary',
        json: false,
        refresh: false,
        limit: 10,
      },
      io,
    })
    expect(logs).toEqual(['time-travel result'])
    expect(errors).toEqual([])
  })

  it('routes doctor and status through injected dependencies', async () => {
    const doctor = createIo()
    const status = createIo()
    const runDoctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>().mockReturnValue('doctor summary')
    const runStatus = vi.fn<NonNullable<CliDependencies['runStatus']>>().mockReturnValue('status summary')
    const dependencies: CliDependencies = {
      ...createDependencies(),
      runDoctor,
      runStatus,
    }

    await expect(executeCli(['doctor', '--graph', 'out/custom.json'], doctor.io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['status'], status.io, dependencies)).resolves.toBe(0)

    expect(runDoctor).toHaveBeenCalledWith('out/custom.json')
    expect(runStatus).toHaveBeenCalledWith('out/graph.json')
    expect(doctor.logs).toEqual(['doctor summary'])
    expect(status.logs).toEqual(['status summary'])
    expect(doctor.errors).toEqual([])
    expect(status.errors).toEqual([])
  })

  it('routes pack through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const runContextPack = vi.fn<NonNullable<CliDependencies['runContextPack']>>().mockResolvedValue('{"task":"explain"}')
    const dependencies: CliDependencies = {
      ...createDependencies(),
      runContextPack,
    }

    await expect(executeCli(['pack', 'how does auth work', '--budget', '1800', '--task', 'explain', '--why'], io, dependencies)).resolves.toBe(0)

    expect(runContextPack).toHaveBeenCalledWith({
      options: {
        prompt: 'how does auth work',
        budget: 1800,
        task: 'explain',
        taskExplicit: true,
        graphPath: 'out/graph.json',
        why: true,
      },
      io,
    })
    expect(logs).toEqual(['{"task":"explain"}'])
    expect(errors).toEqual([])
  })

  it('routes prompt through the injected dependency after parsing args', async () => {
    const { io, logs, errors } = createIo()
    const runContextPrompt = vi.fn<NonNullable<CliDependencies['runContextPrompt']>>().mockResolvedValue('{"provider":"claude"}')
    const dependencies: CliDependencies = {
      ...createDependencies(),
      runContextPrompt,
    }

    await expect(executeCli(['prompt', 'how does auth work', '--provider', 'claude'], io, dependencies)).resolves.toBe(0)

    expect(runContextPrompt).toHaveBeenCalledWith({
      options: {
        prompt: 'how does auth work',
        provider: 'claude',
        graphPath: 'out/graph.json',
      },
      io,
    })
    expect(logs).toEqual(['{"provider":"claude"}'])
    expect(errors).toEqual([])
  })

  it('uses the default time-travel dependency to emit raw JSON unchanged', async () => {
    const { io, logs, errors } = createIo()
    const compareResult = {
      fromRef: 'main',
      toRef: 'HEAD',
      view: 'summary' as const,
      summary: {
        headline: 'Auth flow changed',
        whyItMatters: ['Transport now sits between auth and client.'],
      },
      changed: {
        nodesAdded: 1,
        nodesRemoved: 0,
        edgesAdded: 1,
        edgesRemoved: 0,
        communities: [{ community: 1, changeCount: 2 }],
      },
      risk: {
        topImpacts: [{ label: 'AuthService', transitiveDependents: 2 }],
      },
      drift: {
        movedNodes: [],
      },
      timeline: {
        events: [{ kind: 'node_added', label: 'Transport', reason: 'added in Community 1' }],
      },
    }
    const compareRefs = vi.fn().mockResolvedValue(compareResult)

    try {
      vi.resetModules()
      vi.doMock('../../src/infrastructure/time-travel.js', () => ({
        compareRefs,
      }))

      const { executeCli: executeCliWithDefaultDependencies } = await import('../../src/cli/main.js')

      await expect(executeCliWithDefaultDependencies(['time-travel', 'main', 'HEAD', '--json'], io)).resolves.toBe(0)

      expect(compareRefs).toHaveBeenCalledWith({
        fromRef: 'main',
        toRef: 'HEAD',
        view: 'summary',
        json: true,
        refresh: false,
        limit: 10,
      })
      expect(logs).toEqual([JSON.stringify(compareResult, null, 2)])
      expect(errors).toEqual([])
    } finally {
      vi.doUnmock('../../src/infrastructure/time-travel.js')
      vi.resetModules()
    }
  })

  it('executes query commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['query', 'show auth flow', '--dfs', '--budget', '1500'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['show auth flow :: dfs :: 1500'])
  })

  it('passes query ranking and filters through injected dependencies', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    let capturedOptions: Record<string, unknown> | undefined

    dependencies.queryGraph = (_graph, question, options) => {
      capturedOptions = {
        question,
        ...options,
      }
      return 'filtered query output'
    }

    const exitCode = await executeCli(['query', 'show auth flow', '--rank-by', 'degree', '--community', '0', '--file-type', 'code'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['filtered query output'])
    expect(capturedOptions).toEqual({
      question: 'show auth flow',
      mode: 'bfs',
      tokenBudget: 2000,
      rankBy: 'degree',
      filters: {
        community: 0,
        fileType: 'code',
      },
    })
  })

  it('executes path and explain commands against the loaded graph', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()

    const pathExitCode = await executeCli(['path', 'AuthService', 'Transport', '--max-hops', '3'], io, dependencies)
    const explainExitCode = await executeCli(['explain', 'HttpClient', '--relation', 'uses'], io, dependencies)

    expect(pathExitCode).toBe(0)
    expect(explainExitCode).toBe(0)
    expect(logs[0]).toContain('Shortest path (2 hops)')
    expect(logs[0]).toContain('AuthService')
    expect(logs[1]).toContain('Node: HttpClient')
    expect(logs[1]).toContain('Neighbors of HttpClient')
    expect(logs[1]).toContain('Transport')
  })

  it('executes diff commands against baseline and current graphs', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()

    const exitCode = await executeCli(['diff', 'baseline.json', '--graph', 'current.json', '--limit', '5'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('Graph diff: 1 new node, 1 new edge')
    expect(logs[0]).toContain('Before: 2 nodes')
    expect(logs[0]).toContain('After: 3 nodes')
    expect(logs[0]).toContain('Transport [transport]')
    expect(logs[0]).toContain('HttpClient --uses [EXTRACTED]--> Transport')
  })

  it('executes add commands by ingesting into raw and rebuilding incrementally', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()

    const exitCode = await executeCli(['add', 'https://example.com/post', 'workspace', '--no-html'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[madar add] Saved')
    expect(logs[0]).toContain(resolve('workspace', 'raw'))
    expect(logs[1]).toContain('[madar generate] update completed')
  })

  it('executes generate commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['generate', 'src', '--update'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[madar generate] update completed')
    expect(logs[0]).toContain('graph.json')
    expect(logs[0]).toContain('Semantic anomalies: 2 high-signal item(s)')
  })

  it('passes optional export flags through generate commands', async () => {
    const { io } = createIo()
    let capturedOptions: Record<string, unknown> | undefined
    const dependencies = createDependencies()
    dependencies.generateGraph = (rootPath = '.', options = {}) => {
      capturedOptions = { rootPath, ...options }
      return {
        mode: options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate',
        rootPath: resolve(rootPath),
        outputDir: resolve(rootPath, 'out'),
        graphPath: resolve(rootPath, 'out', 'graph.json'),
        reportPath: resolve(rootPath, 'out', 'GRAPH_REPORT.md'),
        htmlPath: options.noHtml ? null : resolve(rootPath, 'out', 'graph.html'),
        wikiPath: options.wiki ? resolve(rootPath, 'out', 'wiki') : null,
        obsidianPath: options.obsidian ? resolve(options.obsidianDir ?? resolve(rootPath, 'out', 'obsidian')) : null,
        svgPath: options.svg ? resolve(rootPath, 'out', 'graph.svg') : null,
        graphmlPath: options.graphml ? resolve(rootPath, 'out', 'graph.graphml') : null,
        cypherPath: options.neo4j ? resolve(rootPath, 'out', 'cypher.txt') : null,
      docsPath: null,
        totalFiles: 3,
        codeFiles: 2,
        nonCodeFiles: 1,
        extractableFiles: 3,
        extractedFiles: options.useSpi ? 2 : 3,
        totalWords: 120,
        nodeCount: 5,
        edgeCount: 4,
        communityCount: 2,
        changedFiles: 0,
        deletedFiles: 0,
        cache: options.useSpi ? { strategy: 'spi', hit: false, reason: 'no-cache', fileCount: 2 } : null,
        warning: null,
        notes: [],
      }
    }

    const exitCode = await executeCli(
      ['generate', 'src', '--directed', '--wiki', '--obsidian', '--obsidian-dir', 'vault', '--svg', '--graphml', '--neo4j'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capturedOptions).toMatchObject({
      rootPath: 'src',
      update: false,
      clusterOnly: false,
      directed: true,
      followSymlinks: false,
      noHtml: false,
      wiki: true,
      obsidian: true,
      obsidianDir: 'vault',
      svg: true,
      graphml: true,
      neo4j: true,
      includeDocs: false,
      docs: false,
      useSpi: false,
    })
    expect(typeof capturedOptions?.onProgress).toBe('function')
  })

  it('pushes the generated graph to neo4j when requested', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    let capturedOptions: Parameters<CliDependencies['pushGraphToNeo4j']>[1] | undefined

    dependencies.pushGraphToNeo4j = async (_graph, options) => {
      capturedOptions = options
      return {
        uri: options.uri,
        database: options.database ?? 'neo4j',
        nodes: 4,
        edges: 3,
      }
    }

    const exitCode = await executeCli(
      ['generate', 'src', '--neo4j-push', 'bolt://localhost:7687', '--neo4j-user', 'neo4j', '--neo4j-password', 'secret', '--neo4j-database', 'madar'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capturedOptions).toMatchObject({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'secret',
      database: 'madar',
      projectRoot: resolve('src'),
    })
    expect(logs.some((line) => line.includes('[madar neo4j] Pushed 4 nodes and 3 edges'))).toBe(true)
  })

  it('treats path-first invocations as generate commands', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['src', '--cluster-only'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[madar generate] cluster-only completed')
  })

  it('executes save-result commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['save-result', '--question', 'Q', '--answer', 'A', '--memory-dir', 'out/mem'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`Saved to ${resolve('out/mem')}/Q.md`)
  })

  it('executes benchmark commands with question files via injected dependencies', async () => {
    const { io } = createIo()
    let printed = false
    let capturedContext: unknown
    const dependencies = createDependencies()
    dependencies.runBenchmark = ((context: unknown) => {
      capturedContext = context
      return createDependencies().runBenchmark({
        io,
        options: {
          graphPath: 'graph.json',
          questionsPath: null,
          execTemplate: 'unused',
          yes: true,
        },
      })
    }) as CliDependencies['runBenchmark']
    dependencies.printBenchmark = () => {
      printed = true
    }

    const exitCode = await executeCli(
      ['benchmark', 'graph.json', '--questions', resolve('tests/fixtures/workspace-parity-questions.json'), '--exec', 'claude -p "$(cat {prompt_file})"', '--yes'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(printed).toBe(true)
    expect(capturedContext).toEqual({
      io,
      options: {
        graphPath: 'graph.json',
        questionsPath: resolve('tests/fixtures/workspace-parity-questions.json'),
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        yes: true,
      },
    })
  })

  it('executes eval command with question files and routes output through io.log', async () => {
    const { io, logs } = createIo()
    let capturedContext: unknown
    const dependencies: CliDependencies & { runEval: (context: unknown) => string } = Object.assign(createDependencies(), {
      runEval: (context: unknown) => {
        capturedContext = context
        return 'eval result'
      },
    })

    const exitCode = await executeCli(
      ['eval', '--questions', resolve('tests/fixtures/workspace-parity-questions.json'), '--exec', 'claude -p "$(cat {prompt_file})"', '--yes'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['eval result'])
    expect(capturedContext).toEqual({
      io,
      options: {
        graphPath: 'out/graph.json',
        questionsPath: resolve('tests/fixtures/workspace-parity-questions.json'),
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        yes: true,
      },
    })
  })

  it('executes hook commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const installExitCode = await executeCli(['hook', 'install'], io, createDependencies())
    const statusExitCode = await executeCli(['hook', 'status'], io, createDependencies())

    expect(installExitCode).toBe(0)
    expect(statusExitCode).toBe(0)
    expect(logs).toContain('hooks installed')
    expect(logs).toContain('post-commit: installed\npost-checkout: installed')
  })

  it('executes install and platform action commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const aiderInstallExitCode = await executeCli(['aider', 'install'], io, createDependencies())
    const installGeminiExitCode = await executeCli(['install', '--platform', 'gemini'], io, createDependencies())
    const installExitCode = await executeCli(['install', '--platform', 'codex'], io, createDependencies())
    const claudeExitCode = await executeCli(['claude', 'install'], io, createDependencies())
    const geminiInstallExitCode = await executeCli(['gemini', 'install'], io, createDependencies())
    const geminiUninstallExitCode = await executeCli(['gemini', 'uninstall'], io, createDependencies())
    const installCursorExitCode = await executeCli(['install', '--platform', 'cursor'], io, createDependencies())
    const cursorInstallExitCode = await executeCli(['cursor', 'install'], io, createDependencies())
    const cursorUninstallExitCode = await executeCli(['cursor', 'uninstall'], io, createDependencies())
    const copilotInstallExitCode = await executeCli(['copilot', 'install'], io, createDependencies())
    const copilotUninstallExitCode = await executeCli(['copilot', 'uninstall'], io, createDependencies())
    const codexExitCode = await executeCli(['codex', 'uninstall'], io, createDependencies())
    const opencodeExitCode = await executeCli(['opencode', 'install'], io, createDependencies())

    expect(aiderInstallExitCode).toBe(0)
    expect(installGeminiExitCode).toBe(0)
    expect(installExitCode).toBe(0)
    expect(claudeExitCode).toBe(0)
    expect(geminiInstallExitCode).toBe(0)
    expect(geminiUninstallExitCode).toBe(0)
    expect(installCursorExitCode).toBe(0)
    expect(cursorInstallExitCode).toBe(0)
    expect(cursorUninstallExitCode).toBe(0)
    expect(copilotInstallExitCode).toBe(0)
    expect(copilotUninstallExitCode).toBe(0)
    expect(codexExitCode).toBe(0)
    expect(logs).toContain('aider local rules installed')
    expect(logs).toContain('gemini local rules installed')
    expect(opencodeExitCode).toBe(0)
    expect(logs).toContain('installed codex')
    expect(logs).toContain('claude local rules installed')
    expect(logs).toContain('cursor local rules installed')
    expect(logs).toContain('cursor local rules removed')
    expect(logs).toContain('gemini local rules removed')
    expect(logs).toContain('installed copilot')
    expect(logs).toContain('removed copilot')
    expect(logs).toContain('codex local rules removed')
    expect(logs).toContain('opencode local rules installed')
  })

  it('passes the requested install profile into claude, cursor, gemini, and copilot installs', async () => {
    const { io } = createIo()
    const dependencies = createDependencies()
    const claudeInstall = vi.fn().mockReturnValue('claude strict install')
    const cursorInstall = vi.fn().mockReturnValue('cursor strict install')
    const geminiInstall = vi.fn().mockReturnValue('gemini strict install')
    const installCopilotMcp = vi.fn().mockReturnValue('copilot strict install')

    dependencies.claudeInstall = claudeInstall as unknown as CliDependencies['claudeInstall']
    dependencies.cursorInstall = cursorInstall as unknown as CliDependencies['cursorInstall']
    dependencies.geminiInstall = geminiInstall as unknown as CliDependencies['geminiInstall']
    dependencies.installCopilotMcp = installCopilotMcp as unknown as CliDependencies['installCopilotMcp']

    await expect(executeCli(['claude', 'install', '--profile', 'strict'], io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['cursor', 'install', '--profile', 'strict'], io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['gemini', 'install', '--profile', 'strict'], io, dependencies)).resolves.toBe(0)
    await expect(executeCli(['copilot', 'install', '--profile', 'strict'], io, dependencies)).resolves.toBe(0)

    expect(claudeInstall).toHaveBeenCalledWith('.', { profile: 'strict' })
    expect(cursorInstall).toHaveBeenCalledWith('.', { profile: 'strict' })
    expect(geminiInstall).toHaveBeenCalledWith('.', { profile: 'strict' })
    expect(installCopilotMcp).toHaveBeenCalledWith('.', { profile: 'strict' })
  })

  it('removes the Copilot MCP config during copilot uninstall', async () => {
    const { io } = createIo()
    const dependencies = createDependencies()
    const uninstallCopilotMcp = vi.fn().mockReturnValue('copilot mcp removed')

    dependencies.uninstallCopilotMcp = uninstallCopilotMcp as unknown as CliDependencies['uninstallCopilotMcp']

    await expect(executeCli(['copilot', 'uninstall'], io, dependencies)).resolves.toBe(0)

    expect(uninstallCopilotMcp).toHaveBeenCalledWith('.')
  })

  it('executes watch and serve commands via injected dependencies', async () => {
    const { io, logs } = createIo()
    let watched = false
    let served = false
    let servedOverStdio = false
    let lastWatchOptions: Record<string, unknown> | undefined
    const dependencies = createDependencies()
    dependencies.watchGraph = async (_path, _debounce, options) => {
      watched = true
      lastWatchOptions = options as Record<string, unknown>
    }
    dependencies.serveGraph = async () => {
      served = true
    }
    dependencies.serveGraphStdio = async () => {
      servedOverStdio = true
    }

    const watchExitCode = await executeCli(['watch', 'src', '--debounce', '1', '--no-html'], io, dependencies)
    const serveExitCode = await executeCli(['serve', 'out/graph.json', '--port', '0'], io, dependencies)
    const stdioExitCode = await executeCli(['serve', 'out/graph.json', '--mcp'], io, dependencies)

    expect(watchExitCode).toBe(0)
    expect(serveExitCode).toBe(0)
    expect(stdioExitCode).toBe(0)
    expect(watched).toBe(true)
    expect(served).toBe(true)
    expect(servedOverStdio).toBe(true)
    expect(lastWatchOptions?.noHtml).toBe(true)
    expect(logs[0]).toContain('[madar generate]')
  })

  it('returns usage exit codes for invalid usage', async () => {
    const { io, errors } = createIo()

    const exitCode = await executeCli(['query'], io, createDependencies())

    expect(exitCode).toBe(2)
    expect(errors[0]).toContain('Usage: madar query')
  })

  it('returns command errors for unknown commands', async () => {
    const { io, errors } = createIo()

    const exitCode = await executeCli(['mystery'], io, createDependencies())

    expect(exitCode).toBe(1)
    expect(errors[0]).toContain("error: unknown command 'mystery'")
  })
})

describe('summary command', () => {
  it('parses summary args with positional and --graph forms', () => {
    expect(parseSummaryArgs([])).toEqual({
      graphPath: 'out/graph.json',
    })

    expect(parseSummaryArgs(['custom.json'])).toEqual({
      graphPath: 'custom.json',
    })

    expect(parseSummaryArgs(['--graph', 'custom.json'])).toEqual({
      graphPath: 'custom.json',
    })

    expect(parseSummaryArgs(['--graph=custom.json'])).toEqual({
      graphPath: 'custom.json',
    })
  })

  it('formatHelp documents the summary command', () => {
    const help = formatHelp()
    expect(help).toContain('summary [graph.json]')
  })

  it('dispatches summary to the runGraphSummary dependency and prints JSON', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    let capturedGraphPath: string | undefined
    const expectedPayload = {
      graph_version: 'abc123def456',
      generated_at: '2026-05-12T10:00:00.000Z',
      node_count: 3,
      edge_count: 2,
      file_count: 3,
      community_count: 2,
      source_domains: { production: 3 },
      top_modules: [{ label: 'AuthService', degree: 2 }],
      entrypoints: [{ label: 'AuthService', source_file: 'src/auth/service.ts' }],
      frameworks: [],
      runtime_paths: [],
    }
    dependencies.runGraphSummary = (graphPath: string) => {
      capturedGraphPath = graphPath
      return expectedPayload
    }

    const exitCode = await executeCli(['summary', 'out/graph.json'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(capturedGraphPath).toBe('out/graph.json')
    expect(logs).toEqual([JSON.stringify(expectedPayload, null, 2)])
  })

  it('dispatches summary with default graph path when no argument is given', async () => {
    const { io } = createIo()
    const dependencies = createDependencies()
    let capturedGraphPath: string | undefined
    dependencies.runGraphSummary = (graphPath: string) => {
      capturedGraphPath = graphPath
      return { node_count: 0, edge_count: 0, file_count: 0, community_count: 0, source_domains: {}, top_modules: [], entrypoints: [], frameworks: [], runtime_paths: [] }
    }

    const exitCode = await executeCli(['summary'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(capturedGraphPath).toBe('out/graph.json')
  })
})
