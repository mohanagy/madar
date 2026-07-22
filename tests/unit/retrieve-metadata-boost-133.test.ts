// #133 — framework metadata-aware retrieval boost.
// Verifies route_path / http_method / procedure_name substring
// matches add explicit boost on top of the role-based boost from PR #129.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { generateIndex as generateGraph } from '../../src/application/generate-index.js'
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

describe('Framework metadata-aware retrieval boost (#133)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('retrieve-meta-boost-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('boosts the express handler whose route_path matches a substring in the question', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'export function getUserById(): void {}',
      'app.get("/users", listUsers)',
      'app.get("/users/:id", getUserById)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Find the express handler for GET /users/:id',
      budget: 2000,
    })

    const getUserById = retrieved.matched_nodes.find((n) => n.label === 'getUserById()')
    const listUsers = retrieved.matched_nodes.find((n) => n.label === 'listUsers()')
    expect(getUserById?.framework_boost ?? 0).toBeGreaterThan(0)
    // getUserById's route_path '/users/:id' substring-matches the question
    // → should outrank listUsers (route_path '/users' is also matched but
    // /users/:id is longer/more specific so the rule fires equally hard;
    // the GET verb match applies to both. The exact-substring on the FULL
    // longer path still favours getUserById on label-match downstream).
    expect(getUserById?.framework_boost ?? 0).toBeGreaterThanOrEqual(listUsers?.framework_boost ?? 0)
  })

  it('boosts the http_method match (e.g. POST mention favours POST routes)', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'export function createUser(): void {}',
      'app.get("/users", listUsers)',
      'app.post("/users", createUser)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Which route handles POST requests to /users',
      budget: 2000,
    })

    const createUser = retrieved.matched_nodes.find((n) => n.label === 'createUser()')
    const listUsers = retrieved.matched_nodes.find((n) => n.label === 'listUsers()')
    // createUser has http_method=POST + route_path=/users, both match.
    // listUsers has http_method=GET + route_path=/users, only path matches.
    expect((createUser?.framework_boost ?? 0)).toBeGreaterThan(listUsers?.framework_boost ?? 0)
  })

  it('boosts the tRPC procedure whose procedure_name appears in the question', () => {
    writeFile(sandbox, 'src/router.ts', [
      'import { initTRPC } from "@trpc/server"',
      'const t = initTRPC.create()',
      'export const appRouter = t.router({',
      '  getUser: t.procedure.query(() => null),',
      '  cancelOrder: t.procedure.mutation(() => null),',
      '})',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'How does the cancelOrder tRPC mutation work',
      budget: 2000,
    })

    const cancel = retrieved.matched_nodes.find((n) => n.label.includes('cancelOrder'))
    const getUser = retrieved.matched_nodes.find((n) => n.label.includes('getUser'))
    expect((cancel?.framework_boost ?? 0)).toBeGreaterThan(getUser?.framework_boost ?? 0)
  })

  it('seeds a node whose ONLY evidence is metadata match — label has no token overlap (CodeRabbit fix)', () => {
    // The handler is named `h` — no token overlap with the question. The
    // ONLY way it ends up in the seed set is via route_path metadata
    // matching the question's '/orders/:id' substring. Before the
    // CodeRabbit fix this node was invisible to lexical retrieval and
    // would never be ranked.
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function h(): void {}',
      'app.get("/orders/:id", h)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Find the handler for the /orders/:id endpoint',
      budget: 2000,
    })

    const h = retrieved.matched_nodes.find((n) => n.label === 'h()')
    expect(h).toBeDefined()
    expect(h?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('http_method match uses word boundaries — "GET" does NOT match "budget" (CodeRabbit fix)', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listItems(): void {}',
      'app.get("/items", listItems)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    // Question mentions "budget" (which CONTAINS the substring "get")
    // but NOT the literal verb GET. The word-boundary regex must not
    // fire here.
    const retrieved = retrieveContext(graph, {
      question: 'How does the project manage its budget for items',
      budget: 2000,
    })

    const node = retrieved.matched_nodes.find((n) => n.label === 'listItems()')
    // Some boost may still apply from route_path '/items' matching, but
    // the http_method +1.5 should NOT fire. The strongest assertion we
    // can make: the boost should be less than it would be if the verb
    // genuinely matched. We check by comparing against a query that
    // DOES use the verb literally.
    const retrievedVerb = retrieveContext(graph, {
      question: 'GET request to /items',
      budget: 2000,
    })
    const nodeVerb = retrievedVerb.matched_nodes.find((n) => n.label === 'listItems()')
    expect((nodeVerb?.framework_boost ?? 0)).toBeGreaterThan(node?.framework_boost ?? 0)
  })

  it('does NOT apply metadata boost when the question contains no matching substring', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox)
    const graph = loadGraph(result.graphPath)
    // Question is completely unrelated to /users or GET.
    const retrievedUnrelated = retrieveContext(graph, {
      question: 'How does the formatter handle currency conversion',
      budget: 2000,
    })
    // Question that DOES name the express handler — both fire, but the
    // metadata boost should add to it, not be absent.
    const retrievedRelated = retrieveContext(graph, {
      question: 'Find the GET /users handler',
      budget: 2000,
    })

    const unrelatedListUsers = retrievedUnrelated.matched_nodes.find((n) => n.label === 'listUsers()')
    const relatedListUsers = retrievedRelated.matched_nodes.find((n) => n.label === 'listUsers()')
    // Related query's boost should be strictly higher than unrelated.
    expect((relatedListUsers?.framework_boost ?? 0)).toBeGreaterThan(unrelatedListUsers?.framework_boost ?? 0)
  })

  it('boosts runtime_boundary metadata only for matching client/server prompts', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('server_boundary', {
      label: 'persistDashboardOwnerFilter()',
      source_file: '/app/dashboard/actions.ts',
      line_number: 8,
      node_kind: 'function',
      file_type: 'code',
      framework: 'nextjs',
      runtime_boundary: 'server',
      community: 0,
    })
    graph.addNode('client_boundary', {
      label: 'persistDashboardOwnerFilter()',
      source_file: '/components/dashboard-client.tsx',
      line_number: 8,
      node_kind: 'function',
      file_type: 'code',
      framework: 'nextjs',
      runtime_boundary: 'client',
      community: 0,
    })

    const serverPrompt = retrieveContext(graph, {
      question: 'move dashboard owner filter persistence into the Next.js server boundary',
      budget: 2000,
      fileType: 'code',
    })
    const clientPrompt = retrieveContext(graph, {
      question: 'keep dashboard owner filter presentational in the Next.js client boundary',
      budget: 2000,
      fileType: 'code',
    })

    const serverAction = serverPrompt.matched_nodes.find((node) => node.node_id === 'server_boundary')
    const serverDistractor = serverPrompt.matched_nodes.find((node) => node.node_id === 'client_boundary')
    const clientComponent = clientPrompt.matched_nodes.find((node) => node.node_id === 'client_boundary')
    const clientDistractor = clientPrompt.matched_nodes.find((node) => node.node_id === 'server_boundary')

    expect(serverAction).toBeDefined()
    expect(serverDistractor).toBeDefined()
    expect(clientComponent).toBeDefined()
    expect(clientDistractor).toBeDefined()
    expect(serverAction?.framework_boost ?? 0).toBeGreaterThan(serverDistractor?.framework_boost ?? 0)
    expect(clientComponent?.framework_boost ?? 0).toBeGreaterThan(clientDistractor?.framework_boost ?? 0)
  })

  it('does not let runtime_boundary metadata alone seed unrelated server/client nodes', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('relevant_server_boundary', {
      label: 'persistDashboardOwnerFilter()',
      source_file: '/app/dashboard/actions.ts',
      line_number: 8,
      node_kind: 'function',
      file_type: 'code',
      framework: 'nextjs',
      runtime_boundary: 'server',
      community: 0,
    })
    graph.addNode('unrelated_server_boundary', {
      label: 'sendWelcomeEmail()',
      source_file: '/app/onboarding/actions.ts',
      line_number: 12,
      node_kind: 'function',
      file_type: 'code',
      framework: 'nextjs',
      runtime_boundary: 'server',
      community: 0,
    })
    graph.addNode('unrelated_client_boundary', {
      label: 'MarketingBanner()',
      source_file: '/components/marketing-banner.tsx',
      line_number: 4,
      node_kind: 'function',
      file_type: 'code',
      framework: 'nextjs',
      runtime_boundary: 'client',
      community: 0,
    })

    const retrieved = retrieveContext(graph, {
      question: 'move dashboard owner filter persistence into the Next.js server boundary',
      budget: 2000,
      fileType: 'code',
    })

    expect(retrieved.matched_nodes.find((node) => node.node_id === 'relevant_server_boundary')).toBeDefined()
    expect(retrieved.matched_nodes.find((node) => node.node_id === 'unrelated_server_boundary')).toBeUndefined()
    expect(retrieved.matched_nodes.find((node) => node.node_id === 'unrelated_client_boundary')).toBeUndefined()
  })
})
