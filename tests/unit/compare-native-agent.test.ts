import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { build } from '../../src/pipeline/build.js'
import {
  executeNativeAgentCompare,
  formatNativeAgentCompareSummary,
  inspectClaudeNativeAgentInstall,
  parseAnthropicResultEvent,
  type CompareRunMode,
  type NativeAgentCompareResult,
  type NativeAgentCompareReport,
  type NativeAgentRunner,
} from '../../src/infrastructure/compare.js'
import { claudeInstall } from '../../src/infrastructure/install.js'
import { toJson } from '../../src/pipeline/export.js'

const FIXTURE_PARENT = resolve('out', 'test-runtime', 'native-agent')
const COMPARE_OUTPUT_PARENT = resolve('out', 'compare', 'test-runtime-native-agent')

function writeClaudeInstallArtifacts(projectDir: string): void {
  claudeInstall(projectDir)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function writeLineAnchoredSourceFile(filePath: string, lineNumber: number, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const lines = Array.from({ length: lineNumber }, (_, index) => (
    index === lineNumber - 1 ? content : `// filler ${index + 1}`
  ))
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

function makeFixtureProject(
  options: {
    installState?: 'managed' | 'valid' | 'missing'
    profile?: 'core' | 'full'
    spiMode?: boolean
  } = {},
): { projectDir: string; graphPath: string; outputDir: string } {
  mkdirSync(FIXTURE_PARENT, { recursive: true })
  mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
  const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'project-'))
  const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'out-'))
  // Build a minimal out/graph.json so the snapshot has something to rename.
  mkdirSync(join(projectDir, 'out'), { recursive: true })
  writeFileSync(
    join(projectDir, 'out', 'graph.json'),
    JSON.stringify({
      community_labels: { '0': 'Mock' },
      ...(options.spiMode === true ? { spi_mode: true } : {}),
      nodes: [
        { id: 'a', label: 'Alpha', source_file: 'a.ts', source_location: '1', file_type: 'code', community: 0 },
      ],
      edges: [],
      hyperedges: [],
    }),
    'utf8',
  )
  const graphPath = join(projectDir, 'out', 'graph.json')
  const installClaudeWithProfile = claudeInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' }) => string
  if (options.installState === 'managed') {
    installClaudeWithProfile(projectDir, options.profile ? { profile: options.profile } : undefined)
  } else if (options.installState !== 'missing') {
    installClaudeWithProfile(projectDir, options.profile ? { profile: options.profile } : undefined)
  }
  return { projectDir, graphPath, outputDir }
}

function makeImplementationFixtureProject(): {
  projectDir: string
  graphPath: string
  outputDir: string
  questionsPath: string
} {
  const { projectDir, outputDir } = makeFixtureProject()
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  mkdirSync(join(projectDir, 'tests'), { recursive: true })
  mkdirSync(join(projectDir, 'scripts'), { recursive: true })
  mkdirSync(join(projectDir, 'benchmarks', 'implement'), { recursive: true })

  writeFileSync(
    join(projectDir, 'src', 'session.ts'),
    [
      'export class SessionManager {',
      '  createSession(userId: string) {',
      '    return `session:${userId}`',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'src', 'config.ts'),
    [
      'export const config = {',
      '  sessionTtlSeconds: 86400,',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'tests', 'session.test.ts'),
    [
      'import { SessionManager } from "../src/session"',
      '',
      'export function assertSessionManager() {',
      '  return new SessionManager()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'scripts', 'check-session.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      '',
      "const sessionSource = readFileSync(join(process.cwd(), 'src', 'session.ts'), 'utf8')",
      "if (!sessionSource.includes('slidingExpirationMs')) {",
      "  console.error('missing sliding expiration implementation')",
      '  process.exit(1)',
      '}',
      '',
      "console.log('validation ok')",
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'implement-fixture',
      private: true,
      type: 'module',
      scripts: {
        typecheck: 'node scripts/check-session.mjs',
        build: 'node scripts/check-session.mjs',
        test: 'node scripts/check-session.mjs',
      },
    }, null, 2),
    'utf8',
  )

  const question = 'Implement sliding session expiration in SessionManager'
  const questionsPath = join(projectDir, 'benchmarks', 'implement', 'questions.json')
  writeFileSync(questionsPath, JSON.stringify([{ question }], null, 2), 'utf8')
  writeFileSync(
    join(projectDir, 'benchmarks', 'implement', 'implementation-gates.json'),
    JSON.stringify({
      [question]: {
        checks: [
          {
            path: 'src/session.ts',
            must_contain: ['slidingExpirationMs'],
          },
          {
            path: 'src/config.ts',
            must_not_contain: ['slidingExpirationMs'],
          },
        ],
      },
    }, null, 2),
    'utf8',
  )

  const graph = new KnowledgeGraph()
  graph.graph.root_path = projectDir
  graph.addNode('session_manager', {
    label: 'SessionManager',
    source_file: 'src/session.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('config', {
    label: 'config',
    source_file: 'src/config.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'constant',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_test', {
    label: 'SessionManager test',
    source_file: 'tests/session.test.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'function',
    file_type: 'code',
    community: 1,
  })
  graph.addEdge('session_test', 'session_manager', {
    relation: 'tests',
    confidence: 'EXTRACTED',
    source_file: 'tests/session.test.ts',
  })

  const graphPath = join(projectDir, 'out', 'graph.json')
  toJson(graph, { 0: ['session_manager', 'config'], 1: ['session_test'] }, graphPath)

  return { projectDir, graphPath, outputDir, questionsPath }
}

function makeExplainQualityFixtureProject(): {
  projectDir: string
  graphPath: string
  outputDir: string
  questionsPath: string
} {
  const { projectDir, graphPath, outputDir } = makeFixtureProject()
  mkdirSync(join(projectDir, 'benchmarks', 'explain'), { recursive: true })

  const question = 'How idea report is being generated'
  const questionsPath = join(projectDir, 'benchmarks', 'explain', 'questions.json')
  writeFileSync(questionsPath, JSON.stringify([{ question }], null, 2), 'utf8')
  writeFileSync(
    join(projectDir, 'benchmarks', 'explain', 'quality-gates.json'),
    JSON.stringify({
      'idea-report-runtime': {
        prompt: question,
        required_answer_terms: ['idea report'],
        forbidden_answer_terms: ['mcp__madar__retrieve', 'approve the permission'],
        required_concepts: ['answer the runtime path instead of asking for permission'],
        answer_quality_notes: ['Permission-blocked non-answers are not benchmark wins.'],
        manual_review_notes: ['Confirm the answer explains the flow.'],
      },
    }, null, 2),
    'utf8',
  )

  return { projectDir, graphPath, outputDir, questionsPath }
}

function makeRescopedReadinessFixtureProject(): {
  projectDir: string
  graphPath: string
  outputDir: string
} {
  return makeRescopedReadinessFixtureProjectWithOptions()
}

function makeRescopedReadinessFixtureProjectWithOptions(options: {
  includePersistenceStep?: boolean
  includeScopedGraph?: boolean
  scopedGraphUsesScopedRoot?: boolean
} = {}): {
  projectDir: string
  graphPath: string
  outputDir: string
} {
  const { projectDir, outputDir } = makeFixtureProject()
  const includePersistenceStep = options.includePersistenceStep ?? true
  const includeScopedGraph = options.includeScopedGraph ?? true
  const scopedGraphUsesScopedRoot = options.scopedGraphUsesScopedRoot ?? false
  if (includeScopedGraph) {
    mkdirSync(join(projectDir, 'backend', 'out'), { recursive: true })
  }
  writeLineAnchoredSourceFile(
    join(projectDir, 'backend', 'src', 'auth', 'routes.ts'),
    10,
    'export const backendLoginRoute = "backend-login-route"',
  )
  writeLineAnchoredSourceFile(
    join(projectDir, 'backend', 'src', 'auth', 'controller.ts'),
    20,
    'export const backendLoginController = "backend-controller-proof"',
  )
  writeLineAnchoredSourceFile(
    join(projectDir, 'backend', 'src', 'auth', 'service.ts'),
    30,
    'export const backendLoginService = "backend-service-proof"',
  )
  writeLineAnchoredSourceFile(
    join(projectDir, 'backend', 'src', 'queue', 'registry.ts'),
    40,
    'export const backendQueueRegistry = "backend-queue-proof"',
  )
  writeLineAnchoredSourceFile(
    join(projectDir, 'backend', 'src', 'auth', 'worker.ts'),
    50,
    'export const backendLoginWorker = "backend-worker-proof"',
  )
  if (includePersistenceStep) {
    writeLineAnchoredSourceFile(
      join(projectDir, 'backend', 'src', 'session', 'store.ts'),
      60,
      'export const backendSessionStore = "backend-session-persist"',
    )
  }

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'login_route', label: 'POST /login', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'auth', 'routes.ts'), source_location: 'L10', line_number: 10, node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'login_controller', label: 'AuthController.login', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'auth', 'controller.ts'), source_location: 'L20', line_number: 20, node_kind: 'method', framework_role: 'nest_controller', community: 0 },
          { id: 'login_service', label: 'AuthService.login', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'auth', 'service.ts'), source_location: 'L30', line_number: 30, node_kind: 'method', framework_role: 'nest_provider', community: 0 },
          { id: 'queue_registry', label: 'QueueRegistry.addJob', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'queue', 'registry.ts'), source_location: 'L40', line_number: 40, node_kind: 'method', framework_role: 'queue', community: 1 },
          { id: 'login_worker', label: 'AuthWorker.process', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'auth', 'worker.ts'), source_location: 'L50', line_number: 50, node_kind: 'method', framework_role: 'worker', community: 1 },
          ...(includePersistenceStep
            ? [{ id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: join(projectDir, 'backend', 'src', 'session', 'store.ts'), source_location: 'L60', line_number: 60, node_kind: 'method', framework_role: 'repository', community: 1 } as const]
            : []),
        ],
        edges: [
          { source: 'login_route', target: 'login_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: join(projectDir, 'backend', 'src', 'auth', 'routes.ts') },
          { source: 'login_controller', target: 'login_service', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'backend', 'src', 'auth', 'controller.ts') },
          { source: 'login_service', target: 'queue_registry', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'backend', 'src', 'auth', 'service.ts') },
          { source: 'queue_registry', target: 'login_worker', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: join(projectDir, 'backend', 'src', 'queue', 'registry.ts') },
          ...(includePersistenceStep
            ? [{ source: 'login_worker', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'backend', 'src', 'auth', 'worker.ts') } as const]
            : []),
        ],
      },
    ],
    { directed: true },
  )
  graph.graph.root_path = projectDir

  const graphPath = join(projectDir, 'out', 'graph.json')
  toJson(
    graph,
    {
      0: ['login_route', 'login_controller', 'login_service'],
      1: includePersistenceStep ? ['queue_registry', 'login_worker', 'session_store'] : ['queue_registry', 'login_worker'],
    },
    graphPath,
  )

  if (includeScopedGraph) {
    const scopedGraphPath = join(projectDir, 'backend', 'out', 'graph.json')
    toJson(
      graph,
      {
        0: ['login_route', 'login_controller', 'login_service'],
        1: includePersistenceStep ? ['queue_registry', 'login_worker', 'session_store'] : ['queue_registry', 'login_worker'],
      },
      scopedGraphPath,
    )
    const scopedGraph = JSON.parse(readFileSync(scopedGraphPath, 'utf8')) as Record<string, unknown>
    if (scopedGraphUsesScopedRoot) {
      const scopedRoot = join(projectDir, 'backend')
      scopedGraph.root_path = scopedRoot
      const scopedNodes = Array.isArray(scopedGraph.nodes) ? scopedGraph.nodes : []
      for (const node of scopedNodes) {
        if (isObjectRecord(node) && typeof node.source_file === 'string') {
          node.source_file = relative(scopedRoot, node.source_file).replaceAll('\\', '/')
        }
      }
      const scopedLinks = Array.isArray(scopedGraph.links) ? scopedGraph.links : []
      for (const link of scopedLinks) {
        if (isObjectRecord(link) && typeof link.source_file === 'string') {
          link.source_file = relative(scopedRoot, link.source_file).replaceAll('\\', '/')
        }
      }
    }
    scopedGraph.spi_mode = true
    writeFileSync(scopedGraphPath, `${JSON.stringify(scopedGraph, null, 2)}\n`, 'utf8')
  }

  return { projectDir, graphPath, outputDir }
}
function makeImplementFixtureProject(): { projectDir: string; graphPath: string; outputDir: string } {
  const { projectDir, outputDir } = makeFixtureProject()
  mkdirSync(join(projectDir, 'src', 'auth'), { recursive: true })
  mkdirSync(join(projectDir, 'src', 'http'), { recursive: true })
  mkdirSync(join(projectDir, 'src', 'legacy'), { recursive: true })
  mkdirSync(join(projectDir, 'tests', 'unit'), { recursive: true })
  mkdirSync(join(projectDir, 'tests', 'e2e'), { recursive: true })
  mkdirSync(join(projectDir, 'scripts'), { recursive: true })

  writeFileSync(join(projectDir, 'src', 'auth', 'login-service.ts'), 'export const loginValidation = "original"\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'auth', 'login-controller.ts'), 'export const loginController = true\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'auth', 'login-helper.ts'), 'export const normalizeLoginPayload = true\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'auth', 'login-audit-repository.ts'), 'export const loginAuditRepository = true\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'http', 'login-routes.ts'), 'export const loginRoutes = true\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'legacy', 'noisy.ts'), 'export const noisy = "original"\n', 'utf8')
  writeFileSync(join(projectDir, 'tests', 'unit', 'login-service.test.ts'), 'export const loginServiceTest = "original"\n', 'utf8')
  writeFileSync(join(projectDir, 'tests', 'e2e', 'login-flow.test.ts'), 'export const loginFlowTest = "original"\n', 'utf8')
  writeFileSync(
    join(projectDir, 'scripts', 'check-implement.cjs'),
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const root = process.cwd()",
      "const service = fs.readFileSync(path.join(root, 'src/auth/login-service.ts'), 'utf8')",
      "const testFile = fs.readFileSync(path.join(root, 'tests/unit/login-service.test.ts'), 'utf8')",
      "const ok = service.includes('madar-implement-change') && testFile.includes('madar-implement-test')",
      "process.exit(ok ? 0 : 1)",
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'native-agent-implement-fixture',
      private: true,
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
        'test:run': 'node ./scripts/check-implement.cjs',
      },
    }, null, 2),
    'utf8',
  )
  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'login_route', label: 'POST /login', file_type: 'code', source_file: join(projectDir, 'src', 'http', 'login-routes.ts'), source_location: 'L10', node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'login_controller', label: 'LoginController.submit', file_type: 'code', source_file: join(projectDir, 'src', 'auth', 'login-controller.ts'), source_location: 'L20', node_kind: 'method', framework_role: 'nest_controller', community: 0 },
          { id: 'login_service', label: 'LoginService.validate', file_type: 'code', source_file: join(projectDir, 'src', 'auth', 'login-service.ts'), source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'login_repository', label: 'LoginAuditRepository.saveAttempt', file_type: 'code', source_file: join(projectDir, 'src', 'auth', 'login-audit-repository.ts'), source_location: 'L40', node_kind: 'method', community: 1 },
          { id: 'login_helper', label: 'normalizeLoginPayload', file_type: 'code', source_file: join(projectDir, 'src', 'auth', 'login-helper.ts'), source_location: 'L18', node_kind: 'function', community: 1 },
          { id: 'login_unit_test', label: 'LoginService.validate.spec', file_type: 'code', source_file: join(projectDir, 'tests', 'unit', 'login-service.test.ts'), source_location: 'L1', node_kind: 'function', community: 2 },
          { id: 'login_e2e_test', label: 'login flow e2e', file_type: 'code', source_file: join(projectDir, 'tests', 'e2e', 'login-flow.test.ts'), source_location: 'L1', node_kind: 'function', community: 2 },
        ],
        edges: [
          { source: 'login_route', target: 'login_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'http', 'login-routes.ts') },
          { source: 'login_controller', target: 'login_service', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'auth', 'login-controller.ts') },
          { source: 'login_service', target: 'login_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'auth', 'login-service.ts') },
          { source: 'login_service', target: 'login_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'auth', 'login-service.ts') },
          { source: 'login_service', target: 'login_unit_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'auth', 'login-service.ts') },
          { source: 'login_route', target: 'login_e2e_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: join(projectDir, 'src', 'http', 'login-routes.ts') },
        ],
      },
    ],
    { directed: true },
  )
  graph.graph.root_path = projectDir
  const graphPath = join(projectDir, 'out', 'graph.json')
  writeFileSync(
    graphPath,
    `${JSON.stringify({
      schema_version: graph.graph.schema_version === 2 ? 2 : 1,
      directed: graph.isDirected(),
      root_path: projectDir,
      nodes: graph.nodeEntries().map(([id, attributes]) => ({ id, ...attributes })),
      links: graph.edgeEntries().map(([source, target, attributes]) => ({ source, target, ...attributes })),
      hyperedges: Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : [],
      community_labels: { 0: 'Auth entry', 1: 'Auth workflow', 2: 'Tests' },
    }, null, 2)}\n`,
    'utf8',
  )

  return { projectDir, graphPath, outputDir }
}

