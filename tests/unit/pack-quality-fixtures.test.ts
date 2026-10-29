import { describe, expect, it } from 'vitest'

import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { listPackQualityFixtures, readPackQualityFixtureSource, runPackQualityFixture, type PackQualityFixtureRunResult, type SourceEvidenceNode } from './helpers/pack-quality.js'

function assertDeliveredSource(name: string, result: PackQualityFixtureRunResult): SourceEvidenceNode[] {
  const { payload, output } = result
  expect(payload.response_format).toBe('source_evidence_v2')
  expect(payload.evidence.answerability.advisory).toBe(true)
  expect(payload.evidence.answerability.answer_scope).not.toBe('complete')
  expect(payload.serialized_budget).toEqual({
    max_tokens: result.fixture.budget ?? 1800,
    token_count: estimateQueryTokens(output),
    enforced: true,
  })
  expect(payload.serialized_budget.token_count).toBeLessThanOrEqual(payload.serialized_budget.max_tokens)
  const nodes = payload.pack.matched_nodes
  expect(nodes.length).toBeGreaterThan(0)
  const resolveSnippet = (node: SourceEvidenceNode, visiting = new Set<string>()): string => {
    expect(visiting.has(node.node_id)).toBe(false)
    if (typeof node.snippet === 'string') return node.snippet
    expect(node.snippet_ref).toEqual(expect.any(String))
    const owner = nodes.find((entry) => entry.node_id === node.snippet_ref)
    expect(owner, `unresolved snippet_ref for ${node.label}`).toBeDefined()
    expect(owner!.source_file).toBe(node.source_file)
    const range = node.snippet_line_range!, ownerRange = owner!.snippet_line_range!
    expect(range.start_line).toBeGreaterThanOrEqual(ownerRange.start_line)
    expect(range.end_line).toBeLessThanOrEqual(ownerRange.end_line)
    return resolveSnippet(owner!, new Set([...visiting, node.node_id])).split('\n')
      .slice(range.start_line - ownerRange.start_line, range.end_line - ownerRange.start_line + 1).join('\n')
  }
  for (const node of nodes) {
    const lines = readPackQualityFixtureSource(name, node.source_file).replace(/\r\n/g, '\n').split('\n')
    const range = node.snippet_line_range
    expect(range, `missing source range for ${node.label}`).toBeDefined()
    expect(Number.isInteger(range!.start_line)).toBe(true)
    expect(Number.isInteger(range!.end_line)).toBe(true)
    expect(range!.start_line).toBeGreaterThan(0)
    expect(range!.end_line).toBeGreaterThanOrEqual(range!.start_line)
    expect(range!.end_line).toBeLessThanOrEqual(lines.length)
    expect(node.snippet_unverified).not.toBe(true)
    expect(node.snippet_omitted_ranges ?? []).toEqual([])
    expect(resolveSnippet(node), `source excerpt for ${node.label}`).toBe(lines.slice(range!.start_line - 1, range!.end_line).join('\n'))
  }
  for (const continuation of payload.expandable ?? []) {
    expect(continuation.handle_id.length).toBeGreaterThan(0)
    const files = [...(continuation.focus_files ?? []), ...(continuation.focus_ranges ?? []).map((range) => range.source_file)]
    expect(files.length, `continuation ${continuation.handle_id} needs a usable source location`).toBeGreaterThan(0)
    for (const file of files) expect(readPackQualityFixtureSource(name, file).length).toBeGreaterThan(0)
    for (const range of continuation.focus_ranges ?? []) {
      expect(range.start_line).toBeGreaterThan(0)
      expect(range.end_line).toBeGreaterThanOrEqual(range.start_line)
      expect(range.end_line).toBeLessThanOrEqual(readPackQualityFixtureSource(name, range.source_file).split('\n').length)
    }
  }
  return nodes
}

const EXPECTED_IMPLEMENT_FIXTURES = [
  'controller-service-test-flow',
  'queue-job-retry-workflow',
  'cli-command-implementation',
  'api-route-schema-service',
  'monorepo-package-boundary',
  'source-test-adjacency',
  'noisy-helper-distractor',
  'indirect-seed-workflow-owner',
  'framework-request-flow-owner',
  'framework-runtime-boundary-distractor',
] as const

const EXPECTED_EXPLAIN_FIXTURES = [
  'runtime-generation-explain-report-flow',
] as const

const EXPECTED_TOP_WORKFLOW_CENTER = {
  'framework-request-flow-owner': 'src/users/router.ts',
  'framework-runtime-boundary-distractor': 'app/dashboard/actions.ts',
} as const

