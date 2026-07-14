import { describe, expect, it } from 'vitest'

import { listPackQualityFixtures, runPackQualityFixture } from './helpers/pack-quality.js'

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
      expect(result.payload.workflow_centers?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(result.fixture.expected_workflow_centers),
      )
      expect(result.payload.likely_edit_files?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(result.fixture.expected_likely_edit_files),
      )

      const expectedTopWorkflowCenter = EXPECTED_TOP_WORKFLOW_CENTER[
        fixtureName as keyof typeof EXPECTED_TOP_WORKFLOW_CENTER
      ]
      if (expectedTopWorkflowCenter) {
        expect(result.payload.workflow_centers?.[0]?.path).toBe(expectedTopWorkflowCenter)
      }

      const expectedTopLikelyEditFile = EXPECTED_TOP_LIKELY_EDIT_FILE[
        fixtureName as keyof typeof EXPECTED_TOP_LIKELY_EDIT_FILE
      ]
      if (expectedTopLikelyEditFile) {
        expect(result.payload.likely_edit_files?.[0]?.path).toBe(expectedTopLikelyEditFile)
      }

      const expectedWorkflowOrder = EXPECTED_WORKFLOW_ORDER[
        fixtureName as keyof typeof EXPECTED_WORKFLOW_ORDER
      ]
      if (expectedWorkflowOrder) {
        const workflowCenters = result.payload.workflow_centers?.map((entry) => entry.path) ?? []
        expect(workflowCenters.indexOf(expectedWorkflowOrder[0])).toBeGreaterThanOrEqual(0)
        expect(workflowCenters.indexOf(expectedWorkflowOrder[0])).toBeLessThan(
          workflowCenters.indexOf(expectedWorkflowOrder[1]),
        )
      }

      const expectedLikelyEditOrder = EXPECTED_LIKELY_EDIT_ORDER[
        fixtureName as keyof typeof EXPECTED_LIKELY_EDIT_ORDER
      ]
      if (expectedLikelyEditOrder) {
        const likelyEditFiles = result.payload.likely_edit_files?.map((entry) => entry.path) ?? []
        expect(likelyEditFiles.indexOf(expectedLikelyEditOrder[0])).toBeGreaterThanOrEqual(0)
        expect(likelyEditFiles.indexOf(expectedLikelyEditOrder[0])).toBeLessThan(
          likelyEditFiles.indexOf(expectedLikelyEditOrder[1]),
        )
      }

      const forbiddenLikelyEditFiles = FORBIDDEN_LIKELY_EDIT_FILES[
        fixtureName as keyof typeof FORBIDDEN_LIKELY_EDIT_FILES
      ]
      if (forbiddenLikelyEditFiles) {
        expect(result.payload.likely_edit_files?.map((entry) => entry.path)).not.toEqual(
          expect.arrayContaining([...forbiddenLikelyEditFiles]),
        )
      }

      if (result.fixture.expected_likely_test_files.length > 0) {
        expect(result.payload.likely_test_files?.map((entry) => entry.path)).toEqual(
          expect.arrayContaining(result.fixture.expected_likely_test_files),
        )
      }

      if (result.fixture.expected_validation_commands.length > 0) {
        expect(result.payload.validation_commands).toEqual(
          expect.arrayContaining(result.fixture.expected_validation_commands),
        )
      }

      if ((result.fixture.expected_retrieval_pipeline_phases?.length ?? 0) > 0) {
        expect(result.payload.retrieval_pipeline?.phases?.map((entry) => entry.phase)).toEqual(
          expect.arrayContaining(result.fixture.expected_retrieval_pipeline_phases ?? []),
        )
      }

      for (const snippet of result.fixture.expected_negative_guidance) {
        expect(result.payload.negative_guidance?.some((entry) => entry.includes(snippet))).toBe(true)
      }

      const expectedNegativeGuidanceSnippets = EXPECTED_NEGATIVE_GUIDANCE_SNIPPETS[
        fixtureName as keyof typeof EXPECTED_NEGATIVE_GUIDANCE_SNIPPETS
      ]
      if (expectedNegativeGuidanceSnippets) {
        for (const snippet of expectedNegativeGuidanceSnippets) {
          expect(result.payload.negative_guidance?.some((entry) => entry.includes(snippet))).toBe(true)
        }
      }
    })
  }

  it('generates a deterministic explain pack for runtime-generation-explain-report-flow', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.payload as typeof result.payload & {
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

    expect(payload.workflow_centers?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'src/modules/ideas/interface/http/idea-generation.controller.ts',
        'src/modules/pipeline/api/pipeline-trigger.service.ts',
        'src/modules/pipeline/api/queue-registry.service.ts',
        'src/modules/pipeline/workers/orchestrator.worker.ts',
      ]),
    )
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
    expect(payload.pack?.confidence_score).toBeUndefined()
    expect(payload.pack?.workflow_centers).toBeUndefined()
    expect(payload.pack?.recommended_first_read).toBeUndefined()
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
    expect(payload.pack?.matched_nodes?.length).toBeLessThanOrEqual(8)
    const surfacedLabels = new Set([
      ...(payload.pack?.matched_nodes?.map((entry) => entry.label).filter((label): label is string => typeof label === 'string') ?? []),
      ...(payload.expandable?.flatMap((entry) =>
        entry.preview?.map((node) => node.label).filter((label): label is string => typeof label === 'string') ?? [],
      ) ?? []),
      ...(payload.claims?.flatMap((entry) => entry.node_labels ?? []) ?? []),
    ])
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
    const payload = result.payload as typeof result.payload & {
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
  })

  it('surfaces runtime primary-path steps in matched nodes or expandable previews', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.payload as typeof result.payload & {
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
    const surfacedLabels = new Set([
      ...(payload.pack?.matched_nodes ?? []).flatMap((entry) => (typeof entry.label === 'string' && entry.label.length > 0 ? [entry.label] : [])),
      ...(payload.expandable ?? []).flatMap((entry) => (entry.preview ?? []).flatMap((preview) =>
        typeof preview.label === 'string' && preview.label.length > 0 ? [preview.label] : [])),
    ])

    expect(primaryLabels.length).toBeGreaterThan(0)
    expect([...surfacedLabels]).toEqual(expect.arrayContaining(primaryLabels))
  })

  it('does not report workflow centers as omitted slice-path warnings on the explain fixture', async () => {
    const result = await runPackQualityFixture('runtime-generation-explain-report-flow')
    const payload = result.payload as typeof result.payload & {
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
    const workflowCenterEntries = (payload.workflow_centers ?? []) as Array<{ path?: string; label?: string }>

    const workflowCenters = new Set(
      workflowCenterEntries.flatMap((entry) =>
        typeof entry.label === 'string' && entry.label.length > 0 ? [entry.label] : []),
    )
    const omittedLabels = new Set(
      (payload.pack?.routing?.warnings ?? [])
        .filter((warning) => warning.kind === 'slice_path_nodes_not_promoted')
        .flatMap((warning) => warning.detail?.labels ?? []),
    )

    expect(workflowCenters.size).toBeGreaterThan(0)
    expect([...workflowCenters].filter((label) => omittedLabels.has(label))).toEqual([])
  })
})
