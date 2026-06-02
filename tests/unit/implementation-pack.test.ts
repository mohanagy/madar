import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { build } from '../../src/pipeline/build.js'
import { buildImplementationPackGuidance } from '../../src/runtime/implementation-pack.js'

const tempFixtureRoots: string[] = []

afterEach(() => {
  while (tempFixtureRoots.length > 0) {
    const root = tempFixtureRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function buildQuotedTestPathGraph(testFilePath: string) {
  const root = mkdtempSync(join(tmpdir(), 'madar-quoted-tests-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-quoted-tests-fixture',
    private: true,
    scripts: {
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'route', label: 'POST /quote', file_type: 'code', source_file: `${root}/src/quote-route.ts`, source_location: 'L10', node_kind: 'route', community: 0 },
          { id: 'service', label: 'QuoteService.run', file_type: 'code', source_file: `${root}/src/quote-service.ts`, source_location: 'L20', node_kind: 'method', community: 0 },
          { id: 'test', label: 'QuoteService.run.spec', file_type: 'code', source_file: `${root}/${testFilePath}`, source_location: 'L1', node_kind: 'function', community: 1 },
        ],
        edges: [
          { source: 'route', target: 'service', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/quote-route.ts` },
          { source: 'service', target: 'test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/quote-service.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

function buildWorkflowCenterGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-workflow-center-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-workflow-center-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'invoice_route', label: 'POST /invoices/generate', file_type: 'code', source_file: `${root}/src/http/invoice-routes.ts`, source_location: 'L10', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0 },
          { id: 'invoice_controller', label: 'InvoiceController.generate', file_type: 'code', source_file: `${root}/src/invoices/controller.ts`, source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'invoice_service', label: 'InvoiceGenerationService.generateInvoice', file_type: 'code', source_file: `${root}/src/invoices/generation-service.ts`, source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'invoice_retry_helper', label: 'retryWhenInvoiceGenerationFails', file_type: 'code', source_file: `${root}/src/invoices/retry-helper.ts`, source_location: 'L12', node_kind: 'function', community: 1 },
          { id: 'invoice_queue', label: 'InvoiceJobQueue.enqueueRetry', file_type: 'code', source_file: `${root}/src/invoices/queue.ts`, source_location: 'L18', node_kind: 'method', community: 2 },
          { id: 'invoice_repository', label: 'InvoiceRepository.saveRetryRecord', file_type: 'code', source_file: `${root}/src/invoices/repository.ts`, source_location: 'L16', node_kind: 'method', community: 2 },
          { id: 'invoice_presenter', label: 'formatInvoiceFailureNotice', file_type: 'code', source_file: `${root}/src/invoices/presenter.ts`, source_location: 'L8', node_kind: 'function', community: 3 },
          { id: 'invoice_service_test', label: 'InvoiceGenerationService.generateInvoice.spec', file_type: 'code', source_file: `${root}/tests/unit/invoice-generation-service.test.ts`, source_location: 'L1', node_kind: 'function', community: 4 },
        ],
        edges: [
          { source: 'invoice_route', target: 'invoice_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: `${root}/src/http/invoice-routes.ts` },
          { source: 'invoice_controller', target: 'invoice_service', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/controller.ts` },
          { source: 'invoice_service', target: 'invoice_retry_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/generation-service.ts` },
          { source: 'invoice_service', target: 'invoice_queue', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/generation-service.ts` },
          { source: 'invoice_service', target: 'invoice_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/generation-service.ts` },
          { source: 'invoice_service', target: 'invoice_presenter', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/generation-service.ts` },
          { source: 'invoice_service', target: 'invoice_service_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/generation-service.ts` },
          { source: 'invoice_queue', target: 'invoice_repository', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: `${root}/src/invoices/queue.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

function buildLikelyTargetsGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-likely-targets-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-likely-targets-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'login_route', label: 'POST /login', file_type: 'code', source_file: `${root}/src/http/login-routes.ts`, source_location: 'L10', node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'login_controller', label: 'LoginController.submit', file_type: 'code', source_file: `${root}/src/auth/login-controller.ts`, source_location: 'L20', node_kind: 'method', framework_role: 'nest_controller', community: 0 },
          { id: 'login_service', label: 'LoginService.validate', file_type: 'code', source_file: `${root}/src/auth/login-service.ts`, source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'login_repository', label: 'LoginAuditRepository.saveAttempt', file_type: 'code', source_file: `${root}/src/auth/login-audit-repository.ts`, source_location: 'L40', node_kind: 'method', community: 1 },
          { id: 'login_helper', label: 'normalizeLoginPayload', file_type: 'code', source_file: `${root}/src/auth/login-helper.ts`, source_location: 'L18', node_kind: 'function', community: 1 },
          { id: 'login_unit_test', label: 'LoginService.validate.spec', file_type: 'code', source_file: `${root}/tests/unit/login-service.test.ts`, source_location: 'L1', node_kind: 'function', community: 2 },
          { id: 'login_e2e_test', label: 'login flow e2e', file_type: 'code', source_file: `${root}/tests/e2e/login-flow.test.ts`, source_location: 'L1', node_kind: 'function', community: 2 },
        ],
        edges: [
          { source: 'login_route', target: 'login_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: `${root}/src/http/login-routes.ts` },
          { source: 'login_controller', target: 'login_service', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/auth/login-controller.ts` },
          { source: 'login_service', target: 'login_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/auth/login-service.ts` },
          { source: 'login_service', target: 'login_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/auth/login-service.ts` },
          { source: 'login_service', target: 'login_unit_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/auth/login-service.ts` },
          { source: 'login_route', target: 'login_e2e_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/http/login-routes.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

function buildIndirectSeedExpansionGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-indirect-seed-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-indirect-seed-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'task_route', label: 'POST /tasks/apply', file_type: 'code', source_file: `${root}/src/http/task-routes.ts`, source_location: 'L10', node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'task_controller', label: 'TaskController.handle', file_type: 'code', source_file: `${root}/src/core/task-controller.ts`, source_location: 'L20', node_kind: 'method', framework_role: 'nest_controller', community: 0 },
          { id: 'workflow_runner', label: 'WorkflowRunner.run', file_type: 'code', source_file: `${root}/src/core/workflow-runner.ts`, source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'retry_helper', label: 'normalizePaymentAgingRetryWindow', file_type: 'code', source_file: `${root}/src/core/payment-aging-helper.ts`, source_location: 'L40', node_kind: 'function', community: 1 },
          { id: 'retry_store', label: 'RetryLedger.store', file_type: 'code', source_file: `${root}/src/core/retry-ledger.ts`, source_location: 'L50', node_kind: 'method', community: 2 },
          { id: 'retry_contract', label: 'RetryWindowConfig', file_type: 'code', source_file: `${root}/src/contracts/retry-window.ts`, line_number: 60, community: 3 },
          { id: 'workflow_runner_test', label: 'WorkflowRunner.run.spec', file_type: 'code', source_file: `${root}/tests/unit/workflow-runner.test.ts`, source_location: 'L1', node_kind: 'function', community: 4 },
        ],
        edges: [
          { source: 'task_route', target: 'task_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: `${root}/src/http/task-routes.ts` },
          { source: 'task_controller', target: 'workflow_runner', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/core/task-controller.ts` },
          { source: 'workflow_runner', target: 'retry_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/core/workflow-runner.ts` },
          { source: 'workflow_runner', target: 'retry_store', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/core/workflow-runner.ts` },
          { source: 'workflow_runner', target: 'retry_contract', relation: 'depends_on', confidence: 'EXTRACTED', source_file: `${root}/src/core/workflow-runner.ts` },
          { source: 'workflow_runner', target: 'workflow_runner_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/core/workflow-runner.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

function buildFrameworkWorkflowOwnerGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-framework-owner-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-framework-owner-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'app_shell', label: 'createApp', file_type: 'code', source_file: `${root}/src/http/app.ts`, source_location: 'L5', node_kind: 'function', community: 0 },
          { id: 'users_route', label: 'GET /users/:userId', file_type: 'code', source_file: `${root}/src/users/router.ts`, source_location: 'L14', node_kind: 'route', framework_role: 'hono_route', community: 0 },
          { id: 'users_route_flow', label: 'enforceOwnedUserRequestFlow', file_type: 'code', source_file: `${root}/src/users/router.ts`, source_location: 'L7', node_kind: 'function', community: 0 },
          { id: 'users_service_file', label: 'service.ts', file_type: 'code', source_file: `${root}/src/users/service.ts`, source_location: 'L1', community: 1 },
          { id: 'users_service_class', label: 'UserService', file_type: 'code', source_file: `${root}/src/users/service.ts`, source_location: 'L2', node_kind: 'class', community: 1 },
          { id: 'users_service_ctor', label: '.constructor()', file_type: 'code', source_file: `${root}/src/users/service.ts`, source_location: 'L4', node_kind: 'method', community: 1 },
          { id: 'users_service', label: 'UserService.loadProfile', file_type: 'code', source_file: `${root}/src/users/service.ts`, source_location: 'L6', node_kind: 'method', community: 1 },
          { id: 'users_repository', label: 'UserRepository.findOwnedUser', file_type: 'code', source_file: `${root}/src/users/repository.ts`, source_location: 'L20', node_kind: 'method', community: 2 },
          { id: 'users_prisma', label: 'prisma.user.findFirst', file_type: 'code', source_file: `${root}/src/users/repository.ts`, source_location: 'L21', community: 2 },
        ],
        edges: [
          { source: 'app_shell', target: 'users_route', relation: 'imports_from', confidence: 'EXTRACTED', source_file: `${root}/src/http/app.ts` },
          { source: 'users_route', target: 'users_route_flow', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/router.ts` },
          { source: 'users_route_flow', target: 'users_service_file', relation: 'imports_from', confidence: 'EXTRACTED', source_file: `${root}/src/users/router.ts` },
          { source: 'users_service_file', target: 'users_service_class', relation: 'exports', confidence: 'EXTRACTED', source_file: `${root}/src/users/service.ts` },
          { source: 'users_service_class', target: 'users_service_ctor', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/service.ts` },
          { source: 'users_service_class', target: 'users_service', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/service.ts` },
          { source: 'users_route_flow', target: 'users_service', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/router.ts` },
          { source: 'users_service', target: 'users_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/service.ts` },
          { source: 'users_repository', target: 'users_prisma', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/users/repository.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

function buildServerActionPreferenceGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-server-action-owner-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-server-action-owner-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))

  const graph = build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'dashboard_page', label: 'page /dashboard', file_type: 'code', source_file: `${root}/app/dashboard/page.tsx`, source_location: 'L1', node_kind: 'route', framework_role: 'nextjs_page', community: 0 },
          { id: 'dashboard_shell', label: 'DashboardPage()', file_type: 'code', source_file: `${root}/app/dashboard/page.tsx`, source_location: 'L4', node_kind: 'function', community: 0 },
          { id: 'dashboard_action_file', label: 'actions.ts', file_type: 'code', source_file: `${root}/app/dashboard/actions.ts`, source_location: 'L1', community: 1 },
          { id: 'dashboard_action', label: 'persistDashboardOwnerFilter()', file_type: 'code', source_file: `${root}/app/dashboard/actions.ts`, source_location: 'L15', node_kind: 'function', community: 1 },
          { id: 'dashboard_prisma', label: 'prisma.dashboardFilter.upsert', file_type: 'code', source_file: `${root}/app/dashboard/actions.ts`, source_location: 'L19', community: 1 },
          { id: 'dashboard_client', label: 'DashboardClient()', file_type: 'code', source_file: `${root}/components/dashboard-client.tsx`, source_location: 'L7', node_kind: 'function', community: 2 },
        ],
        edges: [
          { source: 'dashboard_page', target: 'dashboard_shell', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/page.tsx` },
          { source: 'dashboard_shell', target: 'dashboard_action_file', relation: 'imports_from', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/page.tsx` },
          { source: 'dashboard_shell', target: 'dashboard_client', relation: 'imports_from', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/page.tsx` },
          { source: 'dashboard_shell', target: 'dashboard_action', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/page.tsx` },
          { source: 'dashboard_action_file', target: 'dashboard_action', relation: 'exports', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/actions.ts` },
          { source: 'dashboard_action', target: 'dashboard_prisma', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/app/dashboard/actions.ts` },
        ],
      },
    ],
    { directed: true },
  )

  graph.graph.root_path = root
  return graph
}

describe('buildImplementationPackGuidance workflow-center scoring (#295)', () => {
  it('ranks the workflow owner above a lexically stronger helper', () => {
    const graph = buildWorkflowCenterGraph()
    const retrieval = {
      question: 'add retry when invoice generation fails',
      token_count: 180,
      matched_nodes: [
        {
          node_id: 'invoice_retry_helper',
          label: 'retryWhenInvoiceGenerationFails',
          source_file: `${graph.graph.root_path}/src/invoices/retry-helper.ts`,
          line_number: 12,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function retryWhenInvoiceGenerationFails() {}',
          match_score: 0.98,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Invoice workflow',
        },
        {
          node_id: 'invoice_service',
          label: 'InvoiceGenerationService.generateInvoice',
          source_file: `${graph.graph.root_path}/src/invoices/generation-service.ts`,
          line_number: 30,
          node_kind: 'method',
          framework_role: 'nest_provider',
          file_type: 'code',
          snippet: 'export class InvoiceGenerationService { async generateInvoice() {} }',
          match_score: 0.62,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Invoice workflow',
        },
        {
          node_id: 'invoice_controller',
          label: 'InvoiceController.generate',
          source_file: `${graph.graph.root_path}/src/invoices/controller.ts`,
          line_number: 20,
          node_kind: 'method',
          framework_role: 'nest_controller',
          file_type: 'code',
          snippet: 'export class InvoiceController { async generate() {} }',
          match_score: 0.58,
          relevance_band: 'related' as const,
          community: 0,
          community_label: 'HTTP surface',
        },
        {
          node_id: 'invoice_route',
          label: 'POST /invoices/generate',
          source_file: `${graph.graph.root_path}/src/http/invoice-routes.ts`,
          line_number: 10,
          node_kind: 'route',
          framework_role: 'express_route',
          file_type: 'code',
          snippet: 'router.post("/invoices/generate", controller.generate)',
          match_score: 0.41,
          relevance_band: 'related' as const,
          community: 0,
          community_label: 'HTTP surface',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['contracts', 'configuration', 'tests', 'impact'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2400,
      taskIntent: 'implement',
    })

    expect(guidance.workflow_centers[0]).toEqual(expect.objectContaining({
      label: 'InvoiceGenerationService.generateInvoice',
      path: 'src/invoices/generation-service.ts',
      phases: expect.arrayContaining(['seed', 'expand', 'promote']),
      score: expect.any(Number),
      reasons: expect.arrayContaining([
        expect.stringMatching(/entry point|route|controller/i),
        expect.stringMatching(/fan-in|fan-out|call graph|central/i),
      ]),
    }))
    expect(guidance.workflow_centers[0]!.score ?? 0).toBeGreaterThan(guidance.workflow_centers[1]!.score ?? 0)
    expect(guidance.likely_edit_files[0]).toEqual(expect.objectContaining({
      path: 'src/invoices/generation-service.ts',
    }))
    expect(guidance.likely_edit_files[0]!.path).not.toBe('src/invoices/retry-helper.ts')
  })

  it('keeps the workflow-owner label when a helper ties inside the same file', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-workflow-center-tie-'))
    tempFixtureRoots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'madar-workflow-center-tie-fixture',
      private: true,
      scripts: {
        typecheck: 'tsc --noEmit',
        build: 'tsc -p tsconfig.build.json',
        'test:run': 'vitest run',
      },
    }))

    const graph = build(
      [
        {
          schema_version: 1,
          nodes: [
            { id: 'workflow_owner', label: 'InvoiceWorkflow.run', file_type: 'code', source_file: `${root}/src/invoices/billing.ts`, source_location: 'L10', node_kind: 'function', community: 1 },
            { id: 'workflow_helper', label: 'formatInvoiceRetryMessage', file_type: 'code', source_file: `${root}/src/invoices/billing.ts`, source_location: 'L30', node_kind: 'function', community: 1 },
          ],
          edges: [],
        },
      ],
      { directed: true },
    )
    graph.graph.root_path = root

    const retrieval = {
      question: 'update invoice retry workflow',
      token_count: 80,
      matched_nodes: [
        {
          node_id: 'workflow_owner',
          label: 'InvoiceWorkflow.run',
          source_file: `${root}/src/invoices/billing.ts`,
          line_number: 10,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function InvoiceWorkflowRun() {}',
          match_score: 0.8,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Invoice workflow',
        },
        {
          node_id: 'workflow_helper',
          label: 'formatInvoiceRetryMessage',
          source_file: `${root}/src/invoices/billing.ts`,
          line_number: 30,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function formatInvoiceRetryMessage() {}',
          match_score: 8.8,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Invoice workflow',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary'] as const,
        semantic_required: ['implementation'] as const,
        semantic_optional: [] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 1200,
      taskIntent: 'implement',
    })

    expect(guidance.workflow_centers[0]).toEqual(expect.objectContaining({
      label: 'InvoiceWorkflow.run',
      path: 'src/invoices/billing.ts',
    }))
    expect(guidance.workflow_centers[0]!.matched_symbols).toEqual(expect.arrayContaining([
      'InvoiceWorkflow.run',
      'formatInvoiceRetryMessage',
    ]))
  })

  it('prefers the framework workflow owner over route-shell distractors when storage semantics are part of the prompt', () => {
    const graph = buildFrameworkWorkflowOwnerGraph()
    const retrieval = {
      question: 'enforce account ownership in the Hono users route handler for users/:userId before calling prisma.user.findFirst',
      token_count: 220,
      matched_nodes: [
        {
          node_id: 'app_shell',
          label: 'app.ts',
          source_file: `${graph.graph.root_path}/src/http/app.ts`,
          line_number: 5,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function createApp() {}',
          match_score: 0.91,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'HTTP shell',
        },
        {
          node_id: 'users_route',
          label: 'registerUserRoutes()',
          source_file: `${graph.graph.root_path}/src/users/router.ts`,
          line_number: 14,
          node_kind: 'route',
          framework_role: 'hono_route',
          file_type: 'code',
          snippet: 'router.get("/:userId", async (context) => {})',
          match_score: 0.95,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Users routes',
        },
        {
          node_id: 'users_route_flow',
          label: 'enforceOwnedUserRequestFlow',
          source_file: `${graph.graph.root_path}/src/users/router.ts`,
          line_number: 7,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'async function enforceOwnedUserRequestFlow() {}',
          match_score: 0.89,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Users routes',
        },
        {
          node_id: 'users_service_file',
          label: 'service.ts',
          source_file: `${graph.graph.root_path}/src/users/service.ts`,
          line_number: 1,
          node_kind: 'module',
          file_type: 'code',
          snippet: 'export * from "./service"',
          match_score: 0.77,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Users service',
        },
        {
          node_id: 'users_service_class',
          label: 'UserService',
          source_file: `${graph.graph.root_path}/src/users/service.ts`,
          line_number: 2,
          node_kind: 'class',
          file_type: 'code',
          snippet: 'export class UserService {}',
          match_score: 0.76,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Users service',
        },
        {
          node_id: 'users_service_ctor',
          label: '.constructor()',
          source_file: `${graph.graph.root_path}/src/users/service.ts`,
          line_number: 4,
          node_kind: 'method',
          file_type: 'code',
          snippet: 'constructor(repository: UserRepository) {}',
          match_score: 0.71,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Users service',
        },
        {
          node_id: 'users_service',
          label: 'UserService.loadProfile',
          source_file: `${graph.graph.root_path}/src/users/service.ts`,
          line_number: 6,
          node_kind: 'method',
          file_type: 'code',
          snippet: 'export class UserService { async loadProfile() {} }',
          match_score: 0.72,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Users service',
        },
        {
          node_id: 'users_repository',
          label: 'UserRepository.findOwnedUser',
          source_file: `${graph.graph.root_path}/src/users/repository.ts`,
          line_number: 20,
          node_kind: 'method',
          file_type: 'code',
          snippet: 'export class UserRepository { async findOwnedUser() {} }',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Users repository',
        },
        {
          node_id: 'users_prisma',
          label: 'prisma.user.findFirst',
          source_file: `${graph.graph.root_path}/src/users/repository.ts`,
          line_number: 21,
          node_kind: 'call_expression',
          file_type: 'code',
          snippet: 'return prisma.user.findFirst({ where })',
          match_score: 0.82,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Users repository',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['contracts', 'tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2400,
      taskIntent: 'implement',
      limit: 4,
    })

    expect(guidance.workflow_centers[0]).toEqual(expect.objectContaining({
      path: 'src/users/service.ts',
      phases: expect.arrayContaining(['seed', 'expand', 'promote']),
    }))
    expect(guidance.workflow_centers[0]!.path).not.toBe('src/http/app.ts')
    expect(guidance.likely_edit_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/users/service.ts' }),
      expect.objectContaining({ path: 'src/users/repository.ts' }),
    ]))
    expect(guidance.likely_edit_files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/http/app.ts' }),
    ]))
    expect(guidance.cautions).toEqual(expect.arrayContaining([
      expect.stringContaining('Treat src/http/app.ts as supporting context first'),
    ]))
  })

  it('prefers the server action owner over the page shell for runtime-boundary prompts', () => {
    const graph = buildServerActionPreferenceGraph()
    const retrieval = {
      question: 'move dashboard owner filter persistence into the Next.js server action and keep the client component presentational',
      token_count: 220,
      matched_nodes: [
        {
          node_id: 'dashboard_page',
          label: 'page /dashboard',
          source_file: `${graph.graph.root_path}/app/dashboard/page.tsx`,
          line_number: 1,
          node_kind: 'page',
          framework_role: 'nextjs_page',
          file_type: 'code',
          snippet: 'export default async function DashboardPage() {}',
          match_score: 0.97,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Dashboard shell',
        },
        {
          node_id: 'dashboard_shell',
          label: 'DashboardPage()',
          source_file: `${graph.graph.root_path}/app/dashboard/page.tsx`,
          line_number: 4,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'return <form action={persistDashboardOwnerFilter}>',
          match_score: 0.89,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Dashboard shell',
        },
        {
          node_id: 'dashboard_action_file',
          label: 'actions.ts',
          source_file: `${graph.graph.root_path}/app/dashboard/actions.ts`,
          line_number: 1,
          node_kind: 'module',
          file_type: 'code',
          snippet: '\'use server\'',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Dashboard runtime',
        },
        {
          node_id: 'dashboard_action',
          label: 'persistDashboardOwnerFilter()',
          source_file: `${graph.graph.root_path}/app/dashboard/actions.ts`,
          line_number: 15,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export async function persistDashboardOwnerFilter(formData: FormData) {}',
          match_score: 0.82,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Dashboard runtime',
        },
        {
          node_id: 'dashboard_prisma',
          label: 'prisma.dashboardFilter.upsert',
          source_file: `${graph.graph.root_path}/app/dashboard/actions.ts`,
          line_number: 19,
          node_kind: 'call_expression',
          file_type: 'code',
          snippet: 'return prisma.dashboardFilter.upsert(...)',
          match_score: 0.78,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Dashboard runtime',
        },
        {
          node_id: 'dashboard_client',
          label: 'DashboardClient()',
          source_file: `${graph.graph.root_path}/components/dashboard-client.tsx`,
          line_number: 7,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function DashboardClient() {}',
          match_score: 0.88,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Dashboard client',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests', 'contracts'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2200,
      taskIntent: 'implement',
      limit: 4,
    })

    expect(guidance.workflow_centers[0]).toEqual(expect.objectContaining({
      path: 'app/dashboard/actions.ts',
      phases: expect.arrayContaining(['seed', 'expand', 'promote']),
    }))
    expect(guidance.workflow_centers[0]!.path).not.toBe('app/dashboard/page.tsx')
    expect(guidance.likely_edit_files[0]).toEqual(expect.objectContaining({
      path: 'app/dashboard/actions.ts',
    }))
    expect(guidance.cautions).toEqual(expect.arrayContaining([
      expect.stringContaining('Treat app/dashboard/page.tsx as supporting context first'),
    ]))
  })
})

