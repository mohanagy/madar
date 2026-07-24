import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  sanitizeShareSafeText,
  toShareSafeArtifactPath,
  type ShareSafePathRoots,
} from '../../src/shared/share-safe-artifacts.js'

const ROOTS = {
  artifactRoot: '/workspace/out/compare',
  projectRoot: '/workspace',
}

let fixtureRoot: string
let roots: ShareSafePathRoots

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'madar-share-safe-'))
  roots = {
    artifactRoot: join(fixtureRoot, 'project', 'out', 'compare'),
    projectRoot: join(fixtureRoot, 'project'),
  }
  mkdirSync(roots.artifactRoot, { recursive: true })
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('toShareSafeArtifactPath', () => {
  it('maps artifact and project paths to portable rooted placeholders', () => {
    expect(toShareSafeArtifactPath(roots.artifactRoot, roots)).toBe('<artifact-root>')
    expect(toShareSafeArtifactPath(join(roots.artifactRoot, 'report.json'), roots)).toBe(
      '<artifact-root>/report.json',
    )
    expect(toShareSafeArtifactPath(roots.projectRoot, roots)).toBe('<project-root>')
    expect(toShareSafeArtifactPath(join(roots.projectRoot, 'src', 'app.ts'), roots)).toBe(
      '<project-root>/src/app.ts',
    )
  })

  it('reduces paths outside both roots to their final segment', () => {
    expect(
      toShareSafeArtifactPath(join(dirname(roots.projectRoot), 'private', 'secret.txt'), roots),
    ).toBe('secret.txt')
    expect(toShareSafeArtifactPath('/', roots)).toBe('<external-path>')
  })
})

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

  it('rewrites existing absolute and relative traversal paths without consuming prose', () => {
    const secretPath = join(roots.projectRoot, 'Quarterly Reports', 'review notes.txt')
    mkdirSync(dirname(secretPath), { recursive: true })
    writeFileSync(secretPath, 'private\n', 'utf8')
    const traversalPath = relative(roots.artifactRoot, secretPath)

    expect(sanitizeShareSafeText(`see ${secretPath}`, roots)).toBe(
      'see <project-root>/Quarterly Reports/review notes.txt',
    )
    expect(sanitizeShareSafeText(`${traversalPath}: details`, roots)).toBe(
      '<project-root>/Quarterly Reports/review notes.txt: details',
    )
    expect(sanitizeShareSafeText(`${traversalPath}:${traversalPath}`, roots)).toBe(
      '<project-root>/Quarterly Reports/review notes.txt:<project-root>/Quarterly Reports/review notes.txt',
    )
  })

  it.each([
    [
      '<project-root>/Quarterly Reports/missing notes.txt and /etc/passwd',
      '<project-root>/Quarterly Reports/missing notes.txt and passwd',
    ],
    [
      '<project-root>/foo v1.2 beta.3 /etc/passwd',
      '<project-root>/foo v1.2 beta.3 passwd',
    ],
    [
      '<project-root>/dir with space/subdir and /etc/passwd',
      '<project-root>/dir with space/subdir and passwd',
    ],
    [
      '<project-root>/dir with space,/etc/passwd',
      '<project-root>/dir with space,passwd',
    ],
  ])('preserves rooted placeholders while sanitizing a later path in %s', (input, expected) => {
    expect(sanitizeShareSafeText(input, roots)).toBe(expected)
  })

  it.each([
    [
      '<project-root>/Quarterly Reports/review notes.txt,C:/Windows/system32/drivers/etc/hosts',
      '<project-root>/Quarterly Reports/review notes.txt,hosts',
    ],
    [
      String.raw`<project-root>/Quarterly Reports/review notes.txt,C:\Windows\system32\drivers\etc\hosts`,
      '<project-root>/Quarterly Reports/review notes.txt,hosts',
    ],
    [
      String.raw`<project-root>/Quarterly Reports/review notes.txt,\\server\share\secret.txt`,
      '<project-root>/Quarterly Reports/review notes.txt,secret.txt',
    ],
    [
      'x,C:/Windows/notepad.exe,C:/Windows/system.ini',
      'x,notepad.exe,system.ini',
    ],
  ])('sanitizes punctuation-attached Windows paths in %s', (input, expected) => {
    expect(sanitizeShareSafeText(input, roots)).toBe(expected)
  })

  it.each([
    ['<project-root>/foo//etc/passwd', '<project-root>/foo/passwd'],
    ['<project-root>/foo/C:/Users/alice/secret.txt', '<project-root>/foo/secret.txt'],
    [
      '<project-root>/dir with space/subdir:/Users/alice/secret.txt',
      '<project-root>/dir with space/subdir:secret.txt',
    ],
    ['<project-root>/missing notes:/etc/passwd', '<project-root>/missing notes:passwd'],
  ])('sanitizes an absolute path restarted after a protected prefix in %s', (input, expected) => {
    expect(sanitizeShareSafeText(input, roots)).toBe(expected)
  })

  it.each([
    '//example.com/api/v1/users',
    '//api.example.com/v1/users',
    '//example.com/docs/getting-started',
    '//cdn.example.com/assets/app.js',
    '<project-root>/safe://example.com/docs/getting-started',
    'foo.bar://example.com/a/b',
  ])('preserves URL-shaped text: %s', (input) => {
    expect(sanitizeShareSafeText(input, roots)).toBe(input)
  })

  it.each([
    ['//server/share/secret.txt', 'secret.txt'],
    ['//server.example.com/share/secret.txt', 'secret.txt'],
    ['//server.example.com/Engineering/secret', 'secret'],
    ['<project-root>/foo//server.example.com/share/secret.txt', '<project-root>/foo/secret.txt'],
    ['<project-root>/safe://etc/passwd', '<project-root>/safe:<external-path>passwd'],
  ])('sanitizes path-shaped double-slash text in %s', (input, expected) => {
    expect(sanitizeShareSafeText(input, roots)).toBe(expected)
  })

  it('sanitizes local file URLs while retaining the file scheme', () => {
    expect(
      sanitizeShareSafeText(
        'see file:///etc/passwd and file:///C:/Users/alice/Documents/secret.txt',
        roots,
      ),
    ).toBe('see file://passwd and file://secret.txt')
    expect(sanitizeShareSafeText('See.file:///etc/passwd', roots)).toBe('See.file://passwd')
  })
})