const BASELINE_USAGE_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 96368,
  num_turns: 9,
  result: 'baseline answer',
  total_cost_usd: 0.62,
  usage: {
    input_tokens: 14,
    cache_creation_input_tokens: 40648,
    cache_read_input_tokens: 574528,
    output_tokens: 3152,
  },
}

const MADAR_USAGE_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 34744,
  num_turns: 3,
  result: 'madar answer',
  total_cost_usd: 0.7,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 92833,
    cache_read_input_tokens: 140662,
    output_tokens: 1893,
  },
}

const BASELINE_TOKEN_REGRESSION_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 42000,
  num_turns: 5,
  result: 'baseline answer',
  total_cost_usd: 0.62,
  usage: {
    input_tokens: 21144,
    cache_creation_input_tokens: 43534,
    cache_read_input_tokens: 324040,
    output_tokens: 1200,
  },
}

const MADAR_TOKEN_REGRESSION_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 39000,
  num_turns: 4,
  result: 'madar answer',
  total_cost_usd: 0.71,
  usage: {
    input_tokens: 18023,
    cache_creation_input_tokens: 72305,
    cache_read_input_tokens: 277531,
    output_tokens: 1000,
  },
}

const GOVALIDATE_BASELINE_TOKEN_REGRESSION_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 166206,
  num_turns: 5,
  result: 'baseline answer',
  total_cost_usd: 0.8682259,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 38851,
    cache_read_input_tokens: 232864,
    output_tokens: 1200,
  },
}

const GOVALIDATE_MADAR_TOKEN_REGRESSION_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 66381,
  num_turns: 7,
  result: 'madar answer',
  total_cost_usd: 0.95262875,
  usage: {
    input_tokens: 17,
    cache_creation_input_tokens: 96575,
    cache_read_input_tokens: 487900,
    output_tokens: 1000,
  },
}

const BASELINE_FULL_WIN_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 80000,
  num_turns: 6,
  result: 'baseline answer',
  total_cost_usd: 0.8,
  usage: {
    input_tokens: 20000,
    cache_creation_input_tokens: 30000,
    cache_read_input_tokens: 100000,
    output_tokens: 1200,
  },
}

const MADAR_FULL_WIN_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 30000,
  num_turns: 2,
  result: 'madar answer',
  total_cost_usd: 0.3,
  usage: {
    input_tokens: 10000,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 50000,
    output_tokens: 1000,
  },
}

const BASELINE_QUALITY_PASS_PAYLOAD = {
  ...BASELINE_FULL_WIN_PAYLOAD,
  result: 'The idea report is generated by GenerateIdeaReportService after the controller hands off the runtime flow.',
}

const MADAR_PERMISSION_BLOCKED_PAYLOAD = {
  ...MADAR_FULL_WIN_PAYLOAD,
  result: 'I need permission to use mcp__madar__retrieve. Please approve the permission before I answer.',
}

const BASELINE_NO_TOOL_COUNT_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 30000,
  num_turns: 3,
  result: 'baseline answer',
  total_cost_usd: 0.3,
  usage: {
    input_tokens: 10000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1000,
  },
}

const MADAR_NO_TOOL_COUNT_LATENCY_REGRESSION_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 60000,
  num_turns: 3,
  result: 'madar answer',
  total_cost_usd: 0.3,
  usage: {
    input_tokens: 10000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1000,
  },
}

const MADAR_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 30000,
  num_turns: 3,
  result: 'madar answer',
  total_cost_usd: 0.3,
  usage: {
    input_tokens: 10000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1000,
  },
}

function toolUses(name: string, count: number): Array<{ type: 'tool_use'; name: string }> {
  return Array.from({ length: count }, () => ({ type: 'tool_use', name }))
}

const VERBOSE_BASELINE_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  BASELINE_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'context_pack' },
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'tool_use', name: 'Glob' },
        { type: 'tool_use', name: 'Bash' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const CONTAMINATED_VERBOSE_MADAR_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'text', text: '<command-name>superpowers:using-superpowers</command-name>' },
        { type: 'text', text: 'Skill tool invoked: {"skill":"superpowers:systematic-debugging"}' },
        { type: 'tool_use', name: 'mcp__madar__context_pack' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'text', text: '<command-name>everything-claude-code:documentation-lookup</command-name>' },
        { type: 'text', text: 'spawn_agent worker launched' },
        { type: 'tool_use', name: 'mcp__github__search_code' },
        { type: 'tool_use', name: 'mcp__context7__get-library-docs' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_NO_INSTALL_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_BASELINE_TOKEN_REGRESSION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
      ],
    },
  },
  BASELINE_TOKEN_REGRESSION_PAYLOAD,
] as const

const VERBOSE_MADAR_TOKEN_REGRESSION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  MADAR_TOKEN_REGRESSION_PAYLOAD,
] as const

const VERBOSE_GOVALIDATE_BASELINE_TOKEN_REGRESSION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        ...toolUses('Read', 12),
        ...toolUses('Grep', 10),
        ...toolUses('Glob', 6),
      ],
    },
  },
  GOVALIDATE_BASELINE_TOKEN_REGRESSION_PAYLOAD,
] as const

const VERBOSE_GOVALIDATE_MADAR_TOKEN_REGRESSION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
        ...toolUses('Read', 3),
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        ...toolUses('Read', 2),
      ],
    },
  },
  GOVALIDATE_MADAR_TOKEN_REGRESSION_PAYLOAD,
] as const

const VERBOSE_BASELINE_FULL_WIN_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        ...toolUses('Read', 6),
        ...toolUses('Grep', 4),
      ],
    },
  },
  BASELINE_FULL_WIN_PAYLOAD,
] as const

const VERBOSE_MADAR_FULL_WIN_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  MADAR_FULL_WIN_PAYLOAD,
] as const

const VERBOSE_BASELINE_QUALITY_PASS_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        ...toolUses('Read', 6),
        ...toolUses('Grep', 4),
      ],
    },
  },
  BASELINE_QUALITY_PASS_PAYLOAD,
] as const

const VERBOSE_MADAR_PERMISSION_BLOCKED_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  MADAR_PERMISSION_BLOCKED_PAYLOAD,
] as const

const RESULT_ONLY_BASELINE_NO_TOOL_COUNT_PAYLOAD = [
  BASELINE_NO_TOOL_COUNT_PAYLOAD,
] as const

const VERBOSE_MADAR_NO_TOOL_COUNT_LATENCY_REGRESSION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  MADAR_NO_TOOL_COUNT_LATENCY_REGRESSION_PAYLOAD,
] as const

const VERBOSE_BASELINE_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  BASELINE_NO_TOOL_COUNT_PAYLOAD,
] as const

const VERBOSE_MADAR_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  MADAR_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD,
] as const

const VERBOSE_MADAR_MCP_RETRIEVE_WITH_FOLLOWUP_EXPLORATION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'tool_use', name: 'Glob' },
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_FIRST_BOUNDED_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__context_pack' },
        {
          type: 'tool_result',
          tool_name: 'mcp__madar__context_pack',
          content: JSON.stringify({
            evidence: {
              pack_confidence: 'high',
              agent_directive: 'answer_from_pack',
            },
            recommended_first_read: [
              { path: 'src/runtime/retrieve.ts', reason: 'primary runtime context' },
            ],
          }),
        },
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_FIRST_LOW_CONFIDENCE_THEN_READY_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__context_pack' },
        {
          type: 'tool_result',
          tool_name: 'mcp__madar__context_pack',
          content: JSON.stringify({
            evidence: {
              pack_confidence: 'low',
              agent_directive: 'explore_with_caution',
            },
          }),
        },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
        {
          type: 'tool_result',
          tool_name: 'mcp__madar__retrieve',
          content: JSON.stringify({
            evidence: {
              pack_confidence: 'high',
              agent_directive: 'answer_from_pack',
            },
          }),
        },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_FIRST_WITH_TWO_READS_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 1,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__context_pack' },
        {
          type: 'tool_result',
          tool_name: 'mcp__madar__context_pack',
          content: JSON.stringify({
            evidence: {
              pack_confidence: 'high',
              agent_directive: 'answer_from_pack',
            },
          }),
        },
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

