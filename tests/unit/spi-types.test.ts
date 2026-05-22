import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type {
  SemanticProgramIndex,
  SpiEdge,
  SpiSymbol,
  SpiSymbolKind,
} from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-types-'))
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
    extractorVersion: 'spi-v1.0.0-slice-2b',
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

function typeEdge(spi: SemanticProgramIndex, fromId: string, kind: SpiEdge['kind'], toId: string): SpiEdge | undefined {
  return spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === kind)
}

describe('buildSpi type layer (slice 2b of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('class extends and implements', () => {
    it('emits an extends edge from a derived class to its parent class', () => {
      writeFile(sandbox, 'src/h.ts', [
        'export class Animal {}',
        'export class Dog extends Animal {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const dog = findSymbol(spi, 'src/h.ts', 'Dog', 'class')
      const animal = findSymbol(spi, 'src/h.ts', 'Animal', 'class')
      const edge = typeEdge(spi, dog.id, 'extends', animal.id)
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('typescript-semantic')
    })

    it('emits an implements edge from a class to each implemented interface', () => {
      writeFile(sandbox, 'src/i.ts', [
        'export interface Logger { log(msg: string): void }',
        'export interface Sink { flush(): void }',
        'export class ConsoleLogger implements Logger, Sink {',
        '  log(_msg: string) {}',
        '  flush() {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/i.ts', 'ConsoleLogger', 'class')
      const logger = findSymbol(spi, 'src/i.ts', 'Logger', 'interface')
      const sink = findSymbol(spi, 'src/i.ts', 'Sink', 'interface')
      expect(typeEdge(spi, cls.id, 'implements', logger.id)).toBeTruthy()
      expect(typeEdge(spi, cls.id, 'implements', sink.id)).toBeTruthy()
    })

    it('does not emit extends/implements edges for external (lib.dom) types', () => {
      writeFile(sandbox, 'src/x.ts', [
        'export class MyError extends Error {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/x.ts', 'MyError', 'class')
      // Error lives in lib.es5.d.ts → outside our SPI → no edge.
      const extendsEdges = spi.edges.filter((e) => e.from === cls.id && e.kind === 'extends')
      expect(extendsEdges).toHaveLength(0)
    })
  })

  describe('interface extends interface', () => {
    it('emits extends edges between interfaces (single and multiple parents)', () => {
      writeFile(sandbox, 'src/iface.ts', [
        'export interface Shape { area(): number }',
        'export interface Drawable { draw(): void }',
        'export interface Polygon extends Shape, Drawable {',
        '  sides(): number',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const polygon = findSymbol(spi, 'src/iface.ts', 'Polygon', 'interface')
      const shape = findSymbol(spi, 'src/iface.ts', 'Shape', 'interface')
      const drawable = findSymbol(spi, 'src/iface.ts', 'Drawable', 'interface')
      expect(typeEdge(spi, polygon.id, 'extends', shape.id)).toBeTruthy()
      expect(typeEdge(spi, polygon.id, 'extends', drawable.id)).toBeTruthy()
    })
  })

  describe('function/method param_type and return_type', () => {
    it('emits param_type and return_type edges for an exported function', () => {
      writeFile(sandbox, 'src/fn.ts', [
        'export interface User { id: string }',
        'export interface Session { token: string }',
        'export function login(user: User): Session {',
        '  return { token: user.id }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const login = findSymbol(spi, 'src/fn.ts', 'login', 'function')
      const user = findSymbol(spi, 'src/fn.ts', 'User', 'interface')
      const session = findSymbol(spi, 'src/fn.ts', 'Session', 'interface')
      expect(typeEdge(spi, login.id, 'param_type', user.id)).toBeTruthy()
      expect(typeEdge(spi, login.id, 'return_type', session.id)).toBeTruthy()
    })

    it('emits type edges for class methods', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'export interface Request { url: string }',
        'export interface Response { status: number }',
        'export class Handler {',
        '  handle(req: Request): Response { return { status: 200 } }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const method = findSymbol(spi, 'src/svc.ts', 'Handler.handle', 'method')
      const req = findSymbol(spi, 'src/svc.ts', 'Request', 'interface')
      const res = findSymbol(spi, 'src/svc.ts', 'Response', 'interface')
      expect(typeEdge(spi, method.id, 'param_type', req.id)).toBeTruthy()
      expect(typeEdge(spi, method.id, 'return_type', res.id)).toBeTruthy()
    })

    it('skips builtin types (string, number, void) and inline object types', () => {
      writeFile(sandbox, 'src/b.ts', [
        'export function plain(a: string, b: number): boolean { return a.length > b }',
        'export function inlineObj(arg: { x: number }): { y: number } { return { y: arg.x } }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const plainFn = findSymbol(spi, 'src/b.ts', 'plain', 'function')
      const inlineFn = findSymbol(spi, 'src/b.ts', 'inlineObj', 'function')
      // No type edges should land for either of these — string/number/boolean
      // are builtins, and inline object literal types don't map to a SpiSymbol.
      expect(spi.edges.filter((e) => e.from === plainFn.id && (e.kind === 'param_type' || e.kind === 'return_type'))).toHaveLength(0)
      expect(spi.edges.filter((e) => e.from === inlineFn.id && (e.kind === 'param_type' || e.kind === 'return_type'))).toHaveLength(0)
    })

    it('resolves a type alias used as a return annotation', () => {
      writeFile(sandbox, 'src/al.ts', [
        'export type UserId = string',
        'export function makeId(): UserId { return "u" }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const fn = findSymbol(spi, 'src/al.ts', 'makeId', 'function')
      const alias = findSymbol(spi, 'src/al.ts', 'UserId', 'type-alias')
      expect(typeEdge(spi, fn.id, 'return_type', alias.id)).toBeTruthy()
    })
  })

  describe('cross-file resolution', () => {
    it('resolves param_type / return_type across files', () => {
      writeFile(sandbox, 'src/types.ts', 'export interface Payload { data: string }\n')
      writeFile(sandbox, 'src/handler.ts', [
        'import type { Payload } from "./types.js"',
        'export function handle(p: Payload): Payload { return p }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handle = findSymbol(spi, 'src/handler.ts', 'handle', 'function')
      const payload = findSymbol(spi, 'src/types.ts', 'Payload', 'interface')
      expect(typeEdge(spi, handle.id, 'param_type', payload.id)).toBeTruthy()
      expect(typeEdge(spi, handle.id, 'return_type', payload.id)).toBeTruthy()
    })
  })

  describe('deduplication', () => {
    it('emits at most one edge per (from, to, kind) tuple even when the type appears multiple times', () => {
      writeFile(sandbox, 'src/dup.ts', [
        'export interface T { v: number }',
        'export function f(a: T, b: T, c: T): T { return a }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const fn = findSymbol(spi, 'src/dup.ts', 'f', 'function')
      const t = findSymbol(spi, 'src/dup.ts', 'T', 'interface')
      const params = spi.edges.filter((e) => e.from === fn.id && e.to === t.id && e.kind === 'param_type')
      expect(params).toHaveLength(1)
    })
  })

  describe('against the checked-in demo repo', () => {
    it('emits at least one type edge that points at a demo-repo SpiSymbol', () => {
      const root = pathResolve(__dirname, '../../examples/demo-repo')
      const spi = buildSpi({ root, sadeemVersion: 'test-0.0.0', now: FROZEN_NOW })

      const ourIds = new Set(spi.symbols.map((s) => s.id))
      const typeKinds = new Set<SpiEdge['kind']>(['extends', 'implements', 'param_type', 'return_type'])
      const typeEdges = spi.edges.filter((e) => typeKinds.has(e.kind))

      expect(typeEdges.length).toBeGreaterThan(0)
      // Every emitted type edge must point at a real SpiSymbol in this index.
      for (const edge of typeEdges) {
        expect(ourIds.has(edge.to)).toBe(true)
        expect(ourIds.has(edge.from)).toBe(true)
        expect(edge.confidence).toBe('high')
        expect(edge.source).toBe('typescript-semantic')
      }
    })
  })
})
