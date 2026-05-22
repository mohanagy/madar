// v0.17 framework substrates (#83) — Hono, Fastify, tRPC, Prisma.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
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
    extractorVersion: 'spi-v1.0.0-v0.17',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('Hono substrate (v0.17 #83)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-hono-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('tags `new Hono()` results as hono_app', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const app = findSymbol(spi, 'src/server.ts', 'app')
    expect(app?.framework_role).toBe('hono_app')
  })

  it('tags app.get/post/etc. handlers with route_path + http_method', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
      'export function listUsers(): void {}',
      'export function getUser(): void {}',
      'app.get("/users", listUsers)',
      'app.get("/users/:id", getUser)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const list = findSymbol(spi, 'src/server.ts', 'listUsers')
    expect(list?.framework_role).toBe('hono_route')
    expect(list?.framework_metadata?.route_path).toBe('/users')
    expect(list?.framework_metadata?.http_method).toBe('GET')
    const get = findSymbol(spi, 'src/server.ts', 'getUser')
    expect(get?.framework_metadata?.route_path).toBe('/users/:id')
  })

  it('tags app.use(...) middleware with mount_path when provided', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
      'export function authMiddleware(): void {}',
      'app.use("/api/*", authMiddleware)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const mw = findSymbol(spi, 'src/server.ts', 'authMiddleware')
    expect(mw?.framework_role).toBe('hono_middleware')
    expect(mw?.framework_metadata?.mount_path).toBe('/api/*')
  })

  it('ignores files that do not import hono', () => {
    writeFile(sandbox, 'src/server.ts', [
      'class Hono { get(_p: string, _h: () => void): void {} }',
      'export const app = new Hono()',
      'app.get("/users", () => {})',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const app = findSymbol(spi, 'src/server.ts', 'app')
    expect(app?.framework_role).toBeUndefined()
  })
})

describe('Fastify substrate (v0.17 #83)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-fastify-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('tags Fastify() factory result as fastify_app', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import Fastify from "fastify"',
      'export const app = Fastify()',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const app = findSymbol(spi, 'src/server.ts', 'app')
    expect(app?.framework_role).toBe('fastify_app')
  })

  it('tags app.get/post/etc. with route_path + http_method', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import Fastify from "fastify"',
      'export const app = Fastify()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const list = findSymbol(spi, 'src/server.ts', 'listUsers')
    expect(list?.framework_role).toBe('fastify_route')
    expect(list?.framework_metadata?.route_path).toBe('/users')
    expect(list?.framework_metadata?.http_method).toBe('GET')
  })

  it('tags app.register(plugin, { prefix }) with mount_path', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import Fastify from "fastify"',
      'export const app = Fastify()',
      'export function authPlugin(): void {}',
      'app.register(authPlugin, { prefix: "/api" })',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const plugin = findSymbol(spi, 'src/server.ts', 'authPlugin')
    expect(plugin?.framework_role).toBe('fastify_plugin')
    expect(plugin?.framework_metadata?.mount_path).toBe('/api')
  })
})

describe('tRPC substrate (v0.17 #83)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-trpc-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('tags t.router({...}) result as trpc_router and synthesizes procedure entries', () => {
    writeFile(sandbox, 'src/router.ts', [
      'import { initTRPC } from "@trpc/server"',
      'declare const t: ReturnType<typeof initTRPC.create>',
      'export const appRouter = t.router({',
      '  getUser: t.procedure.query(() => null),',
      '  createUser: t.procedure.mutation(() => null),',
      '  onMessage: t.procedure.subscription(() => null),',
      '})',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const router = findSymbol(spi, 'src/router.ts', 'appRouter')
    expect(router?.framework_role).toBe('trpc_router')

    // Procedures are synthesized as `<routerName>.<procedureName>`.
    const getUser = findSymbol(spi, 'src/router.ts', 'appRouter.getUser')
    expect(getUser?.framework_role).toBe('trpc_procedure_query')
    expect(getUser?.framework_metadata?.procedure_name).toBe('getUser')

    const createUser = findSymbol(spi, 'src/router.ts', 'appRouter.createUser')
    expect(createUser?.framework_role).toBe('trpc_procedure_mutation')

    const onMessage = findSymbol(spi, 'src/router.ts', 'appRouter.onMessage')
    expect(onMessage?.framework_role).toBe('trpc_procedure_subscription')
  })

  it('ignores files that do not import @trpc/server', () => {
    writeFile(sandbox, 'src/router.ts', [
      'declare const t: any',
      'export const appRouter = t.router({ x: t.procedure.query(() => null) })',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const router = findSymbol(spi, 'src/router.ts', 'appRouter')
    expect(router?.framework_role).toBeUndefined()
  })
})

describe('Prisma substrate (v0.17 #83)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-prisma-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('tags new PrismaClient() result as prisma_client', () => {
    writeFile(sandbox, 'src/db.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'export const prisma = new PrismaClient()',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const client = findSymbol(spi, 'src/db.ts', 'prisma')
    expect(client?.framework_role).toBe('prisma_client')
  })

  it('ignores files that do not import from @prisma/client', () => {
    writeFile(sandbox, 'src/db.ts', [
      'class PrismaClient {}',
      'export const prisma = new PrismaClient()',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const client = findSymbol(spi, 'src/db.ts', 'prisma')
    expect(client?.framework_role).toBeUndefined()
  })
})

describe('Multi-framework workspace (v0.17 parity)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-v017-multi-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('a workspace combining Hono + Fastify + tRPC + Prisma tags each correctly', () => {
    writeFile(sandbox, 'src/hono-app.ts', [
      'import { Hono } from "hono"',
      'export const honoApp = new Hono()',
      'export function honoPing(): void {}',
      'honoApp.get("/ping", honoPing)',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/fastify-app.ts', [
      'import Fastify from "fastify"',
      'export const fastifyApp = Fastify()',
      'export function fastifyHealth(): void {}',
      'fastifyApp.get("/health", fastifyHealth)',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/trpc.ts', [
      'import { initTRPC } from "@trpc/server"',
      'declare const t: ReturnType<typeof initTRPC.create>',
      'export const appRouter = t.router({ ping: t.procedure.query(() => null) })',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/db.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'export const prisma = new PrismaClient()',
    ].join('\n') + '\n')

    const spi = build(sandbox)

    expect(findSymbol(spi, 'src/hono-app.ts', 'honoApp')?.framework_role).toBe('hono_app')
    expect(findSymbol(spi, 'src/hono-app.ts', 'honoPing')?.framework_role).toBe('hono_route')
    expect(findSymbol(spi, 'src/fastify-app.ts', 'fastifyApp')?.framework_role).toBe('fastify_app')
    expect(findSymbol(spi, 'src/fastify-app.ts', 'fastifyHealth')?.framework_role).toBe('fastify_route')
    expect(findSymbol(spi, 'src/trpc.ts', 'appRouter')?.framework_role).toBe('trpc_router')
    expect(findSymbol(spi, 'src/trpc.ts', 'appRouter.ping')?.framework_role).toBe('trpc_procedure_query')
    expect(findSymbol(spi, 'src/db.ts', 'prisma')?.framework_role).toBe('prisma_client')
  })
})
