import { describe, expect, it } from 'vitest'

import { sanitizeShareSafeText } from '../../src/shared/share-safe-artifacts.js'

const ROOTS = {
  artifactRoot: '/workspace/out/compare',
  projectRoot: '/workspace',
}

describe('sanitizeShareSafeText', () => {
  it('redacts remote url credentials and secret-bearing query params while preserving benign urls', () => {
    const text = [
      'signed receipt https://alice:s3cr3t@example.com/hooks?token=abc123&api_key=shh&mode=full',
      'docs https://example.com/guide?tab=usage',
    ].join(' ')

    expect(sanitizeShareSafeText(text, ROOTS)).toBe(
      'signed receipt https://[REDACTED]@example.com/hooks?token=[REDACTED]&api_key=[REDACTED]&mode=full docs https://example.com/guide?tab=usage',
    )
  })

  it('redacts credential-like environment assignments and bearer tokens', () => {
    const text = 'MADAR_TOKEN=abc123 Authorization: Bearer super-secret-value'

    expect(sanitizeShareSafeText(text, ROOTS)).toBe('MADAR_TOKEN=[REDACTED] Authorization: Bearer [REDACTED]')
  })

  it('keeps malformed query keys from crashing share-safe sanitization', () => {
    expect(() =>
      sanitizeShareSafeText('see https://example.com/hook?token%ZZ=abc&mode=full', ROOTS),
    ).not.toThrow()

    expect(sanitizeShareSafeText('see https://example.com/hook?token%ZZ=abc&mode=full', ROOTS)).toBe(
      'see https://example.com/hook?token%ZZ=abc&mode=full',
    )
  })

  it('preserves non-http schemes when redacting secret-bearing query params', () => {
    expect(sanitizeShareSafeText('see custom://example.com/path?token=abc&mode=full', ROOTS)).toBe(
      'see custom://example.com/path?token=[REDACTED]&mode=full',
    )
  })
})
