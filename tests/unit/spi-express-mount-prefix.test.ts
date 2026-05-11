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
    graphifyVersion: 'test-0.0.0',
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
      expect(handler?.framework_metadata?.route_path).toBe('/api/users/')
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
      expect(synthetic?.framework_metadata?.route_path).toBe('/api/users/')
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

  describe('cross-file mount (deferred to slice 1c-ii.h)', () => {
    it('today: cross-file mount does NOT propagate the prefix (current limitation)', () => {
      // The middleware detector's handler resolution is currently
      // current-file only — an imported router identifier in server.ts
      // doesn't resolve to the router's SpiSymbol in routes/users.ts.
      // Adding cross-file resolution requires plumbing pathToFileId
      // through the detector context and following the type checker
      // across file boundaries. Slice 1c-ii.h.
      //
      // This test documents the current behavior so we can detect when
      // 1c-ii.h flips it.
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
      expect(handler?.framework_metadata?.route_path).toBe('/')
    })
  })

  describe('finalizer idempotence', () => {
    it('does not double-apply the prefix when the route_path already starts with it', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express, { Router } from "express"',
        'export const app = express()',
        'export const usersRouter = Router()',
        'export function listUsers(): void {}',
        // Path that already includes the mount prefix — the finalizer
        // must not produce /api/api/users.
        'usersRouter.get("/api/users", listUsers)',
        'app.use("/api", usersRouter)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
      expect(handler?.framework_metadata?.route_path).toBe('/api/users')
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
