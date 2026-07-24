import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type CliDependencies,
  executeCli,
  formatHelp,
} from '../../src/cli/main.js'
import {
  parseBenchmarkArgs,
  parseBenchSuiteArgs,
  parseCompareArgs,
  parseDoctorArgs,
  parseGenerateArgs,
  parseHookArgs,
  parseInstallArgs,
  parsePlatformActionArgs,
  parseQueryArgs,
  parseServeArgs,
  parseTelemetryArgs,
  parseTryArgs,
  parseWatchArgs,
  UsageError,
} from '../../src/cli/parser.js'
import type { RetrieveContextResult } from '../../src/domain/query/types.js'
import {
  resolveMadarOutputDirectory,
  resolveWorkspaceGraphPath,
} from '../../src/shared/workspace.js'

const RESULT: RetrieveContextResult = {
  schema: 'madar.retrieve',
  version: 1,
  outcome: 'missing',
  matched_nodes: [],
  relationships: [],
  boundaries: [{ kind: 'missing', subject: 'where is auth?' }],
  metrics: {
    selected_files: 0,
    snippets: 0,
    closure_passes: 0,
    serialized_tokens: 64,
    truncated: false,
  },
}

const BENCHMARK_RESULT = {
  corpus_tokens: 1_000,
  corpus_words: 750,
  corpus_source: 'graph',
  nodes: 10,
  edges: 20,
  structure_signals: {
    total_nodes: 10,
    total_edges: 20,
    weakly_connected_components: 1,
    singleton_components: 0,
    isolated_nodes: 0,
    largest_component_nodes: 10,
    largest_component_ratio: 1,
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
  per_question: [],
}

const GENERATE_RESULT = {
  mode: 'generate',
  rootPath: '/workspace',
  outputDir: '/workspace/out',
  graphPath: '/workspace/out/graph.json',
  reportPath: '/workspace/out/GRAPH_REPORT.md',
  totalFiles: 4,
  indexedFiles: 3,
  totalWords: 120,
  nodeCount: 5,
  edgeCount: 4,
  communityCount: 2,
  semanticAnomalyCount: 0,
  warning: 'large test corpus',
  notes: ['one test note'],
  discoverySafety: {
    version: 1,
    summary: {
      total: 21,
      sensitive: 20,
      unreadable: 1,
      reasons: { environment_file: 21 },
    },
    exclusions: Array.from({ length: 21 }, (_, index) => ({
      path: `.env.${index}`,
      kind: 'sensitive' as const,
      reason: 'environment_file',
    })),
  },
  indexingManifestPath: '/workspace/out/indexing-manifest.json',
  indexing: {
    state: 'complete',
    candidates: 3,
    counts: {
      indexed: 3,
      indexed_with_warnings: 0,
      skipped_by_policy: 0,
      unsupported: 0,
      failed: 0,
    },
    reason_buckets: { indexed: 3 },
    capability_buckets: { 'builtin:index:typescript': 3 },
  },
  updateReceipt: {
    mode: 'incremental_reconcile',
    scanned_files: 4,
    parsed_files: 1,
    reused_files: 2,
    invalidated_files: 1,
    dependency_closure_size: 1,
    fallback_reason: null,
    previous_build_id: 'b'.repeat(64),
    accepted_build_id: 'a'.repeat(64),
    publication_advanced: true,
  },
  buildId: 'a'.repeat(64),
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

function createDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const graph = {
    nodeEntries: () => [
      ['auth', { source_file: 'src/auth.ts' }],
      ['session', { source_file: 'src/session.ts' }],
    ],
  }
  const generate = vi.fn((_path = '.', options: {
    onProgress?: (step: {
      step: 'detect' | 'index'
      message: string
      current?: number
      total?: number
    }) => void
  } = {}) => {
    options.onProgress?.({ step: 'detect', message: 'Scanning files...' })
    options.onProgress?.({
      step: 'index',
      message: 'Indexing files...',
      current: 1,
      total: 3,
    })
    return { ...GENERATE_RESULT }
  })

  return {
    notifyUpdate: vi.fn(() => null),
    readInstalledVersion: vi.fn(() => '0.32.0'),
    loadGraph: vi.fn(() => graph),
    inspectQueryIndex: vi.fn(() => ({
      state: 'unavailable',
      subject: 'test graph',
    })),
    retrieveContext: vi.fn(() => RESULT),
    runBenchmark: vi.fn(() => BENCHMARK_RESULT),
    runBenchSuite: vi.fn(() => 'suite output'),
    runEval: vi.fn(() => 'eval output'),
    runCompare: vi.fn(() => 'compare output'),
    runTry: vi.fn(() => '{"schema":"madar.retrieve"}'),
    runDoctor: vi.fn(() => 'doctor output'),
    runStatus: vi.fn(() => 'status output'),
    confirm: vi.fn(async () => true),
    printBenchmark: vi.fn(),
    installHooks: vi.fn(() => 'hooks installed'),
    uninstallHooks: vi.fn(() => 'hooks removed'),
    hookStatus: vi.fn(() => 'hooks ready'),
    geminiInstall: vi.fn(() => 'gemini installed'),
    geminiUninstall: vi.fn(() => 'gemini removed'),
    installSkill: vi.fn((platform) => `${platform} skill installed`),
    uninstallSkill: vi.fn((platform) => `${platform} skill removed`),
    cursorInstall: vi.fn(() => 'cursor installed'),
    cursorUninstall: vi.fn(() => 'cursor removed'),
    installCopilotMcp: vi.fn(() => 'copilot MCP installed'),
    uninstallCopilotMcp: vi.fn(() => 'copilot MCP removed'),
    pushGraphToNeo4j: vi.fn(async () => ({
      uri: 'bolt://localhost:7687',
      database: 'neo4j',
      nodes: 5,
      edges: 4,
    })),
    generateGraph: generate,
    updateIndex: vi.fn((_path = '.', options: Parameters<typeof generate>[1]) =>
      generate(_path, options)),
    watchGraph: vi.fn(async () => undefined),
    serveGraphStdio: vi.fn(async () => undefined),
    claudeInstall: vi.fn(() => 'claude installed'),
    claudeUninstall: vi.fn(() => 'claude removed'),
    agentsInstall: vi.fn((_path, platform) => `${platform} installed`),
    agentsUninstall: vi.fn((_path, platform) => `${platform} removed`),
    enableTelemetry: vi.fn(() => 'telemetry enabled'),
    disableTelemetry: vi.fn(() => 'telemetry disabled'),
    readTelemetryStatus: vi.fn(() => 'telemetry status'),
    clearTelemetry: vi.fn(() => 'telemetry cleared'),
    readTelemetryReport: vi.fn(() => 'telemetry report'),
    readDoctorTelemetryBucket: vi.fn(() => 'healthy'),
    readStatusTelemetryBucket: vi.fn(() => 'attention_needed'),
    recordTelemetryEvent: vi.fn(),
    ...overrides,
  } as unknown as CliDependencies
}

function withGraphSandbox(
  run: (paths: { root: string; graphPath: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'madar-cli-'))
  const graphPath = join(root, 'out', 'graph.json')
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(graphPath, '{}\n', 'utf8')

  try {
    run({ root, graphPath })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function withInteractiveTty<T>(run: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  })
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: true,
  })
  try {
    return await run()
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('query and try CLI parsers', () => {
  it('parses query defaults plus split and equals options', () => {
    withGraphSandbox(({ graphPath }) => {
      expect(parseQueryArgs(['where is auth?'])).toEqual({
        question: 'where is auth?',
        graphPath: 'out/graph.json',
      })
      expect(parseQueryArgs([
        '  where is auth?  ',
        '--budget',
        '768',
        '--graph',
        graphPath,
      ])).toEqual({
        question: 'where is auth?',
        budget: 768,
        graphPath: realpathSync(graphPath),
      })
      expect(parseQueryArgs([
        'where is auth?',
        '--budget=512',
        `--graph=${graphPath}`,
      ])).toEqual({
        question: 'where is auth?',
        budget: 512,
        graphPath: realpathSync(graphPath),
      })
    })
  })

  it.each([
    { args: [], message: 'Usage: madar query' },
    { args: ['question', '--budget'], message: '--budget requires a value' },
    { args: ['question', '--budget', '0'], message: 'positive integer' },
    { args: ['question', '--budget=1.5'], message: 'positive integer' },
    { args: ['question', '--budget=1e2'], message: 'positive integer' },
    { args: ['question', '--budget=9007199254740992'], message: 'positive integer' },
    { args: ['question', '--graph'], message: '--graph requires a value' },
    { args: ['question', 'second'], message: 'unknown option for query' },
    { args: ['question', '--profile'], message: 'unknown option for query' },
    { args: ['question', '--semantic'], message: 'unknown option for query' },
    { args: ['question', '--rerank'], message: 'unknown option for query' },
  ])('rejects invalid query args: $args', ({ args, message }) => {
    expect(() => parseQueryArgs(args)).toThrow(message)
  })

  it('parses try defaults and an explicit workspace path', () => {
    expect(parseTryArgs(['where is auth?'])).toEqual({
      question: 'where is auth?',
      path: '.',
    })
    expect(parseTryArgs([' where is auth? ', 'packages/api'])).toEqual({
      question: 'where is auth?',
      path: 'packages/api',
    })
  })

  it.each([
    { args: [] },
    { args: ['question', '--legacy'] },
    { args: ['question', 'one', 'two'] },
    { args: ['question', 'x'.repeat(4_097)] },
  ])('rejects invalid try args: $args', ({ args }) => {
    expect(() => parseTryArgs(args)).toThrow(UsageError)
  })
})

describe('benchmark CLI parsers', () => {
  it('parses benchmark and eval options in split and equals forms', () => {
    const execTemplate = 'claude -p "$(cat {prompt_file})"'
    expect(parseBenchmarkArgs(['--exec', execTemplate])).toEqual({
      graphPath: 'out/graph.json',
      questionsPath: null,
      execTemplate,
      yes: false,
    })
    expect(parseBenchmarkArgs([
      'custom.json',
      '--questions',
      'questions.json',
      `--exec=${execTemplate}`,
      '--yes',
    ])).toEqual({
      graphPath: 'custom.json',
      questionsPath: 'questions.json',
      execTemplate,
      yes: true,
    })
    expect(parseBenchmarkArgs([
      '--questions=questions.json',
      '--exec',
      execTemplate,
    ], 'eval')).toEqual({
      graphPath: 'out/graph.json',
      questionsPath: 'questions.json',
      execTemplate,
      yes: false,
    })
  })

  it.each([
    { args: [], message: '--exec is required' },
    { args: ['one.json', 'two.json', '--exec', 'agent'], message: 'Usage: madar benchmark' },
    { args: ['--questions', '--wat'], message: '--questions requires a value' },
    { args: ['--exec', '--wat'], message: '--exec requires a value' },
    { args: ['--exec', 'agent', '--wat'], message: 'unknown option for benchmark' },
  ])('rejects invalid benchmark args: $args', ({ args, message }) => {
    expect(() => parseBenchmarkArgs(args)).toThrow(message)
  })

  it('parses suite defaults and every split option', () => {
    expect(parseBenchSuiteArgs(['--dry-run'])).toEqual({
      repo: null,
      task: null,
      reposManifestPath: null,
      tasksManifestPath: null,
      mode: 'all',
      trials: 3,
      outputDir: resolve('docs/benchmarks/suite/results'),
      execTemplate: '',
      dryRun: true,
      yes: false,
    })
    expect(parseBenchSuiteArgs([
      '--repo',
      'nestjs-mid',
      '--task',
      'explain-runtime',
      '--repos-manifest',
      'repos.json',
      '--tasks-manifest',
      'tasks.json',
      '--mode',
      'warm',
      '--trials',
      '5',
      '--output-dir',
      'results',
      '--exec',
      'agent {prompt_file}',
      '--yes',
    ])).toEqual({
      repo: 'nestjs-mid',
      task: 'explain-runtime',
      reposManifestPath: resolve('repos.json'),
      tasksManifestPath: resolve('tasks.json'),
      mode: 'warm',
      trials: 5,
      outputDir: resolve('results'),
      execTemplate: 'agent {prompt_file}',
      dryRun: false,
      yes: true,
    })
  })

  it('parses every suite value option in equals form', () => {
    expect(parseBenchSuiteArgs([
      '--repo=repo',
      '--task=task',
      '--repos-manifest=repos.json',
      '--tasks-manifest=tasks.json',
      '--mode=cold',
      '--trials=2',
      '--output-dir=custom-results',
      '--exec=agent {prompt_file}',
    ])).toMatchObject({
      repo: 'repo',
      task: 'task',
      reposManifestPath: resolve('repos.json'),
      tasksManifestPath: resolve('tasks.json'),
      mode: 'cold',
      trials: 2,
      outputDir: resolve('custom-results'),
      execTemplate: 'agent {prompt_file}',
    })
  })

  it.each([
    { args: [], message: '--exec is required unless --dry-run is set' },
    { args: ['--mode', 'weird', '--dry-run'], message: '--mode must be one of' },
    { args: ['--mode=weird', '--dry-run'], message: '--mode must be one of' },
    { args: ['--trials', '0', '--dry-run'], message: 'positive integer' },
    { args: ['--trials=1e2', '--dry-run'], message: 'positive integer' },
    { args: ['--repo', '--wat', '--dry-run'], message: '--repo requires a value' },
    { args: ['--wat', '--dry-run'], message: 'unknown option for bench:suite' },
  ])('rejects invalid suite args: $args', ({ args, message }) => {
    expect(() => parseBenchSuiteArgs(args)).toThrow(message)
  })
})

describe('compare CLI parser', () => {
  it('parses defaults and explicit split options', () => {
    expect(parseCompareArgs([
      'how does login work?',
      '--exec',
      'agent {prompt_file}',
    ])).toMatchObject({
      question: 'how does login work?',
      execTemplate: 'agent {prompt_file}',
      perArmTimeoutSeconds: 600,
      yes: false,
    })

    expect(parseCompareArgs([
      '  how does login work?  ',
      '--graph',
      'custom.json',
      '--exec',
      'agent {prompt_file}',
      '--output-dir',
      'out/compare/custom',
      '--per-arm-timeout',
      '45',
      '--yes',
    ])).toEqual({
      question: 'how does login work?',
      graphPath: resolveWorkspaceGraphPath('custom.json'),
      execTemplate: 'agent {prompt_file}',
      outputDir: resolve(resolveMadarOutputDirectory(), 'compare/custom'),
      perArmTimeoutSeconds: 45,
      yes: true,
    })
  })

  it('parses every compare value option in equals form', () => {
    expect(parseCompareArgs([
      'question',
      '--graph=custom.json',
      '--exec=agent {prompt_file}',
      '--output-dir=out/compare/equal',
      '--per-arm-timeout=30',
    ])).toEqual({
      question: 'question',
      graphPath: resolveWorkspaceGraphPath('custom.json'),
      execTemplate: 'agent {prompt_file}',
      outputDir: resolve(resolveMadarOutputDirectory(), 'compare/equal'),
      perArmTimeoutSeconds: 30,
      yes: false,
    })
  })

  it.each([
    { args: ['question'], message: '--exec is required' },
    { args: ['--exec', 'agent'], message: 'Usage: madar compare' },
    { args: [' ', '--exec', 'agent'], message: 'Usage: madar compare' },
    { args: ['one', 'two', '--exec', 'agent'], message: 'Usage: madar compare' },
    { args: ['question', '--exec', 'agent', '--per-arm-timeout', '0'], message: 'positive integer' },
    { args: ['question', '--exec', 'agent', '--per-arm-timeout=1.5'], message: 'positive integer' },
    { args: ['question', '--exec', 'agent', '--wat'], message: 'unknown option for compare' },
  ])('rejects invalid compare args: $args', ({ args, message }) => {
    expect(() => parseCompareArgs(args)).toThrow(message)
  })
})

describe('generation and runtime CLI parsers', () => {
  it('parses generate defaults and all split options', () => {
    expect(parseGenerateArgs([])).toEqual({
      path: '.',
      update: false,
      watch: false,
      debounceSeconds: 3,
      neo4jPushUri: null,
      neo4jUser: null,
      neo4jPassword: null,
      neo4jDatabase: null,
      strictIndexing: false,
      maxIndexingFailed: 0,
      maxIndexingUnsupported: 0,
    })
    expect(parseGenerateArgs([
      'src',
      '--update',
      '--watch',
      '--follow-symlinks',
      '--respect-gitignore',
      '--debounce',
      '1.5',
      '--neo4j-push',
      'bolt://localhost:7687',
      '--neo4j-user',
      'neo4j',
      '--neo4j-password',
      'secret',
      '--neo4j-database',
      'madar',
      '--max-indexing-failed',
      '2',
      '--max-indexing-unsupported',
      '3',
    ])).toEqual({
      path: 'src',
      update: true,
      watch: true,
      followSymlinks: true,
      respectGitignore: true,
      debounceSeconds: 1.5,
      neo4jPushUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'secret',
      neo4jDatabase: 'madar',
      strictIndexing: true,
      maxIndexingFailed: 2,
      maxIndexingUnsupported: 3,
    })
  })

  it('parses all generate value options in equals form', () => {
    expect(parseGenerateArgs([
      '--debounce=0',
      '--neo4j-push=bolt://localhost',
      '--neo4j-user=user',
      '--neo4j-password=password',
      '--neo4j-database=graph',
      '--max-indexing-failed=1',
      '--max-indexing-unsupported=2',
    ])).toMatchObject({
      debounceSeconds: 0,
      neo4jPushUri: 'bolt://localhost',
      neo4jUser: 'user',
      neo4jPassword: 'password',
      neo4jDatabase: 'graph',
      strictIndexing: true,
      maxIndexingFailed: 1,
      maxIndexingUnsupported: 2,
    })
    expect(parseGenerateArgs(['--strict-indexing'])).toMatchObject({
      strictIndexing: true,
      maxIndexingFailed: 0,
      maxIndexingUnsupported: 0,
    })
  })

  it.each([
    { args: ['one', 'two'], message: 'Usage: madar generate' },
    { args: ['--max-indexing-failed', '-1'], message: 'non-negative integer' },
    { args: ['--max-indexing-unsupported=abc'], message: 'non-negative integer' },
    { args: ['--debounce', '-1'], message: 'non-negative number' },
    { args: ['--debounce=NaN'], message: 'non-negative number' },
    { args: ['--neo4j-push', ''], message: 'requires a value' },
    { args: ['--no-html'], message: 'unknown option for generate' },
    { args: ['--legacy'], message: 'unknown option for generate' },
    { args: ['--spi'], message: 'unknown option for generate' },
  ])('rejects invalid generate args: $args', ({ args, message }) => {
    expect(() => parseGenerateArgs(args)).toThrow(message)
  })

  it('parses watch split and equals options', () => {
    expect(parseWatchArgs([])).toEqual({
      path: '.',
      followSymlinks: false,
      respectGitignore: false,
      debounceSeconds: 3,
    })
    expect(parseWatchArgs([
      'src',
      '--follow-symlinks',
      '--respect-gitignore',
      '--debounce',
      '2',
    ])).toEqual({
      path: 'src',
      followSymlinks: true,
      respectGitignore: true,
      debounceSeconds: 2,
    })
    expect(parseWatchArgs(['--debounce=0.5'])).toMatchObject({
      debounceSeconds: 0.5,
    })
  })

  it.each([
    { args: ['one', 'two'], message: 'Usage: madar watch' },
    { args: ['--debounce', '-1'], message: 'non-negative number' },
    { args: ['--wat'], message: 'unknown option for watch' },
  ])('rejects invalid watch args: $args', ({ args, message }) => {
    expect(() => parseWatchArgs(args)).toThrow(message)
  })

  it('parses serve aliases, graph path, and auto refresh', () => {
    expect(parseServeArgs([])).toEqual({
      graphPath: 'out/graph.json',
      autoRefresh: false,
    })
    withGraphSandbox(({ graphPath }) => {
      expect(parseServeArgs([
        graphPath,
        '--stdio',
        '--mcp',
        '--auto-refresh',
      ])).toEqual({
        graphPath: realpathSync(graphPath),
        autoRefresh: true,
      })
    })
  })

  it('rejects a second serve graph path', () => {
    withGraphSandbox(({ graphPath }) => {
      expect(() => parseServeArgs([graphPath, graphPath])).toThrow(
        'Usage: madar serve',
      )
    })
  })

  it.each([
    { args: ['--http'], message: 'unknown option for serve' },
  ])('rejects invalid serve args: $args', ({ args, message }) => {
    expect(() => parseServeArgs(args)).toThrow(message)
  })

  it('parses doctor and status graph forms', () => {
    expect(parseDoctorArgs([])).toEqual({ graphPath: 'out/graph.json' })
    expect(parseDoctorArgs(['out/custom.json'])).toEqual({
      graphPath: 'out/custom.json',
    })
    expect(parseDoctorArgs(['--graph', 'out/runtime.json'])).toEqual({
      graphPath: 'out/runtime.json',
    })
    expect(parseDoctorArgs(['--graph=out/runtime.json'], 'status')).toEqual({
      graphPath: 'out/runtime.json',
    })
  })

  it.each([
    { args: ['one.json', 'two.json'], command: 'doctor' as const, message: 'Usage: madar doctor' },
    { args: ['--graph', '--wat'], command: 'doctor' as const, message: '--graph requires a value' },
    { args: ['--wat'], command: 'doctor' as const, message: 'unknown option for doctor' },
    { args: ['--wat'], command: 'status' as const, message: 'unknown option for status' },
  ])('rejects invalid doctor/status args: $args', ({ args, command, message }) => {
    expect(() => parseDoctorArgs(args, command)).toThrow(message)
  })
})

describe('configuration CLI parsers', () => {
  it.each(['install', 'uninstall', 'status'] as const)(
    'parses hook %s',
    (action) => {
      expect(parseHookArgs([action])).toEqual({ action })
    },
  )

  it.each([
    { args: [] },
    { args: ['install', 'extra'] },
    { args: ['unknown'] },
  ])(
    'rejects invalid hook args: $args',
    ({ args }) => {
      expect(() => parseHookArgs(args)).toThrow('Usage: madar hook')
    },
  )

  it.each(['enable', 'disable', 'status', 'clear'] as const)(
    'parses telemetry %s',
    (action) => {
      expect(parseTelemetryArgs([action])).toEqual({ action })
    },
  )

  it('parses telemetry reports with optional spool paths', () => {
    expect(parseTelemetryArgs(['report'])).toEqual({
      action: 'report',
      spoolPaths: [],
    })
    expect(parseTelemetryArgs(['report', 'one.json', 'two.json'])).toEqual({
      action: 'report',
      spoolPaths: ['one.json', 'two.json'],
    })
  })

  it.each([
    { args: [] },
    { args: ['enable', 'extra'] },
    { args: ['unknown'] },
  ])(
    'rejects invalid telemetry args: $args',
    ({ args }) => {
      expect(() => parseTelemetryArgs(args)).toThrow('Usage: madar telemetry')
    },
  )

  it('parses install platform defaults, positional, split, and equals forms', () => {
    expect(parseInstallArgs([], 'claude')).toEqual({ platform: 'claude' })
    expect(parseInstallArgs(['cursor'], 'claude')).toEqual({
      platform: 'cursor',
    })
    expect(parseInstallArgs(['--platform', 'aider'], 'claude')).toEqual({
      platform: 'aider',
    })
    expect(parseInstallArgs(['--platform=copilot'], 'claude')).toEqual({
      platform: 'copilot',
    })
  })

  it.each([
    { args: ['--platform', 'unknown'], message: "unknown platform 'unknown'" },
    { args: ['--platform=unknown'], message: "unknown platform 'unknown'" },
    { args: ['--platform'], message: '--platform requires a value' },
    { args: ['claude', 'cursor'], message: 'Usage: madar install' },
    { args: ['claude', '--platform=cursor'], message: 'Usage: madar install' },
    { args: ['--wat'], message: 'Usage: madar install' },
  ])('rejects invalid install args: $args', ({ args, message }) => {
    expect(() => parseInstallArgs(args, 'claude')).toThrow(message)
  })

  it.each(['install', 'uninstall'] as const)(
    'parses platform action %s',
    (action) => {
      expect(parsePlatformActionArgs('claude', [action])).toEqual({ action })
    },
  )

  it.each([
    { args: [] },
    { args: ['unknown'] },
    { args: ['install', 'extra'] },
  ])(
    'rejects invalid platform action args: $args',
    ({ args }) => {
      expect(() => parsePlatformActionArgs('claude', args)).toThrow(
        'Usage: madar claude',
      )
    },
  )
})

describe('CLI help, version, and update notices', () => {
  it.each([
    { argv: [] },
    { argv: ['-h'] },
    { argv: ['--help'] },
  ])('prints help for $argv', async ({ argv }) => {
    const { io, logs, errors } = createIo()
    await expect(executeCli(argv, io, createDependencies())).resolves.toBe(0)
    expect(logs[0]).toContain('Usage: madar <command>')
    expect(errors).toEqual([])
  })

  it('formats the current delivery surface without retired commands', () => {
    const help = formatHelp('madar-test')
    expect(help).toContain('Usage: madar-test <command>')
    expect(help).toContain('query "<question>"')
    expect(help).toContain('serve the single retrieve tool over MCP stdio')
    expect(help).toContain("madar-test generate . --update")
    for (const removed of [
      '  pack ',
      '  prompt ',
      '  handoff ',
      '  proof-report ',
      '  review-compare ',
      '  time-travel ',
      '  diff ',
      '  summary ',
      '  federate ',
      '--cluster-only',
      '--no-html',
    ]) {
      expect(help).not.toContain(removed)
    }
  })

  it.each(['--version', '-v'])('prints the installed version for %s', async (flag) => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    await expect(executeCli([flag], io, dependencies)).resolves.toBe(0)
    expect(logs).toEqual(['0.32.0'])
    expect(dependencies.notifyUpdate).not.toHaveBeenCalled()
  })

  it('returns a controlled error when the version reader fails', async () => {
    const { io, errors } = createIo()
    await expect(executeCli(
      ['--version'],
      io,
      createDependencies({
        readInstalledVersion: vi.fn(() => {
          throw new Error('version unavailable')
        }),
      }),
    )).resolves.toBe(1)
    expect(errors).toEqual(['error: version unavailable'])
  })

  it('prints an update notice before normal output', async () => {
    const { io, logs } = createIo()
    await expect(executeCli(
      ['query', 'where is auth?'],
      io,
      createDependencies({
        notifyUpdate: vi.fn(() => 'Update available: 0.33.0'),
      }),
    )).resolves.toBe(0)
    expect(logs[0]).toBe('Update available: 0.33.0')
    expect(JSON.parse(logs[1] ?? '')).toEqual(RESULT)
  })

  it('treats failed update checks as non-blocking and skips --json', async () => {
    const failed = createDependencies({
      notifyUpdate: vi.fn(() => {
        throw new Error('offline')
      }),
    })
    const first = createIo()
    await expect(executeCli(
      ['query', 'where is auth?'],
      first.io,
      failed,
    )).resolves.toBe(0)
    expect(first.errors).toEqual([])

    const skipped = createDependencies()
    const second = createIo()
    await expect(executeCli(
      ['removed-command', '--json'],
      second.io,
      skipped,
    )).resolves.toBe(1)
    expect(skipped.notifyUpdate).not.toHaveBeenCalled()
  })
})

