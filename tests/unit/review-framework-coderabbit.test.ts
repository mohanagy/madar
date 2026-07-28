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
  const root = mkdtempSync(join(tmpdir(), 'madar-review-framework-'))
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

function routes(
  edges: Array<{ from: Record<string, unknown> | undefined; to: Record<string, unknown> | undefined; attrs: Record<string, unknown> }>,
  from: string,
) {
  return edges.filter((edge) => edge.attrs.relation === 'route_handler' && edge.from?.qualified_name === from)
}

describe('CodeRabbit framework review regressions', () => {
  it('keeps routes declared inside an inline Fastify plugin callback', () => {
    const { nodes, edges } = build({
      'review-framework-fastify.ts': `import fastify from 'fastify'
export const app = fastify()
app.register(async function inlinePlugin(instance) {
  instance.get('/inline-plugin', async () => {})
})
`,
    })

    const plugin = nodes.find((node) => node.framework_role === 'fastify_plugin')
    expect(plugin).toBeDefined()
    expect(routes(edges, 'app').some((edge) => edge.to?.id === plugin?.id)).toBe(true)
    expect(routes(edges, String(plugin?.qualified_name))).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ route_path: '/inline-plugin' }) }),
    ])
  })

  it('rejects a shadowing local while preserving an imported handler alias', () => {
    const { nodes, edges } = build({
      'review-framework-handler.ts': `export function importedHandler(): void {}`,
      'review-framework-hono.ts': `import { Hono } from 'hono'
import { importedHandler as requestHandler } from './review-framework-handler.js'
export const app = new Hono()
export function handler(): void {}
app.get('/imported', requestHandler)
app.get('/top-level', handler)
export function installShadowedRoute() {
  const handler = () => undefined
  app.get('/shadowed', handler)
}
`,
    })

    expect(named(nodes, 'importedHandler')?.framework_role).toBe('hono_route')
    expect(named(nodes, 'handler')?.framework_role).toBe('hono_route')
    const handlerRoutes = routes(edges, 'app').filter((edge) => edge.to?.qualified_name === 'handler')
    expect(handlerRoutes.map((edge) => edge.attrs.route_path)).toEqual(['/top-level'])
    const importedRoutes = routes(edges, 'app').filter((edge) => edge.to?.qualified_name === 'importedHandler')
    expect(importedRoutes.map((edge) => edge.attrs.route_path)).toEqual(['/imported'])
  })

  it('indexes tRPC shorthand procedures without tagging a same-named unrelated declaration', () => {
    const { nodes, edges } = build({
      'review-framework-trpc-base.ts': `import { initTRPC } from '@trpc/server'
const t = initTRPC.create()
export const router = t.router
export const publicProcedure = t.procedure
export const getUser = publicProcedure.query(() => 'user')
export const createUser = publicProcedure.mutation(() => 'created')
`,
      'review-framework-trpc.ts': `import { createUser, getUser, publicProcedure, router } from './review-framework-trpc-base.js'
export const unrelated = () => 'not a procedure'
export const appRouter = router({
  getUser,
  createUser,
  unrelated: publicProcedure.subscription(() => 'updates'),
})
`,
    })

    expect(named(nodes, 'getUser')?.framework_role).toBe('trpc_procedure_query')
    expect(named(nodes, 'createUser')?.framework_role).toBe('trpc_procedure_mutation')
    expect(named(nodes, 'unrelated')?.framework_role).toBeUndefined()
    expect(named(nodes, 'appRouter.unrelated')?.framework_role).toBe('trpc_procedure_subscription')
    expect(routes(edges, 'appRouter').map((edge) => edge.attrs.procedure_name).sort()).toEqual([
      'createUser',
      'getUser',
      'unrelated',
    ])
  })
})
