import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-proj-meta-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function project(root: string) {
  const spi = buildSpi({ root, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
  return projectSpiToExtraction(spi, { root })
}

describe('projector — framework_metadata propagation onto ExtractionNode', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('Express route_path metadata', () => {
    it('surfaces route_path on a named-handler Express route node', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function listUsers(): void {}',
        'app.get("/users/:id", listUsers)',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = extraction.nodes.find((n) => n.label === 'listUsers()')
      expect(node?.framework).toBe('express')
      expect(node?.framework_role).toBe('express_route')
      expect((node as Record<string, unknown> | undefined)?.route_path).toBe('/users/:id')
    })

    it('surfaces route_path on a synthesized inline-handler route node', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'app.post("/users", (_req, _res) => { void 0 })',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const routeNode = extraction.nodes.find((n) => n.framework === 'express' && n.framework_role === 'express_route')
      expect((routeNode as Record<string, unknown> | undefined)?.route_path).toBe('/users')
    })

    it('does NOT add route_path when the source route had a dynamic path string', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'const prefix = "/api"',
        'export function h(): void {}',
        'app.get(`${prefix}/x`, h)',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = extraction.nodes.find((n) => n.label === 'h()')
      expect(node?.framework).toBe('express')
      // Dynamic path → SPI did not capture route_path → projector emits
      // no key on the ExtractionNode.
      expect((node as Record<string, unknown> | undefined)?.route_path).toBeUndefined()
    })
  })

  describe('Express mount_path metadata', () => {
    it('surfaces mount_path on prefixed middleware', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function authMw(): void {}',
        'app.use("/api", authMw)',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = extraction.nodes.find((n) => n.label === 'authMw()')
      expect(node?.framework_role).toBe('express_middleware')
      expect((node as Record<string, unknown> | undefined)?.mount_path).toBe('/api')
    })

    it('omits mount_path on globally-registered middleware', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
        'export function globalMw(): void {}',
        'app.use(globalMw)',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = extraction.nodes.find((n) => n.label === 'globalMw()')
      expect(node?.framework_role).toBe('express_middleware')
      expect((node as Record<string, unknown> | undefined)?.mount_path).toBeUndefined()
    })
  })

  describe('symbols without framework_metadata', () => {
    it('does not add stray keys when the symbol carries no framework_metadata', () => {
      writeFile(sandbox, 'src/plain.ts', 'export function helper(): void {}\n')
      const extraction = project(sandbox)
      const node = extraction.nodes.find((n) => n.label === 'helper()')
      // No metadata → no route_path / mount_path / etc.
      expect((node as Record<string, unknown> | undefined)?.route_path).toBeUndefined()
      expect((node as Record<string, unknown> | undefined)?.mount_path).toBeUndefined()
    })
  })

  describe('forward-compatibility with future framework_metadata keys', () => {
    it('propagates arbitrary keys, not just route_path/mount_path', () => {
      // Direct SPI build → mutate one symbol's framework_metadata with a
      // hypothetical future key → project → assert the key surfaces.
      writeFile(sandbox, 'src/x.ts', 'export function foo(): void {}\n')
      const spi = buildSpi({ root: sandbox, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
      const foo = spi.symbols.find((s) => s.name === 'foo')
      if (foo) {
        foo.framework_role = 'express_route'
        foo.framework_metadata = { route_path: '/foo', some_future_key: 42 }
      }
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'foo()')
      expect((node as Record<string, unknown> | undefined)?.route_path).toBe('/foo')
      expect((node as Record<string, unknown> | undefined)?.some_future_key).toBe(42)
    })
  })
})