describe('CLI evidence and diagnostics routing', () => {
  it('passes only question and optional budget into the query core', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    await expect(executeCli(
      ['query', 'where is auth?', '--budget', '512'],
      io,
      dependencies,
    )).resolves.toBe(0)
    expect(dependencies.loadGraph).toHaveBeenCalledWith('out/graph.json')
    expect(dependencies.inspectQueryIndex).toHaveBeenCalledOnce()
    expect(dependencies.retrieveContext).toHaveBeenCalledWith(
      expect.anything(),
      { question: 'where is auth?', budget: 512 },
    )
    expect(JSON.parse(logs.at(-1) ?? '')).toEqual(RESULT)
  })

  it('routes try to the same evidence-query caller', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    await expect(executeCli(
      ['try', 'where is auth?', 'packages/api'],
      io,
      dependencies,
    )).resolves.toBe(0)
    expect(dependencies.runTry).toHaveBeenCalledWith({
      options: {
        question: 'where is auth?',
        path: 'packages/api',
      },
    })
    expect(logs).toContain('{"schema":"madar.retrieve"}')
  })

  it('allows evidence and comparison commands to return no printable output', async () => {
    for (const [argv, override] of [
      [['try', 'question'], { runTry: vi.fn(() => undefined) }],
      [[
        'compare',
        'question',
        '--exec',
        'agent',
        '--yes',
      ], { runCompare: vi.fn(() => undefined) }],
    ] as const) {
      const { io } = createIo()
      await expect(executeCli(
        [...argv],
        io,
        createDependencies(override),
      )).resolves.toBe(0)
    }
  })

  it('routes doctor and status and records their readiness buckets', async () => {
    for (const [command, dependencyName, output] of [
      ['doctor', 'runDoctor', 'doctor output'],
      ['status', 'runStatus', 'status output'],
    ] as const) {
      const { io, logs } = createIo()
      const dependencies = createDependencies()
      await expect(executeCli(
        [command, '--graph', 'custom.json'],
        io,
        dependencies,
      )).resolves.toBe(0)
      expect(dependencies[dependencyName]).toHaveBeenCalledWith('custom.json')
      expect(logs).toContain(output)
      expect(dependencies.recordTelemetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          command,
          stage: 'succeeded',
        }),
      )
    }
  })
})

