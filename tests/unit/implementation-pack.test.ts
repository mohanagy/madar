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
})
