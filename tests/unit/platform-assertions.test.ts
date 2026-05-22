import { describe, expect, it } from 'vitest'

import { normalizeAssertionPath, shouldAssertExecutableBits } from './helpers/platform.js'

describe('platform assertion helpers', () => {
  it('normalizes Windows-style paths for cross-platform assertions', () => {
    expect(normalizeAssertionPath('C:\\temp\\out\\memory\\query_auth.md')).toBe('C:/temp/out/memory/query_auth.md')
  })

  it('disables executable-bit assertions on Windows only', () => {
    expect(shouldAssertExecutableBits('win32')).toBe(false)
    expect(shouldAssertExecutableBits('darwin')).toBe(true)
    expect(shouldAssertExecutableBits('linux')).toBe(true)
  })
})