const VERBOSE_MADAR_MCP_RETRIEVE_AFTER_PRE_EXPLORATION_PAYLOAD = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    turn: 2,
    message: {
      content: [
        { type: 'tool_use', name: 'ToolSearch' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 3,
    message: {
      content: [
        { type: 'tool_use', name: 'ToolSearch' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 6,
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__madar__retrieve' },
      ],
    },
  },
  {
    type: 'assistant',
    turn: 9,
    message: {
      content: [
        { type: 'tool_use', name: 'Read' },
      ],
    },
  },
  MADAR_USAGE_PAYLOAD,
] as const

function scriptedRunner(payloads: { baseline: unknown; madar: unknown }): NativeAgentRunner {
  return async (input) => ({
    exitCode: 0,
    stdout: `${JSON.stringify(input.mode === 'baseline' ? payloads.baseline : payloads.madar)}\n`,
    stderr: '',
    elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
  })
}

function buildSummaryResult(overrides: {
  question: string
  baselineTurns: number
  madarTurns: number
  baselineDurationMs: number
  madarDurationMs: number
  baselineInputTokens: number
  madarInputTokens: number
  reductions: NonNullable<NativeAgentCompareReport['reductions']>
  madarTrace?: NativeAgentCompareReport['madar_trace']
  toolCallCounts?: NativeAgentCompareReport['tool_call_counts']
  installVerified?: boolean
  measurementValidity?: 'valid' | 'degraded' | 'invalid'
  madarMcpCallCount?: number
}): NativeAgentCompareResult {
  const installVerified = overrides.installVerified ?? true
  const madarMcpCallCount = overrides.madarMcpCallCount ?? overrides.madarTrace?.madar_mcp_call_count ?? 0
  const measurementValidity = overrides.measurementValidity ?? (installVerified ? (madarMcpCallCount > 0 ? 'valid' : 'degraded') : 'invalid')
  const traceStatus = overrides.madarTrace ? 'trace_available' : 'missing_verbose_trace'
  return {
    graph_path: '/tmp/project/out/graph.json',
    output_root: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
    reports: [
      {
        baseline_mode: 'native_agent',
        task: 'explain',
        question: overrides.question,
        graph_path: '/tmp/project/out/graph.json',
        isolation: false,
        environment: {
          claude_code_version: '1.2.3',
          host_os: 'darwin-arm64',
          node_version: 'v22.0.0',
          mcp_servers_active: ['madar'],
          mcp_server_count: 1,
          skills_loaded: [],
          skills_loaded_count: 0,
          plugins_active: [],
          user_claude_md_hash: 'sha256:isolation',
          project_claude_md_hash: null,
          parent_claude_md_hashes: [],
          hooks_active: {
            user_prompt_submit: [],
            pre_tool_use: [],
            post_tool_use: [],
          },
        },
        environment_contamination: {
          skills_activated_during_run: [],
          skills_conflicting_with_madar_rules: [],
          calls_to_other_mcps: {},
          subagent_dispatches_detected: 0,
          skill_alignment_score: 1,
        },
        exec_command: { command: null, redacted: true, placeholders: [] },
        baseline: {
          kind: 'succeeded',
          model: 'claude-sonnet',
          usage: {
            input_tokens: overrides.baselineInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
          total_input_tokens_anthropic_exact: overrides.baselineInputTokens,
          uncached_input_tokens_anthropic_exact: overrides.baselineInputTokens,
          cached_input_tokens_anthropic_exact: 0,
          total_cost_usd: 1,
          num_turns: overrides.baselineTurns,
          duration_ms: overrides.baselineDurationMs,
          result_path: '/tmp/project/baseline.txt',
        },
        madar: {
          kind: 'succeeded',
          model: 'claude-sonnet',
          usage: {
            input_tokens: overrides.madarInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
          total_input_tokens_anthropic_exact: overrides.madarInputTokens,
          uncached_input_tokens_anthropic_exact: overrides.madarInputTokens,
          cached_input_tokens_anthropic_exact: 0,
          total_cost_usd: 1,
          num_turns: overrides.madarTurns,
          duration_ms: overrides.madarDurationMs,
          result_path: '/tmp/project/madar.txt',
        },
        reductions: overrides.reductions,
        token_regression: false,
        token_regression_reasons: [],
        prompt_token_source: {
          baseline: 'anthropic_provider_reported',
          madar: 'anthropic_provider_reported',
        },
        provider_proof: {
          baseline: {
            provider: 'anthropic',
            input_tokens_source: 'anthropic_provider_reported',
            effective_tokens_source: 'anthropic_provider_reported',
            total_tokens_source: 'anthropic_provider_reported',
          },
          madar: {
            provider: 'anthropic',
            input_tokens_source: 'anthropic_provider_reported',
            effective_tokens_source: 'anthropic_provider_reported',
            total_tokens_source: 'anthropic_provider_reported',
          },
          reduction_basis: 'provider_reported',
        },
        install_verified: installVerified,
        measurement_validity: measurementValidity,
        trace_status: traceStatus,
        madar_mcp_call_count: madarMcpCallCount,
        ...(overrides.toolCallCounts ? { tool_call_counts: overrides.toolCallCounts } : {}),
        ...(overrides.madarTrace ? { madar_trace: overrides.madarTrace } : {}),
        started_at: '2026-05-12T00:00:00.000Z',
        completed_at: '2026-05-12T00:00:01.000Z',
        paths: {
          output_dir: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
          report: '/tmp/project/out/compare/2026-05-12T00-00-00Z/report.json',
          share_safe_report: '/tmp/project/out/compare/2026-05-12T00-00-00Z/report.share-safe.json',
          baseline_answer: '/tmp/project/out/compare/2026-05-12T00-00-00Z/baseline.md',
          madar_answer: '/tmp/project/out/compare/2026-05-12T00-00-00Z/madar.md',
          baseline_prompt: '/tmp/project/out/compare/2026-05-12T00-00-00Z/baseline-prompt.txt',
          madar_prompt: '/tmp/project/out/compare/2026-05-12T00-00-00Z/madar-prompt.txt',
          prompt_file: '/tmp/project/out/compare/2026-05-12T00-00-00Z/madar-prompt.txt',
        },
      },
    ],
  }
}

type SummaryOverrides = Parameters<typeof buildSummaryResult>[0]

function buildSuiteSummaryResult(overridesList: SummaryOverrides[]): NativeAgentCompareResult {
  return {
    graph_path: '/tmp/project/out/graph.json',
    output_root: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
    reports: overridesList.map((overrides) => buildSummaryResult(overrides).reports[0]!),
  }
}

describe('parseAnthropicResultEvent', () => {
  it('parses a single non-stream JSON object from stdout', () => {
    const stdout = `${JSON.stringify(BASELINE_USAGE_PAYLOAD)}\n`
    const parsed = parseAnthropicResultEvent(stdout)
    expect(parsed).not.toBeNull()
    expect(parsed?.usage.input_tokens).toBe(14)
    expect(parsed?.num_turns).toBe(9)
  })

  it('extracts the trailing result event from a stream-json stdout', () => {
    const intermediate = JSON.stringify({ type: 'system', subtype: 'init', tools: ['retrieve'] })
    const result = JSON.stringify({ ...MADAR_USAGE_PAYLOAD })
    const parsed = parseAnthropicResultEvent(`${intermediate}\n${result}\n`)
    expect(parsed).not.toBeNull()
    expect(parsed?.usage.input_tokens).toBe(13)
    expect(parsed?.num_turns).toBe(3)
  })

  it('extracts the trailing result event from a verbose JSON array', () => {
    const parsed = parseAnthropicResultEvent(JSON.stringify(VERBOSE_MADAR_PAYLOAD))
    expect(parsed).not.toBeNull()
    expect(parsed?.usage.input_tokens).toBe(13)
    expect(parsed?.num_turns).toBe(3)
  })

  it('returns null when stdout has no parseable trailing JSON object', () => {
    expect(parseAnthropicResultEvent('not a json blob at all')).toBeNull()
  })

  it('returns null when the trailing JSON object lacks a usage block', () => {
    expect(parseAnthropicResultEvent(JSON.stringify({ type: 'result', result: 'no usage' }))).toBeNull()
  })
})

describe('executeNativeAgentCompare', () => {
  it('writes separate native-agent prompts for the baseline and Madar arms', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const baselinePrompt = readFileSync(report.paths.baseline_prompt, 'utf8')
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')
      const legacyPrompt = readFileSync(join(dirname(report.paths.baseline_prompt), 'native_agent-prompt.txt'), 'utf8')

      expect(baselinePrompt).toContain('Answer the question from normal repository evidence.')
      expect(baselinePrompt).toContain('Do not call Madar-specific tools')
      expect(baselinePrompt).not.toContain('Call retrieve first')
      expect(baselinePrompt).not.toContain('Follow the Madar pack contract')
      expect(baselinePrompt).toContain('Question: What is the cluster module?')

      expect(madarPrompt).toContain('Call retrieve first')
      expect(madarPrompt).toContain('Inspect matched_nodes, snippets, relationships, and community context before deciding what to do next')
      expect(madarPrompt).toContain('If retrieve already answers the question, answer from the retrieved evidence and stop without raw search')
      expect(madarPrompt).toContain('Do not call community_overview, graph_summary, get_community, query_graph')
      expect(madarPrompt).toContain('Allow at most one focused raw file read or search')
      expect(madarPrompt).toContain('Broad raw search requires an explicit missing-context reason')
      expect(madarPrompt).toContain('Question: What is the cluster module?')

      expect(legacyPrompt).toBe(baselinePrompt)
      expect(legacyPrompt).not.toContain('Call retrieve first')
      expect(legacyPrompt).not.toContain('Follow the Madar pack contract')

      expect(report.paths.prompt_file).toBe(report.paths.madar_prompt)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('writes a full-profile native-agent prompt that keeps context_pack first', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ profile: 'full' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const prompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(prompt).toContain('Call context_pack first')
      expect(prompt).toContain('Inspect evidence.pack_confidence, evidence.coverage, evidence.agent_directive, missing_context, and recommended_first_read')
      expect(prompt).toContain('If evidence.agent_directive is answer_from_pack, answer from the pack and stop without raw search')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('records implement-task outcome scoring with isolated per-arm workspaces', async () => {
    const { projectDir, graphPath, outputDir, questionsPath } = makeImplementationFixtureProject()
    try {
      const runner: NativeAgentRunner = async (input) => {
        const workspaceRoot = input.cwd ?? projectDir
        if (input.mode === 'baseline') {
          writeFileSync(
            join(workspaceRoot, 'src', 'config.ts'),
            [
              'export const config = {',
              '  sessionTtlSeconds: 86400,',
              '  slidingExpirationMs: 30000,',
              '}',
              '',
            ].join('\n'),
            'utf8',
          )
        } else {
          writeFileSync(
            join(workspaceRoot, 'src', 'session.ts'),
            [
              'export class SessionManager {',
              '  readonly slidingExpirationMs = 30000',
              '',
              '  createSession(userId: string) {',
              '    return `session:${userId}`',
              '  }',
              '}',
              '',
            ].join('\n'),
            'utf8',
          )
        }

        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ...(input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : MADAR_USAGE_PAYLOAD),
            result: input.mode === 'baseline' ? 'updated config' : 'updated session manager',
          })}\n`,
          stderr: '',
          elapsedMs: input.mode === 'baseline' ? 11 : 7,
        }
      }

      const result = await executeNativeAgentCompare(
        {
          graphPath,
          questionsPath,
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          task: 'implement',
        },
        {
          runner,
          now: () => new Date('2026-05-31T12:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.task).toBe('implement')
      expect(report.implementation_guidance?.likely_edit_files.map((entry) => entry.path)).toContain('src/session.ts')
      expect(report.implementation_guidance?.validation_commands).toContain('npm run typecheck')
      expect(report.implement_outcome).toEqual({
        baseline: expect.objectContaining({
          files_touched: ['src/config.ts'],
          wrong_file_edits: ['src/config.ts'],
          validation: expect.objectContaining({
            status: 'failed',
          }),
          reviewer_visible_correctness: expect.objectContaining({
            status: 'failed',
          }),
        }),
        madar: expect.objectContaining({
          files_touched: ['src/session.ts'],
          wrong_file_edits: [],
          validation: expect.objectContaining({
            status: 'passed',
          }),
          reviewer_visible_correctness: expect.objectContaining({
            status: 'passed',
          }),
        }),
      })

      const baselinePrompt = readFileSync(report.paths.baseline_prompt, 'utf8')
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')
      expect(baselinePrompt).toContain('Implement the requested change using normal repository evidence.')
      expect(baselinePrompt).toContain('Do not call Madar-specific tools')
      expect(baselinePrompt).not.toContain('Implement the requested change using the Madar implementation pack.')
      expect(madarPrompt).toContain('Implement the requested change using the Madar implementation pack.')
      expect(madarPrompt).toContain('src/session.ts')
      expect(madarPrompt).toContain('npm run typecheck')

      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
      expect(savedReport).toEqual(expect.objectContaining({
        task: 'implement',
        implement_outcome: expect.objectContaining({
          baseline: expect.objectContaining({
            wrong_file_edits: ['src/config.ts'],
          }),
          madar: expect.objectContaining({
            wrong_file_edits: [],
          }),
        }),
      }))
      expect(shareSafeReport).toEqual(expect.objectContaining({
        task: 'implement',
        implement_outcome: expect.objectContaining({
          madar: expect.objectContaining({
            files_touched: ['src/session.ts'],
          }),
        }),
      }))

      expect(readFileSync(join(projectDir, 'src', 'session.ts'), 'utf8')).not.toContain('slidingExpirationMs')
      expect(readFileSync(join(projectDir, 'src', 'config.ts'), 'utf8')).not.toContain('slidingExpirationMs')

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('implement outcome:')
      expect(summary).toContain('wrong-file edits')
      expect(summary).toContain('reviewer-visible')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('times out implement validation commands instead of hanging after the agent run', async () => {
    const { projectDir, graphPath, outputDir, questionsPath } = makeImplementationFixtureProject()
    try {
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'implement-timeout-fixture',
          private: true,
          type: 'module',
          scripts: {
            typecheck: 'node -e "setTimeout(() => process.exit(0), 5000)"',
          },
        }, null, 2),
        'utf8',
      )

      const runner: NativeAgentRunner = async (input) => {
        const workspaceRoot = input.cwd ?? projectDir
        writeFileSync(
          join(workspaceRoot, 'src', 'session.ts'),
          [
            'export class SessionManager {',
            '  readonly slidingExpirationMs = 30000',
            '',
            '  createSession(userId: string) {',
            '    return `session:${userId}`',
            '  }',
            '}',
            '',
          ].join('\n'),
          'utf8',
        )

        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ...(input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : MADAR_USAGE_PAYLOAD),
            result: 'updated session manager',
          })}\n`,
          stderr: '',
          elapsedMs: 5,
        }
      }

      const request = {
        graphPath,
        questionsPath,
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        task: 'implement',
        validationTimeoutSeconds: 0.01,
      } as Parameters<typeof executeNativeAgentCompare>[0] & { validationTimeoutSeconds: number }
      const hangBudgetMs = 2000

      const outcome = await Promise.race([
        executeNativeAgentCompare(
          request,
          {
            runner,
            now: () => new Date('2026-06-01T00:00:00Z'),
          },
        ).then((result) => ({ kind: 'resolved' as const, result })),
        new Promise<{ kind: 'hung' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'hung' }), hangBudgetMs)
        }),
      ])

      if (outcome.kind !== 'resolved') {
        throw new Error('compare hung instead of timing out implement validation commands')
      }

      const report = outcome.result.reports[0] as NativeAgentCompareReport
      expect(['failed', 'setup_error']).toContain(report.implement_outcome?.baseline.validation.status)
      expect(['failed', 'setup_error']).toContain(report.implement_outcome?.madar.validation.status)
      expect(report.implement_outcome?.baseline.validation.commands).toEqual([
        expect.objectContaining({
          command: 'npm run typecheck',
        }),
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails early when strict benchmark readiness is poor', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    let runnerCalled = false
    try {
      const reportPath = join(outputDir, '2026-05-01T00-00-00', 'report.json')
      const runner: NativeAgentRunner = async (input) => {
        runnerCalled = true
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(input.mode === 'baseline' ? VERBOSE_BASELINE_PAYLOAD : VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD)}\n`,
          stderr: '',
          elapsedMs: 1,
        }
      }

      await expect(
        executeNativeAgentCompare(
          {
            graphPath,
            question: 'How idea report is being generated',
            outputDir,
            execTemplate: 'mock-runner',
            baselineMode: 'native_agent',
            strictBenchmarkReadiness: true,
          } as Parameters<typeof executeNativeAgentCompare>[0] & { strictBenchmarkReadiness: boolean },
          {
            runner,
            now: () => new Date('2026-05-01T00:00:00Z'),
            assessBenchmarkReadiness: () => ({
              status: 'not_ready',
              reasons: ['SPI missing for runtime spine evidence'],
              suggested_graph_scope: 'backend/out/graph.json',
            }),
          } as Parameters<typeof executeNativeAgentCompare>[1] & {
            assessBenchmarkReadiness: () => {
              status: 'ready' | 'degraded' | 'not_ready'
              reasons: string[]
              suggested_graph_scope: string | null
            }
          },
        ),
      ).rejects.toThrow('benchmark readiness is not_ready')
      expect(runnerCalled).toBe(false)
      expect(existsSync(reportPath)).toBe(true)
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(expect.objectContaining({
        benchmark_readiness: {
          status: 'not_ready',
          reasons: ['SPI missing for runtime spine evidence'],
          suggested_graph_scope: 'backend/out/graph.json',
        },
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('records benchmark readiness in the native-agent report and summary', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
          assessBenchmarkReadiness: () => ({
            status: 'not_ready',
            reasons: ['SPI missing for runtime spine evidence', 'scope locality is weak'],
            suggested_graph_scope: 'backend/out/graph.json',
          }),
        } as Parameters<typeof executeNativeAgentCompare>[1] & {
          assessBenchmarkReadiness: () => {
            status: 'ready' | 'degraded' | 'not_ready'
            reasons: string[]
            suggested_graph_scope: string | null
          }
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        benchmark_readiness?: {
          status: 'ready' | 'degraded' | 'not_ready'
          reasons: string[]
          suggested_graph_scope: string | null
        }
      }
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const claimAssessment = savedReport.claim_assessment as {
        routing_efficiency?: { status?: string }
        token_reduction?: { status?: string }
      } | undefined
      const benchmarkOutcome = savedReport.benchmark_outcome as {
        outcome?: string
      } | undefined
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.benchmark_readiness).toEqual({
        status: 'not_ready',
        reasons: ['SPI missing for runtime spine evidence', 'scope locality is weak'],
        suggested_graph_scope: 'backend/out/graph.json',
      })
      expect(savedReport.benchmark_readiness).toEqual({
        status: 'not_ready',
        reasons: ['SPI missing for runtime spine evidence', 'scope locality is weak'],
        suggested_graph_scope: 'backend/out/graph.json',
      })
      expect(claimAssessment).toEqual(expect.objectContaining({
        routing_efficiency: expect.objectContaining({
          status: 'not_measured',
        }),
        token_reduction: expect.objectContaining({
          status: 'not_measured',
        }),
      }))
      expect(benchmarkOutcome).toEqual(expect.objectContaining({
        outcome: 'not_measured',
      }))
      expect(summary).toContain('benchmark_readiness: not_ready')
      expect(summary).toContain('claim_assessment: routing_efficiency not_measured')
      expect(summary).toContain('benchmark_outcome: not_measured')
      expect(summary).toContain('SPI missing for runtime spine evidence')
      expect(summary).toContain('Next step: retry with backend/out/graph.json')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('suppresses runtime benchmark wins when benchmark readiness is degraded', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
          assessBenchmarkReadiness: () => ({
            status: 'degraded',
            reasons: ['missing downstream runtime phases: persistence'],
            suggested_graph_scope: null,
          }),
        } as Parameters<typeof executeNativeAgentCompare>[1] & {
          assessBenchmarkReadiness: () => {
            status: 'ready' | 'degraded' | 'not_ready'
            reasons: string[]
            suggested_graph_scope: string | null
          }
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        benchmark_readiness?: {
          status: 'ready' | 'degraded' | 'not_ready'
          reasons: string[]
          suggested_graph_scope: string | null
        }
      }
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        benchmark_outcome?: {
          outcome?: string
          evidence?: string[]
        }
      }
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.benchmark_readiness).toEqual({
        status: 'degraded',
        reasons: ['missing downstream runtime phases: persistence'],
        suggested_graph_scope: null,
      })
      expect(savedReport.benchmark_outcome).toEqual(expect.objectContaining({
        outcome: 'not_measured',
        evidence: expect.arrayContaining([
          expect.stringContaining('benchmark readiness is degraded'),
        ]),
      }))
      expect(summary).toContain('benchmark_readiness: degraded')
      expect(summary).toContain('benchmark_outcome: not_measured')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('auto-rescopes strict runtime benchmark readiness once when the root graph is too broad', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        benchmark_readiness?: {
          status: 'ready' | 'degraded' | 'not_ready'
          reasons: string[]
          suggested_graph_scope: string | null
          rescope_attempted?: boolean
          rescoped_to?: string | null
        }
      }
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.benchmark_readiness).toEqual(expect.objectContaining({
        status: 'ready',
        suggested_graph_scope: null,
        rescope_attempted: true,
        rescoped_to: 'backend/out/graph.json',
      }))
      expect(summary).toContain('benchmark_readiness: ready')
      expect(summary).toContain('auto-rescoped to backend/out/graph.json')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('keeps strict runtime benchmark readiness ready when the rescoped graph uses its own project root', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProjectWithOptions({
      scopedGraphUsesScopedRoot: true,
    })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        benchmark_readiness?: {
          status: 'ready' | 'degraded' | 'not_ready'
          reasons: string[]
          suggested_graph_scope: string | null
          rescope_attempted?: boolean
          rescoped_to?: string | null
        }
      }
      const summary = formatNativeAgentCompareSummary(result)
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(report.benchmark_readiness).toEqual(expect.objectContaining({
        status: 'ready',
        suggested_graph_scope: null,
        rescope_attempted: true,
        rescoped_to: 'backend/out/graph.json',
      }))
      expect(summary).toContain('benchmark_readiness: ready')
      expect(madarPrompt).toContain('Start from the auto-rescoped graph scope: backend/out/graph.json.')
      expect(madarPrompt).not.toContain('missing persistence')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('passes strict missing-phase proof guidance into the native-agent prompt after auto-rescope', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProjectWithOptions({
      includePersistenceStep: false,
    })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(madarPrompt).toContain('This question requires strict runtime proof.')
      expect(madarPrompt).toContain('Start from the auto-rescoped graph scope: backend/out/graph.json.')
      expect(madarPrompt).toContain('Use at most one focused follow-up to surface the missing persistence phase.')
      expect(madarPrompt).toContain('If the flow still cannot be proven, answer: not enough evidence; missing persistence')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('passes strict missing-phase proof guidance for degraded backend runtime prompts even when the retrieval gate is not flow-proof-shaped', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProjectWithOptions({
      includePersistenceStep: false,
    })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Explain runtime pipeline for `POST /login` persistence',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:46:00Z'),
          assessBenchmarkReadiness: () => ({
            status: 'degraded',
            reasons: ['missing downstream runtime phases: persistence'],
            suggested_graph_scope: null,
          }),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(madarPrompt).toContain('This question requires strict runtime proof.')
      expect(madarPrompt).toContain('Use at most one focused follow-up to surface the missing persistence phase.')
      expect(madarPrompt).toContain('If the flow still cannot be proven, answer: not enough evidence; missing persistence')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not pass strict missing-phase proof guidance for ready backend runtime prompts when the retrieval gate is not flow-proof-shaped', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProjectWithOptions({
      includePersistenceStep: false,
    })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Explain runtime pipeline for `POST /login` persistence',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:47:00Z'),
          assessBenchmarkReadiness: () => ({
            status: 'ready',
            reasons: [],
            suggested_graph_scope: null,
          }),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(madarPrompt).not.toContain('This question requires strict runtime proof.')
      expect(madarPrompt).not.toContain('If the flow still cannot be proven, answer: not enough evidence; missing persistence')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not claim auto-rescope when the suggested scoped graph is unavailable', async () => {
    const { projectDir, graphPath, outputDir } = makeRescopedReadinessFixtureProjectWithOptions({
      includeScopedGraph: false,
    })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        benchmark_readiness?: {
          status: 'ready' | 'degraded' | 'not_ready'
          reasons: string[]
          suggested_graph_scope: string | null
          rescope_attempted?: boolean
          rescoped_to?: string | null
        }
      }
      const summary = formatNativeAgentCompareSummary(result)
      const madarPrompt = readFileSync(report.paths.madar_prompt, 'utf8')

      expect(report.benchmark_readiness).toEqual(expect.objectContaining({
        suggested_graph_scope: 'backend/out/graph.json',
        rescope_attempted: true,
        rescoped_to: null,
      }))
      expect(summary).not.toContain('auto-rescoped to backend/out/graph.json')
      expect(madarPrompt).not.toContain('Start from the auto-rescoped graph scope: backend/out/graph.json.')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('aborts when no Madar install is detected and --allow-no-install is not set', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ installState: 'missing' })
    try {
      await expect(
        executeNativeAgentCompare(
          {
            graphPath,
            question: 'What is the cluster module?',
            outputDir,
            execTemplate: 'mock-runner',
            baselineMode: 'native_agent',
          },
          {
            runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
            now: () => new Date('2026-05-01T00:00:00Z'),
          },
        ),
      ).rejects.toThrow(/No Madar install detected/)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks runs invalid when install is missing but --allow-no-install is set', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ installState: 'missing' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          allowNoInstall: true,
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>

      expect(report.install_verified).toBe(false)
      expect(report.measurement_validity).toBe('invalid')
      expect(report.madar_mcp_call_count).toBe(0)
      expect(savedReport.install_verified).toBe(false)
      expect(savedReport.measurement_validity).toBe('invalid')
      expect(shareSafeReport.install_verified).toBe(false)
      expect(shareSafeReport.measurement_validity).toBe('invalid')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks runs degraded when install is verified but the agent never invokes Madar', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_NO_INSTALL_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.install_verified).toBe(true)
      expect(report.measurement_validity).toBe('degraded')
      expect(report.madar_mcp_call_count).toBe(0)
      expect(report.reductions).toBeNull()
      expect(report.madar_trace).toEqual(expect.objectContaining({
        madar_mcp_call_count: 0,
        exploration_outcome: 'madar_available_but_unused',
      }))
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
      expect(savedReport.reductions).toBeNull()
      expect(shareSafeReport.reductions).toBeNull()
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks no-trace provider-only runs degraded and suppresses derived reductions', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>

      expect(report.install_verified).toBe(true)
      expect(report.measurement_validity).toBe('degraded')
      expect(report.trace_status).toBe('missing_verbose_trace')
      expect(report.madar_mcp_call_count).toBe(0)
      expect(report.madar_trace).toBeUndefined()
      expect(report.reductions).toBeNull()
      expect(savedReport.trace_status).toBe('missing_verbose_trace')
      expect(shareSafeReport.trace_status).toBe('missing_verbose_trace')
      expect(savedReport.reductions).toBeNull()
      expect(shareSafeReport.reductions).toBeNull()
      expect(report.madar.kind).toBe('succeeded')

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('trace_status: missing_verbose_trace')
      expect(summary).toContain('Claude --verbose is required for MCP-call attribution')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks verbose missing-install runs as no_install when trace data is present', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ installState: 'missing' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          allowNoInstall: true,
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_NO_INSTALL_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.install_verified).toBe(false)
      expect(report.measurement_validity).toBe('invalid')
      expect(report.madar_trace).toEqual(expect.objectContaining({
        madar_mcp_call_count: 0,
        exploration_outcome: 'no_install',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks runs valid when install is verified and Madar MCP is invoked', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.install_verified).toBe(true)
      expect(report.measurement_validity).toBe('valid')
      expect(report.trace_status).toBe('trace_available')
      expect(report.madar_mcp_call_count).toBe(1)
      expect(report.madar_trace).toEqual(expect.objectContaining({
        madar_mcp_call_count: 1,
        madar_mcp_calls_by_name: {
          'mcp__madar__retrieve': 1,
        },
        exploration_outcome: 'madar_invoked',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('reports a followed prompt contract when a core install starts with retrieve', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('prompt_contract: followed (started with retrieve and avoided disallowed exploration)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('reports a prompt-contract violation when a full install starts with retrieve instead of context_pack', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ profile: 'full' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('prompt_contract: violated (first Madar call was not context_pack)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves a full-profile first-tool violation even when broad exploration happens later', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ profile: 'full' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_MCP_RETRIEVE_WITH_FOLLOWUP_EXPLORATION_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect((result.reports[0] as NativeAgentCompareReport).prompt_contract).toEqual({
        status: 'violated',
        evidence: [
          'first Madar call was not context_pack',
          'broad exploration occurred after the first Madar call, but the trace does not show whether missing_context justified it',
        ],
      })
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('recognizes the real Claude installer hook as a verified Madar install', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ installState: 'managed' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.install_verified).toBe(true)
      expect(report.measurement_validity).toBe('valid')
      expect(report.madar_mcp_call_count).toBe(1)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not treat a non-Claude managed hook matcher as a verified Claude install', () => {
    const { projectDir } = makeFixtureProject({ installState: 'managed' })
    try {
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  name: 'madar',
                  source: 'madar',
                  matcher: 'read_file|list_directory|search_for_pattern',
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo ignored',
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      )

      expect(inspectClaudeNativeAgentInstall(projectDir).verified).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not treat a missing generated Claude hook script as a verified install', () => {
    const { projectDir } = makeFixtureProject({ installState: 'managed' })
    try {
      rmSync(join(projectDir, '.claude', 'madar-user-prompt-submit.cjs'), { force: true })

      expect(inspectClaudeNativeAgentInstall(projectDir).verified).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('classifies broad exploration after a Madar MCP call as madar_invoked_with_followup_exploration', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_MCP_RETRIEVE_WITH_FOLLOWUP_EXPLORATION_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.madar_trace).toEqual(expect.objectContaining({
        madar_mcp_call_count: 1,
        exploration_outcome: 'madar_invoked_with_followup_exploration',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks prompt-contract evidence after post-pack broad exploration as not measured', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_MCP_RETRIEVE_WITH_FOLLOWUP_EXPLORATION_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.prompt_contract).toEqual({
        status: 'not_measured',
        evidence: [
          'broad exploration occurred after the first Madar call, but the trace does not show whether missing_context justified it',
        ],
      })

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain(
        'prompt_contract: not_measured (broad exploration occurred after the first Madar call, but the trace does not show whether missing_context justified it)',
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('distinguishes Madar-first bounded traces from generic Madar invocation', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How does runtime retrieval work?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_FIRST_BOUNDED_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.madar_trace).toEqual(expect.objectContaining({
        first_madar_turn: 1,
        context_pack_call_count: 1,
        focused_follow_up_tool_call_count: 1,
        broad_exploration_tool_call_count: 0,
        agent_directive_seen: ['answer_from_pack'],
        exploration_outcome: 'madar_first_bounded',
      }))
      expect(report.madar_trace?.exploration_summary).toContain('Madar-first bounded path')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not classify low-confidence first packs as Madar-first bounded even when follow-up is answer-ready', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How does runtime retrieval work?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_FIRST_LOW_CONFIDENCE_THEN_READY_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.madar_trace).toEqual(expect.objectContaining({
        first_madar_turn: 1,
        agent_directive_seen: ['explore_with_caution', 'answer_from_pack'],
        exploration_outcome: 'madar_invoked',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not classify multiple focused reads after a pack as Madar-first bounded', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How does runtime retrieval work?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_FIRST_WITH_TWO_READS_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.madar_trace).toEqual(expect.objectContaining({
        first_madar_turn: 1,
        focused_follow_up_tool_call_count: 2,
        exploration_outcome: 'madar_invoked',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('flags broad exploration before the first Madar MCP call', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_MCP_RETRIEVE_AFTER_PRE_EXPLORATION_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.measurement_validity).toBe('valid')
      expect(report.madar_trace).toEqual(expect.objectContaining({
        first_madar_turn: 6,
        pre_madar_broad_exploration_tool_call_count: 2,
        pre_madar_broad_exploration_tool_calls_by_name: {
          ToolSearch: 2,
        },
        exploration_outcome: 'madar_invoked_after_broad_exploration',
      }))

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('madar_invoked_after_broad_exploration')
      expect(summary).toContain('2 broad exploration calls before the first Madar call')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('degrades broad exploration before the first Madar MCP call in strict mode', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          strictMadarFirst: true,
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_PAYLOAD,
            madar: VERBOSE_MADAR_MCP_RETRIEVE_AFTER_PRE_EXPLORATION_PAYLOAD,
          }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.measurement_validity).toBe('degraded')
      expect(report.reductions).toBeNull()
      expect(report.claim_assessment).toEqual({
        routing_efficiency: {
          status: 'not_measured',
          evidence: ['Broad exploration occurred before the first Madar MCP call.'],
        },
        token_reduction: {
          status: 'not_measured',
          evidence: ['Broad exploration occurred before the first Madar MCP call.'],
        },
      })
      expect(report.madar_trace).toEqual(expect.objectContaining({
        first_madar_turn: 6,
        pre_madar_broad_exploration_tool_call_count: 2,
        exploration_outcome: 'madar_invoked_after_broad_exploration',
      }))

      const summary = formatNativeAgentCompareSummary(result)
      expect(summary).toContain('measurement_validity: degraded (broad exploration preceded the first Madar MCP call)')
      expect(summary).toContain('Cannot attribute outcome differences to Madar.')
      expect(summary).toContain('madar_invoked_after_broad_exploration')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('produces a report with both Anthropic-reported usage blocks and computed reductions', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(result.reports).toHaveLength(1)
      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.baseline_mode).toBe('native_agent')
      expect(report.exec_command.command).toBeNull()
      expect(report.exec_command.redacted).toBe(true)
      expect(report.measurement_validity).toBe('valid')
      expect(report.madar_mcp_call_count).toBe(1)

      // Both Anthropic-reported usage blocks are preserved as-is.
      expect(report.baseline.kind).toBe('succeeded')
      if (report.baseline.kind !== 'succeeded') {
        throw new Error('baseline should have succeeded')
      }
      expect(report.baseline.usage).toEqual(BASELINE_USAGE_PAYLOAD.usage)
      expect(report.baseline.num_turns).toBe(9)
      expect(report.baseline.total_cost_usd).toBe(0.62)

      expect(report.madar.kind).toBe('succeeded')
      if (report.madar.kind !== 'succeeded') {
        throw new Error('madar should have succeeded')
      }
      expect(report.madar.usage).toEqual(MADAR_USAGE_PAYLOAD.usage)
      expect(report.madar.num_turns).toBe(3)
      expect(report.madar.total_cost_usd).toBe(0.7)

      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        baseline: Record<string, unknown>
        madar: Record<string, unknown>
      }
      expect(savedReport.baseline).toEqual(expect.objectContaining({
        total_input_tokens_anthropic_exact: 615190,
        uncached_input_tokens_anthropic_exact: 40662,
        cached_input_tokens_anthropic_exact: 574528,
      }))
      expect(savedReport.madar).toEqual(expect.objectContaining({
        total_input_tokens_anthropic_exact: 233508,
        uncached_input_tokens_anthropic_exact: 92846,
        cached_input_tokens_anthropic_exact: 140662,
      }))

      // Reductions match the spec table (3x turns, 2.6x input, 2.77x duration).
      expect(report.reductions).not.toBeNull()
      expect(report.reductions?.num_turns).toBeCloseTo(3.0, 2)
      expect(report.reductions?.input_tokens).toBeCloseTo(2.63, 1)
      expect(report.reductions?.duration_ms).toBeCloseTo(2.77, 1)

      // prompt_token_source must label both as Anthropic-provider-reported when
      // a usage block was present in the runner output.
      expect(report.prompt_token_source.baseline).toBe('anthropic_provider_reported')
      expect(report.prompt_token_source.madar).toBe('anthropic_provider_reported')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('flags token regressions when fresh-token usage rises despite near-flat total input tokens', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_TOKEN_REGRESSION_PAYLOAD,
            madar: VERBOSE_MADAR_TOKEN_REGRESSION_PAYLOAD,
          }),
          now: () => new Date('2026-05-26T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
      const reductions = savedReport.reductions as Record<string, unknown>
      const shareSafeReductions = shareSafeReport.reductions as Record<string, unknown>

      expect(report.measurement_validity).toBe('valid')
      expect(report.madar_mcp_call_count).toBe(1)
      expect(reductions.input_tokens).toBeCloseTo(1.06, 2)
      expect(reductions.uncached_input_tokens).toBeCloseTo(0.72, 2)
      expect(reductions.cache_creation_input_tokens).toBeCloseTo(0.6, 2)
      expect(savedReport.token_regression).toBe(true)
      expect(savedReport.token_regression_reasons).toEqual(expect.arrayContaining([
        'uncached_input_tokens',
        'cache_creation_input_tokens',
      ]))
      expect(shareSafeReductions.uncached_input_tokens).toBeCloseTo(0.72, 2)
      expect(shareSafeReport.token_regression).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('classifies native-agent benchmark outcomes as full wins only when every measured gate passes', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ spiMode: true })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:30:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const benchmarkOutcome = savedReport.benchmark_outcome as Record<string, unknown> | undefined
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.measurement_validity).toBe('valid')
      expect(report.tool_call_counts?.baseline.total).toBe(10)
      expect(report.tool_call_counts?.madar.total).toBe(1)
      expect(savedReport.token_regression).toBe(false)
      expect(benchmarkOutcome).toEqual(expect.objectContaining({
        outcome: 'full_win',
        checks: expect.objectContaining({
          routing_tool_latency: 'win',
          token: 'win',
          fresh_token: 'win',
          cost: 'win',
          turns: 'win',
        }),
      }))
      expect(summary).toContain('benchmark_outcome: full_win')
      expect(summary).toContain('turns win')
      expect(summary).toContain('fresh_token win')
      expect(summary).toContain('cost win')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('suppresses benchmark wins and headline claims when Madar answer quality fails deterministic gates', async () => {
    const { projectDir, graphPath, outputDir, questionsPath } = makeExplainQualityFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          questionsPath,
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_QUALITY_PASS_PAYLOAD,
            madar: VERBOSE_MADAR_PERMISSION_BLOCKED_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        answer_quality?: {
          baseline: {
            passed: boolean
            missing_required_terms: string[]
            forbidden_terms_present: string[]
          }
          madar: {
            passed: boolean
            missing_required_terms: string[]
            forbidden_terms_present: string[]
          }
        }
      }
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        benchmark_outcome?: {
          outcome?: string
          checks?: Record<string, string>
          evidence?: string[]
        }
        claim_assessment?: {
          routing_efficiency?: { status?: string; evidence?: string[] }
          token_reduction?: { status?: string; evidence?: string[] }
        }
      }
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.answer_quality).toEqual(expect.objectContaining({
        baseline: expect.objectContaining({
          passed: true,
        }),
        madar: expect.objectContaining({
          passed: false,
          forbidden_terms_present: expect.arrayContaining(['mcp__madar__retrieve', 'approve the permission']),
        }),
      }))
      expect(savedReport.claim_assessment).toEqual(expect.objectContaining({
        routing_efficiency: expect.objectContaining({
          status: 'not_measured',
        }),
        token_reduction: expect.objectContaining({
          status: 'not_measured',
        }),
      }))
      expect(savedReport.benchmark_outcome).toEqual(expect.objectContaining({
        outcome: 'not_measured',
        checks: expect.objectContaining({
          routing_tool_latency: 'not_measured',
          token: 'not_measured',
          fresh_token: 'not_measured',
          cost: 'not_measured',
          turns: 'not_measured',
        }),
        evidence: expect.arrayContaining([
          expect.stringContaining('answer quality'),
        ]),
      }))
      expect(summary).toContain('answer quality: baseline PASS')
      expect(summary).toContain('madar FAIL')
      expect(summary).toContain('claim_assessment: routing_efficiency not_measured')
      expect(summary).toContain('benchmark_outcome: not_measured')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('suppresses runtime benchmark wins when the prompt contract is violated', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ profile: 'full' })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_FULL_WIN_PAYLOAD,
            madar: VERBOSE_MADAR_FULL_WIN_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:45:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        benchmark_outcome?: {
          outcome?: string
          evidence?: string[]
        }
      }
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.prompt_contract).toEqual({
        status: 'violated',
        evidence: ['first Madar call was not context_pack'],
      })
      expect(savedReport.benchmark_outcome).toEqual(expect.objectContaining({
        outcome: 'not_measured',
        evidence: expect.arrayContaining([
          expect.stringContaining('prompt contract'),
        ]),
      }))
      expect(summary).toContain('prompt_contract: violated')
      expect(summary).toContain('benchmark_outcome: not_measured')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
  it('classifies implement outcomes from isolated touched-file overlap and passing validation', async () => {
    const { projectDir, graphPath, outputDir } = makeImplementFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'change login validation behavior',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          task: 'implement',
        } as Parameters<typeof executeNativeAgentCompare>[0],
        {
          runner: async (input) => {
            const workspaceRoot = ((input as { workspaceRoot?: string }).workspaceRoot) ?? projectDir
            if (input.mode === 'baseline') {
              writeFileSync(join(workspaceRoot, 'src', 'legacy', 'noisy.ts'), 'export const noisy = "baseline-change"\n', 'utf8')
            } else {
              writeFileSync(join(workspaceRoot, 'src', 'auth', 'login-service.ts'), 'export const loginValidation = "madar-implement-change"\n', 'utf8')
              writeFileSync(join(workspaceRoot, 'tests', 'unit', 'login-service.test.ts'), 'export const loginServiceTest = "madar-implement-test"\n', 'utf8')
            }
            return {
              exitCode: 0,
              stdout: `${JSON.stringify(input.mode === 'baseline' ? VERBOSE_BASELINE_PAYLOAD : VERBOSE_MADAR_MCP_RETRIEVE_PAYLOAD)}\n`,
              stderr: '',
              elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
            }
          },
          now: () => new Date('2026-05-28T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport & {
        implement_outcome?: {
          baseline: {
            files_touched: string[]
            wrong_file_edits: string[]
            validation: { status: string }
          }
          madar: {
            files_touched: string[]
            wrong_file_edits: string[]
            validation: { status: string }
          }
        }
      }
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        implement_outcome?: {
          baseline: {
            files_touched: string[]
            wrong_file_edits: string[]
            validation: { status: string }
          }
          madar: {
            files_touched: string[]
            wrong_file_edits: string[]
            validation: { status: string }
          }
        }
        benchmark_outcome?: unknown
      }
      const summary = formatNativeAgentCompareSummary(result)

      expect(savedReport.implement_outcome).toEqual(expect.objectContaining({
        baseline: expect.objectContaining({
          files_touched: expect.arrayContaining(['src/legacy/noisy.ts']),
          wrong_file_edits: ['src/legacy/noisy.ts'],
          validation: expect.objectContaining({
            status: 'failed',
          }),
        }),
        madar: expect.objectContaining({
          files_touched: expect.arrayContaining(['src/auth/login-service.ts', 'tests/unit/login-service.test.ts']),
          wrong_file_edits: [],
          validation: expect.objectContaining({
            status: 'passed',
          }),
        }),
      }))
      expect(report.implement_outcome).toEqual(savedReport.implement_outcome)
      expect(savedReport.benchmark_outcome).toEqual(expect.objectContaining({
        outcome: 'partial_win',
      }))
      expect(summary).toContain('implement outcome:')
      expect(summary).toContain('benchmark_outcome: partial_win')
      expect(summary).toContain('wrong-file edit')
      expect(summary).toContain('validation passed')
      expect(readFileSync(join(projectDir, 'src', 'auth', 'login-service.ts'), 'utf8')).toBe('export const loginValidation = "original"\n')
      expect(readFileSync(join(projectDir, 'tests', 'unit', 'login-service.test.ts'), 'utf8')).toBe('export const loginServiceTest = "original"\n')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('marks routing latency as a loss when latency regresses and tool counts are unavailable', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ spiMode: true })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: RESULT_ONLY_BASELINE_NO_TOOL_COUNT_PAYLOAD,
            madar: VERBOSE_MADAR_NO_TOOL_COUNT_LATENCY_REGRESSION_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T01:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const benchmarkOutcome = savedReport.benchmark_outcome as Record<string, unknown> | undefined

      expect(report.measurement_validity).toBe('valid')
      expect(report.tool_call_counts).toBeUndefined()
      expect(benchmarkOutcome).toEqual(expect.objectContaining({
        outcome: 'regression',
        checks: expect.objectContaining({
          routing_tool_latency: 'loss',
          token: 'flat',
          fresh_token: 'flat',
          cost: 'flat',
          turns: 'flat',
        }),
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('marks routing tool usage as a loss when tool counts regress and latency is flat', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ spiMode: true })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_BASELINE_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD,
            madar: VERBOSE_MADAR_TOOL_COUNT_REGRESSION_FLAT_LATENCY_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T01:30:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const benchmarkOutcome = savedReport.benchmark_outcome as Record<string, unknown> | undefined

      expect(report.measurement_validity).toBe('valid')
      expect(report.tool_call_counts?.baseline.total).toBe(1)
      expect(report.tool_call_counts?.madar.total).toBe(2)
      expect(benchmarkOutcome).toEqual(expect.objectContaining({
        outcome: 'regression',
        checks: expect.objectContaining({
          routing_tool_latency: 'loss',
          token: 'flat',
          fresh_token: 'flat',
          cost: 'flat',
          turns: 'flat',
        }),
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('separates routing wins from token-reduction proof for GoValidate-style token regressions', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject({ spiMode: true })
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'How idea report is being generated',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({
            baseline: VERBOSE_GOVALIDATE_BASELINE_TOKEN_REGRESSION_PAYLOAD,
            madar: VERBOSE_GOVALIDATE_MADAR_TOKEN_REGRESSION_PAYLOAD,
          }),
          now: () => new Date('2026-05-27T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const claimAssessment = savedReport.claim_assessment as Record<string, unknown> | undefined
      const benchmarkOutcome = savedReport.benchmark_outcome as Record<string, unknown> | undefined
      const summary = formatNativeAgentCompareSummary(result)

      expect(report.measurement_validity).toBe('valid')
      expect(report.tool_call_counts?.baseline.total).toBe(28)
      expect(report.tool_call_counts?.madar.total).toBe(6)
      if (report.baseline.kind !== 'succeeded' || report.madar.kind !== 'succeeded') {
        throw new Error('GoValidate fixture should produce succeeded runs')
      }
      expect(report.madar.duration_ms).toBeLessThan(report.baseline.duration_ms)
      expect(savedReport.token_regression).toBe(true)
      expect(claimAssessment).toEqual(expect.objectContaining({
        routing_efficiency: expect.objectContaining({
          status: 'improved',
        }),
        token_reduction: expect.objectContaining({
          status: 'not_proven',
        }),
      }))
      expect(benchmarkOutcome).toEqual(expect.objectContaining({
        outcome: 'partial_win',
        checks: expect.objectContaining({
          routing_tool_latency: 'win',
          token: 'loss',
          fresh_token: 'loss',
          cost: 'loss',
          turns: 'loss',
        }),
      }))
      expect(benchmarkOutcome?.evidence).toEqual(expect.arrayContaining([
        expect.stringContaining('turns regressed'),
        expect.stringContaining('fresh-token regression'),
        expect.stringContaining('cost regressed'),
      ]))
      expect(summary).toContain('claim_assessment: routing_efficiency improved')
      expect(summary).toContain('token_reduction not_proven')
      expect(summary).toContain('benchmark_outcome: partial_win')
      expect(summary).toContain('turns loss')
      expect(summary).toContain('fresh_token loss')
      expect(summary).toContain('cost loss')
      expect(summary).toContain('provider input grew')
      expect(summary).toContain('fresh-token regression')
      expect(summary).toContain('cost_usd')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores out, .mcp.json, CLAUDE.md, and .claude/ when the baseline runner crashes', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    const before = {
      madarOut: readFileSync(join(projectDir, 'out', 'graph.json'), 'utf8'),
      mcpJson: readFileSync(join(projectDir, '.mcp.json'), 'utf8'),
      claudeMd: readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8'),
      claudeSettings: readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'),
    }
    try {
      const crashRunner: NativeAgentRunner = async (input) => {
        if (input.mode === 'baseline') {
          throw new Error('baseline runner exploded mid-snapshot')
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(MADAR_USAGE_PAYLOAD)}\n`,
          stderr: '',
          elapsedMs: 34744,
        }
      }

      await expect(
        executeNativeAgentCompare(
          {
            graphPath,
            question: 'crash test',
            outputDir,
            execTemplate: 'mock-runner',
            baselineMode: 'native_agent',
          },
          {
            runner: crashRunner,
            now: () => new Date('2026-05-01T00:00:00Z'),
          },
        ),
      ).rejects.toThrow(/baseline/i)

      // Snapshot targets must be restored exactly even after the crash.
      expect(existsSync(join(projectDir, 'out', 'graph.json'))).toBe(true)
      expect(readFileSync(join(projectDir, 'out', 'graph.json'), 'utf8')).toBe(before.madarOut)
      expect(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).toBe(before.mcpJson)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(before.claudeMd)
      expect(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')).toBe(before.claudeSettings)

      // No leftover *.compare-bak-* siblings in the project root.
      const entries = readdirSync(projectDir)
      const leftoverBackups = ['out', '.mcp.json', 'CLAUDE.md', '.claude'].filter((target) =>
        entries.some((entry) => entry.startsWith(`${target}.compare-bak-`)),
      )
      expect(leftoverBackups).toEqual([])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('times out a stuck madar arm after baseline and writes partial artifacts instead of hanging', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const request = {
        graphPath,
        question: 'stalled madar arm',
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        perArmTimeoutSeconds: 0.01,
      } as Parameters<typeof executeNativeAgentCompare>[0] & { perArmTimeoutSeconds: number }

      const stalledRunner: NativeAgentRunner = async (input) => {
        if (input.mode === 'baseline') {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(BASELINE_USAGE_PAYLOAD)}\n`,
            stderr: '',
            elapsedMs: 10,
          }
        }
        return await new Promise(() => {})
      }

      const outcome = await Promise.race([
        executeNativeAgentCompare(
          request,
          {
            runner: stalledRunner,
            now: () => new Date('2026-05-28T00:00:00Z'),
          },
        ).then((result) => ({ kind: 'resolved' as const, result })),
        new Promise<{ kind: 'hung' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'hung' }), 1000)
        }),
      ])

      if (outcome.kind !== 'resolved') {
        throw new Error('compare hung instead of timing out the stuck madar arm')
      }

      const report = outcome.result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const runStatePath = join(report.paths.output_dir, 'run-state.json')
      const runState = JSON.parse(readFileSync(runStatePath, 'utf8')) as Record<string, unknown>

      expect(report.baseline.kind).toBe('succeeded')
      expect(report.madar.kind).toBe('runner_error')
      expect((report.madar as { failure_reason?: unknown }).failure_reason).toBe('timed_out')
      expect(savedReport.madar).toEqual(expect.objectContaining({
        kind: 'runner_error',
        failure_reason: 'timed_out',
      }))
      expect(existsSync(runStatePath)).toBe(true)
      expect(runState).toEqual(expect.objectContaining({
        phase: 'madar_timed_out',
        arm: 'madar',
      }))
      expect(readFileSync(report.paths.baseline_answer, 'utf8')).toContain('baseline answer')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('waits for an aborted madar arm to settle before resolving the timeout outcome', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      let abortedRunnerSettled = false
      const request = {
        graphPath,
        question: 'stalled madar arm with abort cleanup',
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        perArmTimeoutSeconds: 0.01,
      } as Parameters<typeof executeNativeAgentCompare>[0] & { perArmTimeoutSeconds: number }

      const stalledRunner: NativeAgentRunner = async (input) => {
        if (input.mode === 'baseline') {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(BASELINE_USAGE_PAYLOAD)}\n`,
            stderr: '',
            elapsedMs: 10,
          }
        }
        return await new Promise((_, reject) => {
          input.signal!.addEventListener('abort', () => {
            setTimeout(() => {
              abortedRunnerSettled = true
              reject(new Error('aborted after cleanup'))
            }, 50)
          }, { once: true })
        })
      }

      const result = await executeNativeAgentCompare(
        request,
        {
          runner: stalledRunner,
          now: () => new Date('2026-05-28T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(abortedRunnerSettled).toBe(true)
      expect(report.madar.kind).toBe('runner_error')
      expect((report.madar as { failure_reason?: unknown }).failure_reason).toBe('timed_out')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('saves partial madar stdout when a timed-out arm settles after abort', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const request = {
        graphPath,
        question: 'stalled madar arm with partial output',
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        perArmTimeoutSeconds: 0.01,
      } as Parameters<typeof executeNativeAgentCompare>[0] & { perArmTimeoutSeconds: number }

      const stalledRunner: NativeAgentRunner = async (input) => {
        if (input.mode === 'baseline') {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(BASELINE_USAGE_PAYLOAD)}\n`,
            stderr: '',
            elapsedMs: 10,
          }
        }
        return await new Promise((resolve) => {
          input.signal!.addEventListener('abort', () => {
            resolve({
              exitCode: 1,
              stdout: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__madar__retrieve"}]}}\npartial trace\n',
              stderr: 'aborted by timeout\n',
              elapsedMs: 10,
            })
          }, { once: true })
        })
      }

      const result = await executeNativeAgentCompare(
        request,
        {
          runner: stalledRunner,
          now: () => new Date('2026-05-28T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.madar.kind).toBe('runner_error')
      expect((report.madar as { failure_reason?: unknown }).failure_reason).toBe('timed_out')
      expect((report.madar as { evidence?: unknown }).evidence).toBe('Timed out after 10ms. Partial stdout was saved to the answer artifact.')
      expect((report.madar as { stderr?: unknown }).stderr).toBe('aborted by timeout')
      expect(readFileSync(report.paths.madar_answer, 'utf8')).toContain('partial trace')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('times out a stuck baseline arm and writes a partial report instead of hanging', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const request = {
        graphPath,
        question: 'stalled baseline arm',
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        perArmTimeoutSeconds: 0.01,
      } as Parameters<typeof executeNativeAgentCompare>[0] & { perArmTimeoutSeconds: number }
      const seenModes: CompareRunMode[] = []

      const stalledRunner: NativeAgentRunner = async (input) => {
        seenModes.push(input.mode)
        if (input.mode === 'baseline') {
          return await new Promise(() => {})
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(MADAR_USAGE_PAYLOAD)}\n`,
          stderr: '',
          elapsedMs: 5,
        }
      }

      const outcome = await Promise.race([
        executeNativeAgentCompare(
          request,
          {
            runner: stalledRunner,
            now: () => new Date('2026-05-28T00:00:00Z'),
          },
        ).then((result) => ({ kind: 'resolved' as const, result })),
        new Promise<{ kind: 'hung' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'hung' }), 1000)
        }),
      ])

      if (outcome.kind !== 'resolved') {
        throw new Error('compare hung instead of timing out the stuck baseline arm')
      }

      const report = outcome.result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const runStatePath = join(report.paths.output_dir, 'run-state.json')
      const runState = JSON.parse(readFileSync(runStatePath, 'utf8')) as Record<string, unknown>

      expect(seenModes).toEqual(['baseline'])
      expect(report.baseline.kind).toBe('runner_error')
      expect((report.baseline as { failure_reason?: unknown }).failure_reason).toBe('timed_out')
      expect(savedReport.baseline).toEqual(expect.objectContaining({
        kind: 'runner_error',
        failure_reason: 'timed_out',
      }))
      expect(runState).toEqual(expect.objectContaining({
        phase: 'baseline_timed_out',
        arm: 'baseline',
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('emits stderr heartbeat lines while a native_agent arm is still running', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const request = {
        graphPath,
        question: 'slow heartbeat run',
        outputDir,
        execTemplate: 'mock-runner',
        baselineMode: 'native_agent',
        perArmTimeoutSeconds: 1,
        heartbeatIntervalMs: 5,
      } as Parameters<typeof executeNativeAgentCompare>[0] & {
        perArmTimeoutSeconds: number
        heartbeatIntervalMs: number
      }
      const stderrLines: string[] = []

      const slowRunner: NativeAgentRunner = async (input) => {
        await new Promise((resolve) => {
          setTimeout(resolve, input.mode === 'baseline' ? 20 : 1)
        })
        const payload = input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : MADAR_USAGE_PAYLOAD
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload)}\n`,
          stderr: '',
          elapsedMs: input.mode === 'baseline' ? 20 : 1,
        }
      }

      await executeNativeAgentCompare(
        request,
        {
          runner: slowRunner,
          now: () => new Date('2026-05-28T00:00:00Z'),
          writeStderr: (message) => {
            stderrLines.push(message)
          },
        },
      )

      expect(stderrLines.some((line) => line.includes('baseline arm running'))).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('absent out files at start mean the baseline run sees an unmodified absent state', async () => {
    // When CLAUDE.md / .mcp.json / .claude don't exist, snapshot is a no-op for them
    // and they should still be absent after the run.
    mkdirSync(FIXTURE_PARENT, { recursive: true })
    mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
    const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'bare-'))
    const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'bare-out-'))
    mkdirSync(join(projectDir, 'out'), { recursive: true })
    writeFileSync(
      join(projectDir, 'out', 'graph.json'),
      JSON.stringify({ nodes: [], edges: [], hyperedges: [] }),
      'utf8',
    )
    try {
      await executeNativeAgentCompare(
        {
          graphPath: join(projectDir, 'out', 'graph.json'),
          question: 'bare project',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          allowNoInstall: true,
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
      expect(existsSync(join(projectDir, '.claude'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('keeps out/compare/<ts> writable during the baseline run (snapshot does not hide the output dir)', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      // The runner deliberately probes the prompt-file path during the baseline run.
      // If the snapshot renamed out/ wholesale, the path would be missing
      // and the runner would have observed it. The runner returns whether each call
      // saw the file present.
      const probeResults: Array<{ mode: CompareRunMode; promptFileExists: boolean; promptFile: string }> = []
      const probingRunner: NativeAgentRunner = async (input) => {
        probeResults.push({ mode: input.mode, promptFileExists: existsSync(input.promptFile), promptFile: input.promptFile })
        const payload = input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : MADAR_USAGE_PAYLOAD
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload)}\n`,
          stderr: '',
          elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
        }
      }

      await executeNativeAgentCompare(
        {
          graphPath,
          question: 'snapshot scope check',
          outputDir,
          execTemplate: 'noop',
          baselineMode: 'native_agent',
        },
        {
          runner: probingRunner,
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(probeResults).toHaveLength(2)
      expect(probeResults.every((probe) => probe.promptFileExists)).toBe(true)
      expect(probeResults[0]).toEqual(expect.objectContaining({
        mode: 'baseline',
        promptFile: expect.stringContaining('baseline-prompt.txt'),
      }))
      expect(probeResults[1]).toEqual(expect.objectContaining({
        mode: 'madar',
        promptFile: expect.stringContaining('madar-prompt.txt'),
      }))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('redacts the exec command in the persisted report (does not leak --exec text)', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'redaction check',
          outputDir,
          execTemplate: "claude --api-key sk-secret -p '{question}'",
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const reportFile = readFileSync(report.paths.report, 'utf8')
      expect(reportFile).not.toContain('sk-secret')
      expect(reportFile).not.toContain('--api-key')
      expect(report.exec_command.command).toBeNull()
      expect(report.exec_command.redacted).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves answer-only runs when stdout has no parseable result event but the runner exits cleanly', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const garbledRunner: NativeAgentRunner = async () => ({
        exitCode: 0,
        stdout: 'not JSON, just a text blob',
        stderr: '',
        elapsedMs: 1,
      })

      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'garbled',
          outputDir,
          execTemplate: 'mock',
          baselineMode: 'native_agent',
        },
        {
          runner: garbledRunner,
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.baseline.kind).toBe('answer_only')
      if (report.baseline.kind === 'answer_only') {
        expect(report.baseline.evidence).toContain('not JSON')
        expect(report.baseline.exit_code).toBe(0)
      }
      expect(report.madar.kind).toBe('answer_only')
      expect(report.reductions).toBeNull()
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves reductions, provider proof, and tool-call counts for verbose JSON-array runs', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'verbose trace',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: VERBOSE_MADAR_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.baseline.kind).toBe('succeeded')
      expect(report.madar.kind).toBe('succeeded')
      expect(report.reductions).not.toBeNull()
      expect(report.provider_proof?.reduction_basis).toBe('provider_reported')
      expect(report.tool_call_counts).toEqual({
        baseline: {
          total: 3,
          Read: 2,
          Bash: 0,
          Glob: 0,
          Grep: 1,
          ToolSearch: 0,
          other: {},
        },
        madar: {
          total: 4,
          Read: 1,
          Bash: 1,
          Glob: 1,
          Grep: 0,
          ToolSearch: 0,
          other: {
            context_pack: 1,
          },
        },
      })

      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        tool_call_counts?: NativeAgentCompareReport['tool_call_counts']
      }
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as {
        tool_call_counts?: NativeAgentCompareReport['tool_call_counts']
      }
      expect(savedReport.tool_call_counts).toEqual(report.tool_call_counts)
      expect(shareSafeReport.tool_call_counts).toEqual(report.tool_call_counts)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('writes environment and contamination blocks to report.json and report.share-safe.json', async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousIsolation = process.env.MADAR_BENCH_ISOLATION
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    const claudeConfigDir = mkdtempSync(join(FIXTURE_PARENT, 'claude-config-'))
    const homeDir = dirname(claudeConfigDir)
    try {
      mkdirSync(join(claudeConfigDir, 'skills', 'brainstorming'), { recursive: true })
      mkdirSync(join(homeDir, '.agents', 'skills', 'systematic-debugging'), { recursive: true })
      mkdirSync(join(projectDir, '.opencode', 'plugins'), { recursive: true })
      writeFileSync(join(claudeConfigDir, 'CLAUDE.md'), '# user claude\n', 'utf8')
      writeFileSync(
        join(claudeConfigDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'echo submit' }], matcher: 'prompt' },
            ],
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(join(projectDir, '.opencode', 'plugins', 'context7.ts'), 'export {}\n', 'utf8')
      mkdirSync(join(projectDir, '.vscode'), { recursive: true })
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Glob|Grep|Bash|Agent|Read', hooks: [{ type: 'command', command: 'echo project-pre' }] },
            ],
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(
        join(projectDir, '.vscode', 'mcp.json'),
        JSON.stringify({
          servers: {
            github: {},
          },
        }, null, 2),
        'utf8',
      )

      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
      process.env.MADAR_BENCH_ISOLATION = '0'

      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'environment capture',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
          allowNoInstall: true,
        },
        {
          runner: scriptedRunner({ baseline: VERBOSE_BASELINE_PAYLOAD, madar: CONTAMINATED_VERBOSE_MADAR_PAYLOAD }),
          now: () => new Date('2026-05-27T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>

      expect(savedReport).toEqual(expect.objectContaining({
        isolation: false,
        environment: expect.objectContaining({
          mcp_servers_active: expect.arrayContaining(['github', 'madar']),
          skills_loaded_count: 2,
          plugins_active: ['context7'],
          hooks_active: expect.objectContaining({
            user_prompt_submit: ['user:command:prompt'],
            pre_tool_use: ['project:command:Glob|Grep|Bash|Agent|Read'],
          }),
        }),
        environment_contamination: {
          skills_activated_during_run: [
            'everything-claude-code:documentation-lookup',
            'superpowers:systematic-debugging',
            'superpowers:using-superpowers',
          ],
          skills_conflicting_with_madar_rules: [
            'everything-claude-code:documentation-lookup',
            'superpowers:systematic-debugging',
          ],
          calls_to_other_mcps: {
            'mcp__context7__get-library-docs': 1,
            'mcp__github__search_code': 1,
          },
          subagent_dispatches_detected: 1,
          skill_alignment_score: 0.33,
        },
      }))
      expect(shareSafeReport).toEqual(expect.objectContaining({
        isolation: false,
        environment: savedReport.environment,
        environment_contamination: savedReport.environment_contamination,
      }))
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
      }
      if (previousIsolation === undefined) {
        delete process.env.MADAR_BENCH_ISOLATION
      } else {
        process.env.MADAR_BENCH_ISOLATION = previousIsolation
      }
      rmSync(claudeConfigDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

describe('formatNativeAgentCompareSummary', () => {
  it('describes wins as fewer, less, and faster', () => {
    const result = buildSummaryResult({
      question: 'win case',
      baselineTurns: 9,
      madarTurns: 3,
      baselineDurationMs: 9000,
      madarDurationMs: 3000,
      baselineInputTokens: 900,
      madarInputTokens: 300,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
      measurementValidity: 'valid',
      madarMcpCallCount: 1,
    })
    const report = result.reports[0]
    if (!report || report.baseline.kind !== 'succeeded' || report.madar.kind !== 'succeeded') {
      throw new Error('summary fixture should produce succeeded runs')
    }
    report.baseline.usage = {
      input_tokens: 600,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      output_tokens: 100,
    }
    report.baseline.uncached_input_tokens_anthropic_exact = 800
    report.baseline.cached_input_tokens_anthropic_exact = 100
    report.madar.usage = {
      input_tokens: 150,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
      output_tokens: 100,
    }
    report.madar.uncached_input_tokens_anthropic_exact = 250
    report.madar.cached_input_tokens_anthropic_exact = 50

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('num_turns: baseline 9 → madar 3 (3x fewer)')
    expect(summary).toContain('latency:   baseline 9000ms → madar 3000ms (3x faster)')
    expect(summary).toContain('input_tokens (Anthropic-reported): baseline 900 → madar 300 (3x less)')
    expect(summary).toContain('uncached_input_tokens (Anthropic-reported): baseline 800 → madar 250 (3.2x less)')
    expect(summary).toContain('cache_creation_input_tokens (Anthropic-reported): baseline 200 → madar 100 (2x less)')
    expect(summary).toContain('cache_read_input_tokens (Anthropic-reported): baseline 100 → madar 50 (2x less)')
  })

  it('describes regressions as more and slower instead of fewer and faster', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'loss case',
      baselineTurns: 3,
      madarTurns: 9,
      baselineDurationMs: 3000,
      madarDurationMs: 9000,
      baselineInputTokens: 300,
      madarInputTokens: 900,
      reductions: {
        num_turns: 0.33,
        duration_ms: 0.33,
        input_tokens: 0.33,
        cost_usd: 1,
      },
      measurementValidity: 'valid',
      madarMcpCallCount: 1,
    }))

    expect(summary).toContain('num_turns: baseline 3 → madar 9 (3x more)')
    expect(summary).toContain('latency:   baseline 3000ms → madar 9000ms (3x slower)')
    expect(summary).toContain('input_tokens (Anthropic-reported): baseline 300 → madar 900 (3x more)')
    expect(summary).not.toContain('0.33x fewer')
    expect(summary).not.toContain('0.33x faster')
    expect(summary).not.toContain('0.33x less')
  })

  it('omits cache-detail lines when neither run reported cache activity', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'no cache case',
      baselineTurns: 9,
      madarTurns: 3,
      baselineDurationMs: 9000,
      madarDurationMs: 3000,
      baselineInputTokens: 900,
      madarInputTokens: 300,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
      measurementValidity: 'valid',
      madarMcpCallCount: 1,
    }))

    expect(summary).not.toContain('uncached_input_tokens (Anthropic-reported)')
    expect(summary).not.toContain('cache_creation_input_tokens (Anthropic-reported)')
    expect(summary).not.toContain('cache_read_input_tokens (Anthropic-reported)')
  })

  it('summarizes all-win native_agent suites with aggregate win counts and reductions', () => {
    const summary = formatNativeAgentCompareSummary(buildSuiteSummaryResult([
      {
        question: 'win a',
        baselineTurns: 9,
        madarTurns: 3,
        baselineDurationMs: 9000,
        madarDurationMs: 3000,
        baselineInputTokens: 900,
        madarInputTokens: 300,
        reductions: {
          num_turns: 3,
          duration_ms: 3,
          input_tokens: 3,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
      {
        question: 'win b',
        baselineTurns: 8,
        madarTurns: 2,
        baselineDurationMs: 8000,
        madarDurationMs: 2000,
        baselineInputTokens: 800,
        madarInputTokens: 200,
        reductions: {
          num_turns: 4,
          duration_ms: 4,
          input_tokens: 4,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
    ]))

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 2 wins · 0 losses · mean reduction 70.8% · median reduction 70.8% · best win: "win b" (75% less) · worst regression: none')
    expect(summary).toContain('Suite num_turns: 2 wins · 0 losses · best win: "win b" (75% fewer) · worst regression: none')
    expect(summary).toContain('Suite latency: 2 wins · 0 losses · best win: "win b" (75% faster) · worst regression: none')
  })

  it('summarizes mixed native_agent suites with wins, losses, and regressions', () => {
    const summary = formatNativeAgentCompareSummary(buildSuiteSummaryResult([
      {
        question: 'win case',
        baselineTurns: 10,
        madarTurns: 5,
        baselineDurationMs: 10000,
        madarDurationMs: 5000,
        baselineInputTokens: 1000,
        madarInputTokens: 500,
        reductions: {
          num_turns: 2,
          duration_ms: 2,
          input_tokens: 2,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
      {
        question: 'loss case',
        baselineTurns: 4,
        madarTurns: 6,
        baselineDurationMs: 4000,
        madarDurationMs: 6000,
        baselineInputTokens: 400,
        madarInputTokens: 500,
        reductions: {
          num_turns: 0.67,
          duration_ms: 0.67,
          input_tokens: 0.8,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
    ]))

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 1 win · 1 loss · mean reduction 12.5% · median reduction 12.5% · best win: "win case" (50% less) · worst regression: "loss case" (25% more)')
    expect(summary).toContain('Suite num_turns: 1 win · 1 loss · best win: "win case" (50% fewer) · worst regression: "loss case" (50% more)')
    expect(summary).toContain('Suite latency: 1 win · 1 loss · best win: "win case" (50% faster) · worst regression: "loss case" (50% slower)')
  })

  it('calls out the comparable-question denominator when answer-only runs are excluded from suite aggregates', () => {
    const result = buildSuiteSummaryResult([
      {
        question: 'win a',
        baselineTurns: 9,
        madarTurns: 3,
        baselineDurationMs: 9000,
        madarDurationMs: 3000,
        baselineInputTokens: 900,
        madarInputTokens: 300,
        reductions: {
          num_turns: 3,
          duration_ms: 3,
          input_tokens: 3,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
      {
        question: 'win b',
        baselineTurns: 8,
        madarTurns: 2,
        baselineDurationMs: 8000,
        madarDurationMs: 2000,
        baselineInputTokens: 800,
        madarInputTokens: 200,
        reductions: {
          num_turns: 4,
          duration_ms: 4,
          input_tokens: 4,
          cost_usd: 1,
        },
        measurementValidity: 'valid',
        madarMcpCallCount: 1,
      },
      {
        question: 'answer only',
        baselineTurns: 5,
        madarTurns: 5,
        baselineDurationMs: 5000,
        madarDurationMs: 5000,
        baselineInputTokens: 500,
        madarInputTokens: 500,
        reductions: {
          num_turns: 1,
          duration_ms: 1,
          input_tokens: 1,
          cost_usd: 1,
        },
      },
    ])
    result.reports[2] = {
      ...result.reports[2]!,
      madar: {
        kind: 'answer_only',
        evidence: null,
        exit_code: 0,
        stderr: null,
        result_path: '/tmp/project/answer-only.txt',
      },
      reductions: null,
    }

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 2 wins · 0 losses · 2/3 comparable · mean reduction 70.8% · median reduction 70.8% · best win: "win b" (75% less) · worst regression: none')
    expect(summary).toContain('Suite num_turns: 2 wins · 0 losses · 2/3 comparable · best win: "win b" (75% fewer) · worst regression: none')
    expect(summary).toContain('Suite latency: 2 wins · 0 losses · 2/3 comparable · best win: "win b" (75% faster) · worst regression: none')
    expect(summary).toContain('- "answer only"')
    expect(summary).toContain('answer-only run saved; no Anthropic usage block was available, so provider-proof reductions were not computed')
  })

  it('surfaces whether Madar was invoked cleanly when trace data is present', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'trace case',
      baselineTurns: 6,
      madarTurns: 2,
      baselineDurationMs: 6000,
      madarDurationMs: 2000,
      baselineInputTokens: 600,
      madarInputTokens: 200,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
      madarTrace: {
        source: 'claude_messages_tool_use',
        summary: '2 tool calls across 2 turns',
        tool_call_count: 2,
        tool_calls_by_name: {
          'mcp__madar__retrieve': 2,
        },
        per_turn: [
          {
            turn: 1,
            tool_call_count: 1,
            tools: ['mcp__madar__retrieve'],
          },
          {
            turn: 2,
            tool_call_count: 1,
            tools: ['mcp__madar__retrieve'],
          },
        ],
        madar_mcp_call_count: 2,
        madar_mcp_calls_by_name: {
          'mcp__madar__retrieve': 2,
        },
        context_pack_call_count: 0,
        focused_follow_up_tool_call_count: 1,
        broad_exploration_tool_call_count: 0,
        broad_exploration_tool_calls_by_name: {},
        exploration_outcome: 'madar_invoked',
        exploration_summary: 'Madar MCP invoked 2 times (mcp__madar__retrieve); 1 focused follow-up call; no broad exploration after the first Madar call.',
      },
    }))

    expect(summary).toContain('madar_trace: madar_invoked')
    expect(summary).toContain('Madar MCP invoked 2 times (mcp__madar__retrieve); 1 focused follow-up call; no broad exploration after the first Madar call.')
    expect(summary).toContain('measurement_validity: valid')
    expect(summary).toContain('install_verified: true')
    expect(summary).toContain('madar_mcp_call_count: 2 (mcp__madar__retrieve)')
  })

  it('summarizes Madar-first bounded traces in suite output', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'ideal trace case',
      baselineTurns: 6,
      madarTurns: 2,
      baselineDurationMs: 6000,
      madarDurationMs: 2000,
      baselineInputTokens: 600,
      madarInputTokens: 200,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
      madarTrace: {
        source: 'claude_messages_tool_use',
        summary: '2 tool calls across 1 turn',
        tool_call_count: 2,
        tool_calls_by_name: {
          'mcp__madar__context_pack': 1,
          Read: 1,
        },
        per_turn: [
          {
            turn: 1,
            tool_call_count: 2,
            tools: ['mcp__madar__context_pack', 'Read'],
            agent_directive_seen: ['answer_from_pack'],
          },
        ],
        agent_directive_seen: ['answer_from_pack'],
        madar_mcp_call_count: 1,
        madar_mcp_calls_by_name: {
          'mcp__madar__context_pack': 1,
        },
        first_madar_turn: 1,
        context_pack_call_count: 1,
        focused_follow_up_tool_call_count: 1,
        broad_exploration_tool_call_count: 0,
        broad_exploration_tool_calls_by_name: {},
        exploration_outcome: 'madar_first_bounded',
        exploration_summary: 'Madar-first bounded path: no broad exploration after the first Madar call.',
      },
    }))

    expect(summary).toContain('madar_trace: madar_first_bounded')
    expect(summary).toContain('outcomes: 1 madar-first bounded')
  })

  it('prints invalid measurement warnings when install is missing', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'invalid case',
      baselineTurns: 6,
      madarTurns: 6,
      baselineDurationMs: 6000,
      madarDurationMs: 6000,
      baselineInputTokens: 600,
      madarInputTokens: 600,
      reductions: {
        num_turns: 1,
        duration_ms: 1,
        input_tokens: 1,
        cost_usd: 1,
      },
      installVerified: false,
      measurementValidity: 'invalid',
      madarMcpCallCount: 0,
    }))

    expect(summary).toContain('measurement_validity: INVALID')
    expect(summary).toContain('install_verified: false')
    expect(summary).toContain('madar_mcp_call_count: 0')
  })

  it('prints install validity lines for answer-only runs', () => {
    const result = buildSummaryResult({
      question: 'answer-only case',
      baselineTurns: 6,
      madarTurns: 6,
      baselineDurationMs: 6000,
      madarDurationMs: 6000,
      baselineInputTokens: 600,
      madarInputTokens: 600,
      reductions: {
        num_turns: 1,
        duration_ms: 1,
        input_tokens: 1,
        cost_usd: 1,
      },
      installVerified: false,
      measurementValidity: 'invalid',
      madarMcpCallCount: 0,
    })
    result.reports[0]!.madar = {
      kind: 'answer_only',
      evidence: 'madar answer',
      exit_code: 0,
      stderr: null,
      result_path: '/tmp/project/madar.txt',
    }

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('measurement_validity: INVALID')
    expect(summary).toContain('install_verified: false')
    expect(summary).toContain('madar_mcp_call_count: 0')
    expect(summary).toContain('answer-only run saved')
  })

  it('prints install validity lines for runner-error runs', () => {
    const result = buildSummaryResult({
      question: 'runner-error case',
      baselineTurns: 6,
      madarTurns: 6,
      baselineDurationMs: 6000,
      madarDurationMs: 6000,
      baselineInputTokens: 600,
      madarInputTokens: 600,
      reductions: {
        num_turns: 1,
        duration_ms: 1,
        input_tokens: 1,
        cost_usd: 1,
      },
      installVerified: true,
      measurementValidity: 'degraded',
      madarMcpCallCount: 0,
    })
    result.reports[0]!.madar = {
      kind: 'runner_error',
      evidence: 'runner failed',
      exit_code: 1,
      stderr: 'boom',
    }

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('measurement_validity: degraded')
    expect(summary).toContain('install_verified: true')
    expect(summary).toContain('madar_mcp_call_count: 0')
    expect(summary).toContain('runner error')
  })

  it('suppresses favorable win lines for degraded runs where Madar was never invoked', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'degraded case',
      baselineTurns: 21,
      madarTurns: 16,
      baselineDurationMs: 108335,
      madarDurationMs: 106420,
      baselineInputTokens: 1891943,
      madarInputTokens: 1077831,
      reductions: {
        num_turns: 1.31,
        duration_ms: 1.02,
        input_tokens: 1.76,
        uncached_input_tokens: 0.95,
        cache_creation_input_tokens: 0.95,
        cost_usd: 1.29,
      },
      madarTrace: {
        source: 'claude_messages_tool_use',
        summary: '0 tool calls across 0 turns',
        tool_call_count: 0,
        tool_calls_by_name: {},
        per_turn: [],
        madar_mcp_call_count: 0,
        madar_mcp_calls_by_name: {},
        context_pack_call_count: 0,
        focused_follow_up_tool_call_count: 0,
        broad_exploration_tool_call_count: 0,
        broad_exploration_tool_calls_by_name: {},
        exploration_outcome: 'madar_available_but_unused',
        exploration_summary: 'Madar tools were available but not used.',
      },
      measurementValidity: 'degraded',
      madarMcpCallCount: 0,
    }))

    expect(summary).toContain('measurement_validity: degraded')
    expect(summary).toContain('Cannot attribute outcome differences to Madar.')
    expect(summary).not.toContain('num_turns: baseline 21 → madar 16 (1.31x fewer)')
    expect(summary).not.toContain('input_tokens (Anthropic-reported): baseline 1891943 → madar 1077831 (1.76x less)')
  })

  it('suppresses favorable win lines for degraded runs without trace data', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'degraded no-trace case',
      baselineTurns: 9,
      madarTurns: 3,
      baselineDurationMs: 9000,
      madarDurationMs: 3000,
      baselineInputTokens: 900,
      madarInputTokens: 300,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        uncached_input_tokens: 3,
        cache_creation_input_tokens: null,
        cost_usd: 1,
      },
      measurementValidity: 'degraded',
      madarMcpCallCount: 0,
    }))

    expect(summary).toContain('measurement_validity: degraded')
    expect(summary).toContain('Cannot attribute outcome differences to Madar.')
    expect(summary).not.toContain('num_turns: baseline 9 → madar 3 (3x fewer)')
    expect(summary).not.toContain('input_tokens (Anthropic-reported): baseline 900 → madar 300 (3x less)')
  })

  it('prints the tool-call delta when per-side tool counts are available', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'tool counts',
      baselineTurns: 6,
      madarTurns: 3,
      baselineDurationMs: 6000,
      madarDurationMs: 3000,
      baselineInputTokens: 600,
      madarInputTokens: 300,
      reductions: {
        num_turns: 2,
        duration_ms: 2,
        input_tokens: 2,
        cost_usd: 1,
      },
      measurementValidity: 'valid',
      madarMcpCallCount: 1,
      toolCallCounts: {
        baseline: {
          total: 6,
          Read: 3,
          Bash: 1,
          Glob: 1,
          Grep: 1,
          ToolSearch: 0,
          other: {},
        },
        madar: {
          total: 4,
          Read: 2,
          Bash: 1,
          Glob: 0,
          Grep: 0,
          ToolSearch: 0,
          other: {
            context_pack: 1,
          },
        },
      },
    }))

    expect(summary).toContain('tool calls: baseline 6 → madar 4 (1.5x fewer)')
  })

  it('warns when total input tokens show no meaningful change but fresh-token usage regresses', () => {
    const result = buildSummaryResult({
      question: 'regression honesty',
      baselineTurns: 5,
      madarTurns: 4,
      baselineDurationMs: 42000,
      madarDurationMs: 39000,
      baselineInputTokens: 388718,
      madarInputTokens: 367859,
      reductions: {
        num_turns: 1.25,
        duration_ms: 1.08,
        input_tokens: 1.06,
        cost_usd: 0.87,
      },
      measurementValidity: 'valid',
      madarMcpCallCount: 1,
    })
    const report = result.reports[0]
    if (!report || report.baseline.kind !== 'succeeded' || report.madar.kind !== 'succeeded') {
      throw new Error('summary fixture should produce succeeded runs')
    }
    report.baseline.usage = BASELINE_TOKEN_REGRESSION_PAYLOAD.usage
    report.baseline.total_input_tokens_anthropic_exact = 388718
    report.baseline.uncached_input_tokens_anthropic_exact = 64678
    report.baseline.cached_input_tokens_anthropic_exact = 324040
    report.madar.usage = MADAR_TOKEN_REGRESSION_PAYLOAD.usage
    report.madar.total_input_tokens_anthropic_exact = 367859
    report.madar.uncached_input_tokens_anthropic_exact = 90328
    report.madar.cached_input_tokens_anthropic_exact = 277531

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('input_tokens (Anthropic-reported): baseline 388718 → madar 367859 (no meaningful change)')
    expect(summary).toContain('WARNING: fresh-token regression')
    expect(summary).toContain('uncached_input_tokens')
    expect(summary).toContain('cache_creation_input_tokens')
  })
})
