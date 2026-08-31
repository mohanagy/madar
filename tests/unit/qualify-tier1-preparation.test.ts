import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pathExistsInTarget, prepareTarget } from '../../scripts/lib/qualify-tier1/targets.mjs'

// A real local git repository stands in for a pinned external target, so the
// identity checks are exercised end to end without touching the network. A
// mocked git would prove nothing about the verification these checks perform.
let scratch: string
let originDir: string
let cacheDir: string
let pinnedSha: string
let composeBlob: string
let patchDir: string

function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'qualification-test',
      GIT_AUTHOR_EMAIL: 'qualification@example.invalid',
      GIT_COMMITTER_NAME: 'qualification-test',
      GIT_COMMITTER_EMAIL: 'qualification@example.invalid',
    },
  }).trim()
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'madar-tier1-prep-'))
  originDir = join(scratch, 'origin')
  cacheDir = join(scratch, 'cache')
  patchDir = join(scratch, 'contract', 'docs', 'qualification')
  mkdirSync(join(originDir, 'src'), { recursive: true })
  mkdirSync(join(patchDir, 'patches'), { recursive: true })

  git(['init', '--quiet', '-b', 'main'], originDir)
  writeFileSync(join(originDir, 'src', 'compose.ts'), 'export const compose = 1\n')
  git(['add', '.'], originDir)
  git(['commit', '--quiet', '-m', 'pinned'], originDir)
  pinnedSha = git(['rev-parse', 'HEAD'], originDir)
  composeBlob = git(['rev-parse', 'HEAD:src/compose.ts'], originDir)

  writeFileSync(
    join(patchDir, 'patches', 'seed.patch'),
    [
      'diff --git a/src/compose.ts b/src/compose.ts',
      '--- a/src/compose.ts',
      '+++ b/src/compose.ts',
      '@@ -1 +1 @@',
      '-export const compose = 1',
      '+export const compose = 2',
      '',
    ].join('\n'),
  )
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fixture',
    kind: 'git',
    source: { url: originDir, ref: pinnedSha },
    cited_blobs: { 'src/compose.ts': composeBlob },
    ...overrides,
  }
}

function prepare(definition: Record<string, unknown>, name: string) {
  return prepareTarget({
    target: definition,
    baseTarget: null,
    contractRoot: patchDir,
    cacheDir,
    destDir: join(scratch, 'work', name),
    allowNetwork: true,
  })
}

describe('target preparation identity', () => {
  it('checks out the exact pinned revision and verifies every cited blob', () => {
    const receipt = prepare(target(), 'clean')
    expect(receipt.valid).toBe(true)
    expect(receipt.head).toBe(pinnedSha)
    expect(receipt.cited_blobs_verified).toBe(1)
    expect(receipt.cited_blobs_total).toBe(1)
    expect(receipt.invalid_reason).toBeNull()
  })

  it('reports target_revision_mismatch when a cited blob digest differs', () => {
    const receipt = prepare(
      target({ cited_blobs: { 'src/compose.ts': '0'.repeat(40) } }),
      'bad-blob',
    )
    expect(receipt.valid).toBe(false)
    expect(receipt.invalid_reason).toBe('target_revision_mismatch')
    expect(receipt.cited_blob_mismatches).toHaveLength(1)
  })

  it('reports target_revision_mismatch when the pinned ref does not exist', () => {
    const receipt = prepare(
      target({ source: { url: originDir, ref: 'f'.repeat(40) } }),
      'bad-ref',
    )
    expect(receipt.valid).toBe(false)
    expect(receipt.invalid_reason).toBe('target_revision_mismatch')
  })

  it('applies a seeded patch exactly and records its digest', () => {
    const receipt = prepare(
      target({ id: 'fixture-seeded', kind: 'git_patched', patch: 'patches/seed.patch' }),
      'patched',
    )
    expect(receipt.valid).toBe(true)
    expect(receipt.patch_applied).toBe(true)
    expect(receipt.patch_digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports patch_application_failure when a patch does not apply cleanly', () => {
    writeFileSync(
      join(patchDir, 'patches', 'conflicting.patch'),
      [
        'diff --git a/src/compose.ts b/src/compose.ts',
        '--- a/src/compose.ts',
        '+++ b/src/compose.ts',
        '@@ -1 +1 @@',
        '-export const somethingElse = 9',
        '+export const somethingElse = 10',
        '',
      ].join('\n'),
    )
    const receipt = prepare(
      target({ id: 'fixture-bad-patch', kind: 'git_patched', patch: 'patches/conflicting.patch' }),
      'bad-patch',
    )
    expect(receipt.valid).toBe(false)
    expect(receipt.invalid_reason).toBe('patch_application_failure')
  })

  it('resolves paths inside the prepared tree', () => {
    const dir = join(scratch, 'work', 'clean')
    expect(pathExistsInTarget(dir, 'src/compose.ts')).toBe(true)
    expect(pathExistsInTarget(dir, 'src/absent.ts')).toBe(false)
  })
})