describe('CLI paid-run confirmation and benchmark routing', () => {
  it('routes benchmark, eval, and suite with --yes', async () => {
    const benchmark = createDependencies()
    await expect(executeCli(
      ['benchmark', '--exec', 'agent', '--yes'],
      createIo().io,
      benchmark,
    )).resolves.toBe(0)
    expect(benchmark.runBenchmark).toHaveBeenCalledOnce()
    expect(benchmark.printBenchmark).toHaveBeenCalledWith(BENCHMARK_RESULT)

    const evaluation = createDependencies()
    const evalIo = createIo()
    await expect(executeCli(
      ['eval', '--exec', 'agent', '--yes'],
      evalIo.io,
      evaluation,
    )).resolves.toBe(0)
    expect(evaluation.runEval).toHaveBeenCalledOnce()
    expect(evalIo.logs).toContain('eval output')

    const suite = createDependencies()
    const suiteIo = createIo()
    await expect(executeCli(
      ['bench:suite', '--exec', 'agent', '--yes'],
      suiteIo.io,
      suite,
    )).resolves.toBe(0)
    expect(suite.runBenchSuite).toHaveBeenCalledOnce()
    expect(suiteIo.logs).toContain('suite output')
  })

  it('runs a suite dry-run without confirmation or an exec template', async () => {
    const dependencies = createDependencies()
    await expect(executeCli(
      ['bench:suite', '--dry-run'],
      createIo().io,
      dependencies,
    )).resolves.toBe(0)
    expect(dependencies.confirm).not.toHaveBeenCalled()
    expect(dependencies.runBenchSuite).toHaveBeenCalledOnce()
  })

  it.each([
    ['benchmark', 'Benchmark cancelled.'],
    ['eval', 'Eval cancelled.'],
    ['bench:suite', 'Benchmark suite cancelled.'],
  ])('allows an interactive user to cancel %s', async (command, cancelled) => {
    const dependencies = createDependencies({
      confirm: vi.fn(async () => false),
    })
    const { io, logs } = createIo()
    await withInteractiveTty(async () => {
      await expect(executeCli(
        [command, '--exec', 'agent'],
        io,
        dependencies,
      )).resolves.toBe(1)
    })
    expect(logs.at(-1)).toBe(cancelled)
    expect(dependencies.confirm).toHaveBeenCalledOnce()
  })

  it('allows an interactive user to approve a benchmark', async () => {
    const dependencies = createDependencies()
    const { io } = createIo()
    await withInteractiveTty(async () => {
      await expect(executeCli(
        ['benchmark', '--exec', 'agent'],
        io,
        dependencies,
      )).resolves.toBe(0)
    })
    expect(dependencies.confirm).toHaveBeenCalledOnce()
    expect(dependencies.runBenchmark).toHaveBeenCalledOnce()
  })

  it('requires --yes for paid commands in non-interactive mode', async () => {
    const originalIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const originalOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    })
    try {
      const { io, errors } = createIo()
      await expect(executeCli(
        ['benchmark', '--exec', 'agent'],
        io,
        createDependencies(),
      )).resolves.toBe(2)
      expect(errors[0]).toContain('benchmark requires --yes')
    } finally {
      if (originalIn) Object.defineProperty(process.stdin, 'isTTY', originalIn)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      if (originalOut) Object.defineProperty(process.stdout, 'isTTY', originalOut)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
    }
  })

  it('routes compare with --yes and supports explicit confirmation', async () => {
    const direct = createDependencies()
    const directIo = createIo()
    await expect(executeCli([
      'compare',
      'question',
      '--exec',
      'agent',
      '--yes',
    ], directIo.io, direct)).resolves.toBe(0)
    expect(direct.confirm).not.toHaveBeenCalled()
    expect(direct.runCompare).toHaveBeenCalledOnce()
    expect(directIo.logs).toContain('compare output')

    const approved = createDependencies()
    const approvedIo = createIo()
    await expect(executeCli([
      'compare',
      'question',
      '--exec',
      'agent',
    ], approvedIo.io, approved)).resolves.toBe(0)
    expect(approved.confirm).toHaveBeenCalledOnce()
    expect(approved.runCompare).toHaveBeenCalledOnce()

    const declined = createDependencies({
      confirm: vi.fn(async () => false),
    })
    const declinedIo = createIo()
    await expect(executeCli([
      'compare',
      'question',
      '--exec',
      'agent',
    ], declinedIo.io, declined)).resolves.toBe(1)
    expect(declined.runCompare).not.toHaveBeenCalled()
    expect(declinedIo.logs.at(-1)).toBe('Compare cancelled.')
  })
})