describe('buildImplementationPackGuidance validation commands', () => {
  it('shell-quotes test file paths with spaces and shell metacharacters', () => {
    const graph = buildQuotedTestPathGraph('tests/unit/login flow $(touch pwned).test.ts')
    const retrieval = {
      question: 'implement login flow validation',
      token_count: 120,
      matched_nodes: [
        {
          node_id: 'service',
          label: 'QuoteService.run',
          source_file: `${graph.graph.root_path}/src/quote-service.ts`,
          line_number: 20,
          node_kind: 'method',
          file_type: 'code',
          snippet: 'export class QuoteService { run() {} }',
          match_score: 0.9,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Workflow',
        },
        {
          node_id: 'test',
          label: 'QuoteService.run.spec',
          source_file: `${graph.graph.root_path}/tests/unit/login flow $(touch pwned).test.ts`,
          line_number: 1,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'it("works", () => {})',
          match_score: 0.7,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Tests',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2000,
      taskIntent: 'implement',
    })

    expect(guidance.validation_commands).toContain(
      "npm run test:run -- 'tests/unit/login flow $(touch pwned).test.ts'",
    )
  })

  it('prefixes repo-root test paths that start with a dash so runners do not parse them as flags', () => {
    const graph = buildQuotedTestPathGraph('--help.test.ts')
    const retrieval = {
      question: 'implement login flow validation',
      token_count: 120,
      matched_nodes: [
        {
          node_id: 'service',
          label: 'QuoteService.run',
          source_file: `${graph.graph.root_path}/src/quote-service.ts`,
          line_number: 20,
          node_kind: 'method',
          file_type: 'code',
          snippet: 'export class QuoteService { run() {} }',
          match_score: 0.9,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Workflow',
        },
        {
          node_id: 'test',
          label: 'QuoteService.run.spec',
          source_file: `${graph.graph.root_path}/--help.test.ts`,
          line_number: 1,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'it("works", () => {})',
          match_score: 0.7,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Tests',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2000,
      taskIntent: 'implement',
    })

    expect(guidance.validation_commands).toContain(
      'npm run test:run -- ./--help.test.ts',
    )
  })
})

describe('buildImplementationPackGuidance likely edit/test targets (#296)', () => {
  it('scores likely edit files separately from likely test files', () => {
    const graph = buildLikelyTargetsGraph()
    const retrieval = {
      question: 'change login validation behavior',
      token_count: 180,
      matched_nodes: [
        {
          node_id: 'login_helper',
          label: 'normalizeLoginPayload',
          source_file: `${graph.graph.root_path}/src/auth/login-helper.ts`,
          line_number: 18,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function normalizeLoginPayload() {}',
          match_score: 0.96,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Login workflow',
        },
        {
          node_id: 'login_service',
          label: 'LoginService.validate',
          source_file: `${graph.graph.root_path}/src/auth/login-service.ts`,
          line_number: 30,
          node_kind: 'method',
          framework_role: 'nest_provider',
          file_type: 'code',
          snippet: 'export class LoginService { validate() {} }',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Login workflow',
        },
        {
          node_id: 'login_controller',
          label: 'LoginController.submit',
          source_file: `${graph.graph.root_path}/src/auth/login-controller.ts`,
          line_number: 20,
          node_kind: 'method',
          framework_role: 'nest_controller',
          file_type: 'code',
          snippet: 'export class LoginController { submit() {} }',
          match_score: 0.51,
          relevance_band: 'related' as const,
          community: 0,
          community_label: 'Login HTTP surface',
        },
        {
          node_id: 'login_route',
          label: 'POST /login',
          source_file: `${graph.graph.root_path}/src/http/login-routes.ts`,
          line_number: 10,
          node_kind: 'route',
          framework_role: 'express_route',
          file_type: 'code',
          snippet: 'router.post("/login", controller.submit)',
          match_score: 0.48,
          relevance_band: 'related' as const,
          community: 0,
          community_label: 'Login HTTP surface',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2200,
      taskIntent: 'implement',
    })

    expect(guidance.likely_edit_files[0]).toEqual(expect.objectContaining({
      path: 'src/auth/login-service.ts',
      score: expect.any(Number),
      reason: expect.stringMatching(/workflow|entry point|side-effect|call-graph|direct/i),
    }))
    expect(guidance.likely_edit_files.every((entry) => !entry.path.startsWith('tests/'))).toBe(true)
    expect(guidance.likely_test_files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'tests/unit/login-service.test.ts',
        score: expect.any(Number),
        reason: expect.stringMatching(/covered|unit|validation|test/i),
      }),
      expect.objectContaining({
        path: 'tests/e2e/login-flow.test.ts',
        score: expect.any(Number),
        reason: expect.stringMatching(/e2e|integration|route|entry/i),
      }),
    ]))
  })

  it('keeps an explicitly named helper target in likely_edit_files', () => {
    const graph = buildLikelyTargetsGraph()
    const retrieval = {
      question: 'update normalizeLoginPayload in src/auth/login-helper.ts to preserve the new login validation behavior',
      token_count: 180,
      matched_nodes: [
        {
          node_id: 'login_helper',
          label: 'normalizeLoginPayload',
          source_file: `${graph.graph.root_path}/src/auth/login-helper.ts`,
          line_number: 18,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function normalizeLoginPayload() {}',
          match_score: 0.96,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Login workflow',
        },
        {
          node_id: 'login_service',
          label: 'LoginService.validate',
          source_file: `${graph.graph.root_path}/src/auth/login-service.ts`,
          line_number: 30,
          node_kind: 'method',
          framework_role: 'nest_provider',
          file_type: 'code',
          snippet: 'export class LoginService { validate() {} }',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Login workflow',
        },
        {
          node_id: 'login_controller',
          label: 'LoginController.submit',
          source_file: `${graph.graph.root_path}/src/auth/login-controller.ts`,
          line_number: 20,
          node_kind: 'method',
          framework_role: 'nest_controller',
          file_type: 'code',
          snippet: 'export class LoginController { submit() {} }',
          match_score: 0.51,
          relevance_band: 'related' as const,
          community: 0,
          community_label: 'Login HTTP surface',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2200,
      taskIntent: 'implement',
      limit: 5,
    })

    expect(guidance.likely_edit_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/auth/login-helper.ts' }),
      expect.objectContaining({ path: 'src/auth/login-service.ts' }),
    ]))
  })

  it('keeps a clear caution when no related tests are discoverable', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-no-tests-'))
    tempFixtureRoots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'madar-no-tests-fixture',
      private: true,
      scripts: {
        typecheck: 'tsc --noEmit',
        build: 'tsc -p tsconfig.build.json',
        'test:run': 'vitest run',
      },
    }))

    const graph = build(
      [
        {
          schema_version: 1,
          nodes: [
            { id: 'billing_service', label: 'BillingService.retry', file_type: 'code', source_file: `${root}/src/billing/service.ts`, source_location: 'L10', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
            { id: 'billing_helper', label: 'formatRetryWindow', file_type: 'code', source_file: `${root}/src/billing/helper.ts`, source_location: 'L20', node_kind: 'function', community: 1 },
          ],
          edges: [
            { source: 'billing_service', target: 'billing_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/billing/service.ts` },
          ],
        },
      ],
      { directed: true },
    )
    graph.graph.root_path = root

    const retrieval = {
      question: 'adjust retry window logic',
      token_count: 60,
      matched_nodes: [
        {
          node_id: 'billing_service',
          label: 'BillingService.retry',
          source_file: `${root}/src/billing/service.ts`,
          line_number: 10,
          node_kind: 'method',
          framework_role: 'nest_provider',
          file_type: 'code',
          snippet: 'export class BillingService { retry() {} }',
          match_score: 0.72,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Billing workflow',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary'] as const,
        semantic_required: ['implementation'] as const,
        semantic_optional: ['tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 1400,
      taskIntent: 'implement',
    })

    expect(guidance.likely_test_files).toEqual([])
    expect(guidance.cautions).toContain('No related tests were retrieved; validate regression coverage manually.')
  })

  it('does not leak matched test files into likely_edit_files when the task does not ask to modify tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-edit-filter-'))
    tempFixtureRoots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'madar-edit-filter-fixture',
      private: true,
      scripts: {
        typecheck: 'tsc --noEmit',
        build: 'tsc -p tsconfig.build.json',
        'test:run': 'vitest run',
      },
    }))

    const graph = build(
      [
        {
          schema_version: 1,
          nodes: [
            { id: 'profile_service', label: 'ProfileService.update', file_type: 'code', source_file: `${root}/src/profile/service.ts`, source_location: 'L10', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
            { id: 'profile_service_test', label: 'ProfileService.update.spec', file_type: 'code', source_file: `${root}/tests/unit/profile-service.test.ts`, source_location: 'L1', node_kind: 'function', community: 2 },
          ],
          edges: [
            { source: 'profile_service', target: 'profile_service_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/profile/service.ts` },
          ],
        },
      ],
      { directed: true },
    )
    graph.graph.root_path = root

    const retrieval = {
      question: 'change profile update validation',
      token_count: 70,
      matched_nodes: [
        {
          node_id: 'profile_service',
          label: 'ProfileService.update',
          source_file: `${root}/src/profile/service.ts`,
          line_number: 10,
          node_kind: 'method',
          framework_role: 'nest_provider',
          file_type: 'code',
          snippet: 'export class ProfileService { update() {} }',
          match_score: 0.78,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Profile workflow',
        },
        {
          node_id: 'profile_service_test',
          label: 'ProfileService.update.spec',
          source_file: `${root}/tests/unit/profile-service.test.ts`,
          line_number: 1,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'describe("ProfileService.update", () => {})',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Profile tests',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary'] as const,
        semantic_required: ['implementation'] as const,
        semantic_optional: ['tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 1200,
      taskIntent: 'implement',
      limit: 3,
    })

    expect(guidance.likely_edit_files.every((entry) => !entry.path.startsWith('tests/'))).toBe(true)
  })
})

