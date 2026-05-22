import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

const tempRoots: string[] = []
const scratchRoot = join(process.cwd(), '.test-artifacts', 'stdio-slice-surface')
let previousToolProfile: string | undefined

function createGraphPath(): string {
  mkdirSync(scratchRoot, { recursive: true })
  const root = join(scratchRoot, `madar-stdio-slice-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tempRoots.push(root)
  const madarOut = join(root, 'out')
  const graphPath = join(madarOut, 'graph.json')
  mkdirSync(madarOut, { recursive: true })
  writeFileSync(join(root, 'routes.ts'), 'export const loginRoute = "POST /login"\n', 'utf8')
  writeFileSync(join(root, 'controller.ts'), 'export class AuthController { login() {} }\n', 'utf8')
  writeFileSync(join(root, 'auth.ts'), 'export class AuthService { login() {} }\n', 'utf8')
  writeFileSync(join(root, 'session-store.ts'), 'export class SessionStore { createSession() {} }\n', 'utf8')
  writeFileSync(join(root, 'auth.spec.ts'), 'test("login", () => {})\n', 'utf8')
  writeFileSync(join(madarOut, 'GRAPH_REPORT.md'), '# Graph report\n', 'utf8')
  writeFileSync(graphPath, JSON.stringify({
    root_path: root,
    nodes: [
      { id: 'auth_route', label: 'POST /login', source_file: join(root, 'routes.ts'), source_location: 'L1', file_type: 'code', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0 },
      { id: 'auth_controller', label: 'AuthController.login', source_file: join(root, 'controller.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
      { id: 'auth_service', label: 'AuthService.login', source_file: join(root, 'auth.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', community: 0 },
      { id: 'session_store', label: 'SessionStore.createSession', source_file: join(root, 'session-store.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', community: 1 },
      { id: 'auth_test', label: 'AuthService.login.spec', source_file: join(root, 'auth.spec.ts'), source_location: 'L2', file_type: 'code', node_kind: 'function', community: 2 },
    ],
    edges: [
      { source: 'auth_route', target: 'auth_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: join(root, 'routes.ts') },
      { source: 'auth_controller', target: 'auth_service', relation: 'calls', confidence: 'EXTRACTED', source_file: join(root, 'controller.ts') },
      { source: 'auth_service', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: join(root, 'auth.ts') },
      { source: 'auth_service', target: 'auth_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: join(root, 'auth.ts') },
    ],
    hyperedges: [],
  }), 'utf8')
  return graphPath
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

beforeEach(() => {
  previousToolProfile = process.env.MADAR_TOOL_PROFILE
  process.env.MADAR_TOOL_PROFILE = 'full'
})

afterEach(() => {
  if (previousToolProfile === undefined) {
    delete process.env.MADAR_TOOL_PROFILE
  } else {
    process.env.MADAR_TOOL_PROFILE = previousToolProfile
  }
})

describe('stdio slice-v1 surface', () => {
  it('accepts retrieval_strategy=slice-v1 for retrieve and context_pack', async () => {
    const graphPath = createGraphPath()

    const retrieveResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'retrieve',
        arguments: {
          question: 'Explain `AuthService.login`',
          budget: 1000,
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Explain `AuthService.login`',
          budget: 1000,
          task: 'explain',
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const retrieveText = ((retrieveResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''
    const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

    expect(retrieveText).toContain('"retrieval_strategy":"slice-v1"')
    expect(contextPackText).toContain('"retrieval_strategy":"slice-v1"')
  })

  it('rejects unsupported retrieval_strategy values', async () => {
    const graphPath = createGraphPath()

    const retrieveResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'retrieve',
        arguments: {
          question: 'Explain auth',
          budget: 1000,
          retrieval_strategy: 'invented',
        },
      },
    }))

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Explain auth',
          budget: 1000,
          task: 'explain',
          retrieval_strategy: 'invented',
        },
      },
    }))

    expect(JSON.stringify(retrieveResponse)).toContain('retrieval_strategy must be one of default, slice-v1')
    expect(JSON.stringify(contextPackResponse)).toContain('retrieval_strategy must be one of default, slice-v1')
  })

  it('includes execution_slice in runtime-generation context_pack responses', async () => {
    const graphPath = createGraphPath()

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 4,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
          budget: 1000,
          task: 'explain',
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

    expect(contextPackText).toContain('"execution_slice"')
  })

  it('rejects retrieval_strategy for review context packs instead of ignoring it', async () => {
    const graphPath = createGraphPath()

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Review current diff',
          budget: 1000,
          task: 'review',
          retrieval_strategy: 'slice-v1',
        },
      },
    }))

    expect(JSON.stringify(contextPackResponse)).toContain('retrieval_strategy is not supported for task=review')
  })
})
