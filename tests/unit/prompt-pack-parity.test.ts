// #660-A control G5 — prompt-pack output parity across the module-ownership move.
//
// `buildMadarPromptPack` is the single builder behind normal context prompt
// construction, MCP prompt/context construction, and compare/benchmark prompt
// construction. #660-A moves its OWNER module so that normal product paths stop
// carrying the grader loader in their module graph. Nothing about the product
// output may change.
//
// The golden file was captured from the BASE commit before any production edit,
// so a post-extraction diff is a genuine before/after signal rather than a
// snapshot rewritten alongside the code it is meant to check. Regenerate it only
// with MADAR_CAPTURE_PROMPT_PACK_GOLDEN=1 and only from a commit where the
// builder's behaviour is known-good.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import type { ContextSessionState } from '../../src/contracts/context-session.js'
import { buildMadarPromptPack } from '../../src/infrastructure/compare.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

const GOLDEN_PATH = resolve('tests/fixtures/prompt-pack-parity.golden.json')
const WORKSPACE = resolve('out', 'test-runtime', 'prompt-pack-parity')

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('login_route', {
    label: 'POST /login',
    source_file: 'src/routes.ts',
    source_location: 'L2',
    line_number: 2,
    node_kind: 'route',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: 'src/auth.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_manager', {
    label: 'SessionManager',
    source_file: 'src/session.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_store', {
    label: 'SessionStore',
    source_file: 'src/session-store.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 1,
  })
  graph.addEdge('login_route', 'auth_user', { relation: 'handles_route', confidence: 'EXTRACTED', source_file: 'src/routes.ts' })
  graph.addEdge('auth_user', 'session_manager', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('session_manager', 'session_store', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'src/session.ts' })
  return graph
}

const PROJECT_FILES: Record<string, string> = {
  'src/routes.ts': [
    'export function registerRoutes(app) {',
    '  app.post("/login", authenticateUser)',
    '  app.get("/health", () => "ok")',
    '}',
  ].join('\n'),
  'src/auth.ts': [
    'export function authenticateUser(credentials) {',
    '  const session = new SessionManager().createSession(credentials.userId)',
    '  return { status: session ? "ok" : "denied", session }',
    '}',
  ].join('\n'),
  'src/session.ts': [
    'export class SessionManager {',
    '  createSession(userId) {',
    '    return new SessionStore().write(userId)',
    '  }',
    '}',
  ].join('\n'),
  'src/session-store.ts': [
    'export class SessionStore {',
    '  write(userId) {',
    '    return `session:${userId}`',
    '  }',
    '}',
  ].join('\n'),
}

function writeWorkspace(): void {
  for (const [relativePath, content] of Object.entries(PROJECT_FILES)) {
    const absolute = join(WORKSPACE, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `${content}\n`, 'utf8')
  }
}

// A previously-stored session whose payload ref is deliberately stale, so the
// pack must report reuse/invalidation rather than trivially matching.
const SESSION: ContextSessionState = {
  version: 1,
  revision: 3,
  refs: {
    '__stable_prefix:instructions': { hash: 'stale-instructions-hash', token_count: 41 },
    explain_pack_payload: { hash: 'stale-payload-hash', token_count: 512 },
  },
}

/**
 * The matrix required by the #660-A contract: the normal context-prompt shape,
 * the MCP shape (identical builder input, session carried), the compare shape
 * (graphPath present), and the optional/absent-field permutations.
 */
function buildMatrix(): Record<string, unknown> {
  const graph = makeGraph()
  const question = 'how does login create a session and persist it'
  const retrieval = retrieveContext(graph, {
    question,
    budget: 3000,
    retrievalStrategy: 'slice-v1',
  })
  const narrowRetrieval = retrieveContext(graph, {
    question,
    budget: 300,
    retrievalStrategy: 'slice-v1',
  })

  return {
    // normal context prompt construction (no session, no graphPath)
    normal_context_prompt: buildMadarPromptPack({ question, retrieval }),
    // MCP prompt/context construction (session carried forward)
    mcp_with_session: buildMadarPromptPack({ question, retrieval, session: SESSION }),
    // compare / benchmark prompt construction (graphPath present)
    compare_with_graph_path: buildMadarPromptPack({
      question,
      retrieval,
      graphPath: `${WORKSPACE}/out/graph.json`,
    }),
    // optional-field permutation: every optional input supplied at once
    all_optional_fields: buildMadarPromptPack({
      question,
      retrieval,
      graphPath: `${WORKSPACE}/out/graph.json`,
      session: SESSION,
    }),
    // a materially different budget, so a budget-dependent regression is visible
    narrow_budget: buildMadarPromptPack({ question: narrowRetrieval.question, retrieval: narrowRetrieval }),
  }
}

describe('#660-A prompt-pack output parity', () => {
  it('produces byte-identical prompt packs across the module-ownership move', () => {
    writeWorkspace()
    const actual = `${JSON.stringify(buildMatrix(), null, 2)}\n`

    if (process.env['MADAR_CAPTURE_PROMPT_PACK_GOLDEN'] === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, actual, 'utf8')
    }

    const golden = readFileSync(GOLDEN_PATH, 'utf8')
    // Byte equality on purpose. Ordering, whitespace, token counts and session
    // diagnostics are all product output; none of them may move because the
    // builder changed file.
    expect(actual).toBe(golden)
  })

  it('is deterministic across repeated construction', () => {
    writeWorkspace()
    expect(JSON.stringify(buildMatrix())).toBe(JSON.stringify(buildMatrix()))
  })

  it('preserves error behaviour for an unusable retrieval input', () => {
    writeWorkspace()
    // A retrieval without the fields the builder reads must fail the same way
    // before and after the move rather than silently producing a partial pack.
    expect(() => buildMadarPromptPack({
      question: 'x',
      retrieval: undefined as unknown as ReturnType<typeof retrieveContext>,
    })).toThrow()
  })
})