const EXPECTED_TOP_LIKELY_EDIT_FILE = {
  'framework-runtime-boundary-distractor': 'app/dashboard/actions.ts',
} as const

const EXPECTED_WORKFLOW_ORDER = {
  'framework-runtime-boundary-distractor': [
    'app/dashboard/actions.ts',
    'components/dashboard-client.tsx',
  ],
} as const

const EXPECTED_LIKELY_EDIT_ORDER = {
  'framework-runtime-boundary-distractor': [
    'app/dashboard/actions.ts',
    'components/dashboard-client.tsx',
  ],
} as const

const FORBIDDEN_LIKELY_EDIT_FILES = {
  'framework-request-flow-owner': ['src/http/app.ts'],
  'framework-runtime-boundary-distractor': ['app/dashboard/page.tsx'],
} as const

const EXPECTED_NEGATIVE_GUIDANCE_SNIPPETS = {
  'framework-request-flow-owner': ['src/http/app.ts'],
  'framework-runtime-boundary-distractor': ['app/dashboard/page.tsx'],
} as const

const EXPECTED_FIXTURES = [
  ...EXPECTED_IMPLEMENT_FIXTURES,
  ...EXPECTED_EXPLAIN_FIXTURES,
] as const

describe('pack-quality fixtures (#298)', () => {
  it('ships all listed pack-quality fixture categories', () => {
    expect(listPackQualityFixtures()).toEqual(EXPECTED_FIXTURES)
  })

  for (const fixtureName of EXPECTED_IMPLEMENT_FIXTURES) {
    it(`generates a deterministic implement pack for ${fixtureName}`, async () => {
      const result = await runPackQualityFixture(fixtureName)

      expect(result.graph.nodeCount).toBeGreaterThan(0)
      const delivered = assertDeliveredSource(fixtureName, result)
      expect(delivered.map((node) => node.source_file)).toEqual(expect.arrayContaining([
        ...result.fixture.expected_workflow_centers,
        ...result.fixture.expected_likely_edit_files,
      ]))
      // Optional planning guidance may yield to source under the wire budget.
      // Its original algorithm assertions below still run for every fixture.
      if (result.payload.implementation) {
        expect(result.payload.implementation.likely_edit_files?.map((entry) => entry.path)).toEqual(
          expect.arrayContaining(result.fixture.expected_likely_edit_files),
        )
        if (result.fixture.expected_likely_test_files.length > 0) {
          expect(result.payload.implementation.likely_test_files?.map((entry) => entry.path)).toEqual(
            expect.arrayContaining(result.fixture.expected_likely_test_files),
          )
        }
        if (result.fixture.expected_validation_commands.length > 0) {
          expect(result.payload.implementation.validation_commands).toEqual(
            expect.arrayContaining(result.fixture.expected_validation_commands),
          )
        }
      } else {
        expect(result.payload.evidence.answerability.missing_obligations?.length).toBeGreaterThan(0)
      }
      expect(result.diagnostics.workflow_centers?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(result.fixture.expected_workflow_centers),
      )
      expect(result.diagnostics.likely_edit_files?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(result.fixture.expected_likely_edit_files),
      )

      const expectedTopWorkflowCenter = EXPECTED_TOP_WORKFLOW_CENTER[
        fixtureName as keyof typeof EXPECTED_TOP_WORKFLOW_CENTER
      ]
      if (expectedTopWorkflowCenter) {
        expect(result.diagnostics.workflow_centers?.[0]?.path).toBe(expectedTopWorkflowCenter)
      }

      const expectedTopLikelyEditFile = EXPECTED_TOP_LIKELY_EDIT_FILE[
        fixtureName as keyof typeof EXPECTED_TOP_LIKELY_EDIT_FILE
      ]
      if (expectedTopLikelyEditFile) {
        expect(result.diagnostics.likely_edit_files?.[0]?.path).toBe(expectedTopLikelyEditFile)
      }

      const expectedWorkflowOrder = EXPECTED_WORKFLOW_ORDER[
        fixtureName as keyof typeof EXPECTED_WORKFLOW_ORDER
      ]
      if (expectedWorkflowOrder) {
        const workflowCenters = result.diagnostics.workflow_centers?.map((entry) => entry.path) ?? []
        expect(workflowCenters.indexOf(expectedWorkflowOrder[0])).toBeGreaterThanOrEqual(0)
        expect(workflowCenters.indexOf(expectedWorkflowOrder[0])).toBeLessThan(
          workflowCenters.indexOf(expectedWorkflowOrder[1]),
        )
      }

      const expectedLikelyEditOrder = EXPECTED_LIKELY_EDIT_ORDER[
        fixtureName as keyof typeof EXPECTED_LIKELY_EDIT_ORDER
      ]
      if (expectedLikelyEditOrder) {
        const likelyEditFiles = result.diagnostics.likely_edit_files?.map((entry) => entry.path) ?? []
        expect(likelyEditFiles.indexOf(expectedLikelyEditOrder[0])).toBeGreaterThanOrEqual(0)
        expect(likelyEditFiles.indexOf(expectedLikelyEditOrder[0])).toBeLessThan(
          likelyEditFiles.indexOf(expectedLikelyEditOrder[1]),
        )
      }

      const forbiddenLikelyEditFiles = FORBIDDEN_LIKELY_EDIT_FILES[
        fixtureName as keyof typeof FORBIDDEN_LIKELY_EDIT_FILES
      ]
      if (forbiddenLikelyEditFiles) {
        expect(result.diagnostics.likely_edit_files?.map((entry) => entry.path)).not.toEqual(
          expect.arrayContaining([...forbiddenLikelyEditFiles]),
        )
      }

      if (result.fixture.expected_likely_test_files.length > 0) {
        expect(result.diagnostics.likely_test_files?.map((entry) => entry.path)).toEqual(
          expect.arrayContaining(result.fixture.expected_likely_test_files),
        )
      }

      if (result.fixture.expected_validation_commands.length > 0) {
        expect(result.diagnostics.validation_commands).toEqual(
          expect.arrayContaining(result.fixture.expected_validation_commands),
        )
      }

      if ((result.fixture.expected_retrieval_pipeline_phases?.length ?? 0) > 0) {
        expect(result.diagnostics.retrieval_pipeline?.phases?.map((entry) => entry.phase)).toEqual(
          expect.arrayContaining(result.fixture.expected_retrieval_pipeline_phases ?? []),
        )
      }

      for (const snippet of result.fixture.expected_negative_guidance) {
        expect(result.diagnostics.negative_guidance?.some((entry) => entry.includes(snippet))).toBe(true)
      }

      const expectedNegativeGuidanceSnippets = EXPECTED_NEGATIVE_GUIDANCE_SNIPPETS[
        fixtureName as keyof typeof EXPECTED_NEGATIVE_GUIDANCE_SNIPPETS
      ]
      if (expectedNegativeGuidanceSnippets) {
        for (const snippet of expectedNegativeGuidanceSnippets) {
          expect(result.diagnostics.negative_guidance?.some((entry) => entry.includes(snippet))).toBe(true)
        }
      }
    })
  }

  it('generates a deterministic explain pack for runtime-generation-explain-report-flow', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.diagnostics as typeof result.diagnostics & {
      confidence_score?: number
      workflow_centers?: Array<{ path?: string }>
      recommended_first_read?: Array<{ path?: string }>
      pack?: {
        confidence_score?: number
        workflow_centers?: Array<{ path?: string }>
        recommended_first_read?: Array<{ path?: string }>
        execution_slice?: {
          steps?: Array<{ label?: string }>
          primary_path?: {
            steps?: Array<{ label?: string }>
          }
          phase_coverage?: {
            expected?: string[]
            observed?: string[]
            missing?: string[]
          }
        }
        matched_nodes?: Array<{ label?: string }>
      }
    }

    expect(payload.recommended_first_read?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'src/modules/ideas/interface/http/idea-generation.controller.ts',
        'src/modules/pipeline/api/pipeline-trigger.service.ts',
        'src/modules/pipeline/api/queue-registry.service.ts',
      ]),
    )
    expect(payload.confidence_score).toEqual(expect.any(Number))
    expect(payload.confidence_score).toBeGreaterThanOrEqual(0)
    expect(payload.confidence_score).toBeLessThanOrEqual(1)
    // Rankings stay diagnostic; compact v2 spends the budget on source evidence.
    expect(result.payload).not.toHaveProperty('confidence_score')
    expect(result.payload.pack).not.toHaveProperty('workflow_centers')
    expect(result.payload.pack).not.toHaveProperty('recommended_first_read')
    expect(payload.recommended_first_read?.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining([
        'src/modules/ideas/application/helpers/idea-report-status-message.helper.ts',
        'src/modules/ideas/application/helpers/idea-report-suggested-next-steps.helper.ts',
      ]),
    )
    expect(payload.negative_guidance).toEqual(expect.arrayContaining([
      expect.stringContaining('direct_producer_to_worker_calls_without_enqueues_boundary'),
      expect.stringContaining('irrelevant_model_or_provider_details'),
    ]))
    expect(payload.pack?.execution_slice?.steps?.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        '.generateFromProblem()',
        'startIdeaReportPipeline()',
        'enqueueIdeaReportJob()',
        '.process()',
        'saveStructuredReport()',
      ]),
    )
    const normalPrimaryLabels = payload.pack?.execution_slice?.primary_path?.steps?.map((entry) => entry.label) ?? []
    expect(normalPrimaryLabels).not.toContain('handleQualityGateFailure()')
    expect(normalPrimaryLabels).not.toContain('writeRawFailureReport()')
    expect(normalPrimaryLabels).toEqual(
      expect.arrayContaining([
        'saveStructuredReport()',
      ]),
    )
    expect(payload.pack?.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: expect.arrayContaining([
        'planner',
        'external_research_or_api',
        'report_builder',
        'persistence',
      ]),
      observed: expect.arrayContaining([
        'planner',
        'external_research_or_api',
        'report_builder',
        'persistence',
      ]),
      missing: [],
    }))
    const delivered = assertDeliveredSource('runtime-generation-explain-report-flow', result)
    expect(delivered.map((node) => node.source_file)).toEqual(expect.arrayContaining(result.fixture.expected_workflow_centers))
    expect(result.payload.pack.answer_contract?.do_not_claim).toEqual(expect.arrayContaining(result.fixture.expected_negative_guidance))
    const surfacedLabels = new Set(delivered.map((node) => node.label))
    expect([...surfacedLabels]).toEqual(
      expect.arrayContaining([
        '.generateFromProblem()',
      ]),
    )
    expect([...surfacedLabels]).not.toContain('.buildQueuedIdeaReportResponse()')
  })

  it('promotes the quality-gate failure branch when the explain prompt asks what happens if it fails', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow', {
      prompt: 'How is idea report handled when it fails',
      task: 'explain',
      budget: 1800,
    })
    const payload = result.diagnostics as typeof result.diagnostics & {
      pack?: {
        execution_slice?: {
          primary_path?: {
            steps?: Array<{ label?: string }>
          }
        }
      }
    }
    const primaryLabels = payload.pack?.execution_slice?.primary_path?.steps?.map((entry) => entry.label) ?? []

    expect(primaryLabels).toEqual(expect.arrayContaining([
      'handleQualityGateFailure()',
    ]))
    expect(primaryLabels).not.toContain('saveStructuredReport()')
    const delivered = assertDeliveredSource('runtime-generation-explain-report-flow', result)
    expect(delivered.map((node) => node.label)).toContain('handleQualityGateFailure()')
    expect(result.payload.pack.execution_slice?.steps?.map((step) => step.label)).toContain('handleQualityGateFailure()')
    expect(result.payload.pack.execution_slice?.steps?.map((step) => step.label)).not.toContain('saveStructuredReport()')
  })

  it('delivers source for runtime primary-path steps in the compact response', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.diagnostics as typeof result.diagnostics & {
      expandable?: Array<{
        preview?: Array<{ label?: string }>
      }>
      pack?: {
        execution_slice?: {
          primary_path?: {
            steps?: Array<{ label?: string }>
          }
        }
        matched_nodes?: Array<{ label?: string }>
      }
    }

    const primaryLabels = (payload.pack?.execution_slice?.primary_path?.steps ?? [])
      .flatMap((entry) => (typeof entry.label === 'string' && entry.label.length > 0 ? [entry.label] : []))
    const delivered = assertDeliveredSource('runtime-generation-explain-report-flow', result)
    const surfacedLabels = new Set(delivered.map((node) => node.label))

    expect(primaryLabels.length).toBeGreaterThan(0)
    expect([...surfacedLabels]).toEqual(expect.arrayContaining(primaryLabels))
  })

  it('does not report recommended first reads as omitted slice-path warnings on the explain fixture', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.diagnostics as typeof result.diagnostics & {
      pack?: {
        routing?: {
          warnings?: Array<{
            kind?: string
            detail?: {
              labels?: string[]
            }
          }>
        }
      }
    }
    const recommendedFirstReadEntries = (payload.recommended_first_read ?? []) as Array<{ path?: string; label?: string }>

    const recommendedFirstReads = new Set(
      recommendedFirstReadEntries.flatMap((entry) =>
        typeof entry.label === 'string' && entry.label.length > 0 ? [entry.label] : []),
    )
    const omittedLabels = new Set(
      (payload.pack?.routing?.warnings ?? [])
        .filter((warning) => warning.kind === 'slice_path_nodes_not_promoted')
        .flatMap((warning) => warning.detail?.labels ?? []),
    )

    expect(recommendedFirstReads.size).toBeGreaterThan(0)
    expect([...recommendedFirstReads].filter((label) => omittedLabels.has(label))).toEqual([])
  })
})
