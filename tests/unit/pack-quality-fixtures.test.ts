import { describe, expect, it } from 'vitest'

import { listPackQualityFixtures, runPackQualityFixture } from './helpers/pack-quality.js'

const EXPECTED_FIXTURES = [
  'controller-service-test-flow',
  'queue-job-retry-workflow',
  'cli-command-implementation',
  'api-route-schema-service',
  'monorepo-package-boundary',
  'source-test-adjacency',
  'noisy-helper-distractor',
] as const

describe('pack-quality fixtures (#298)', () => {
  it('ships all listed pack-quality fixture categories', () => {
    expect(listPackQualityFixtures()).toEqual(EXPECTED_FIXTURES)
  })

  for (const fixtureName of EXPECTED_FIXTURES) {
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

      for (const snippet of result.fixture.expected_negative_guidance) {
        expect(result.payload.negative_guidance?.some((entry) => entry.includes(snippet))).toBe(true)
      }
    })
  }
})