describe('CLI generation, watch, and serve routing', () => {
  it('routes an update, Neo4j push, strict indexing, and watch', async () => {
    const dependencies = createDependencies()
    const { io, logs } = createIo()
    await expect(executeCli([
      'generate',
      'src',
      '--update',
      '--watch',
      '--follow-symlinks',
      '--respect-gitignore',
      '--max-indexing-failed=1',
      '--max-indexing-unsupported=2',
      '--debounce=0.25',
      '--neo4j-push=bolt://localhost:7687',
      '--neo4j-user=user',
      '--neo4j-password=password',
      '--neo4j-database=neo4j',
    ], io, dependencies)).resolves.toBe(0)

    expect(dependencies.updateIndex).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        followSymlinks: true,
        respectGitignore: true,
        indexingStrict: {
          maxFailed: 1,
          maxUnsupported: 2,
        },
        onProgress: expect.any(Function),
      }),
    )
    expect(dependencies.pushGraphToNeo4j).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        uri: 'bolt://localhost:7687',
        user: 'user',
        password: 'password',
        database: 'neo4j',
      }),
    )
    expect(dependencies.watchGraph).toHaveBeenCalledWith(
      'src',
      0.25,
      expect.objectContaining({
        seed: expect.objectContaining({ graphPath: GENERATE_RESULT.graphPath }),
      }),
    )
    expect(logs).toContain('[madar index] Indexing files... (1/3)')
    expect(logs.join('\n')).toContain('... 1 more')
    expect(logs.join('\n')).toContain('[madar neo4j] Pushed 5 nodes')
  })

  it('routes ordinary and implicit generation without optional policies', async () => {
    const explicit = createDependencies()
    await expect(executeCli(
      ['generate'],
      createIo().io,
      explicit,
    )).resolves.toBe(0)
    expect(explicit.generateGraph).toHaveBeenCalledWith(
      '.',
      expect.not.objectContaining({
        followSymlinks: expect.anything(),
        indexingStrict: expect.anything(),
      }),
    )

    const implicitFlag = createDependencies()
    await expect(executeCli(
      ['--update'],
      createIo().io,
      implicitFlag,
    )).resolves.toBe(0)
    expect(implicitFlag.updateIndex).toHaveBeenCalledOnce()

    const root = mkdtempSync(join(tmpdir(), 'madar-implicit-generate-'))
    try {
      const implicitPath = createDependencies()
      await expect(executeCli(
        [root],
        createIo().io,
        implicitPath,
      )).resolves.toBe(0)
      expect(implicitPath.generateGraph).toHaveBeenCalledWith(
        root,
        expect.anything(),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes watch with a generated seed', async () => {
    const dependencies = createDependencies()
    await expect(executeCli([
      'watch',
      'src',
      '--follow-symlinks',
      '--respect-gitignore',
      '--debounce=2',
    ], createIo().io, dependencies)).resolves.toBe(0)
    expect(dependencies.generateGraph).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        followSymlinks: true,
        respectGitignore: true,
      }),
    )
    expect(dependencies.watchGraph).toHaveBeenCalledWith(
      'src',
      2,
      expect.objectContaining({
        seed: expect.objectContaining({ graphPath: GENERATE_RESULT.graphPath }),
      }),
    )
  })

  it('routes serve in default and auto-refresh modes', async () => {
    const basic = createDependencies()
    await expect(executeCli(
      ['serve'],
      createIo().io,
      basic,
    )).resolves.toBe(0)
    expect(basic.serveGraphStdio).toHaveBeenCalledWith({
      graphPath: resolveWorkspaceGraphPath('out/graph.json'),
      logger: expect.anything(),
    })

    const refreshed = createDependencies()
    await expect(executeCli(
      ['serve', '--auto-refresh'],
      createIo().io,
      refreshed,
    )).resolves.toBe(0)
    expect(refreshed.serveGraphStdio).toHaveBeenCalledWith({
      graphPath: resolveWorkspaceGraphPath('out/graph.json'),
      autoRefresh: true,
      workspaceRoot: process.cwd(),
      logger: expect.anything(),
    })
  })
})

