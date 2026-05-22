import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExtractionData, ExtractionNode } from '../../src/contracts/types.js'
import { extract } from '../../src/pipeline/extract.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-express-parity-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function projectFromSpi(root: string): ExtractionData {
  const spi = buildSpi({ root, sadeemVersion: 'test-0.0.0', now: FROZEN_NOW })
  return projectSpiToExtraction(spi, { root })
}

function legacyExtract(root: string, files: string[]): ExtractionData {
  return extract(files.map((f) => resolve(root, f)))
}

/** Helper: pluck Express route handler nodes from an ExtractionData,
 *  keyed by label (the legacy extractor and the SPI projector both use
 *  the function-call label form like `listUsers()`). */
function routeNodesByLabel(extraction: ExtractionData): Map<string, ExtractionNode> {
  const out = new Map<string, ExtractionNode>()
  for (const node of extraction.nodes) {
    if (node.framework === 'express' && node.framework_role === 'express_route') {
      out.set(node.label, node)
    }
  }
  return out
}

describe('Express projector parity (legacy extract vs SPI projector)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('single-file Express server', () => {
    it('SPI side tags the handler with express_route + route_path; legacy emits a synthesized route node with the same path', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(): void {}',
        'app.get("/users", listUsers)',
      ].join('\n') + '\n')

      const projected = projectFromSpi(sandbox)
      const legacy = legacyExtract(sandbox, ['src/server.ts'])

      // SPI side: the HANDLER function is tagged with framework=express,
      // framework_role=express_route, and route_path is on the same node.
      const projectedHandler = projected.nodes.find((n) => n.label === 'listUsers()')
      expect(projectedHandler?.framework).toBe('express')
      expect(projectedHandler?.framework_role).toBe('express_route')
      expect((projectedHandler as Record<string, unknown>)?.route_path).toBe('/users')

      // Legacy side: the handler function is a plain ExtractionNode with
      // no framework tag, and a SEPARATE synthesized route node with
      // node_kind='route' + route_path carries the routing claim. This
      // is a documented taxonomy divergence between the two paths; the
      // demo-repo byte-equivalence work will need to decide which shape
      // to canonicalize on (likely retain both for back-compat).
      const legacyRouteNode = legacy.nodes.find((n) =>
        n.framework === 'express' && (n as Record<string, unknown>).route_path === '/users',
      )
      expect(legacyRouteNode).toBeTruthy()
    })
  })

  describe('Express with mounted router (cross-file)', () => {
    it('SPI projector resolves mount prefix for cross-file imported routers — legacy emits the same path on a synthesized route node', () => {
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

      const projected = projectFromSpi(sandbox)
      const legacy = legacyExtract(sandbox, ['src/server.ts', 'src/routes/users.ts'])

      // SPI projector: listUsers gets framework=express, route_path=/api/users
      // (slice 1c-ii.i collapses the router-root '/' so the projector's
      // output is byte-equivalent to the legacy extractor's emission).
      const projectedListUsers = projected.nodes.find((n) => n.label === 'listUsers()')
      expect(projectedListUsers?.framework).toBe('express')
      expect(projectedListUsers?.framework_role).toBe('express_route')
      expect((projectedListUsers as Record<string, unknown>)?.route_path).toBe('/api/users')

      // Legacy: assert it produced a node for the handler function and
      // that at least one ExtractionNode in the legacy output carries
      // the prefixed path in the canonical form. After slice 1c-ii.i
      // both paths agree on `/api/users` (no trailing slash).
      const legacyHandler = legacy.nodes.find((n) => n.label === 'listUsers()')
      expect(legacyHandler, 'legacy extractor must emit a node for listUsers').toBeTruthy()

      const legacyPaths = legacy.nodes
        .map((n) => (n as Record<string, unknown>).route_path)
        .filter((p): p is string => typeof p === 'string')
      expect(
        legacyPaths.includes('/api/users'),
        'legacy extractor must register /api/users somewhere in its node payload',
      ).toBe(true)
    })
  })

  describe('Express middleware', () => {
    it('SPI side tags named middleware with framework=express + express_middleware', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function logger(): void {}',
        'app.use(logger)',
      ].join('\n') + '\n')

      const projected = projectFromSpi(sandbox)
      const legacy = legacyExtract(sandbox, ['src/server.ts'])

      const projectedLogger = projected.nodes.find((n) => n.label === 'logger()')
      const legacyLogger = legacy.nodes.find((n) => n.label === 'logger()')

      expect(projectedLogger?.framework).toBe('express')
      expect(projectedLogger?.framework_role).toBe('express_middleware')
      // Legacy: minimum assertion is that both paths emit a node for
      // the function. The middleware role labeling is a SPI-side
      // enrichment not yet reproduced by the legacy extractor.
      expect(legacyLogger).toBeTruthy()
    })
  })

  describe('parity bounds — what this PR pins', () => {
    it('both paths produce nodes for the same handler function labels for a small Express server', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(): void {}',
        'export function createUser(): void {}',
        'export function updateUser(): void {}',
        'app.get("/users", listUsers)',
        'app.post("/users", createUser)',
        'app.patch("/users/:id", updateUser)',
      ].join('\n') + '\n')

      const projected = projectFromSpi(sandbox)
      const legacy = legacyExtract(sandbox, ['src/server.ts'])

      // Both paths must produce a node for each function (regardless of
      // whether they tag it as express_route or emit a separate route
      // node — that taxonomy divergence is what slice 1c-ii.e covers,
      // but the function-handler node is common to both).
      const projectedLabels = new Set(projected.nodes.map((n) => n.label))
      const legacyLabels = new Set(legacy.nodes.map((n) => n.label))
      for (const label of ['listUsers()', 'createUser()', 'updateUser()']) {
        expect(projectedLabels.has(label)).toBe(true)
        expect(legacyLabels.has(label)).toBe(true)
      }
    })

    it('both paths register all three route paths SOMEWHERE in their output (via different nodes)', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(): void {}',
        'export function createUser(): void {}',
        'export function updateUser(): void {}',
        'app.get("/users", listUsers)',
        'app.post("/users", createUser)',
        'app.patch("/users/:id", updateUser)',
      ].join('\n') + '\n')

      const projected = projectFromSpi(sandbox)
      const legacy = legacyExtract(sandbox, ['src/server.ts'])

      const projectedPaths = new Set(
        projected.nodes
          .map((n) => (n as Record<string, unknown>).route_path)
          .filter((p): p is string => typeof p === 'string'),
      )
      const legacyPaths = new Set(
        legacy.nodes
          .map((n) => (n as Record<string, unknown>).route_path)
          .filter((p): p is string => typeof p === 'string'),
      )

      for (const path of ['/users', '/users/:id']) {
        expect(projectedPaths.has(path)).toBe(true)
        expect(legacyPaths.has(path)).toBe(true)
      }
    })
  })
})
