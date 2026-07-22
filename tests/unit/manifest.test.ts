import { describe, expect, test } from 'vitest'

import * as detectModule from '../../src/pipeline/detect.js'
import * as manifestModule from '../../src/pipeline/manifest.js'

describe('manifest re-exports', () => {
  test('re-exports detect manifest helpers', () => {
    expect(manifestModule.saveManifest).toBe(detectModule.saveManifest)
    expect(manifestModule.loadManifest).toBe(detectModule.loadManifest)
  })
})
