import { describe, expect, it } from 'vitest'

import { classifyCalibrationBucket } from '../../tools/eval/lib/runtime/benchmark/probe-calibration.js'

describe('benchmark probe calibration buckets', () => {
  it('treats token expansion as hurts_or_expands even when quality improves', () => {
    expect(classifyCalibrationBucket({
      tokenDelta: 25,
      qualityDelta: 0.2,
    })).toBe('hurts_or_expands')
  })

  it('treats quality regressions as hurts_or_expands even when tokens drop', () => {
    expect(classifyCalibrationBucket({
      tokenDelta: -15,
      qualityDelta: -0.1,
    })).toBe('hurts_or_expands')
  })
})