describe('buildImplementationPackGuidance search-expand-refine pipeline (#299)', () => {
  it('tracks explicit pipeline phases when graph expansion promotes the workflow owner from an indirect seed', () => {
    const graph = buildIndirectSeedExpansionGraph()
    const retrieval = {
      question: 'normalize payment aging retry window',
      token_count: 90,
      matched_nodes: [
        {
          node_id: 'retry_helper',
          label: 'normalizePaymentAgingRetryWindow',
          source_file: `${graph.graph.root_path}/src/core/payment-aging-helper.ts`,
          line_number: 40,
          node_kind: 'function',
          file_type: 'code',
          snippet: 'export function normalizePaymentAgingRetryWindow() {}',
          match_score: 0.97,
          relevance_band: 'direct' as const,
          community: 1,
          community_label: 'Task workflow',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests', 'contracts'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult

    const guidance = buildImplementationPackGuidance(graph, retrieval, {
      budget: 2200,
      taskIntent: 'implement',
      limit: 5,
    })

    expect(guidance.retrieval_pipeline.phases.map((entry) => entry.phase)).toEqual([
      'seed',
      'expand',
      'promote',
      'attach',
      'refine',
      'render',
    ])
    expect(guidance.workflow_centers[0]).toEqual(expect.objectContaining({
      path: 'src/core/workflow-runner.ts',
      phases: expect.arrayContaining(['expand', 'promote']),
      reason: expect.stringMatching(/expand|promot/i),
    }))
    expect(guidance.likely_edit_files[0]).toEqual(expect.objectContaining({
      path: 'src/core/workflow-runner.ts',
      phases: expect.arrayContaining(['expand', 'promote', 'attach', 'refine']),
      reason: expect.stringMatching(/expand|promot/i),
    }))
    expect(guidance.contracts_and_public_surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_file: 'src/contracts/retry-window.ts',
        line_number: 60,
        kind: 'contract',
        phases: expect.arrayContaining(['attach']),
        why: expect.stringMatching(/attach|neighbor/i),
      }),
      expect.objectContaining({
        source_file: 'src/core/task-controller.ts',
        kind: 'public_surface',
        phases: expect.arrayContaining(['attach']),
      }),
    ]))
  })
})
