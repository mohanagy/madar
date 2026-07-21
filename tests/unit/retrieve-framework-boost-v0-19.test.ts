// v0.19 — Hono / Fastify / tRPC / Prisma framework boost in retrieve().
// Mirrors the existing express/redux/nest/next boost tests but for the
// substrates added in v0.17 (#83). This is the slice that makes --spi
// actually move tokens: questions about the new frameworks now route
// matches via framework_role-based boosting instead of label-matching alone.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { loadGraph } from '../../src/runtime/serve.js'

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function normalizePathForAssertion(value: string): string {
  return value.replaceAll('\\', '/')
}

describe('Framework-aware retrieval boost for v0.17 substrates (#83 → v0.19)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('retrieve-fwk-boost-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('Hono question boosts hono_route nodes', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    // Include a label overlap ("listUsers") so the retrieval candidate
    // set finds the node; the boost then promotes it ABOVE plain
    // function matches in the ranking.
    const retrieved = retrieveContext(graph, {
      question: 'Find the Hono route for listUsers',
      budget: 2000,
    })

    const listUsers = retrieved.matched_nodes.find((n) => n.label === 'listUsers()')
    expect(listUsers).toBeDefined()
    expect(listUsers?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('Fastify "plugin" question boosts fastify_plugin nodes', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import Fastify from "fastify"',
      'export const app = Fastify()',
      'export function authPlugin(): void {}',
      'app.register(authPlugin, { prefix: "/api" })',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'What Fastify plugins are registered?',
      budget: 2000,
    })

    const plugin = retrieved.matched_nodes.find((n) => n.label === 'authPlugin()')
    expect(plugin?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('tRPC "mutation" question boosts trpc_procedure_mutation nodes', () => {
    writeFile(sandbox, 'src/router.ts', [
      'import { initTRPC } from "@trpc/server"',
      'const t = initTRPC.create()',
      'export const appRouter = t.router({',
      '  getUser: t.procedure.query(() => null),',
      '  updateUser: t.procedure.mutation(() => null),',
      '})',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Which tRPC mutations update users?',
      budget: 2000,
    })

    // The updateUser procedure synthesized as appRouter.updateUser should
    // win the boost competition against getUser when "mutation" is the
    // intent.
    const updateUser = retrieved.matched_nodes.find((n) => n.label.includes('updateUser'))
    const getUser = retrieved.matched_nodes.find((n) => n.label.includes('getUser'))
    expect(updateUser?.framework_boost ?? 0).toBeGreaterThan(0)
    if (getUser) {
      expect(updateUser?.framework_boost ?? 0).toBeGreaterThanOrEqual(getUser.framework_boost ?? 0)
    }
  })

  it('bare mutation questions do not boost tRPC nodes without tRPC signals', () => {
    writeFile(sandbox, 'src/router.ts', [
      'import { initTRPC } from "@trpc/server"',
      'const t = initTRPC.create()',
      'export const appRouter = t.router({',
      '  updateWorkspace: t.procedure.mutation(() => null),',
      '})',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'How does the API mutation flow through workspace services to persistence?',
      budget: 2000,
    })

    const updateWorkspace = retrieved.matched_nodes.find((n) => n.label.includes('updateWorkspace'))
    expect(updateWorkspace).toBeDefined()
    expect(updateWorkspace?.framework_boost ?? 0).toBe(0)
  })

  it('API mutation service questions boost Nest provider nodes', () => {
    writeFile(sandbox, 'src/workspace-mutation.resolver.ts', [
      'import { Injectable } from "@nestjs/common"',
      '@Injectable()',
      'export class WorkspaceMutationResolver {',
      '  createRecord(): Promise<void> {',
      '    return Promise.resolve()',
      '  }',
      '}',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'How does the API mutation flow through workspace services to persistence?',
      budget: 2000,
    })

    const resolver = retrieved.matched_nodes.find((n) => n.label === 'WorkspaceMutationResolver')
    expect(resolver).toBeDefined()
    expect(resolver?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('Prisma "model" question boosts prisma_client nodes', () => {
    writeFile(sandbox, 'src/db.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'export const prisma = new PrismaClient()',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Where is the Prisma database client used?',
      budget: 2000,
    })

    const client = retrieved.matched_nodes.find((n) => n.label === 'prisma')
    expect(client?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('storage-write questions boost canonical Prisma writers over readers', () => {
    writeFile(sandbox, 'src/persistence/report.repository.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'const prisma = new PrismaClient()',
      'export async function loadReports(): Promise<void> {',
      '  await prisma.report.findMany()',
      '}',
      'export async function createReport(): Promise<void> {',
      '  await prisma.report.create({ data: { title: "report" } })',
      '}',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Which Prisma operation creates and writes the report to the database?',
      budget: 2000,
    })

    const writer = retrieved.matched_nodes.find((node) =>
      node.framework_role === 'prisma_model_writer'
      && normalizePathForAssertion(node.source_file).endsWith('src/persistence/report.repository.ts'))
    const reader = retrieved.matched_nodes.find((node) =>
      node.framework_role === 'prisma_model_reader'
      && normalizePathForAssertion(node.source_file).endsWith('src/persistence/report.repository.ts'))

    expect(writer).toBeDefined()
    expect(writer?.framework_boost ?? 0).toBeGreaterThan(0)
    expect(writer?.framework_boost ?? 0).toBeGreaterThan(reader?.framework_boost ?? 0)
  })

  it('non-framework question receives no framework boost on Hono nodes', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'how do i convert a string to a number',  // unrelated
      budget: 2000,
    })

    const listUsers = retrieved.matched_nodes.find((n) => n.label === 'listUsers()')
    // Either zero or unboosted — definitely not the high-boost path.
    expect((listUsers?.framework_boost ?? 0)).toBeLessThan(4)
  })

  it('promotes the Hono request-flow owner above route-shell distractors', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('route_shell', {
      label: 'GET /users/:userId',
      source_file: '/src/users/router.ts',
      line_number: 12,
      node_kind: 'route',
      file_type: 'code',
      framework: 'hono',
      route_path: '/users/:userId',
      http_method: 'GET',
      community: 0,
    })
    graph.addNode('primary_workflow_owner', {
      label: 'lookupOwnedUser()',
      source_file: '/src/users/repository.ts',
      line_number: 18,
      node_kind: 'function',
      file_type: 'code',
      framework: 'prisma',
      framework_role: 'prisma_model_reader',
      storage_operation: 'findFirst',
      community: 0,
    })

    const retrieved = retrieveContext(graph, {
      question: 'enforce account ownership in the Hono users route handler for GET /users/:userId before calling prisma.user.findFirst',
      budget: 2000,
      fileType: 'code',
    })

    const primaryWorkflowOwner = retrieved.matched_nodes.find((node) => node.node_id === 'primary_workflow_owner')
    const routeShell = retrieved.matched_nodes.find((node) => node.node_id === 'route_shell')
    const primaryWorkflowOwnerIndex = retrieved.matched_nodes.findIndex((node) => node.node_id === 'primary_workflow_owner')
    const routeShellIndex = retrieved.matched_nodes.findIndex((node) => node.node_id === 'route_shell')

    expect(primaryWorkflowOwner).toBeDefined()
    expect(routeShell).toBeDefined()
    expect(primaryWorkflowOwner?.framework_boost ?? 0).toBeGreaterThan(routeShell?.framework_boost ?? 0)
    expect(primaryWorkflowOwnerIndex).toBeGreaterThanOrEqual(0)
    expect(routeShellIndex).toBeGreaterThanOrEqual(0)
    expect(primaryWorkflowOwnerIndex).toBeLessThan(routeShellIndex)
  })

  it('promotes the Hono request-flow owner for endpoint phrasing too', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('route_shell', {
      label: 'GET /users/:userId',
      source_file: '/src/users/router.ts',
      line_number: 12,
      node_kind: 'route',
      file_type: 'code',
      framework: 'hono',
      route_path: '/users/:userId',
      http_method: 'GET',
      community: 0,
    })
    graph.addNode('primary_workflow_owner', {
      label: 'lookupOwnedUser()',
      source_file: '/src/users/repository.ts',
      line_number: 18,
      node_kind: 'function',
      file_type: 'code',
      framework: 'prisma',
      framework_role: 'prisma_model_reader',
      storage_operation: 'findFirst',
      community: 0,
    })

    const retrieved = retrieveContext(graph, {
      question: 'enforce account ownership in the Hono users endpoint for GET /users/:userId before calling prisma.user.findFirst',
      budget: 2000,
      fileType: 'code',
    })

    const primaryWorkflowOwner = retrieved.matched_nodes.find((node) => node.node_id === 'primary_workflow_owner')
    const routeShell = retrieved.matched_nodes.find((node) => node.node_id === 'route_shell')
    const primaryWorkflowOwnerIndex = retrieved.matched_nodes.findIndex((node) => node.node_id === 'primary_workflow_owner')
    const routeShellIndex = retrieved.matched_nodes.findIndex((node) => node.node_id === 'route_shell')

    expect(primaryWorkflowOwner).toBeDefined()
    expect(routeShell).toBeDefined()
    expect(primaryWorkflowOwner?.framework_boost ?? 0).toBeGreaterThan(routeShell?.framework_boost ?? 0)
    expect(primaryWorkflowOwnerIndex).toBeGreaterThanOrEqual(0)
    expect(routeShellIndex).toBeGreaterThanOrEqual(0)
    expect(primaryWorkflowOwnerIndex).toBeLessThan(routeShellIndex)
  })
})