describe('CLI telemetry and installation routing', () => {
  it.each([
    ['enable', 'enableTelemetry', 'telemetry enabled'],
    ['disable', 'disableTelemetry', 'telemetry disabled'],
    ['status', 'readTelemetryStatus', 'telemetry status'],
    ['clear', 'clearTelemetry', 'telemetry cleared'],
  ] as const)(
    'routes telemetry %s',
    async (action, dependencyName, output) => {
      const dependencies = createDependencies()
      const { io, logs } = createIo()
      await expect(executeCli(
        ['telemetry', action],
        io,
        dependencies,
      )).resolves.toBe(0)
      expect(dependencies[dependencyName]).toHaveBeenCalledOnce()
      expect(logs).toContain(output)
    },
  )

  it('routes telemetry report paths', async () => {
    const dependencies = createDependencies()
    await expect(executeCli(
      ['telemetry', 'report', 'one.json', 'two.json'],
      createIo().io,
      dependencies,
    )).resolves.toBe(0)
    expect(dependencies.readTelemetryReport).toHaveBeenCalledWith([
      'one.json',
      'two.json',
    ])
  })

  it.each([
    ['gemini', 'geminiInstall'],
    ['cursor', 'cursorInstall'],
    ['codex', 'installSkill'],
  ] as const)(
    'routes install %s',
    async (platform, dependencyName) => {
      const dependencies = createDependencies()
      await expect(executeCli(
        ['install', platform],
        createIo().io,
        dependencies,
      )).resolves.toBe(0)
      expect(dependencies[dependencyName]).toHaveBeenCalled()
      expect(dependencies.recordTelemetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'install',
          stage: 'succeeded',
          agentTarget: platform,
        }),
      )
    },
  )

  it.each([
    ['install', 'installHooks'],
    ['uninstall', 'uninstallHooks'],
    ['status', 'hookStatus'],
  ] as const)(
    'routes hook %s',
    async (action, dependencyName) => {
      const dependencies = createDependencies()
      await expect(executeCli(
        ['hook', action],
        createIo().io,
        dependencies,
      )).resolves.toBe(0)
      expect(dependencies[dependencyName]).toHaveBeenCalledWith('.')
    },
  )

  it.each([
    ['claude', 'install', 'claudeInstall'],
    ['claude', 'uninstall', 'claudeUninstall'],
    ['cursor', 'install', 'cursorInstall'],
    ['cursor', 'uninstall', 'cursorUninstall'],
    ['gemini', 'install', 'geminiInstall'],
    ['gemini', 'uninstall', 'geminiUninstall'],
  ] as const)(
    'routes %s %s',
    async (platform, action, dependencyName) => {
      const dependencies = createDependencies()
      await expect(executeCli(
        [platform, action],
        createIo().io,
        dependencies,
      )).resolves.toBe(0)
      expect(dependencies[dependencyName]).toHaveBeenCalledWith('.')
    },
  )

  it('routes Copilot install and uninstall through both integrations', async () => {
    const installed = createDependencies()
    await expect(executeCli(
      ['copilot', 'install'],
      createIo().io,
      installed,
    )).resolves.toBe(0)
    expect(installed.installSkill).toHaveBeenCalledWith('copilot')
    expect(installed.installCopilotMcp).toHaveBeenCalledWith('.')

    const removed = createDependencies()
    await expect(executeCli(
      ['copilot', 'uninstall'],
      createIo().io,
      removed,
    )).resolves.toBe(0)
    expect(removed.uninstallCopilotMcp).toHaveBeenCalledWith('.')
    expect(removed.uninstallSkill).toHaveBeenCalledWith('copilot')
  })

  it('routes generic agent platform install and uninstall', async () => {
    const installed = createDependencies()
    await expect(executeCli(
      ['codex', 'install'],
      createIo().io,
      installed,
    )).resolves.toBe(0)
    expect(installed.agentsInstall).toHaveBeenCalledWith('.', 'codex')

    const removed = createDependencies()
    await expect(executeCli(
      ['aider', 'uninstall'],
      createIo().io,
      removed,
    )).resolves.toBe(0)
    expect(removed.agentsUninstall).toHaveBeenCalledWith('.', 'aider')
  })
})

