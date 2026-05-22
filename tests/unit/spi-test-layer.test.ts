import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import { isTestFilePath } from '../../src/pipeline/spi/test-layer.js'
import type { SemanticProgramIndex, SpiEdge } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    madarVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-3c',
    now: FROZEN_NOW,
  })
}

function fileIdFor(spi: SemanticProgramIndex, path: string): string {
  const file = spi.files.find((f) => f.path === path)
  if (!file) throw new Error(`fixture missing SpiFile: ${path}\nhad: ${spi.files.map((f) => f.path).join(', ')}`)
  return file.id
}

function coveredBy(spi: SemanticProgramIndex, sourcePath: string, testPath: string): SpiEdge | undefined {
  const sourceId = fileIdFor(spi, sourcePath)
  const testId = fileIdFor(spi, testPath)
  return spi.edges.find((e) => e.from === sourceId && e.to === testId && e.kind === 'covered_by')
}

describe('isTestFilePath', () => {
  it('recognizes the standard spec/test naming patterns', () => {
    expect(isTestFilePath('src/foo.spec.ts')).toBe(true)
    expect(isTestFilePath('src/foo.test.ts')).toBe(true)
    expect(isTestFilePath('src/foo.spec.tsx')).toBe(true)
    expect(isTestFilePath('src/foo.spec.js')).toBe(true)
    expect(isTestFilePath('src/foo.test.mjs')).toBe(true)
  })

  it('recognizes files inside a __tests__ directory', () => {
    expect(isTestFilePath('src/__tests__/foo.ts')).toBe(true)
    expect(isTestFilePath('packages/auth/__tests__/login.ts')).toBe(true)
  })

  it('does not flag plain source files as tests', () => {
    expect(isTestFilePath('src/foo.ts')).toBe(false)
    expect(isTestFilePath('src/specifications.ts')).toBe(false) // contains "spec" but not as suffix
    expect(isTestFilePath('src/test-utils.ts')).toBe(false) // "test-" is not the suffix
  })
})

describe('buildSpi test layer (slice 3c of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('confidence rules', () => {
    it('emits a high-confidence covered_by edge when the test file name matches the source file', () => {
      writeFile(sandbox, 'src/auth.ts', 'export function login() {}\n')
      writeFile(sandbox, 'src/auth.spec.ts', 'import { login } from "./auth.js"\nlogin()\n')
      const spi = build(sandbox)

      const edge = coveredBy(spi, 'src/auth.ts', 'src/auth.spec.ts')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('heuristic')
    })

    it('emits a medium-confidence edge when the test imports the source but the names do not match', () => {
      writeFile(sandbox, 'src/util.ts', 'export const helper = 1\n')
      writeFile(sandbox, 'src/integration.spec.ts', 'import { helper } from "./util.js"\nhelper\n')
      const spi = build(sandbox)

      const edge = coveredBy(spi, 'src/util.ts', 'src/integration.spec.ts')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('medium')
    })

    it('promotes confidence to high for __tests__ siblings (foo.ts ↔ __tests__/foo.spec.ts)', () => {
      writeFile(sandbox, 'src/auth/auth.ts', 'export function login() {}\n')
      writeFile(sandbox, 'src/auth/__tests__/auth.spec.ts', 'import { login } from "../auth.js"\nlogin()\n')
      const spi = build(sandbox)

      const edge = coveredBy(spi, 'src/auth/auth.ts', 'src/auth/__tests__/auth.spec.ts')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
    })

    it('handles .test.ts naming alongside .spec.ts', () => {
      writeFile(sandbox, 'src/utils.ts', 'export const u = 1\n')
      writeFile(sandbox, 'src/utils.test.ts', 'import { u } from "./utils.js"\nu\n')
      const spi = build(sandbox)

      const edge = coveredBy(spi, 'src/utils.ts', 'src/utils.test.ts')
      expect(edge?.confidence).toBe('high')
    })
  })

  describe('what does NOT get a covered_by edge', () => {
    it('does not emit an edge from a test file to itself (test importing test)', () => {
      writeFile(sandbox, 'src/helpers.spec.ts', 'export function makeMock() {}\n')
      writeFile(sandbox, 'src/auth.spec.ts', 'import { makeMock } from "./helpers.spec.js"\nmakeMock()\n')
      const spi = build(sandbox)

      const helpers = fileIdFor(spi, 'src/helpers.spec.ts')
      const edges = spi.edges.filter((e) => e.from === helpers && e.kind === 'covered_by')
      expect(edges).toHaveLength(0)
    })

    it('does not emit covered_by for source files that no test imports', () => {
      writeFile(sandbox, 'src/lonely.ts', 'export const lonely = 1\n')
      writeFile(sandbox, 'src/other.spec.ts', 'export const t = 1\n') // imports nothing
      const spi = build(sandbox)

      const lonely = fileIdFor(spi, 'src/lonely.ts')
      const edges = spi.edges.filter((e) => e.from === lonely && e.kind === 'covered_by')
      expect(edges).toHaveLength(0)
    })

    it('does not double-emit when a test imports the same source twice', () => {
      writeFile(sandbox, 'src/svc.ts', 'export const a = 1\nexport const b = 2\n')
      writeFile(sandbox, 'src/svc.spec.ts', [
        'import { a } from "./svc.js"',
        'import { b } from "./svc.js"',  // different specifier, same module
        'a; b;',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const svc = fileIdFor(spi, 'src/svc.ts')
      const test = fileIdFor(spi, 'src/svc.spec.ts')
      const edges = spi.edges.filter((e) => e.from === svc && e.to === test && e.kind === 'covered_by')
      expect(edges).toHaveLength(1)
    })
  })

  describe('integration with the type checker pass', () => {
    it('does not produce a spurious calls edge from test imports interfering with the type checker', () => {
      // Sanity check: adding the test layer must not break the call-edge
      // resolution we already verified in slice 2a's tests.
      writeFile(sandbox, 'src/svc.ts', [
        'export function helper() { return 1 }',
        'export function caller() { return helper() }',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/svc.spec.ts', 'import { caller } from "./svc.js"\ncaller()\n')
      const spi = build(sandbox)

      // Both layers' edges should coexist on the same SPI.
      const callEdges = spi.edges.filter((e) => e.kind === 'calls')
      const coveredEdges = spi.edges.filter((e) => e.kind === 'covered_by')
      expect(callEdges.length).toBeGreaterThan(0)
      expect(coveredEdges.length).toBeGreaterThan(0)
    })
  })

  describe('against the checked-in demo repo', () => {
    it('does not crash on a workspace with no test files (demo-repo currently has none)', () => {
      // This is regression protection: addTestLayerEdges must early-return
      // gracefully when there are no test files in the index.
      const root = join(__dirname, '../../examples/demo-repo')
      const spi = buildSpi({ root, madarVersion: 'test-0.0.0', now: FROZEN_NOW })
      const coveredEdges = spi.edges.filter((e) => e.kind === 'covered_by')
      // Demo repo currently has no spec/test files; expect zero covered_by.
      // If/when fixtures gain tests, this should be relaxed to >= 0.
      expect(coveredEdges).toHaveLength(0)
    })
  })
})
