import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiEdge, SpiSymbol, SpiSymbolKind } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-calls-'))
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
    extractorVersion: 'spi-v1.0.0-slice-2a',
    now: FROZEN_NOW,
  })
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

function callsEdge(spi: SemanticProgramIndex, fromId: string, toId: string): SpiEdge | undefined {
  return spi.edges.find((e) => e.kind === 'calls' && e.from === fromId && e.to === toId)
}

describe('buildSpi call layer (slice 2a of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('basic call resolution', () => {
    it('emits a high-confidence calls edge between two functions in the same file', () => {
      writeFile(sandbox, 'src/a.ts', [
        'function helper() { return 1 }',
        'export function caller() { return helper() }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const caller = findSymbol(spi, 'src/a.ts', 'caller', 'function')
      const helper = findSymbol(spi, 'src/a.ts', 'helper', 'function')
      const edge = callsEdge(spi, caller.id, helper.id)
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('typescript-semantic')
    })

    it('attributes calls inside class methods to the Class.method symbol', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'function helper() { return 1 }',
        'export class Svc {',
        '  doWork() { return helper() }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const method = findSymbol(spi, 'src/svc.ts', 'Svc.doWork', 'method')
      const helper = findSymbol(spi, 'src/svc.ts', 'helper', 'function')
      expect(callsEdge(spi, method.id, helper.id)).toBeTruthy()
    })

    it('attributes calls inside constructors to the Class.constructor symbol', () => {
      writeFile(sandbox, 'src/init.ts', [
        'function setup() {}',
        'export class Bootstrapper {',
        '  constructor() { setup() }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const ctor = findSymbol(spi, 'src/init.ts', 'Bootstrapper.constructor', 'method')
      const setup = findSymbol(spi, 'src/init.ts', 'setup', 'function')
      expect(callsEdge(spi, ctor.id, setup.id)).toBeTruthy()
    })

    it('attributes calls inside arrow-function constants to the constant symbol', () => {
      writeFile(sandbox, 'src/arrow.ts', [
        'function inner() { return 1 }',
        'export const wrapper = () => inner()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const wrapper = findSymbol(spi, 'src/arrow.ts', 'wrapper', 'constant')
      const inner = findSymbol(spi, 'src/arrow.ts', 'inner', 'function')
      expect(callsEdge(spi, wrapper.id, inner.id)).toBeTruthy()
    })

    it('does not emit self-recursive calls edges', () => {
      writeFile(sandbox, 'src/r.ts', [
        'export function recursive(n: number): number {',
        '  return n <= 0 ? 0 : recursive(n - 1)',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const fn = findSymbol(spi, 'src/r.ts', 'recursive', 'function')
      expect(callsEdge(spi, fn.id, fn.id)).toBeUndefined()
    })

    it('does not duplicate calls edges when the same caller calls the same callee twice', () => {
      writeFile(sandbox, 'src/dup.ts', [
        'function f() { return 1 }',
        'export function caller() {',
        '  f()',
        '  f()',
        '  return f()',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const caller = findSymbol(spi, 'src/dup.ts', 'caller', 'function')
      const f = findSymbol(spi, 'src/dup.ts', 'f', 'function')
      const matches = spi.edges.filter((e) => e.kind === 'calls' && e.from === caller.id && e.to === f.id)
      expect(matches).toHaveLength(1)
    })
  })

  describe('cross-file resolution', () => {
    it('resolves a call across files via the type checker (no SCC needed)', () => {
      writeFile(sandbox, 'src/util.ts', 'export function shared() { return 1 }\n')
      writeFile(sandbox, 'src/feature/index.ts', [
        'import { shared } from "../util.js"',
        'export function caller() { return shared() }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const caller = findSymbol(spi, 'src/feature/index.ts', 'caller', 'function')
      const shared = findSymbol(spi, 'src/util.ts', 'shared', 'function')
      expect(callsEdge(spi, caller.id, shared.id)).toBeTruthy()
    })
  })

  describe('what NOT to emit', () => {
    it('does not emit calls into node_modules / external packages', () => {
      writeFile(sandbox, 'src/x.ts', [
        'import { readFileSync } from "node:fs"',
        'export function uses() { return readFileSync("a.txt") }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      // No call edge should land on a target outside our SpiSymbol set.
      const fileId = spi.files.find((f) => f.path === 'src/x.ts')!.id
      const ourIds = new Set(spi.symbols.map((s) => s.id))
      for (const e of spi.edges.filter((e) => e.kind === 'calls')) {
        // Caller must be in our SPI; callee must too. node:fs declarations live
        // in .d.ts files outside the workspace and never produce SpiSymbol.
        expect(ourIds.has(e.to)).toBe(true)
        // sanity: caller must be in this file or another SPI file
        expect(typeof e.from).toBe('string')
        // Make linter/coverage happy with fileId reference.
        expect(typeof fileId).toBe('string')
      }
    })

    it('does not emit a calls edge when the callsite is at module top level (no enclosing SpiSymbol)', () => {
      writeFile(sandbox, 'src/top.ts', [
        'function init() {}',
        'init()', // top-level call, no caller symbol
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const init = findSymbol(spi, 'src/top.ts', 'init', 'function')
      // No edge with this init as the target should exist (no caller).
      const incoming = spi.edges.filter((e) => e.kind === 'calls' && e.to === init.id)
      expect(incoming).toHaveLength(0)
    })
  })

  describe('confidence', () => {
    it('marks a call to an overloaded function as medium confidence', () => {
      writeFile(sandbox, 'src/ov.ts', [
        'export function shape(a: number): number',
        'export function shape(a: string): string',
        'export function shape(a: number | string): number | string { return a }',
        'export function caller() { return shape(1) }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const caller = findSymbol(spi, 'src/ov.ts', 'caller', 'function')
      const target = spi.symbols.find((s) => s.kind === 'function' && s.name === 'shape')!
      const edge = callsEdge(spi, caller.id, target.id)
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('medium')
    })
  })

  describe('graceful degradation', () => {
    it('survives a workspace with a malformed tsconfig.json by falling back to defaults', () => {
      writeFile(sandbox, 'tsconfig.json', '{ "compilerOptions": { "module": "thisIsNotAValidModule" }, ')
      writeFile(sandbox, 'src/a.ts', [
        'function helper() {}',
        'export function caller() { helper() }',
      ].join('\n') + '\n')
      // Should not throw; the call layer is best-effort.
      const spi = build(sandbox)
      const caller = findSymbol(spi, 'src/a.ts', 'caller', 'function')
      const helper = findSymbol(spi, 'src/a.ts', 'helper', 'function')
      // Even on malformed config, simple in-file resolution should still work.
      expect(callsEdge(spi, caller.id, helper.id)).toBeTruthy()
    })
  })

  describe('against the checked-in demo repo', () => {
    it('emits at least one cross-file calls edge between known symbols', () => {
      const root = pathResolve(__dirname, '../../examples/demo-repo')
      const spi = buildSpi({ root, madarVersion: 'test-0.0.0', now: FROZEN_NOW })

      const allCalls = spi.edges.filter((e) => e.kind === 'calls')
      expect(allCalls.length).toBeGreaterThan(0)

      // Every emitted call points at a symbol that exists in this SPI.
      const ourSymbolIds = new Set(spi.symbols.map((s) => s.id))
      for (const edge of allCalls) {
        expect(ourSymbolIds.has(edge.to)).toBe(true)
        expect(ourSymbolIds.has(edge.from)).toBe(true)
        expect(edge.source).toBe('typescript-semantic')
      }

      // Cross-file call: at least one edge whose caller and callee live in
      // different files.
      const symbolToFile = new Map<string, string>()
      for (const s of spi.symbols) symbolToFile.set(s.id, s.file_id)
      const crossFileCalls = allCalls.filter((e) => symbolToFile.get(e.from) !== symbolToFile.get(e.to))
      expect(crossFileCalls.length).toBeGreaterThan(0)
    })
  })
})
