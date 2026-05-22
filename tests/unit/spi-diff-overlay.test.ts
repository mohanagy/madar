import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import { computeSpiDiffOverlay, type GitDiffRunner } from '../../src/pipeline/spi/diff-overlay.js'
import type { SemanticProgramIndex, SpiSymbol, SpiSymbolKind } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-diff-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function buildIndex(root: string): SemanticProgramIndex {
  return buildSpi({ root, madarVersion: 'test-0.0.0', extractorVersion: 'spi-v1.0.0-slice-3a', now: FROZEN_NOW })
}

function findSymbol(spi: SemanticProgramIndex, filePath: string, name: string, kind: SpiSymbolKind): SpiSymbol {
  const file = spi.files.find((f) => f.path === filePath)
  if (!file) throw new Error(`fixture missing SpiFile: ${filePath}`)
  const matches = spi.symbols.filter((s) => s.file_id === file.id && s.name === name && s.kind === kind)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${kind} ${name} in ${filePath}; got ${matches.length}`)
  }
  return matches[0]!
}

// Builds a mock git-diff runner that returns the supplied unified-diff text.
function diffRunner(diff: string): GitDiffRunner {
  return () => diff
}

describe('computeSpiDiffOverlay (slice 3a of #72)', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('basic mapping', () => {
    it('maps a changed line range to the smallest containing SpiSymbol and emits a changed_in edge', () => {
      writeFile(sandbox, 'src/a.ts', [
        'export function alpha() {',  // line 1
        '  return 1',                  // line 2
        '}',                            // line 3
        '',                             // line 4
        'export function beta() {',    // line 5
        '  return 2',                   // line 6
        '}',                            // line 7
      ].join('\n') + '\n')
      const spi = buildIndex(sandbox)
      const alpha = findSymbol(spi, 'src/a.ts', 'alpha', 'function')
      const beta = findSymbol(spi, 'src/a.ts', 'beta', 'function')
      const file = spi.files.find((f) => f.path === 'src/a.ts')!

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/a.ts',
            '+++ src/a.ts',
            '@@ -2,1 +2,1 @@',
            '-  return 1',
            '+  return 42',
          ].join('\n') + '\n',
        ),
      })

      expect(overlay.base_ref).toBe('main')
      expect(overlay.head_ref).toBe('HEAD')
      expect(overlay.changed_files).toEqual([file.id])
      expect(overlay.changed_symbols).toEqual([alpha.id])
      // beta was not touched; only alpha gets a changed_in edge.
      expect(overlay.changed_symbols).not.toContain(beta.id)
      expect(overlay.edges_added).toHaveLength(1)
      const edge = overlay.edges_added[0]!
      expect(edge.from).toBe(alpha.id)
      expect(edge.to).toBe(file.id)
      expect(edge.kind).toBe('changed_in')
      expect(edge.confidence).toBe('high')
      expect(edge.source).toBe('typescript-syntactic')
    })

    it('attributes a multi-line hunk to every overlapping symbol in the file', () => {
      writeFile(sandbox, 'src/m.ts', [
        'export function fst() { return 1 }',  // line 1
        'export function snd() { return 2 }',  // line 2
        'export function thd() { return 3 }',  // line 3
      ].join('\n') + '\n')
      const spi = buildIndex(sandbox)
      const fst = findSymbol(spi, 'src/m.ts', 'fst', 'function')
      const snd = findSymbol(spi, 'src/m.ts', 'snd', 'function')

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/m.ts',
            '+++ src/m.ts',
            '@@ -1,2 +1,2 @@',
            '-export function fst() { return 1 }',
            '-export function snd() { return 2 }',
            '+export function fst() { return 11 }',
            '+export function snd() { return 22 }',
          ].join('\n') + '\n',
        ),
      })

      // fst (line 1) and snd (line 2) are both in the hunk; thd (line 3) is not.
      expect(overlay.changed_symbols).toEqual([fst.id, snd.id].sort())
    })

    it('produces no changed_in edge for files not in the SPI', () => {
      writeFile(sandbox, 'src/in-spi.ts', 'export const x = 1\n')
      const spi = buildIndex(sandbox)

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/some/unrelated/file.txt',
            '+++ some/unrelated/file.txt',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
          ].join('\n') + '\n',
        ),
      })
      expect(overlay.changed_files).toHaveLength(0)
      expect(overlay.changed_symbols).toHaveLength(0)
      expect(overlay.edges_added).toHaveLength(0)
    })
  })

  describe('git diff parsing edge cases', () => {
    it('handles deletion-only hunks (count=0) without producing changed_in edges', () => {
      writeFile(sandbox, 'src/d.ts', 'export function survivor() { return 1 }\n')
      const spi = buildIndex(sandbox)

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/d.ts',
            '+++ src/d.ts',
            '@@ -10,3 +9,0 @@',
            '-removed line one',
            '-removed line two',
            '-removed line three',
          ].join('\n') + '\n',
        ),
      })
      // The change touched the file but had no head-side range, so no
      // symbol-level edges. The file itself is still listed as changed.
      expect(overlay.changed_files).toHaveLength(1)
      expect(overlay.changed_symbols).toHaveLength(0)
      expect(overlay.edges_added).toHaveLength(0)
    })

    it('handles single-line hunks with the implicit count of 1', () => {
      writeFile(sandbox, 'src/s.ts', 'export const target = 1\n')
      const spi = buildIndex(sandbox)
      const target = findSymbol(spi, 'src/s.ts', 'target', 'constant')

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/s.ts',
            '+++ src/s.ts',
            // No count = implicit 1
            '@@ -1 +1 @@',
            '-export const target = 1',
            '+export const target = 99',
          ].join('\n') + '\n',
        ),
      })
      expect(overlay.changed_symbols).toEqual([target.id])
    })

    it('skips deleted-from-head files (+++ /dev/null)', () => {
      writeFile(sandbox, 'src/keeper.ts', 'export const k = 1\n')
      const spi = buildIndex(sandbox)
      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/deleted.ts',
            '+++ /dev/null',
            '@@ -1,1 +0,0 @@',
            '-was here',
          ].join('\n') + '\n',
        ),
      })
      expect(overlay.changed_files).toHaveLength(0)
    })

    it('strips the conventional b/ prefix when --no-prefix was not used', () => {
      writeFile(sandbox, 'src/p.ts', 'export const p = 1\n')
      const spi = buildIndex(sandbox)
      const target = findSymbol(spi, 'src/p.ts', 'p', 'constant')

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: diffRunner(
          [
            '--- a/src/p.ts',
            '+++ b/src/p.ts',  // <-- the 'b/' prefix some git configs emit
            '@@ -1 +1 @@',
            '-export const p = 1',
            '+export const p = 2',
          ].join('\n') + '\n',
        ),
      })
      expect(overlay.changed_symbols).toEqual([target.id])
    })
  })

  describe('multiple files in one diff', () => {
    it('walks every file block and dedupes symbols across hunks', () => {
      writeFile(sandbox, 'src/a.ts', 'export function fa() { return 1 }\n')
      writeFile(sandbox, 'src/b.ts', 'export function fb() { return 2 }\n')
      const spi = buildIndex(sandbox)
      const fa = findSymbol(spi, 'src/a.ts', 'fa', 'function')
      const fb = findSymbol(spi, 'src/b.ts', 'fb', 'function')

      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        headRef: 'feature/foo',
        runGitDiff: diffRunner(
          [
            '--- a/src/a.ts',
            '+++ src/a.ts',
            '@@ -1 +1 @@',
            '-export function fa() { return 1 }',
            '+export function fa() { return 11 }',
            '--- a/src/b.ts',
            '+++ src/b.ts',
            '@@ -1 +1 @@',
            '-export function fb() { return 2 }',
            '+export function fb() { return 22 }',
          ].join('\n') + '\n',
        ),
      })
      expect(overlay.head_ref).toBe('feature/foo')
      expect(overlay.changed_symbols.sort()).toEqual([fa.id, fb.id].sort())
      expect(overlay.edges_added).toHaveLength(2)
    })
  })

  describe('graceful failure', () => {
    it('returns an empty overlay when the git runner throws (uninitialized repo)', () => {
      writeFile(sandbox, 'src/s.ts', 'export const x = 1\n')
      const spi = buildIndex(sandbox)
      const overlay = computeSpiDiffOverlay({
        spi,
        root: sandbox,
        baseRef: 'main',
        runGitDiff: vi.fn(() => { throw new Error('not a git repo') }),
      })
      expect(overlay).toEqual({
        base_ref: 'main',
        head_ref: 'HEAD',
        changed_files: [],
        changed_symbols: [],
        edges_added: [],
      })
    })
  })

  describe('determinism', () => {
    it('produces a stable JSON shape for the same SPI + diff text', () => {
      writeFile(sandbox, 'src/a.ts', [
        'export function alpha() { return 1 }',
        'export function beta() { return 2 }',
      ].join('\n') + '\n')
      const spi = buildIndex(sandbox)
      const diff = [
        '--- a/src/a.ts',
        '+++ src/a.ts',
        '@@ -1,2 +1,2 @@',
        '-export function alpha() { return 1 }',
        '-export function beta() { return 2 }',
        '+export function alpha() { return 11 }',
        '+export function beta() { return 22 }',
      ].join('\n') + '\n'

      const first = computeSpiDiffOverlay({ spi, root: sandbox, baseRef: 'main', runGitDiff: diffRunner(diff) })
      const second = computeSpiDiffOverlay({ spi, root: sandbox, baseRef: 'main', runGitDiff: diffRunner(diff) })
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })
  })
})
