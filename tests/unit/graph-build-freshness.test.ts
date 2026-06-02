import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fileContentFingerprint, normalizeFreshnessSourceFile } from '../../src/shared/graph-build-freshness.js'

const sandboxRoots: string[] = []

afterEach(() => {
  while (sandboxRoots.length > 0) {
    const root = sandboxRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('graph build freshness helpers', () => {
  it('drops absolute source paths that escape the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-graph-build-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'madar-graph-build-outside-'))
    sandboxRoots.push(root, outside)

    expect(normalizeFreshnessSourceFile(root, join(outside, 'src', 'auth.ts'))).toBe('')
  })

  it('keeps non-file fingerprints stable across different absolute roots', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'madar-graph-build-fingerprint-a-'))
    const secondRoot = mkdtempSync(join(tmpdir(), 'madar-graph-build-fingerprint-b-'))
    sandboxRoots.push(firstRoot, secondRoot)

    const firstDir = join(firstRoot, 'src', 'nested')
    const secondDir = join(secondRoot, 'src', 'nested')
    mkdirSync(firstDir, { recursive: true })
    mkdirSync(secondDir, { recursive: true })

    const fixedTime = new Date('2024-01-01T00:00:00.000Z')
    utimesSync(firstDir, fixedTime, fixedTime)
    utimesSync(secondDir, fixedTime, fixedTime)

    expect(fileContentFingerprint(firstDir)).toBe(fileContentFingerprint(secondDir))
  })
})
