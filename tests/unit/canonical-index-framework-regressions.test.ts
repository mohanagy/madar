import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function build(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-framework-regression-'))
  roots.push(root)
  const files = Object.entries(sources).map(([path, source]) => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
    return absolute
  })
  const result = buildCanonicalTypeScriptIndex({ root, files })
  const nodes = new Map(result.graph.nodeEntries())
  const edges = result.graph.edgeEntries().map(([from, to, attrs]) => ({
    from: nodes.get(from),
    to: nodes.get(to),
    attrs,
  }))
  return { nodes: [...nodes.values()], edges }
}

function named(nodes: Array<Record<string, unknown>>, name: string) {
  return nodes.find((node) => node.qualified_name === name)
}

function relations(
  edges: Array<{ from: Record<string, unknown> | undefined; to: Record<string, unknown> | undefined; attrs: Record<string, unknown> }>,
  from: string,
  to?: string,
) {
  return edges.filter((edge) =>
    edge.attrs.relation === 'route_handler'
    && edge.from?.qualified_name === from
    && (to === undefined || edge.to?.qualified_name === to),
  )
}

describe('canonical framework relationship regressions', () => {
  it('keeps repeated Express registrations distinct by evidence and route metadata', () => {
    const { edges } = build({
      'server.ts': `import express from 'express'
import { handler } from './handler.js'
export const app = express()
app.get('/one', handler)
app.post('/two', handler)
`,
      'handler.ts': `export function handler(): void {}`,
    })
    const routes = relations(edges, 'app', 'handler')
    expect(routes).toHaveLength(2)
    expect(routes.map((edge) => [edge.attrs.http_method, edge.attrs.route_path]).sort()).toEqual([
      ['GET', '/one'],
      ['POST', '/two'],
    ])
    expect(new Set(routes.map((edge) => edge.attrs.source_location)).size).toBe(2)
  })

  it('follows standard exported tRPC router and procedure helpers across files', () => {
    const { nodes, edges } = build({
      'trpc.ts': `import { initTRPC as boot } from '@trpc/server'
const t = boot.context<{ user: string }>().create()
export const router = t.router
export const publicProcedure = t.procedure
`,
      'router.ts': `import { publicProcedure, router } from './trpc.js'
const fake = { router: (x: unknown) => x, procedure: { query: (x: unknown) => x } }
export const fakeRouter = fake.router({ nope: fake.procedure.query(() => 'no') })
export const appRouter = router({ health: publicProcedure.input(String).query(() => 'ok') })
`,
    })
    expect(named(nodes, 'appRouter')?.framework_role).toBe('trpc_router')
    expect(named(nodes, 'appRouter.health')?.framework_role).toBe('trpc_procedure_query')
    expect(named(nodes, 'fakeRouter')?.framework_role).toBeUndefined()
    expect(relations(edges, 'appRouter', 'appRouter.health')).toHaveLength(1)
  })

  it('classifies the supported Prisma operation set through imported singleton aliases', () => {
    const { nodes, edges } = build({
      'client.ts': `import { PrismaClient } from '@prisma/client'
export const client = new PrismaClient()
`,
      'service.ts': `import { client as db } from './client.js'
const fakeDb = { user: { findMany: () => [] } }
export async function usePrisma() {
  await db.user.findUnique({})
  await db.user.findUniqueOrThrow({})
  await db.user.findFirst({})
  await db.user.findFirstOrThrow({})
  await db.user.findMany({})
  await db.user.count({})
  await db.user.aggregate({})
  await db.user.groupBy({})
  await db.user.create({})
  await db.user.createMany({})
  await db.user.update({})
  await db.user.updateMany({})
  await db.user.delete({})
  await db.user.deleteMany({})
  await db.user.upsert({})
  await db.$transaction([])
}
export function listFake() { return fakeDb.user.findMany() }
`,
    })
    expect(named(nodes, 'client')?.framework_role).toBe('prisma_client')
    const operations = nodes.filter((node) => String(node.framework_role).startsWith('prisma_model_'))
    expect(operations.filter((node) => node.framework_role === 'prisma_model_reader')).toHaveLength(8)
    expect(operations.filter((node) => node.framework_role === 'prisma_model_writer')).toHaveLength(8)
    expect(new Set(operations.map((node) => node.storage_operation))).toHaveLength(16)
    expect(edges.filter((edge) => edge.attrs.relation === 'calls' && edge.from?.qualified_name === 'usePrisma')).toHaveLength(16)
    expect(edges.some((edge) => edge.from?.qualified_name === 'listFake' && edge.to?.framework_role === 'prisma_model_reader')).toBe(false)
  })

  it('connects Fastify plugin receivers and imported or inline handlers', () => {
    const { nodes, edges } = build({
      'handler.ts': `export function importedHandler(): void {}`,
      'plugin.ts': `import type { FastifyPluginAsync as Plugin } from 'fastify'
import { importedHandler } from './handler.js'
type RoutesPlugin = Plugin
export const routes: RoutesPlugin = async (instance) => {
  instance.get('/plugin', importedHandler)
  instance.post('/inline', async () => {})
}
`,
      'server.ts': `import fastify from 'fastify'
import { importedHandler } from './handler.js'
import { routes } from './plugin.js'
export const app = fastify()
app.register(routes, { prefix: '/v1' })
app.get('/direct', importedHandler)
`,
    })
    expect(named(nodes, 'routes')?.framework_role).toBe('fastify_plugin')
    expect(relations(edges, 'app', 'routes')).toHaveLength(1)
    expect(relations(edges, 'routes').filter((edge) => edge.to?.framework_role === 'fastify_route')).toHaveLength(2)
    expect(relations(edges, 'app', 'importedHandler')).toHaveLength(1)
  })

  it('connects imported React Router loaders and actions without tagging lookalikes', () => {
    const { nodes, edges } = build({
      'handlers.ts': `export function loader(): void {}
export function action(): void {}`,
      'router.ts': `import { createBrowserRouter } from 'react-router-dom'
import { action as submit, loader as load } from './handlers.js'
export const router = createBrowserRouter([{ path: '/users', loader: load, action: submit }])
`,
    })
    expect(named(nodes, 'loader')).toMatchObject({ framework_role: 'react_router_loader', route_path: '/users' })
    expect(named(nodes, 'action')).toMatchObject({ framework_role: 'react_router_action', route_path: '/users' })
    expect(relations(edges, 'router', 'loader')).toHaveLength(1)
    expect(relations(edges, 'router', 'action')).toHaveLength(1)
  })

  it('connects imported and inline Hono handlers', () => {
    const { nodes, edges } = build({
      'handler.ts': `export function importedHandler(): void {}`,
      'server.ts': `import { Hono } from 'hono'
import { importedHandler } from './handler.js'
export const app = new Hono()
app.get('/imported', importedHandler)
app.post('/inline', async () => {})
`,
    })
    expect(named(nodes, 'importedHandler')?.framework_role).toBe('hono_route')
    expect(relations(edges, 'app').filter((edge) => edge.to?.framework_role === 'hono_route')).toHaveLength(2)
  })

  it('finds arbitrary Next roots without tagging every use-client callable', () => {
    const { nodes } = build({
      'products/portal/src/app/dashboard/page.tsx': `export default function Dashboard() { return <main /> }`,
      'products/portal/src/app/widgets/client.tsx': `'use client'
export function Widget() { return <section /> }
export const Card = () => <article />
export function helper() { return 1 }
export const parse = () => 2
`,
    })
    expect(named(nodes, 'Dashboard')).toMatchObject({ framework_role: 'nextjs_app_page', route_path: '/dashboard' })
    expect(named(nodes, 'Widget')?.framework_role).toBe('nextjs_client_component')
    expect(named(nodes, 'Card')?.framework_role).toBe('nextjs_client_component')
    expect(named(nodes, 'helper')?.framework_role).toBeUndefined()
    expect(named(nodes, 'parse')?.framework_role).toBeUndefined()
  })
})
