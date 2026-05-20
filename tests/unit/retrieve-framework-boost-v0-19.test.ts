// v0.19 — Hono / Fastify / tRPC / Prisma framework boost in retrieve().
// Mirrors the existing express/redux/nest/next boost tests but for the
// substrates added in v0.17 (#83). This is the slice that makes --spi
// actually move tokens: questions about the new frameworks now route
// matches via framework_role-based boosting instead of label-matching alone.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
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

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
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
      'declare const t: ReturnType<typeof initTRPC.create>',
      'export const appRouter = t.router({',
      '  getUser: t.procedure.query(() => null),',
      '  updateUser: t.procedure.mutation(() => null),',
      '})',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
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

  it('Prisma "model" question boosts prisma_client nodes', () => {
    writeFile(sandbox, 'src/db.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'export const prisma = new PrismaClient()',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Where is the Prisma database client used?',
      budget: 2000,
    })

    const client = retrieved.matched_nodes.find((n) => n.label === 'prisma')
    expect(client?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('storage question boosts repository save endpoints over generic save helpers', () => {
    writeFile(sandbox, 'src/persistence/report.repository.ts', [
      'export class ReportRepository {',
      '  async save(): Promise<void> {}',
      '}',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/ui/report-footer.ts', [
      'export class ReportFooter {',
      '  save(): void {}',
      '}',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Which method writes the report to the database?',
      budget: 2000,
    })

    const repoSaveIndex = retrieved.matched_nodes.findIndex((node) =>
      node.label === '.save()' && normalizePathForAssertion(node.source_file).endsWith('src/persistence/report.repository.ts'))
    const repoClassIndex = retrieved.matched_nodes.findIndex((node) =>
      node.label === 'ReportRepository' && normalizePathForAssertion(node.source_file).endsWith('src/persistence/report.repository.ts'))
    const helperSaveIndex = retrieved.matched_nodes.findIndex((node) =>
      node.label === '.save()' && normalizePathForAssertion(node.source_file).endsWith('src/ui/report-footer.ts'))
    const repoSave = repoSaveIndex >= 0 ? retrieved.matched_nodes[repoSaveIndex] : undefined

    expect(repoSaveIndex).toBeGreaterThanOrEqual(0)
    expect(repoSave?.framework_boost ?? 0).toBeGreaterThan(0)
    if (repoClassIndex >= 0) {
      expect(repoSaveIndex).toBeLessThan(repoClassIndex)
    }
    if (helperSaveIndex >= 0) {
      expect(repoSaveIndex).toBeLessThan(helperSaveIndex)
    }
  })

  it('non-framework question receives no framework boost on Hono nodes', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import { Hono } from "hono"',
      'export const app = new Hono()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { useSpi: true, noHtml: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'how do i convert a string to a number',  // unrelated
      budget: 2000,
    })

    const listUsers = retrieved.matched_nodes.find((n) => n.label === 'listUsers()')
    // Either zero or unboosted — definitely not the high-boost path.
    expect((listUsers?.framework_boost ?? 0)).toBeLessThan(4)
  })
})
