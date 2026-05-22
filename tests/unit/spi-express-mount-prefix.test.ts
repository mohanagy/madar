import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-express-mount-tests-'))
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
    extractorVersion: 'spi-v1.0.0-slice-1c-ii.g',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI Express mount-prefix resolution (slice 1c-ii.g)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('same-file mount', () => {
    it('prefixes a route registered on a router mounted via app.use', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/", listUsers)',
        'app.use("/api/users", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      // Trailing-slash normalization (slice 1c-ii.i): router-root '/'
      // collapses to the bare mount prefix, matching the legacy
      // extractor's emission. The router's own mount_path is still
      // recorded literally on the router symbol.
      expect(handler?.framework_metadata?.route_path).toBe('/api/users')
    })

    it('works when the mount call appears BEFORE the route registration', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'app.use("/api/users", usersRouter)',
        'export function listUsers(): void {}',
        'usersRouter.get("/:id", listUsers)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      // The finalizer runs after all per-file detection completes, so
      // declaration order in the source file doesn't affect prefixing.
      expect(handler?.framework_metadata?.route_path).toBe('/api/users/:id')
    })

    it('applies the prefix to inline (synthesized) route handlers too', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'usersRouter.post("/", (_req, _res) => { void 0 })',
        'app.use("/api/users", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const synthetic = spi.symbols.find((s) => s.framework_role === 'express_route' && s.kind === 'function')
      // Trailing-slash normalization (slice 1c-ii.i): same rule as named
      // handlers — router-root '/' collapses to the bare prefix.
      expect(synthetic?.framework_metadata?.route_path).toBe('/api/users')
    })

    it('does not prefix when the router is registered without a path prefix', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/users", listUsers)',
        'app.use(usersRouter)', // no path → no mount_path on router
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      // No mount path captured → finalizer leaves route_path alone.
      expect(handler?.framework_metadata?.route_path).toBe('/users')
    })
  })

  describe('cross-file mount (slice 1c-ii.h)', () => {
    it('prefixes routes when the mount call lives in a different file from the router', () => {
      writeFile(sandbox, 'src/routes/users.ts', [
        'import { Router } from "express"',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/", listUsers)',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'import { usersRouter } from "./routes/users.js"',
        'export const app = express()',
        'app.use("/api/users", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/routes/users.ts', 'listUsers')
      // The detector resolves `usersRouter` in server.ts to its
      // declaration in routes/users.ts via the type checker's
      // alias-following + pathToFileId lookup. mount_path is stamped
      // on the router's SpiSymbol; the workspace-level finalizer then
      // propagates the prefix to all routes registered on that router.
      // Trailing-slash normalization (slice 1c-ii.i): router-root '/'
      // collapses to the bare mount prefix.
      expect(handler?.framework_metadata?.route_path).toBe('/api/users')
    })

    it('handles aliased imports across files (`import { usersRouter as users } from ...`)', () => {
      writeFile(sandbox, 'src/routes/users.ts', [
        'import { Router } from "express"',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/", listUsers)',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'import { usersRouter as users } from "./routes/users.js"',
        'export const app = express()',
        'app.use("/v2", users)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/routes/users.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/v2')
    })

    it('handles default-import re-exported routers (`export default usersRouter`)', () => {
      writeFile(sandbox, 'src/routes/users.ts', [
        'import { Router } from "express"',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/", listUsers)',
        'export default usersRouter',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'import usersRouter from "./routes/users.js"',
        'export const app = express()',
        'app.use("/api", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/routes/users.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/api')
    })

    it('does NOT mis-tag local same-named identifiers in unrelated files', () => {
      // Sanity: a local `usersRouter` const in another file that is NOT
      // an Express router (and NOT imported from the routes file) should
      // not get mount_path stamped just because server.ts has a mount
      // call with the same identifier text.
      writeFile(sandbox, 'src/other.ts', [
        'export const usersRouter = { foo: 1 }',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',  // local router
        'export function listUsers(): void {}',
        'usersRouter.get("/", listUsers)',
        'app.use("/api", usersRouter)',  // mounts the LOCAL router, not src/other.ts's
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const other = findSymbol(spi, 'src/other.ts', 'usersRouter')
      // Other's usersRouter should not be tagged express_router (it's
      // a plain object) and not pick up any mount_path.
      expect(other?.framework_role).toBeUndefined()
      expect(other?.framework_metadata?.mount_path).toBeUndefined()
      // The LOCAL router in server.ts gets the prefix.
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/api')
    })
  })

  describe('Express mount semantics: prefix is ALWAYS prepended', () => {
    it('prepends the mount prefix even when the router-local path equals the prefix (CodeRabbit fix)', () => {
      // Express semantics: a router mounted at '/api' that has a route
      // registered at '/api' answers requests to '/api/api', NOT '/api'.
      // The previous slice 1c-ii.g implementation incorrectly collapsed
      // this case via a misguided idempotence check; the regression
      // pins the corrected behavior.
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/api", listUsers)',
        'app.use("/api", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/api/api')
    })

    it('prepends the mount prefix even when the router-local path begins with the prefix (CodeRabbit fix)', () => {
      // Same correction. /api + /api/users → /api/api/users, not /api/users.
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        'usersRouter.get("/api/users", listUsers)',
        'app.use("/api", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/api/api/users')
    })
  })

  describe('router preserves its express_router role', () => {
    it('the router stays tagged express_router even after the mount records mount_path', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'app.use("/api/users", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const router = findSymbol(spi, 'src/server.ts', 'usersRouter')
      expect(router?.framework_role).toBe('express_router')
      expect(router?.framework_metadata?.mount_path).toBe('/api/users')
    })
  })
})