describe('CLI failures and telemetry isolation', () => {
  it('returns controlled usage and unknown-command exit codes', async () => {
    const usage = createIo()
    await expect(executeCli(
      ['query'],
      usage.io,
      createDependencies(),
    )).resolves.toBe(2)
    expect(usage.errors[0]).toContain('Usage: madar query')

    const unknown = createIo()
    await expect(executeCli(
      ['removed-command'],
      unknown.io,
      createDependencies(),
    )).resolves.toBe(1)
    expect(unknown.errors).toEqual([
      "error: unknown command 'removed-command'",
      "Run 'madar --help' for usage.",
    ])
  })

  it('returns a controlled error for a dependency failure', async () => {
    const { io, errors } = createIo()
    await expect(executeCli(
      ['try', 'question'],
      io,
      createDependencies({
        runTry: vi.fn(() => {
          throw 'plain failure'
        }),
      }),
    )).resolves.toBe(1)
    expect(errors).toEqual(['error: plain failure'])
  })

  it.each([
    ['invalid params', 'invalid_params'],
    ['graph.json not found', 'missing_graph'],
    ['unsupported corpus', 'unsupported_corpus'],
    ['install failed', 'install_error'],
    ['unexpected failure', 'unknown'],
  ] as const)(
    'classifies compare failure %s as %s',
    async (message, failureBucket) => {
      const dependencies = createDependencies({
        runCompare: vi.fn(() => {
          throw new Error(message)
        }),
      })
      await expect(executeCli([
        'compare',
        'question',
        '--exec',
        'agent',
        '--yes',
      ], createIo().io, dependencies)).resolves.toBe(1)
      expect(dependencies.recordTelemetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'compare',
          stage: 'failed',
          failureBucket,
        }),
      )
    },
  )

  it('records usage failures and direct agent installation failures', async () => {
    const compare = createDependencies()
    await expect(executeCli(
      ['compare', 'question'],
      createIo().io,
      compare,
    )).resolves.toBe(2)

    const install = createDependencies({
      agentsInstall: vi.fn(() => {
        throw new Error('install failed')
      }),
    })
    await expect(executeCli(
      ['codex', 'install'],
      createIo().io,
      install,
    )).resolves.toBe(1)
    expect(install.recordTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'install',
        stage: 'failed',
        failureBucket: 'install_error',
      }),
    )
  })

  it('keeps telemetry writer failures non-fatal', async () => {
    const { io, errors } = createIo()
    await expect(executeCli(
      ['doctor'],
      io,
      createDependencies({
        recordTelemetryEvent: vi.fn(() => {
          throw new Error('spool unavailable')
        }),
      }),
    )).resolves.toBe(0)
    expect(errors).toContain('[madar telemetry] spool unavailable')
  })
})
