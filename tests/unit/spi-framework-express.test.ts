import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-express-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    graphifyVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-1c-ii.b',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI Express framework detector (slice 1c-ii.b)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('app factory detection', () => {
    it('tags `const app = express()` with framework_role express_app via default import', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })

    it('tags `const app = express.default()` via named-default import', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import { default as expressFactory } from "express"',
        'export const app = expressFactory()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })

    it('tags `const app = e()` via namespace import alias', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import * as e from "express"',
        'export const app = e.default()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })
  })

  describe('router factory detection', () => {
    it('tags `const router = Router()` via named import', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/routes.ts', 'router')
      expect(sym?.framework_role).toBe('express_router')
    })

    it('tags `const router = e.Router()` via namespace alias', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import * as e from "express"',
        'export const router = e.Router()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/routes.ts', 'router')
      expect(sym?.framework_role).toBe('express_router')
    })
  })

  describe('non-Express files', () => {
    it('does not tag variables in files that do not import express', () => {
      writeFile(sandbox, 'src/plain.ts', [
        'function notExpress(): { use: () => void } { return { use: () => {} } }',
        'export const app = notExpress()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/plain.ts', 'app')
      expect(sym?.framework_role).toBeUndefined()
    })

    it('does not tag variables when express is imported but not used as a factory', () => {
      writeFile(sandbox, 'src/types.ts', [
        'import type { Application } from "express"',
        'export const app: Application | null = null',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/types.ts', 'app')
      // Type-only imports skip the bindings collector entirely.
      expect(sym?.framework_role).toBeUndefined()
    })
  })

  describe('route detection (slice 1c-ii.c)', () => {
    it('tags a named handler referenced by app.get() with framework_role=express_route', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(req: unknown, res: unknown): void { void req; void res }',
        'app.get("/users", listUsers)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      expect(handler?.framework_role).toBe('express_route')
    })

    it('emits a route_handler edge from the express binding to the handler', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(req: unknown, res: unknown): void { void req; void res }',
        'app.get("/users", listUsers)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/server.ts', 'app')
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      const edge = spi.edges.find((e) => e.from === app?.id && e.to === handler?.id && e.kind === 'route_handler')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('framework-decorator')
    })

    it('detects every standard HTTP route method', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function a(): void {}',
        'export function b(): void {}',
        'export function c(): void {}',
        'export function d(): void {}',
        'export function e(): void {}',
        'export function f(): void {}',
        'export function g(): void {}',
        'export function h(): void {}',
        'app.get("/a", a)',
        'app.post("/b", b)',
        'app.put("/c", c)',
        'app.patch("/d", d)',
        'app.delete("/e", e)',
        'app.all("/f", f)',
        'app.options("/g", g)',
        'app.head("/h", h)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/server.ts', 'app')
      const routeEdges = spi.edges.filter((edge) => edge.from === app?.id && edge.kind === 'route_handler')
      expect(routeEdges).toHaveLength(8)
    })

    it('works for router.<method> too (router from express.Router())', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
        'export function listUsers(): void {}',
        'router.get("/users", listUsers)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/routes.ts', 'listUsers')
      expect(handler?.framework_role).toBe('express_route')
    })

    it('does not tag handlers when the receiver is not an express binding', () => {
      writeFile(sandbox, 'src/server.ts', [
        'function notExpress(): { get: (path: string, fn: () => void) => void } {',
        '  return { get: (_path, _fn) => {} }',
        '}',
        'const fakeApp = notExpress()',
        'export function handler(): void {}',
        'fakeApp.get("/x", handler)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'handler')
      expect(handler?.framework_role).toBeUndefined()
    })

    it('skips inline arrow handlers (deferred to slice 1c-ii.e)', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'app.get("/x", (_req, _res) => { void 0 })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/server.ts', 'app')
      const routeEdges = spi.edges.filter((edge) => edge.from === app?.id && edge.kind === 'route_handler')
      // No named handler symbol → no edge emitted in this slice.
      expect(routeEdges).toHaveLength(0)
    })

    it('does NOT tag the outer handler when a lexical shadow uses the same identifier (CodeRabbit fix)', () => {
      // Critical correctness regression: an inner scope that shadows
      // either the receiver (`const app = { get: ... }`) or the handler
      // (`const handler = ...`) must not cause the OUTER express_app and
      // OUTER handler symbols to be treated as a route registration. The
      // detector compares the receiver's resolved declaration to the
      // tagged binding declaration, and only accepts top-level handler
      // declarations.
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function handler(): void {}',
        'function setup(): void {',
        '  const app = { get: (_p: string, _h: () => void): void => {} }',
        '  const handler = (): void => {}',
        '  app.get("/x", handler)',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const outerApp = findSymbol(spi, 'src/server.ts', 'app')
      const outerHandler = findSymbol(spi, 'src/server.ts', 'handler')
      // Neither the outer handler should be tagged express_route, nor
      // should there be any route_handler edge from the outer app to
      // the outer handler. The shadowed inner call resolves to the
      // local `app` and `handler`, neither of which is in the SPI.
      expect(outerHandler?.framework_role).toBeUndefined()
      const edges = spi.edges.filter((e) =>
        e.from === outerApp?.id && e.to === outerHandler?.id && e.kind === 'route_handler',
      )
      expect(edges).toHaveLength(0)
    })

    it('dedupes route_handler edges when the same handler is registered on multiple paths', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function handler(): void {}',
        'app.get("/a", handler)',
        'app.get("/alias", handler)',
        'app.post("/a", handler)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/server.ts', 'app')
      const handler = findSymbol(spi, 'src/server.ts', 'handler')
      const routeEdges = spi.edges.filter((e) => e.from === app?.id && e.to === handler?.id && e.kind === 'route_handler')
      expect(routeEdges).toHaveLength(1)
    })
  })

  describe('middleware detection (slice 1c-ii.d)', () => {
    it('tags app.use(middleware) handler with express_middleware', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function logger(_req: unknown, _res: unknown, next: () => void): void { next() }',
        'app.use(logger)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'logger')
      expect(handler?.framework_role).toBe('express_middleware')
    })

    it('skips the optional path-prefix string argument', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function authMiddleware(): void {}',
        'app.use("/api", authMiddleware)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'authMiddleware')
      expect(handler?.framework_role).toBe('express_middleware')
    })

    it('tags every middleware in a chain `app.use(mw1, mw2, mw3)`', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function mw1(): void {}',
        'export function mw2(): void {}',
        'export function mw3(): void {}',
        'app.use(mw1, mw2, mw3)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/server.ts', 'mw1')?.framework_role).toBe('express_middleware')
      expect(findSymbol(spi, 'src/server.ts', 'mw2')?.framework_role).toBe('express_middleware')
      expect(findSymbol(spi, 'src/server.ts', 'mw3')?.framework_role).toBe('express_middleware')
    })

    it('tags `router.use(...)` middleware too', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
        'export function middleware(): void {}',
        'router.use(middleware)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/routes.ts', 'middleware')
      expect(handler?.framework_role).toBe('express_middleware')
    })

    it('does not emit a route_handler edge for `use` calls (middleware ≠ route)', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function logger(): void {}',
        'app.use(logger)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/server.ts', 'app')
      const logger = findSymbol(spi, 'src/server.ts', 'logger')
      const edges = spi.edges.filter((e) =>
        e.from === app?.id && e.to === logger?.id && e.kind === 'route_handler',
      )
      expect(edges).toHaveLength(0)
    })

    it('does not downgrade an express_route tag to express_middleware when a fn is used as both', () => {
      // A handler used as a route AND as middleware should retain its
      // route tag — route is the more semantic role. (Convention: route
      // wins; middleware is the fallback.)
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function dual(): void {}',
        'app.get("/x", dual)',
        'app.use(dual)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const dual = findSymbol(spi, 'src/server.ts', 'dual')
      expect(dual?.framework_role).toBe('express_route')
    })

    it('does not tag inline arrow middleware (deferred to slice 1c-ii.e)', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'app.use((_req, _res, next) => next())',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      // No top-level handler symbol exists for the arrow, so nothing to
      // tag. The detector silently skips. Sanity: no shadow false-tags.
      const allFunctionSymbols = spi.symbols.filter((s) => s.framework_role === 'express_middleware')
      expect(allFunctionSymbols).toHaveLength(0)
    })

    it('does not tag handlers when the receiver is a shadowed local `app`', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function outerMiddleware(): void {}',
        'function setup(): void {',
        '  const app = { use: (_h: () => void): void => {} }',
        '  app.use(outerMiddleware)',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const outer = findSymbol(spi, 'src/server.ts', 'outerMiddleware')
      // The shadowed inner `app.use(outerMiddleware)` resolves the
      // receiver to the LOCAL `const app`, not the outer express()
      // binding. The detector's declaration-identity check rejects it.
      expect(outer?.framework_role).toBeUndefined()
    })
  })

  describe('projector — framework propagation through to ExtractionNode', () => {
    it('an express_app variable surfaces with framework=express on the projected ExtractionNode', async () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
      ].join('\n') + '\n')
      // Lazy-import projector to avoid pulling extraction-side deps for
      // tests that only need the SPI substrate.
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'app')
      expect(node?.framework).toBe('express')
      expect(node?.framework_role).toBe('express_app')
      expect(node?.node_kind).toBe('function')
    })

    it('an express_router variable projects with node_kind=router', async () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'router')
      expect(node?.framework).toBe('express')
      expect(node?.framework_role).toBe('express_router')
      expect(node?.node_kind).toBe('router')
    })
  })
})
