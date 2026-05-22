import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type {
  SemanticProgramIndex,
  SpiSymbol,
  SpiSymbolKind,
} from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-symbols-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    sadeemVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-1b',
    now: FROZEN_NOW,
  })
}

function symbolsIn(spi: SemanticProgramIndex, filePath: string): SpiSymbol[] {
  const file = spi.files.find((f) => f.path === filePath)
  if (!file) throw new Error(`fixture missing SpiFile: ${filePath}`)
  return spi.symbols.filter((s) => s.file_id === file.id)
}

function findSymbol(spi: SemanticProgramIndex, filePath: string, name: string, kind: SpiSymbolKind): SpiSymbol {
  const matches = symbolsIn(spi, filePath).filter((s) => s.name === name && s.kind === kind)
  if (matches.length === 0) {
    const inFile = symbolsIn(spi, filePath).map((s) => `${s.kind} ${s.name}`).join(', ')
    throw new Error(`fixture missing SpiSymbol ${kind} ${name} in ${filePath}\nhad: ${inFile}`)
  }
  if (matches.length > 1) {
    throw new Error(`expected exactly one ${kind} ${name} in ${filePath}; got ${matches.length}`)
  }
  return matches[0]!
}

describe('buildSpi symbol layer (slice 1b of #72)', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('symbol kinds', () => {
    it('emits one SpiSymbol per top-level declaration form', () => {
      writeFile(sandbox, 'src/all-kinds.ts', [
        'export function fn() {}',
        'export class Cls {}',
        'export interface Iface { x: number }',
        'export type Alias = number',
        'export enum Enm { Z }',
        'export const constant = 1',
        'export let variable = 1',
        'export namespace Ns {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const all = symbolsIn(spi, 'src/all-kinds.ts')
      const byKind = new Map<SpiSymbolKind, SpiSymbol>()
      for (const s of all) byKind.set(s.kind, s)

      expect(byKind.get('function')?.name).toBe('fn')
      expect(byKind.get('class')?.name).toBe('Cls')
      expect(byKind.get('interface')?.name).toBe('Iface')
      expect(byKind.get('type-alias')?.name).toBe('Alias')
      expect(byKind.get('enum')?.name).toBe('Enm')
      expect(byKind.get('constant')?.name).toBe('constant')
      expect(byKind.get('variable')?.name).toBe('variable')
      expect(byKind.get('namespace')?.name).toBe('Ns')
      // Every top-level declaration was exported in the fixture.
      for (const symbol of all) {
        expect(symbol.exported).toBe(true)
      }
    })

    it('marks unexported declarations with exported: false', () => {
      writeFile(sandbox, 'src/private.ts', [
        'function notExported() {}',
        'class AlsoNot {}',
        'export const yes = 1',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/private.ts', 'notExported', 'function').exported).toBe(false)
      expect(findSymbol(spi, 'src/private.ts', 'AlsoNot', 'class').exported).toBe(false)
      expect(findSymbol(spi, 'src/private.ts', 'yes', 'constant').exported).toBe(true)
    })

    it('distinguishes const from let/var on variable statements', () => {
      writeFile(sandbox, 'src/vars.ts', [
        'const a = 1',
        'let b = 2',
        'var c = 3',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/vars.ts', 'a', 'constant')).toBeTruthy()
      expect(findSymbol(spi, 'src/vars.ts', 'b', 'variable')).toBeTruthy()
      expect(findSymbol(spi, 'src/vars.ts', 'c', 'variable')).toBeTruthy()
    })

    it('emits one SpiSymbol per declarator in a multi-name variable statement', () => {
      writeFile(sandbox, 'src/multi.ts', 'export const a = 1, b = 2, c = 3\n')
      const spi = build(sandbox)
      const constants = symbolsIn(spi, 'src/multi.ts').filter((s) => s.kind === 'constant')
      expect(constants.map((s) => s.name).sort()).toEqual(['a', 'b', 'c'])
      for (const c of constants) expect(c.exported).toBe(true)
    })

    it('skips destructured variable declarations (deferred to slice 2)', () => {
      writeFile(sandbox, 'src/destructure.ts', [
        'const { a, b } = { a: 1, b: 2 }',
        'export const visible = 1',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const constants = symbolsIn(spi, 'src/destructure.ts').filter((s) => s.kind === 'constant')
      expect(constants.map((s) => s.name)).toEqual(['visible'])
    })

    it('skips external module augmentations (declare module "string-name")', () => {
      writeFile(sandbox, 'src/aug.ts', [
        'declare module "external-pkg" { interface Foo {} }',
        'export namespace Real {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const namespaces = symbolsIn(spi, 'src/aug.ts').filter((s) => s.kind === 'namespace')
      expect(namespaces.map((s) => s.name)).toEqual(['Real'])
    })

    it('does not enumerate namespace members in v1 (slice 2 expansion)', () => {
      writeFile(sandbox, 'src/ns.ts', [
        'export namespace Outer {',
        '  export function inside() {}',
        '  export class Inner {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const all = symbolsIn(spi, 'src/ns.ts').map((s) => `${s.kind} ${s.name}`)
      expect(all).toEqual(['namespace Outer'])
    })
  })

  describe('class methods', () => {
    it('emits a method symbol per class member with qualified Class.method names', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'export class AuthService {',
        '  constructor() {}',
        '  login(user: string) { return user }',
        '  logout() {}',
        '  get current() { return null }',
        '  set current(_v: unknown) {}',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const methods = symbolsIn(spi, 'src/svc.ts').filter((s) => s.kind === 'method')
      // Note: the getter and setter for `current` collide on name and produce
      // method-overload IDs; both should still be emitted.
      const names = methods.map((m) => m.name).sort()
      expect(names).toEqual([
        'AuthService.constructor',
        'AuthService.current',
        'AuthService.current',
        'AuthService.login',
        'AuthService.logout',
      ])
    })

    it('appends #1, #2 suffixes to overloaded method IDs in source order', () => {
      writeFile(sandbox, 'src/overloads.ts', [
        'export class Foo {',
        '  bar(a: number): number',
        '  bar(a: string): string',
        '  bar(a: number | string): number | string { return a }',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const ids = symbolsIn(spi, 'src/overloads.ts')
        .filter((s) => s.kind === 'method' && s.name === 'Foo.bar')
        .map((s) => s.id)
        .sort()
      expect(ids).toHaveLength(3)
      // First overload has the bare base id; subsequent get #1, #2 suffixes.
      const base = ids.find((id) => !id.includes('#'))
      expect(base).toBeTruthy()
      expect(ids.some((id) => id.endsWith('#1'))).toBe(true)
      expect(ids.some((id) => id.endsWith('#2'))).toBe(true)
    })
  })

  describe('declares edges', () => {
    it('emits a high-confidence declares edge from file -> every emitted symbol', () => {
      writeFile(sandbox, 'src/d.ts', [
        'export function alpha() {}',
        'export class Beta {',
        '  gamma() {}',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const file = spi.files.find((f) => f.path === 'src/d.ts')!
      const fileSymbols = symbolsIn(spi, 'src/d.ts')
      const declares = spi.edges.filter((e) => e.from === file.id && e.kind === 'declares')

      // One declares edge per symbol in this file, no extras.
      expect(declares).toHaveLength(fileSymbols.length)
      for (const edge of declares) {
        expect(edge.confidence).toBe('high')
        expect(edge.source).toBe('typescript-syntactic')
        expect(edge.evidence?.file_id).toBe(file.id)
        // Edge target must point at a real SpiSymbol id.
        expect(fileSymbols.some((s) => s.id === edge.to)).toBe(true)
      }
    })
  })

  describe('range and ID stability', () => {
    it('mints stable IDs that survive in-file reordering as long as path/kind/name are stable', { timeout: 30_000 }, () => {
      writeFile(sandbox, 'src/order.ts', [
        'export function a() {}',
        'export function b() {}',
      ].join('\n') + '\n')
      const first = build(sandbox)
      const idA1 = findSymbol(first, 'src/order.ts', 'a', 'function').id
      const idB1 = findSymbol(first, 'src/order.ts', 'b', 'function').id

      // Reorder the declarations; same names + same file path => same IDs.
      writeFile(sandbox, 'src/order.ts', [
        'export function b() {}',
        'export function a() {}',
      ].join('\n') + '\n')
      const second = build(sandbox)
      expect(findSymbol(second, 'src/order.ts', 'a', 'function').id).toBe(idA1)
      expect(findSymbol(second, 'src/order.ts', 'b', 'function').id).toBe(idB1)
    })

    it('captures one-based line/column ranges for every symbol', () => {
      writeFile(sandbox, 'src/r.ts', 'export function fn() {\n  return 1\n}\n')
      const spi = build(sandbox)
      const fn = findSymbol(spi, 'src/r.ts', 'fn', 'function')
      expect(fn.range.start.line).toBe(1)
      expect(fn.range.start.column).toBe(1)
      expect(fn.range.end.line).toBeGreaterThanOrEqual(3)
    })

    it('produces a stable, sorted symbol list across two runs of the same workspace', { timeout: 30_000 }, () => {
      writeFile(sandbox, 'src/a.ts', 'export const a = 1\n')
      writeFile(sandbox, 'src/b.ts', 'export class B {\n  one() {}\n  two() {}\n}\n')
      const first = build(sandbox)
      const second = build(sandbox)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })
  })

  describe('against the checked-in demo repo', () => {
    it('emits multiple symbols per source file with declares edges and no error diagnostics', () => {
      const root = pathResolve(__dirname, '../../examples/demo-repo')
      const spi = buildSpi({ root, sadeemVersion: 'test-0.0.0', now: FROZEN_NOW })

      // Demo repo has classes/functions across several modules; expect at
      // least one symbol per source file.
      expect(spi.symbols.length).toBeGreaterThan(spi.files.length)

      // Spot-check a known class in the auth module.
      const auth = symbolsIn(spi, 'src/auth/auth-service.ts')
      const authClass = auth.find((s) => s.kind === 'class')
      expect(authClass?.name).toBe('AuthService')
      // It should have at least one declared method.
      expect(auth.some((s) => s.kind === 'method' && s.name.startsWith('AuthService.'))).toBe(true)

      // Every symbol must have a matching declares edge.
      for (const symbol of spi.symbols) {
        expect(spi.edges.some((e) => e.from === symbol.file_id && e.to === symbol.id && e.kind === 'declares')).toBe(true)
      }

      expect(spi.diagnostics.filter((d) => d.level === 'error')).toHaveLength(0)
    })
  })
})
