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
] as const

const EXPECTED_EXPLAIN_FIXTURES = [
  'runtime-generation-explain-report-flow',
] as const

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
    expect(payload.pack?.confidence_score).toEqual(expect.any(Number))
    expect(payload.pack?.confidence_score).toBeGreaterThanOrEqual(0)
    expect(payload.pack?.confidence_score).toBeLessThanOrEqual(1)
    expect(payload.pack?.confidence_score).toBe(payload.confidence_score)
    expect(payload.pack?.workflow_centers?.map((entry) => entry.path)).toEqual(payload.workflow_centers?.map((entry) => entry.path))
    expect(payload.pack?.recommended_first_read?.map((entry) => entry.path)).toEqual(
      payload.recommended_first_read?.map((entry) => entry.path),
    )
    expect(payload.recommended_first_read?.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining([
        'src/modules/ideas/application/helpers/idea-report-status-message.helper.ts',
        'src/modules/ideas/application/helpers/idea-report-suggested-next-steps.helper.ts',
      ]),
    )
    expect(payload.negative_guidance).toEqual(expect.arrayContaining([
      expect.stringContaining('idea-report-status-message.helper.ts'),
      expect.stringContaining('idea-report-suggested-next-steps.helper.ts'),
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
    expect(payload.pack?.matched_nodes?.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        'planIdeaReport()',
        'processIdeaReportSection()',
        'assembleIdeaReport()',
        'saveStructuredReport()',
      ]),
    )
  })
})
