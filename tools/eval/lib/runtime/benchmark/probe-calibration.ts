export function classifyCalibrationBucket(input: {
  tokenDelta: number
  qualityDelta: number
}): 'helps' | 'hurts_or_expands' | 'no_material_change' {
  if (input.tokenDelta < 0 && input.qualityDelta >= 0) {
    return 'helps'
  }
  if (input.tokenDelta > 0 || input.qualityDelta < 0) {
    return 'hurts_or_expands'
  }
  return 'no_material_change'
}
