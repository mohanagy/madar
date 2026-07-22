import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleStdioRequest, serveGraphStdio } from '../../src/runtime/stdio-server.js'
import { graphFreshnessMetadata } from '../../src/runtime/freshness.js'
import { fileContentFingerprint } from '../../src/shared/graph-build-freshness.js'
import { readWatcherStateForGraph, writeWatcherState } from '../../src/infrastructure/watcher-state.js'
import { appendCanonicalGraphNode, readCanonicalGraphFixture, writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

const GRAPH_REGENERATION_INSTRUCTION = 'Run `madar generate . --update` to regenerate it.'

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await delay(10)
  }
  throw new Error('Timed out waiting for expected condition')
}

function createGraphFixtureRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-'))
  writeFileSync(join(root, 'auth.ts'), 'export function AuthService() {\n  return new HttpClient()\n}\n', 'utf8')
  writeFileSync(join(root, 'client.ts'), 'export class HttpClient {\n  request() {\n    return new Transport()\n  }\n}\n', 'utf8')
  writeFileSync(join(root, 'transport.ts'), 'export class Transport {}\n', 'utf8')
  const generatedMs = Date.now()
  const graphBuildFreshness = {
    format_version: 4,
    strategy: 'filesystem',
    generated_at: new Date(generatedMs).toISOString(),
    generated_ms: generatedMs,
    supported_receipt_paths: ['auth.ts', 'client.ts', 'transport.ts'],
    unsupported_receipt_paths: [],
    control_file_fingerprints: {},
    follow_symlinks: false,
    respect_gitignore: false,
    filesystem: {
      file_fingerprints: Object.fromEntries(
        ['auth.ts', 'client.ts', 'transport.ts'].map((sourceFile) => [
          sourceFile,
          fileContentFingerprint(join(root, sourceFile)),
        ]),
      ),
    },
  } as const
  writeCanonicalGraphFixture(
    join(root, 'baseline.graph.json'),
    {
      nodes: [
        { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code', community: 0 },
      ],
      edges: [{ source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' }],
    },
  )
  writeCanonicalGraphFixture(
    join(root, 'graph.json'),
    {
      root_path: root,
      graph_build_freshness: graphBuildFreshness,
      community_labels: {
        '0': 'Auth Services',
        '1': 'Transport Layer',
      },
      semantic_anomalies: [
        {
          id: 'bridge-httpclient',
          kind: 'bridge_node',
          severity: 'HIGH',
          score: 8.4,
          summary: 'HttpClient bridges Auth Services and Transport Layer.',
          why: 'High betweenness across two communities.',
        },
      ],
      nodes: [
        { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code', community: 0 },
        { id: 'transport', label: 'Transport', source_file: 'transport.ts', source_location: '3', file_type: 'code', community: 1 },
      ],
      edges: [
        { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
        { source: 'client', target: 'transport', relation: 'uses', confidence: 'EXTRACTED', source_file: 'client.ts' },
      ],
    },
  )
  writeFileSync(join(root, 'GRAPH_REPORT.md'), '# Graph Report\n\n- AuthService calls HttpClient\n', 'utf8')
  return root
}

function createTimeTravelResult(view: 'summary' | 'risk' | 'drift' | 'timeline' = 'summary') {
  return {
    fromRef: 'main',
    toRef: 'HEAD',
    view,
    summary: {
      headline: 'Time travel changed',
      whyItMatters: ['Cached snapshots keep MCP fast.'],
    },
    changed: {
      nodesAdded: 1,
      nodesRemoved: 0,
      edgesAdded: 1,
      edgesRemoved: 0,
      communities: [{ community: 0, changeCount: 2 }],
    },
    risk: { topImpacts: [] },
    drift: { movedNodes: [] },
    timeline: { events: [] },
  }
}

function createRetrieveOverflowFixtureRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-retrieve-overflow-'))
  const nodes = [
    { id: 'auth', label: 'AuthService', source_file: join(root, 'src', 'auth.ts'), source_location: 'L1-L4', file_type: 'code', community: 0 },
    ...Array.from({ length: 220 }, (_, index) => ({
      id: `support-${index}`,
      label: `SupportNode${index}`,
      source_file: join(root, 'src', `support-${index}.ts`),
      source_location: `L${index + 1}-L${index + 2}`,
      file_type: 'code',
      community: 1,
    })),
  ]
  const edges = Array.from({ length: 220 }, (_, index) => ({
    source: 'auth',
    target: `support-${index}`,
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'auth.ts'),
  }))

  writeCanonicalGraphFixture(
    join(root, 'graph.json'),
    {
      root_path: root,
      community_labels: {
        '0': 'Auth',
        '1': 'Support',
      },
      nodes,
      edges,
    },
  )

  return root
}

function createPrImpactFixtureRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-pr-impact-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })

  const authLines = Array.from({ length: 16 }, (_, index) => `// auth filler ${index + 1}`)
  authLines[4] = 'export function authenticateUser(token: string) {'
  authLines[5] = '  const status = "ok"'
  authLines[6] = '  return token.trim().length > 0 ? status : "fail"'
  authLines[7] = '}'

  const apiLines = Array.from({ length: 12 }, (_, index) => `// api filler ${index + 1}`)
  apiLines[3] = 'import { authenticateUser } from "./auth"'
  apiLines[4] = 'export function ApiHandler(token: string) {'
  apiLines[5] = '  return authenticateUser(token)'
  apiLines[6] = '}'

  writeFileSync(join(root, 'src', 'auth.ts'), `${authLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'src', 'api.ts'), `${apiLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')
  writeFileSync(join(root, 'tests', 'api.test.ts'), 'describe("api", () => {})\n', 'utf8')
  writeCanonicalGraphFixture(
    join(root, 'out', 'graph.json'),
    {
      community_labels: {
        '0': 'Auth Layer',
        '1': 'API Layer',
      },
      nodes: [
        {
          id: 'auth_user',
          label: 'authenticateUser',
          source_file: join(root, 'src', 'auth.ts'),
          source_location: 'L5-L8',
          node_kind: 'function',
          file_type: 'code',
          community: 0,
        },
        {
          id: 'api_handler',
          label: 'ApiHandler',
          source_file: join(root, 'src', 'api.ts'),
          source_location: 'L5-L7',
          node_kind: 'function',
          file_type: 'code',
          community: 1,
        },
      ],
      edges: [
        {
          source: 'api_handler',
          target: 'auth_user',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'api.ts'),
        },
      ],
      root_path: root,
    },
  )

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'madar@example.com'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Madar Test'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root, stdio: 'pipe' })

  return root
}

describe('stdio runtime', () => {
  // These tests exercise tools across the full MCP surface (query_graph, shortest_path,
  // relevant_files, feature_map, risk_map, implementation_checklist, etc.). The default
  // tool profile in v0.10.1+ is "core" which gates non-core tools, so opt into "full"
  // for the lifetime of this describe. Gating-specific assertions live in
  // tests/unit/stdio-tool-profile.test.ts.
  let previousToolProfile: string | undefined
  beforeAll(() => {
    previousToolProfile = process.env.MADAR_TOOL_PROFILE
    process.env.MADAR_TOOL_PROFILE = 'full'
  })
  afterAll(() => {
    if (previousToolProfile === undefined) {
      delete process.env.MADAR_TOOL_PROFILE
    } else {
      process.env.MADAR_TOOL_PROFILE = previousToolProfile
    }
  })

  it('supports basic MCP initialize, tools/list, and tools/call flows', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const compareRefs = vi.fn(async () => createTimeTravelResult('summary'))

      const initialize = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'initialize' }))
      const prompts = await Promise.resolve(handleStdioRequest(graphPath, { id: 2, method: 'prompts/list' }))
      const resources = await Promise.resolve(handleStdioRequest(graphPath, { id: 3, method: 'resources/list' }))
      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 4, method: 'tools/list' }))
      const call = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'shortest_path',
          arguments: { source: 'AuthService', target: 'Transport', maxHops: 3 },
        },
      }))
      const promptGet = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 6,
        method: 'prompts/get',
        params: {
          name: 'graph_query_prompt',
          arguments: { question: 'How does auth reach transport?' },
        },
      }))
      const resourceRead = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 7,
        method: 'resources/read',
        params: { uri: 'madar://artifact/GRAPH_REPORT.md' },
      }))
      const communityPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 8,
        method: 'prompts/get',
        params: {
          name: 'graph_community_summary_prompt',
          arguments: { community_id: '0' },
        },
      }))
      const inboundCommunityPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 9,
        method: 'prompts/get',
        params: {
          name: 'graph_community_summary_prompt',
          arguments: { community_id: '1' },
        },
      }))
      const timeTravelCall = await Promise.resolve(handleStdioRequest(
        graphPath,
        {
          id: 11,
          method: 'tools/call',
          params: {
            name: 'time_travel_compare',
            arguments: {
              from_ref: 'main',
              to_ref: 'HEAD',
              view: 'summary',
              refresh: false,
              limit: 5,
            },
          },
        },
        undefined,
        { compareRefs },
      ))
      const initializedNotification = await Promise.resolve(handleStdioRequest(graphPath, { method: 'notifications/initialized' }))

      expect(initialize).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {
            completions: {},
            logging: {},
            prompts: { listChanged: false },
            resources: { subscribe: true, listChanged: true },
            tools: { listChanged: false },
          },
          serverInfo: { name: 'madar' },
        },
      })
      expect((prompts?.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(['graph_query_prompt', 'graph_path_prompt', 'graph_explain_prompt', 'graph_community_summary_prompt']),
      )
      expect((resources?.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['madar://artifact/graph.json', 'madar://artifact/GRAPH_REPORT.md']),
      )
      expect((resources?.result as { resources: Array<{ uri: string }> }).resources).toHaveLength(2)
      const graphResource = (resources?.result as { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> }).resources.find(
        (resource) => resource.uri === 'madar://artifact/graph.json',
      )
      const toolNames = (tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'query_graph',
          'graph_diff',
          'semantic_anomalies',
          'get_node',
          'get_neighbors',
          'shortest_path',
          'explain_node',
          'graph_stats',
          'get_community',
          'god_nodes',
        ]),
      )
      expect(toolNames).toContain('time_travel_compare')
      expect(graphResource?.annotations?.graph_version).toMatch(/^[a-f0-9]{12}$/)
      expect(graphResource?.annotations?.graph_modified_ms).toEqual(expect.any(Number))
      expect((call?.result as { content: Array<{ type: string; text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect(JSON.parse((timeTravelCall?.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(
        expect.objectContaining({ view: 'summary' }),
      )
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('How does auth reach transport?')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Top communities:')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Auth Services')
      expect((resourceRead?.result as { contents: Array<{ text: string }> }).contents[0]?.text).toContain('# Graph Report')
      expect((resourceRead?.result as { contents: Array<{ annotations?: Record<string, unknown> }> }).contents[0]?.annotations?.graph_version).toMatch(/^[a-f0-9]{12}$/)
      expect((resourceRead?.result as { contents: Array<{ annotations?: Record<string, unknown> }> }).contents[0]?.annotations?.resource_modified_ms).toEqual(
        expect.any(Number),
      )
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Auth Services')
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('AuthService')
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('HttpClient')
      const inboundCommunityText = (inboundCommunityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text ?? ''
      expect(inboundCommunityText).toContain('HttpClient -> Transport (Auth Services)')
      expect(inboundCommunityText).not.toContain('Transport -> HttpClient')
      expect(initializedNotification).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports completion requests for prompt arguments', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const labelCompletion = handleStdioRequest(graphPath, {
        id: 8,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_explain_prompt' },
          argument: { name: 'label', value: 'Auth' },
        },
      })
      const modeCompletion = handleStdioRequest(graphPath, {
        id: 9,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_query_prompt' },
          argument: { name: 'mode', value: 'd' },
        },
      })
      const communityCompletion = handleStdioRequest(graphPath, {
        id: 10,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_community_summary_prompt' },
          argument: { name: 'community_id', value: '' },
        },
      })

      expect(labelCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 8,
        result: {
          completion: {
            values: expect.arrayContaining(['AuthService']),
          },
        },
      })
      expect(modeCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 9,
        result: {
          completion: {
            values: ['dfs'],
            hasMore: false,
          },
        },
      })
      expect(communityCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 10,
        result: {
          completion: {
            values: expect.arrayContaining(['0', '1']),
          },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports logging/setLevel and emits JSON-RPC log notifications for stdio errors', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const input = new PassThrough()
      const output = new PassThrough()
      let outputText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })

      input.end([JSON.stringify({ id: 1, method: 'logging/setLevel', params: { level: 'error' } }), '{bad json'].join('\n'))

      await serveGraphStdio({
        graphPath,
        input,
        output,
      })

      const messages = outputText
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jsonrpc: '2.0', id: 1, result: {} }),
          expect.objectContaining({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: expect.objectContaining({
              level: 'error',
            }),
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports resource subscriptions and emits resource update notifications for subscribed artifacts', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const input = new PassThrough()
      const output = new PassThrough()
      let outputText = ''

      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })

      const serverPromise = serveGraphStdio({
        graphPath,
        input,
        output,
      })

      input.write(`${JSON.stringify({ id: 1, method: 'initialize' })}\n`)
      input.write(`${JSON.stringify({ id: 2, method: 'resources/subscribe', params: { uri: 'madar://artifact/graph.json' } })}\n`)

      await delay(25)
      writeCanonicalGraphFixture(
        graphPath,
        {
          nodes: [{ id: 'updated', label: 'UpdatedNode', source_file: 'updated.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
        },
      )

      input.write(`${JSON.stringify({ id: 3, method: 'ping' })}\n`)
      await delay(25)
      input.write(`${JSON.stringify({ id: 4, method: 'resources/unsubscribe', params: { uri: 'madar://artifact/graph.json' } })}\n`)

      await delay(25)
      writeCanonicalGraphFixture(
        graphPath,
        {
          nodes: [{ id: 'updated-again', label: 'UpdatedAgain', source_file: 'updated-again.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
        },
      )

      input.end(`${JSON.stringify({ id: 5, method: 'ping' })}\n`)
      await serverPromise

      const messages = outputText
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const updatedNotifications = messages.filter((message) => message.method === 'notifications/resources/updated')

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jsonrpc: '2.0', id: 2, result: {} }),
          expect.objectContaining({ jsonrpc: '2.0', id: 3, result: { ok: true } }),
          expect.objectContaining({ jsonrpc: '2.0', id: 4, result: {} }),
          expect.objectContaining({ jsonrpc: '2.0', id: 5, result: { ok: true } }),
        ]),
      )
      expect(updatedNotifications).toHaveLength(1)
      expect(updatedNotifications[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: {
          uri: 'madar://artifact/graph.json',
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports richer MCP snake_case schemas and tool arguments', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const compareRefs = vi.fn(async () => createTimeTravelResult('summary'))

      const initialize = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'initialize' }))
      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 2, method: 'tools/list' }))
      const query = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'query_graph',
          arguments: { question: 'auth transport', token_budget: 256, depth: 3, rank_by: 'degree', community_id: 0, file_type: 'code' },
        },
      }))
      const filteredOut = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 31,
        method: 'tools/call',
        params: {
          name: 'query_graph',
          arguments: { question: 'auth', community_id: 1 },
        },
      }))
      const neighbors = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_neighbors',
          arguments: { label: 'HttpClient', relation_filter: 'uses' },
        },
      }))
      const path = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'shortest_path',
          arguments: { source: 'AuthService', target: 'Transport', max_hops: 3 },
        },
      }))
      const community = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_community',
          arguments: { community_id: 0 },
        },
      }))
      const godNodes = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 7,
        method: 'tools/call',
        params: {
          name: 'god_nodes',
          arguments: { top_n: 1 },
        },
      }))
      const anomalies = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 71,
        method: 'tools/call',
        params: {
          name: 'semantic_anomalies',
          arguments: { top_n: 1 },
        },
      }))
      const diff = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 8,
        method: 'tools/call',
        params: {
          name: 'graph_diff',
          arguments: { baseline_graph_path: join(root, 'baseline.graph.json'), limit: 5 },
        },
      }))
      const directDiff = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 9,
        method: 'diff',
        params: { baseline_graph_path: join(root, 'baseline.graph.json'), limit: 5 },
      }))
      const directAnomalies = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 10,
        method: 'anomalies',
        params: { top_n: 1 },
      }))
      const timeTravel = await Promise.resolve(handleStdioRequest(
        graphPath,
        {
          id: 11,
          method: 'tools/call',
          params: {
            name: 'time_travel_compare',
            arguments: {
              from_ref: 'main',
              to_ref: 'HEAD',
              view: 'summary',
              refresh: false,
              limit: 5,
            },
          },
        },
        undefined,
        { compareRefs },
      ))

      const toolList = (tools?.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const queryTool = toolList.find((tool) => tool.name === 'query_graph')
      const diffTool = toolList.find((tool) => tool.name === 'graph_diff')
      const anomaliesTool = toolList.find((tool) => tool.name === 'semantic_anomalies')
      const neighborsTool = toolList.find((tool) => tool.name === 'get_neighbors')
      const pathTool = toolList.find((tool) => tool.name === 'shortest_path')
      const communityTool = toolList.find((tool) => tool.name === 'get_community')
      const timeTravelTool = toolList.find((tool) => tool.name === 'time_travel_compare')

      expect(initialize).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          serverInfo: {
            name: 'madar',
            title: 'Madar TS',
          },
        },
      })
      expect(queryTool?.inputSchema.properties).toHaveProperty('token_budget')
      expect(queryTool?.inputSchema.properties).toHaveProperty('rank_by')
      expect(queryTool?.inputSchema.properties).toHaveProperty('community_id')
      expect(queryTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(diffTool?.inputSchema.properties).toHaveProperty('baseline_graph_path')
      expect(diffTool?.inputSchema.properties).toHaveProperty('limit')
      expect(anomaliesTool?.inputSchema.properties).toHaveProperty('top_n')
      expect(neighborsTool?.inputSchema.properties).toHaveProperty('relation_filter')
      expect(pathTool?.inputSchema.properties).toHaveProperty('max_hops')
      expect(communityTool?.inputSchema.properties).toHaveProperty('community_id')
      expect(timeTravelTool?.inputSchema.properties).toHaveProperty('from_ref')
      expect(timeTravelTool?.inputSchema.properties).toHaveProperty('to_ref')
      expect(timeTravelTool?.inputSchema.properties).toHaveProperty('view')
      expect(timeTravelTool?.inputSchema.properties).toHaveProperty('refresh')
      expect(timeTravelTool?.inputSchema.properties).toHaveProperty('limit')
      expect(timeTravelTool?.description).toBe(
        'Compare two git refs using on-demand cached graph snapshots and return summary, risk, drift, or timeline output.',
      )
      expect((query?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Traversal:')
      expect((query?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Rank: DEGREE')
      expect((filteredOut?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('No matching nodes found')
      expect((neighbors?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Transport')
      expect((path?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect((community?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Community 0')
      expect((godNodes?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('God nodes')
      expect((anomalies?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Semantic anomalies (1 shown)')
      expect((anomalies?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('HttpClient bridges Auth Services and Transport Layer.')
      expect((diff?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Graph diff: 1 new node, 1 new edge')
      expect((diff?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Transport [transport]')
      expect(JSON.parse((timeTravel?.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(
        expect.objectContaining({ view: 'summary' }),
      )
      expect(directDiff?.result as string).toContain('Before: 2 nodes')
      expect(directDiff?.result as string).toContain('After: 3 nodes')
      expect(directAnomalies?.result as string).toContain('Semantic anomalies (1 shown)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns compact retrieve and impact payloads by default and keeps verbose mode as an escape hatch', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeCanonicalGraphFixture(
        graphPath,
        {
          root_path: '/',
          community_labels: {
            '0': 'Routes',
            '1': 'State',
          },
          nodes: [
            { id: 'dashboard_route', label: '/dashboard', source_file: '/src/routes/dashboard.tsx', line_number: 5, node_kind: 'route', file_type: 'code', framework: 'react-router', framework_role: 'react_router_route', community: 0 },
            { id: 'dashboard_layout', label: 'DashboardLayout', source_file: '/src/routes/dashboard-layout.tsx', line_number: 9, node_kind: 'component', file_type: 'code', framework: 'react-router', framework_role: 'react_router_layout', community: 0 },
            { id: 'dashboard_page_primary', label: 'DashboardPage', source_file: '/src/routes/dashboard-page.tsx', line_number: 12, node_kind: 'component', file_type: 'code', framework: 'react-router', framework_role: 'react_router_component', community: 0 },
            { id: 'dashboard_loader', label: 'dashboardLoader', source_file: '/src/routes/dashboard-loader.ts', line_number: 18, node_kind: 'function', file_type: 'code', framework: 'react-router', framework_role: 'react_router_loader', community: 0 },
            { id: 'dashboard_action', label: 'dashboardAction', source_file: '/src/routes/dashboard-action.ts', line_number: 24, node_kind: 'function', file_type: 'code', framework: 'react-router', framework_role: 'react_router_action', community: 0 },
            { id: 'dashboard_router', label: 'dashboardRouter', source_file: '/src/routes/router.tsx', line_number: 30, node_kind: 'router', file_type: 'code', framework: 'react-router', framework_role: 'react_router', community: 0 },
            { id: 'dashboard_page_secondary', label: 'DashboardPage', source_file: '/src/legacy/dashboard-page.ts', line_number: 36, node_kind: 'function', file_type: 'code', community: 0 },
            { id: 'auth_slice', label: 'auth slice', source_file: '/src/state/authSlice.ts', line_number: 40, node_kind: 'slice', file_type: 'code', framework: 'redux-toolkit', framework_role: 'redux_slice', community: 1 },
            { id: 'select_auth_status', label: 'selectAuthStatus', source_file: '/src/state/authSlice.ts', line_number: 48, node_kind: 'function', file_type: 'code', framework: 'redux-toolkit', framework_role: 'redux_selector', community: 1 },
            { id: 'store', label: 'store', source_file: '/src/state/store.ts', line_number: 55, node_kind: 'store', file_type: 'code', framework: 'redux-toolkit', framework_role: 'redux_store', community: 1 },
          ],
          edges: [
            { source: 'dashboard_route', target: 'dashboard_layout', relation: 'renders', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
            { source: 'dashboard_route', target: 'dashboard_page_primary', relation: 'renders', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
            { source: 'dashboard_route', target: 'dashboard_loader', relation: 'loads_route', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
            { source: 'dashboard_route', target: 'dashboard_action', relation: 'submits_route', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
            { source: 'dashboard_router', target: 'dashboard_route', relation: 'contains', confidence: 'EXTRACTED', source_file: '/src/routes/router.tsx' },
            { source: 'dashboard_route', target: 'dashboard_page_secondary', relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
            { source: 'auth_slice', target: 'select_auth_status', relation: 'defines_selector', confidence: 'EXTRACTED', source_file: '/src/state/authSlice.ts' },
            { source: 'auth_slice', target: 'store', relation: 'registered_in_store', confidence: 'EXTRACTED', source_file: '/src/state/store.ts' },
            { source: 'dashboard_page_primary', target: 'select_auth_status', relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard-page.tsx' },
            { source: 'dashboard_route', target: 'dashboard_page_primary', relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/routes/dashboard.tsx' },
          ],
        },
      )

      const retrieveDefault = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question: 'which react router route renders dashboard page',
            budget: 5000,
            file_type: 'code',
          },
        },
      }))
      const retrieveVerbose = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question: 'which react router route renders dashboard page',
            budget: 5000,
            file_type: 'code',
            verbose: true,
          },
        },
      }))
      const impactDefault = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'impact',
          arguments: {
            label: 'auth slice',
            depth: 4,
          },
        },
      }))
      const impactVerbose = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'impact',
          arguments: {
            label: 'auth slice',
            depth: 4,
            verbose: true,
          },
        },
      }))

      const retrieveDefaultPayload = JSON.parse((retrieveDefault?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const retrieveVerbosePayload = JSON.parse((retrieveVerbose?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const impactDefaultPayload = JSON.parse((impactDefault?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const impactVerbosePayload = JSON.parse((impactVerbose?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(retrieveVerbosePayload.matched_nodes.length).toBeGreaterThanOrEqual(retrieveDefaultPayload.matched_nodes.length)
      expect(retrieveVerbosePayload.matched_nodes.map((node: { label: string }) => node.label)).toEqual(
        expect.arrayContaining(['/dashboard', 'DashboardLayout']),
      )
      expect(retrieveVerbosePayload.shared_file_type).toBeUndefined()
      expect(retrieveVerbosePayload.matched_nodes[0]).toEqual(
        expect.objectContaining({
          node_id: expect.any(String),
          file_type: 'code',
          community_label: expect.any(String),
          framework_boost: expect.any(Number),
        }),
      )
      expect(retrieveVerbosePayload.relationships.length).toBeGreaterThan(0)
      expect(retrieveVerbosePayload.relationships[0]).toEqual(
        expect.objectContaining({
          from_id: expect.any(String),
          from: expect.any(String),
          to_id: expect.any(String),
          to: expect.any(String),
          relation: expect.any(String),
        }),
      )

      expect(impactVerbosePayload.shared_file_type).toBeUndefined()
      expect(impactVerbosePayload.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'selectAuthStatus',
            file_type: 'code',
            framework_role: 'redux_selector',
            community_label: 'State',
          }),
          expect.objectContaining({
            label: 'store',
            file_type: 'code',
            framework_role: 'redux_store',
            community_label: 'State',
          }),
        ]),
      )

      expect(retrieveDefaultPayload.matched_nodes.length).toBeGreaterThan(0)
      expect(retrieveDefaultPayload.shared_file_type).toBe('code')
      expect(retrieveDefaultPayload.matched_nodes[0]).toEqual(
        expect.objectContaining({
          node_id: expect.any(String),
        }),
      )
      expect(retrieveDefaultPayload.matched_nodes[0]).not.toHaveProperty('evidence_class')
      expect(retrieveDefaultPayload.matched_nodes[0]).not.toHaveProperty('file_type')
      expect(retrieveDefaultPayload.matched_nodes[0]).not.toHaveProperty('community_label')
      expect(retrieveDefaultPayload.matched_nodes[0]).not.toHaveProperty('framework_boost')
      expect(retrieveDefaultPayload.coverage).toEqual(expect.objectContaining({
        required_evidence: expect.arrayContaining(['primary', 'supporting', 'structural']),
      }))
      expect(retrieveDefaultPayload.expandable).toEqual(expect.any(Array))
      expect(retrieveDefaultPayload.missing_context).toEqual(expect.any(Array))

      expect(impactDefaultPayload.shared_file_type).toBe('code')
      expect(impactDefaultPayload.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'selectAuthStatus',
          }),
          expect.objectContaining({
            label: 'store',
          }),
        ]),
      )
      expect(impactDefaultPayload.direct_dependents[0]).not.toHaveProperty('file_type')
      expect(impactDefaultPayload.direct_dependents[0]).not.toHaveProperty('framework_role')
      expect(impactDefaultPayload.direct_dependents[0]).not.toHaveProperty('community_label')
      expect(impactDefaultPayload.missing_context).toEqual(expect.any(Array))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds an evidence block to Madar MCP responses that guide agent exploration', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const calls = {
        context_pack: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 100,
          method: 'tools/call',
          params: {
            name: 'context_pack',
            arguments: {
              prompt: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        retrieve: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 101,
          method: 'tools/call',
          params: {
            name: 'retrieve',
            arguments: {
              question: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        relevant_files: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 102,
          method: 'tools/call',
          params: {
            name: 'relevant_files',
            arguments: {
              question: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        feature_map: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 103,
          method: 'tools/call',
          params: {
            name: 'feature_map',
            arguments: {
              question: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        risk_map: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 104,
          method: 'tools/call',
          params: {
            name: 'risk_map',
            arguments: {
              question: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        implementation_checklist: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 105,
          method: 'tools/call',
          params: {
            name: 'implementation_checklist',
            arguments: {
              question: 'How does auth reach transport?',
              budget: 1200,
            },
          },
        })),
        graph_summary: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 106,
          method: 'tools/call',
          params: {
            name: 'graph_summary',
            arguments: {},
          },
        })),
        impact: await Promise.resolve(handleStdioRequest(graphPath, {
          id: 107,
          method: 'tools/call',
          params: {
            name: 'impact',
            arguments: {
              label: 'AuthService',
              depth: 3,
            },
          },
        })),
      } as const

      for (const response of Object.values(calls)) {
        const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text) as {
          evidence?: Record<string, unknown>
        }
        expect(payload.evidence).toEqual(expect.objectContaining({
          pack_confidence: expect.stringMatching(/^(high|medium|low)$/),
          evidence_strength: expect.objectContaining({
            level: expect.stringMatching(/^(strong|moderate|weak)$/),
          }),
          coverage: expect.stringMatching(/^(complete|partial|unknown)$/),
          coverage_detail: expect.objectContaining({
            status: expect.stringMatching(/^(complete|partial|unknown)$/),
            missing_obligations: expect.any(Array),
          }),
          answerability: expect.objectContaining({
            state: expect.stringMatching(/^(ready|ready_with_caveat|verify_targets|insufficient)$/),
            caveats: expect.any(Array),
            verification_targets: expect.any(Array),
            broad_search_fallback: expect.stringMatching(/^(not_needed|targeted_only|allowed|blocked)$/),
          }),
          agent_directive: expect.stringMatching(/^(answer_from_pack|verify_one_targeted_file|explore_with_caution)$/),
          missing_phases: expect.any(Array),
          covered_workflow_owners: expect.any(Array),
        }))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('trims default retrieve expandable follow-up payloads and reuses their handles for context expansion', async () => {
    const root = createRetrieveOverflowFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackHandles: new Map<string, unknown>(),
      }
      const retrieve = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 300,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question: 'auth',
            budget: 1,
          },
        },
      }, sessionState))

      const retrievePayload = JSON.parse((retrieve?.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        expandable: Array<{
          handle_id: string
          follow_up: {
            focus_files: string[]
            focus_ranges: Array<{ source_file: string; start_line: number; end_line: number }>
          }
        }>
      }

      expect(retrievePayload.expandable.length).toBeGreaterThan(0)
      expect(retrievePayload.expandable[0]?.follow_up.focus_files.length).toBeLessThanOrEqual(12)
      expect(retrievePayload.expandable[0]?.follow_up.focus_ranges.length).toBeLessThanOrEqual(12)

      const expanded = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 301,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: retrievePayload.expandable[0]!.handle_id,
            budget: 1200,
          },
        },
      }, sessionState))

      expect(expanded).not.toHaveProperty('error')
      const expandedPayload = JSON.parse((expanded?.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        matched_focus: number
        pack: {
          matched_nodes: Array<{ label: string }>
        }
      }
      expect(expandedPayload.matched_focus).toBeGreaterThan(0)
      expect(expandedPayload.pack.matched_nodes.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns compact pr_impact payloads by default and keeps verbose mode as an escape hatch', async () => {
    const root = createPrImpactFixtureRoot()
    try {
      writeFileSync(
        join(root, 'src', 'auth.ts'),
        readFileSync(join(root, 'src', 'auth.ts'), 'utf8').replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'),
        'utf8',
      )

      const graphPath = join(root, 'out', 'graph.json')
      const prImpactDefault = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 50,
        method: 'tools/call',
        params: {
          name: 'pr_impact',
          arguments: {
            budget: 240,
          },
        },
      }))
      const prImpactVerbose = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 51,
        method: 'tools/call',
        params: {
          name: 'pr_impact',
          arguments: {
            budget: 240,
            verbose: true,
          },
        },
      }))

      const prImpactDefaultPayload = JSON.parse((prImpactDefault?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const prImpactVerbosePayload = JSON.parse((prImpactVerbose?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const defaultSeedNode = prImpactDefaultPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'authenticateUser')
      const verboseSeedNode = prImpactVerbosePayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'authenticateUser')

      expect(prImpactDefaultPayload).not.toHaveProperty('changed_nodes')
      expect(prImpactDefaultPayload).not.toHaveProperty('affected_files')
      expect(prImpactDefaultPayload.review_bundle).toEqual(expect.objectContaining({
        budget: 240,
      }))
      expect(defaultSeedNode).toEqual(expect.objectContaining({
        label: 'authenticateUser',
      }))
      expect(defaultSeedNode).not.toHaveProperty('evidence_class')
      expect(defaultSeedNode).not.toHaveProperty('file_type')
      expect(prImpactDefaultPayload.missing_context).toEqual(expect.any(Array))

      expect(prImpactVerbosePayload.changed_nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'authenticateUser',
        }),
      ]))
      expect(verboseSeedNode).toEqual(expect.objectContaining({
        label: 'authenticateUser',
        evidence_class: 'change',
        file_type: 'code',
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records opt-in context_pack telemetry for MCP success and failure without source-sensitive payloads', async () => {
    const root = createGraphFixtureRoot()
    const previousEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      MADAR_ENABLE_TELEMETRY: process.env.MADAR_ENABLE_TELEMETRY,
      MADAR_DISABLE_TELEMETRY: process.env.MADAR_DISABLE_TELEMETRY,
      DO_NOT_TRACK: process.env.DO_NOT_TRACK,
      CI: process.env.CI,
    }

    try {
      const graphPath = join(root, 'graph.json')
      const configRoot = join(root, 'xdg-config')
      const cacheRoot = join(root, 'xdg-cache')
      mkdirSync(configRoot, { recursive: true })
      mkdirSync(cacheRoot, { recursive: true })
      process.env.XDG_CONFIG_HOME = configRoot
      process.env.XDG_CACHE_HOME = cacheRoot
      process.env.MADAR_ENABLE_TELEMETRY = '1'
      delete process.env.MADAR_DISABLE_TELEMETRY
      delete process.env.DO_NOT_TRACK
      delete process.env.CI

      const success = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 301,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does auth reach transport?',
            budget: 1200,
          },
        },
      }))
      const failure = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 302,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            budget: 1200,
          },
        },
      }))

      expect(success?.error).toBeUndefined()
      expect(failure?.error?.message).toContain('context_pack requires a string prompt parameter')

      const spool = JSON.parse(readFileSync(join(cacheRoot, 'madar', 'telemetry-events.json'), 'utf8')) as {
        schema_version: number
        events: Array<Record<string, unknown>>
      }
      expect(spool).toEqual({
        schema_version: 2,
        events: [
          expect.objectContaining({
            command: 'context_pack',
            stage: 'succeeded',
            repo_size_bucket: '1-24',
            graph_size_bucket: '1-99',
            initial_answerability_bucket: expect.stringMatching(/^(ready|ready_with_caveat|verify_targets|insufficient)$/),
            recovery_attempts_bucket: expect.stringMatching(/^[0-2]$/),
            recovery_improvement_bucket: expect.stringMatching(/^(not_attempted|improved|unchanged)$/),
            final_answerability_bucket: expect.stringMatching(/^(ready|ready_with_caveat|verify_targets|insufficient)$/),
            broad_search_fallback_bucket: expect.stringMatching(/^(not_needed|targeted_only|allowed|blocked)$/),
          }),
          expect.objectContaining({
            command: 'context_pack',
            stage: 'failed',
            failure_bucket: 'invalid_params',
          }),
        ],
      })
      const serialized = JSON.stringify(spool)
      expect(serialized).not.toContain('How does auth reach transport?')
      expect(serialized).not.toContain('auth.ts')
    } finally {
      if (previousEnv.XDG_CONFIG_HOME === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousEnv.XDG_CONFIG_HOME
      }
      if (previousEnv.XDG_CACHE_HOME === undefined) {
        delete process.env.XDG_CACHE_HOME
      } else {
        process.env.XDG_CACHE_HOME = previousEnv.XDG_CACHE_HOME
      }
      if (previousEnv.MADAR_ENABLE_TELEMETRY === undefined) {
        delete process.env.MADAR_ENABLE_TELEMETRY
      } else {
        process.env.MADAR_ENABLE_TELEMETRY = previousEnv.MADAR_ENABLE_TELEMETRY
      }
      if (previousEnv.MADAR_DISABLE_TELEMETRY === undefined) {
        delete process.env.MADAR_DISABLE_TELEMETRY
      } else {
        process.env.MADAR_DISABLE_TELEMETRY = previousEnv.MADAR_DISABLE_TELEMETRY
      }
      if (previousEnv.DO_NOT_TRACK === undefined) {
        delete process.env.DO_NOT_TRACK
      } else {
        process.env.DO_NOT_TRACK = previousEnv.DO_NOT_TRACK
      }
      if (previousEnv.CI === undefined) {
        delete process.env.CI
      } else {
        process.env.CI = previousEnv.CI
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes context-pack and context-prompt MCP flows with reusable prompt sessions', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions: new Map(),
      }
      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const explainPack = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
          },
        },
      }, sessionState))
      const impactPack = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 7,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'What breaks if HttpClient changes?',
            task: 'impact',
            budget: 200,
          },
        },
      }, sessionState))
      const explainPackPayload = JSON.parse((explainPack?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const expandedPack = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 12,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: explainPackPayload.expandable[0].handle_id,
          },
        },
      }, sessionState))
      const firstPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'context_prompt',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            provider: 'claude',
            session_id: 'auth-thread',
          },
        },
      }, sessionState))
      const geminiPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 9,
        method: 'tools/call',
        params: {
          name: 'context_prompt',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            provider: 'gemini',
          },
        },
      }, sessionState))
      const followUpPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'context_prompt',
          arguments: {
            prompt: 'Which file defines HttpClient?',
            provider: 'claude',
            session_id: 'auth-thread',
          },
        },
      }, sessionState))
      const resetSession = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'context_session_reset',
          arguments: {
            session_id: 'auth-thread',
          },
        },
      }, sessionState))
      const resetPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 6,
        method: 'tools/call',
        params: {
          name: 'context_prompt',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            provider: 'claude',
            session_id: 'auth-thread',
          },
        },
      }, sessionState))

      const toolNames = (tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      const impactPackPayload = JSON.parse((impactPack?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const expandedPackPayload = JSON.parse((expandedPack?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const firstPromptPayload = JSON.parse((firstPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const geminiPromptPayload = JSON.parse((geminiPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const followUpPromptPayload = JSON.parse((followUpPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const resetSessionPayload = JSON.parse((resetSession?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const resetPromptPayload = JSON.parse((resetPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(toolNames).toEqual(expect.arrayContaining(['context_pack', 'context_expand', 'context_prompt', 'context_session_reset']))

      expect(explainPackPayload).toEqual(expect.objectContaining({
        task: 'explain',
        task_intent: 'explain',
        prompt: 'How does AuthService reach Transport?',
        budget: 1,
        pack: expect.objectContaining({
          matched_nodes: expect.any(Array),
          community_context: expect.any(Array),
        }),
      }))
      expect(explainPackPayload.serialized_budget).toEqual(expect.objectContaining({
        max_tokens: 1,
      }))
      expect(explainPackPayload.missing_semantic).toEqual(expect.arrayContaining(['structure']))
      expect(explainPackPayload.expandable).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'nodes' }),
      ]))
      expect(explainPackPayload.missing_context).toEqual(expect.arrayContaining(['supporting', 'structural']))
      expect(impactPackPayload).toEqual(expect.objectContaining({
        task: 'impact',
        task_intent: 'impact',
        prompt: 'What breaks if HttpClient changes?',
        target: 'HttpClient',
      }))
      expect(impactPackPayload.coverage).toEqual(expect.objectContaining({
        required_evidence: ['primary', 'impact', 'structural'],
        semantic_entries: expect.arrayContaining([
          expect.objectContaining({
            category: 'implementation',
            status: 'covered',
          }),
        ]),
      }))
      expect(impactPackPayload.coverage.required_evidence).not.toContain('supporting')
      expect(impactPackPayload.missing_context).toEqual(impactPackPayload.coverage.missing_required)
      expect(impactPackPayload.missing_context).not.toContain('supporting')
      expect(impactPackPayload.missing_semantic).not.toContain('implementation')
      expect(expandedPackPayload).toEqual(expect.objectContaining({
        handle_id: explainPackPayload.expandable[0].handle_id,
        task: 'explain',
        task_intent: 'explain',
        pack: expect.objectContaining({
          matched_nodes: expect.any(Array),
        }),
      }))
      expect(expandedPackPayload.matched_focus).toBeGreaterThan(0)
      expect(expandedPackPayload.pack.matched_nodes.length).toBeGreaterThan(0)
      expect(expandedPackPayload.pack.matched_nodes.some((node: { snippet: string | null }) => typeof node.snippet === 'string' && node.snippet.length > 0)).toBe(true)

      expect(firstPromptPayload).toEqual(expect.objectContaining({
        provider: 'claude',
        prompt: 'How does AuthService reach Transport?',
        compiled: expect.objectContaining({
          provider: 'claude',
          format: 'session_payload',
          session_id: 'auth-thread',
          token_count: expect.any(Number),
          session_payload_token_count: expect.any(Number),
          reused_context_tokens: 0,
          session_diagnostics: {
            mode: 'initial',
            previous_revision: null,
            reused_refs: [],
            added_refs: expect.any(Array),
            updated_refs: [],
            invalidated_refs: [],
            reused_context_tokens: 0,
            effective_token_count: expect.any(Number),
          },
          session_state: expect.objectContaining({ revision: 1 }),
        }),
      }))
      expect(firstPromptPayload).not.toHaveProperty('task')
      expect(firstPromptPayload.missing_context).toEqual(expect.any(Array))
      expect(geminiPromptPayload).toEqual(expect.objectContaining({
        provider: 'gemini',
        prompt: 'How does AuthService reach Transport?',
        compiled: expect.objectContaining({
          provider: 'gemini',
          format: 'prompt',
          token_count: firstPromptPayload.compiled.token_count,
        }),
      }))
      expect(geminiPromptPayload).not.toHaveProperty('task')
      expect(followUpPromptPayload.compiled.session_id).toBe('auth-thread')
      expect(followUpPromptPayload.compiled.session_state.revision).toBe(2)
      expect(followUpPromptPayload.compiled.reused_context_tokens).toBeGreaterThan(0)
      expect(followUpPromptPayload.compiled.effective_token_count).toBeLessThan(followUpPromptPayload.compiled.token_count)
      expect(followUpPromptPayload.compiled.session_diagnostics).toEqual({
        mode: 'follow_up',
        previous_revision: 1,
        reused_refs: ['__stable_prefix:instructions', '__stable_prefix:title'],
        added_refs: [],
        updated_refs: ['explain_pack_payload'],
        invalidated_refs: [],
        reused_context_tokens: followUpPromptPayload.compiled.reused_context_tokens,
        effective_token_count: followUpPromptPayload.compiled.effective_token_count,
      })

      expect(resetSessionPayload).toEqual({
        session_id: 'auth-thread',
        cleared: true,
      })
      expect(resetPromptPayload.compiled.session_state.revision).toBe(1)
      expect(resetPromptPayload.compiled.reused_context_tokens).toBe(0)
      expect(resetPromptPayload.compiled.session_diagnostics.mode).toBe('initial')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks identical context_pack requests as cached within the same MCP session', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }

      const first = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      const second = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      const firstPayload = JSON.parse((first?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const secondPayload = JSON.parse((second?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(firstPayload.cache).toEqual(expect.objectContaining({ status: 'miss' }))
      expect(secondPayload.cache).toEqual(expect.objectContaining({
        status: 'hit',
        graph_version: firstPayload.cache.graph_version,
      }))
      expect(secondPayload.pack).toEqual(firstPayload.pack)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rehydrates cached explain context_pack expandable handles before returning a cache hit', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackHandles: new Map<string, unknown>(),
      }

      const first = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
          },
        },
      }, sessionState))

      const firstPayload = JSON.parse((first?.result as { content: Array<{ text: string }> }).content[0]!.text)
      expect(firstPayload.expandable).toEqual(expect.arrayContaining([
        expect.objectContaining({ handle_id: expect.any(String) }),
      ]))
      sessionState.contextPackHandles.clear()

      const second = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
          },
        },
      }, sessionState))

      const secondPayload = JSON.parse((second?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const expanded = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: secondPayload.expandable[0].handle_id,
          },
        },
      }, sessionState))

      const expandedPayload = JSON.parse((expanded?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(firstPayload.expandable[0].handle_id).toBe(secondPayload.expandable[0].handle_id)
      expect(secondPayload.cache).toEqual(expect.objectContaining({ status: 'hit' }))
      expect(expandedPayload).toEqual(expect.objectContaining({
        handle_id: secondPayload.expandable[0].handle_id,
        pack: expect.objectContaining({
          matched_nodes: expect.any(Array),
        }),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recomputes scoped freshness for cached explain context_pack hits before returning', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }

      const first = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
          },
        },
      }, sessionState))

      const firstPayload = JSON.parse((first?.result as { content: Array<{ text: string }> }).content[0]!.text)
      expect(firstPayload.cache).toEqual(expect.objectContaining({ status: 'miss' }))

      writeFileSync(join(root, 'client.ts'), 'export class HttpClient {\n  request() {\n    return new Transport()\n  }\n  refresh() {\n    return true\n  }\n}\n', 'utf8')

      const second = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
          },
        },
      }, sessionState))

      const secondPayload = JSON.parse((second?.result as { content: Array<{ text: string }> }).content[0]!.text)
      expect(secondPayload.cache).toEqual(expect.objectContaining({ status: 'hit' }))
      expect(secondPayload.governance.graph_freshness).toEqual(expect.objectContaining({
        status: 'possibly_stale',
        selected_context_status: 'possibly_stale',
        changed_selected_context_count: 1,
      }))

      const strict = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 1,
            require_fresh_context: true,
          },
        },
      }, sessionState))
      expect((strict as { error?: { message?: string } }).error?.message).toMatch(/selected context/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects require_fresh_context for review context_pack requests instead of ignoring it', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'review current diff',
            task: 'review',
            require_fresh_context: true,
          },
        },
      }))

      expect((response as { error?: { message?: string } }).error?.message).toMatch(/require_fresh_context.*review/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts implement context_pack handles in context_expand', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackHandles: new Map<string, unknown>(),
      }

      const pack = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'implement',
            budget: 1,
          },
        },
      }, sessionState))

      const packPayload = JSON.parse((pack?.result as { content: Array<{ text: string }> }).content[0]!.text)
      expect(packPayload.expandable).toEqual(expect.arrayContaining([
        expect.objectContaining({ handle_id: expect.any(String) }),
      ]))
      expect(packPayload.implementation).toEqual(expect.objectContaining({
        likely_edit_files: expect.any(Array),
        validation_commands: expect.any(Array),
      }))

      const expanded = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: packPayload.expandable[0].handle_id,
          },
        },
      }, sessionState))

      const expandedPayload = JSON.parse((expanded?.result as { content: Array<{ text: string }> }).content[0]!.text)
      expect(expandedPayload).toEqual(expect.objectContaining({
        handle_id: packPayload.expandable[0].handle_id,
        task: 'implement',
        pack: expect.objectContaining({
          matched_nodes: expect.any(Array),
        }),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('invalidates cached context_pack responses after graph.json changes', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }

      const first = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      appendCanonicalGraphNode(graphPath, 'fresh-cache-node', {
        label: 'FreshCacheNode',
        source_file: '/workspace/src/cache.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })

      const second = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      const firstPayload = JSON.parse((first?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const secondPayload = JSON.parse((second?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(firstPayload.cache).toEqual(expect.objectContaining({ status: 'miss' }))
      expect(secondPayload.cache).toEqual(expect.objectContaining({ status: 'miss' }))
      expect(secondPayload.cache.graph_version).not.toBe(firstPayload.cache.graph_version)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not cache review context_pack requests', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }

      const first = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'Review the current changes',
            task: 'review',
            budget: 150,
          },
        },
      }, sessionState))

      const second = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'Review the current changes',
            task: 'review',
            budget: 150,
          },
        },
      }, sessionState))

      const firstPayload = JSON.parse((first?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const secondPayload = JSON.parse((second?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(firstPayload).not.toHaveProperty('cache')
      expect(secondPayload).not.toHaveProperty('cache')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a fresh explain context_pack response when a cached entry is malformed', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackCache: new Map<string, string>([
          [JSON.stringify({
            graph_path: graphPath,
            graph_version: graphFreshnessMetadata(graphPath).graphVersion,
            tool: 'context_pack',
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
            retrieval_level: null,
            retrieval_strategy: null,
            resolution: 'detail',
            verbose: false,
          }), '{'],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(payload.cache).toEqual(expect.objectContaining({ status: 'miss' }))
      expect(payload.pack).toEqual(expect.objectContaining({
        matched_nodes: expect.any(Array),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a fresh explain context_pack response when a cached entry has the wrong shape', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackCache: new Map<string, string>([
          [JSON.stringify({
            graph_path: graphPath,
            graph_version: graphFreshnessMetadata(graphPath).graphVersion,
            tool: 'context_pack',
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
            retrieval_level: null,
            retrieval_strategy: null,
            resolution: 'detail',
            verbose: false,
          }), JSON.stringify({ task: 'explain', prompt: 'How does AuthService reach Transport?' })],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            budget: 150,
          },
        },
      }, sessionState))

      const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(payload.cache).toEqual(expect.objectContaining({ status: 'miss' }))
      expect(payload.pack).toEqual(expect.objectContaining({
        matched_nodes: expect.any(Array),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed stored context-pack handles during expansion', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions: new Map(),
        contextPackHandles: new Map<string, unknown>([
          ['broken-handle', { prompt: 'How does AuthService reach Transport?' }],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: 'broken-handle',
          },
        },
      }, sessionState))

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: "Malformed context_pack handle_id 'broken-handle'. Re-run context_pack and retry context_expand within the same MCP session.",
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects stored context-pack handles with malformed focus ranges during expansion', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions: new Map(),
        contextPackHandles: new Map<string, unknown>([
          ['broken-focus-range', {
            prompt: 'How does AuthService reach Transport?',
            task: 'explain',
            task_intent: 'explain',
            follow_up: {
              kind: 'context_pack',
              task_kind: 'explain',
              evidence_class: 'primary',
              focus_files: ['auth.ts'],
              focus_ranges: [{}],
            },
          }],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: 'broken-focus-range',
          },
        },
      }, sessionState))

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: "Malformed context_pack handle_id 'broken-focus-range'. Re-run context_pack and retry context_expand within the same MCP session.",
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers explicit node line_number values when expanding focused context', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const sourcePath = join(root, 'line-number.ts')
      writeFileSync(sourcePath, 'const first = 1\nconst second = process.env.SECRET\n', 'utf8')

      appendCanonicalGraphNode(graphPath, 'line-node', {
        label: 'LineNode',
        source_file: sourcePath,
        line_number: 2,
        file_type: 'code',
        community: 0,
      })

      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions: new Map(),
        contextPackHandles: new Map<string, unknown>([
          ['line-number-handle', {
            prompt: 'Show the configuration line',
            task: 'explain',
            task_intent: 'runtime-config',
            follow_up: {
              kind: 'context_pack',
              task_kind: 'explain',
              evidence_class: 'supporting',
              focus_files: [sourcePath],
              focus_ranges: [],
            },
          }],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: 'line-number-handle',
          },
        },
      }, sessionState))

      const payload = JSON.parse((response as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? '{}') as {
        pack?: {
          matched_nodes?: Array<{ label: string; line_number: number; snippet: string | null }>
        }
      }
      expect(payload.pack?.matched_nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'LineNode',
          line_number: 2,
          snippet: expect.stringContaining('const second = process.env.SECRET'),
        }),
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not read focused expansion snippets from files outside the graph workspace', async () => {
    const root = createGraphFixtureRoot()
    const outsidePath = resolve(root, '..', 'outside-secret.ts')
    try {
      const graphPath = join(root, 'graph.json')
      writeFileSync(outsidePath, 'const first = 1\nconst secret = process.env.OUTSIDE_SECRET\n', 'utf8')

      appendCanonicalGraphNode(graphPath, 'outside-node', {
        label: 'OutsideSecret',
        source_file: outsidePath,
        line_number: 2,
        file_type: 'code',
        community: 0,
      })

      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions: new Map(),
        contextPackHandles: new Map<string, unknown>([
          ['outside-handle', {
            prompt: 'Show the outside secret line',
            task: 'explain',
            task_intent: 'runtime-config',
            follow_up: {
              kind: 'context_pack',
              task_kind: 'explain',
              evidence_class: 'supporting',
              focus_files: [outsidePath],
              focus_ranges: [],
            },
          }],
        ]),
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'context_expand',
          arguments: {
            handle_id: 'outside-handle',
          },
        },
      }, sessionState))

      const payload = JSON.parse((response as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? '{}') as {
        pack?: {
          matched_nodes?: Array<{ label: string; snippet: string | null }>
        }
      }
      expect(payload.pack?.matched_nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'OutsideSecret',
          snippet: null,
        }),
      ]))
    } finally {
      rmSync(outsidePath, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('evicts the oldest stored context prompt session when the session cache is full', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const contextPromptSessions = new Map(
        Array.from({ length: 256 }, (_, index) => [
          `session-${index}`,
          { version: 1 as const, revision: index, refs: {} },
        ] as const),
      )
      const sessionState = {
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPromptSessions,
      }

      const response = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 10,
        method: 'tools/call',
        params: {
          name: 'context_prompt',
          arguments: {
            prompt: 'How does AuthService reach Transport?',
            provider: 'claude',
            session_id: 'session-256',
          },
        },
      }, sessionState))

      expect(response).not.toBeNull()
      expect(contextPromptSessions.size).toBe(256)
      expect(contextPromptSessions.has('session-0')).toBe(false)
      expect(contextPromptSessions.has('session-1')).toBe(true)
      expect(contextPromptSessions.has('session-256')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a relevant_files tool that returns ranked files with reasons', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeCanonicalGraphFixture(
        graphPath,
        {
          root_path: '/workspace',
          nodes: [
            { id: 'route_users_show', label: 'GET /users/:id', source_file: '/workspace/src/routes/users.ts', line_number: 12, node_kind: 'route', file_type: 'code', framework: 'express', framework_role: 'express_route', community: 0 },
            { id: 'show_user_profile', label: 'showUserProfile', source_file: '/workspace/src/routes/users.ts', line_number: 24, node_kind: 'function', file_type: 'code', community: 0 },
            { id: 'get_user_profile', label: 'getUserProfile', source_file: '/workspace/src/services/users.ts', line_number: 8, node_kind: 'function', file_type: 'code', community: 1, contextual_prefix: 'Loads user profile data for the users route handler.' },
            { id: 'logger', label: 'Logger', source_file: '/workspace/src/utils/logger.ts', line_number: 3, node_kind: 'class', file_type: 'code', community: 2 },
          ],
          edges: [
            { source: 'route_users_show', target: 'show_user_profile', relation: 'handles_route', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'logger', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
          ],
        },
      )

      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const relevantFilesCall = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'relevant_files',
          arguments: {
            question: 'where should I edit the user profile route',
            limit: 2,
            file_type: 'code',
          },
        },
      }))

      const toolList = (tools?.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const relevantFilesTool = toolList.find((tool) => tool.name === 'relevant_files')
      const relevantFilesPayload = JSON.parse((relevantFilesCall?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(relevantFilesTool?.inputSchema.properties).toHaveProperty('question')
      expect(relevantFilesTool?.inputSchema.properties).toHaveProperty('limit')
      expect(relevantFilesTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(relevantFilesPayload.relevant_files.map((entry: { path: string }) => entry.path)).toEqual([
        'src/routes/users.ts',
        'src/services/users.ts',
      ])
      expect(relevantFilesPayload.relevant_files[0]).toEqual(
        expect.objectContaining({
          path: 'src/routes/users.ts',
          matched_symbols: expect.arrayContaining(['showUserProfile']),
        }),
      )
      expect(relevantFilesPayload.relevant_files[0].why).toContain('showUserProfile')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a feature_map tool that returns communities, entry points, and starter files', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeCanonicalGraphFixture(
        graphPath,
        {
          root_path: '/workspace',
          community_labels: {
            '0': 'Routes',
            '1': 'Services',
            '2': 'Utilities',
          },
          nodes: [
            { id: 'route_users_show', label: 'GET /users/:id', source_file: '/workspace/src/routes/users.ts', line_number: 12, node_kind: 'route', file_type: 'code', framework: 'express', framework_role: 'express_route', community: 0 },
            { id: 'show_user_profile', label: 'showUserProfile', source_file: '/workspace/src/routes/users.ts', line_number: 24, node_kind: 'function', file_type: 'code', community: 0 },
            { id: 'get_user_profile', label: 'getUserProfile', source_file: '/workspace/src/services/users.ts', line_number: 8, node_kind: 'function', file_type: 'code', community: 1, contextual_prefix: 'Loads user profile data for the users route handler.' },
            { id: 'logger', label: 'Logger', source_file: '/workspace/src/utils/logger.ts', line_number: 3, node_kind: 'class', file_type: 'code', community: 2 },
          ],
          edges: [
            { source: 'route_users_show', target: 'show_user_profile', relation: 'handles_route', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'logger', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
          ],
        },
      )

      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const featureMapCall = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'feature_map',
          arguments: {
            question: 'where should I edit the user profile route',
            limit: 2,
            file_type: 'code',
          },
        },
      }))

      const toolList = (tools?.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const featureMapTool = toolList.find((tool) => tool.name === 'feature_map')
      const featureMapPayload = JSON.parse((featureMapCall?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(featureMapTool?.inputSchema.properties).toHaveProperty('question')
      expect(featureMapTool?.inputSchema.properties).toHaveProperty('limit')
      expect(featureMapTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(featureMapPayload.summary).toContain('Routes')
      expect(featureMapPayload.communities.map((community: { label: string }) => community.label)).toEqual(
        expect.arrayContaining(['Routes']),
      )
      expect(featureMapPayload.entry_points[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          source_file: 'src/routes/users.ts',
        }),
      )
      expect(featureMapPayload.relevant_files[0].path).toBe('src/routes/users.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a risk_map tool that returns top risks and structural hotspots', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeCanonicalGraphFixture(
        graphPath,
        {
          root_path: '/workspace',
          community_labels: {
            '0': 'Routes',
            '1': 'Services',
            '2': 'Persistence',
            '3': 'Account UI',
          },
          nodes: [
            { id: 'route_users_show', label: 'GET /users/:id', source_file: '/workspace/src/routes/users.ts', line_number: 12, node_kind: 'route', file_type: 'code', framework: 'express', framework_role: 'express_route', community: 0 },
            { id: 'show_user_profile', label: 'showUserProfile', source_file: '/workspace/src/routes/users.ts', line_number: 24, node_kind: 'function', file_type: 'code', community: 0 },
            { id: 'get_user_profile', label: 'getUserProfile', source_file: '/workspace/src/services/users.ts', line_number: 8, node_kind: 'function', file_type: 'code', community: 1, contextual_prefix: 'Loads user profile data for the users route handler.' },
            { id: 'database', label: 'DatabaseConnection', source_file: '/workspace/src/persistence/database.ts', line_number: 4, node_kind: 'class', file_type: 'code', community: 2 },
            { id: 'hydrate_account', label: 'hydrateAccountScreen', source_file: '/workspace/src/account/screen.ts', line_number: 14, node_kind: 'function', file_type: 'code', community: 3 },
          ],
          edges: [
            { source: 'route_users_show', target: 'show_user_profile', relation: 'handles_route', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'hydrate_account', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/account/screen.ts' },
            { source: 'get_user_profile', target: 'database', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/services/users.ts' },
          ],
        },
      )

      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const riskMapCall = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'risk_map',
          arguments: {
            question: 'where should I edit the user profile route',
            limit: 3,
            file_type: 'code',
          },
        },
      }))

      const toolList = (tools?.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const riskMapTool = toolList.find((tool) => tool.name === 'risk_map')
      const riskMapPayload = JSON.parse((riskMapCall?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(riskMapTool?.inputSchema.properties).toHaveProperty('question')
      expect(riskMapTool?.inputSchema.properties).toHaveProperty('limit')
      expect(riskMapTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(['showUserProfile', 'getUserProfile']).toContain(riskMapPayload.top_risks[0]?.label)
      expect(riskMapPayload.summary).toContain(riskMapPayload.top_risks[0]?.label)
      expect(riskMapPayload.top_risks[0]).toEqual(
        expect.objectContaining({
          severity: 'high',
        }),
      )
      expect(riskMapPayload.structural_hotspots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'showUserProfile',
            type: 'bridge',
          }),
        ]),
      )
      expect(riskMapPayload.starter_files[0].path).toBe('src/routes/users.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes an implementation_checklist tool that returns edit steps and validation checkpoints', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeCanonicalGraphFixture(
        graphPath,
        {
          root_path: '/workspace',
          community_labels: {
            '0': 'Routes',
            '1': 'Services',
            '2': 'Persistence',
            '3': 'Account UI',
          },
          nodes: [
            { id: 'route_users_show', label: 'GET /users/:id', source_file: '/workspace/src/routes/users.ts', line_number: 12, node_kind: 'route', file_type: 'code', framework: 'express', framework_role: 'express_route', community: 0 },
            { id: 'show_user_profile', label: 'showUserProfile', source_file: '/workspace/src/routes/users.ts', line_number: 24, node_kind: 'function', file_type: 'code', community: 0 },
            { id: 'get_user_profile', label: 'getUserProfile', source_file: '/workspace/src/services/users.ts', line_number: 8, node_kind: 'function', file_type: 'code', community: 1, contextual_prefix: 'Loads user profile data for the users route handler.' },
            { id: 'database', label: 'DatabaseConnection', source_file: '/workspace/src/persistence/database.ts', line_number: 4, node_kind: 'class', file_type: 'code', community: 2 },
            { id: 'hydrate_account', label: 'hydrateAccountScreen', source_file: '/workspace/src/account/screen.ts', line_number: 14, node_kind: 'function', file_type: 'code', community: 3 },
          ],
          edges: [
            { source: 'route_users_show', target: 'show_user_profile', relation: 'handles_route', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'show_user_profile', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/routes/users.ts' },
            { source: 'hydrate_account', target: 'get_user_profile', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/account/screen.ts' },
            { source: 'get_user_profile', target: 'database', relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/src/services/users.ts' },
          ],
        },
      )

      const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const checklistCall = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'implementation_checklist',
          arguments: {
            question: 'where should I edit the user profile route',
            limit: 3,
            file_type: 'code',
          },
        },
      }))

      const toolList = (tools?.result as { tools: Array<{ name: string; description?: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const checklistTool = toolList.find((tool) => tool.name === 'implementation_checklist')
      const checklistPayload = JSON.parse((checklistCall?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(checklistTool?.inputSchema.properties).toHaveProperty('question')
      expect(checklistTool?.inputSchema.properties).toHaveProperty('limit')
      expect(checklistTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(checklistPayload.summary).toContain('src/routes/users.ts')
      expect(checklistPayload.edit_steps[0]).toEqual(
        expect.objectContaining({
          path: 'src/routes/users.ts',
        }),
      )
      expect(checklistPayload.validation_steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining('GET /users/:id'),
          }),
          expect.objectContaining({
            title: expect.stringContaining('showUserProfile'),
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles stdio requests for query and path-like methods', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const ping = handleStdioRequest(graphPath, { id: 1, method: 'ping' })
      const path = handleStdioRequest(graphPath, { id: 2, method: 'path', params: { source: 'AuthService', target: 'Transport', maxHops: 3 } })
      const explain = handleStdioRequest(graphPath, { id: 3, method: 'explain', params: { label: 'HttpClient', relation: 'uses' } })

      expect(ping).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      expect(path).not.toBeNull()
      expect(explain).not.toBeNull()
      expect((path as { result: string }).result).toContain('Shortest path (2 hops)')
      expect((explain as { result: string }).result).toContain('Node: HttpClient')
      expect((explain as { result: string }).result).toContain('Neighbors of HttpClient')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reloads the cached graph when graph.json changes on disk', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const before = handleStdioRequest(graphPath, { id: 1, method: 'stats' })
      const freshnessBefore = handleStdioRequest(graphPath, { id: 11, method: 'resources/list' })

      writeCanonicalGraphFixture(
        graphPath,
        {
          nodes: [{ id: 'replacement', label: 'ReplacementNode', source_file: 'replacement.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
        },
      )

      const after = handleStdioRequest(graphPath, { id: 2, method: 'node', params: { label: 'ReplacementNode' } })
      const freshnessAfter = handleStdioRequest(graphPath, { id: 12, method: 'resources/list' })

      const versionBefore = (freshnessBefore as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'madar://artifact/graph.json',
      )?.annotations?.graph_version
      const versionAfter = (freshnessAfter as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'madar://artifact/graph.json',
      )?.annotations?.graph_version

      expect((before as { result: string }).result).toContain('Nodes: 3')
      expect((after as { result: string }).result).toContain('Node: ReplacementNode')
      expect(versionBefore).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).not.toBe(versionBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reloads the cached graph when graph.json size changes without an mtime change', async () => {
    const root = createGraphFixtureRoot()
    const graphPath = join(root, 'graph.json')
    const originalGraphStat = statSync(graphPath)
    let freezeGraphMtime = false

    try {
      vi.resetModules()
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        return {
          ...actual,
          statSync(path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) {
            const stat = actual.statSync(path, options as never)
            if (freezeGraphMtime && path === graphPath) {
              return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
                mtimeMs: originalGraphStat.mtimeMs,
                mtime: originalGraphStat.mtime,
              })
            }
            return stat
          },
        }
      })

      const { handleStdioRequest: isolatedHandleStdioRequest } = await import('../../src/runtime/stdio-server.js')

      const before = isolatedHandleStdioRequest(graphPath, { id: 1, method: 'stats' })
      const freshnessBefore = isolatedHandleStdioRequest(graphPath, { id: 11, method: 'resources/list' })

      writeCanonicalGraphFixture(
        graphPath,
        {
          nodes: [{ id: 'replacement', label: 'ReplacementNode', source_file: 'replacement.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
        },
      )
      freezeGraphMtime = true

      const after = isolatedHandleStdioRequest(graphPath, { id: 2, method: 'node', params: { label: 'ReplacementNode' } })
      const freshnessAfter = isolatedHandleStdioRequest(graphPath, { id: 12, method: 'resources/list' })

      const versionBefore = (freshnessBefore as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'madar://artifact/graph.json',
      )?.annotations?.graph_version
      const versionAfter = (freshnessAfter as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'madar://artifact/graph.json',
      )?.annotations?.graph_version

      expect((before as { result: string }).result).toContain('Nodes: 3')
      expect((after as { result: string }).result).toContain('Node: ReplacementNode')
      expect(versionBefore).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).not.toBe(versionBefore)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refreshes an active stdio session after an agent changes its workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-stdio-auto-refresh-'))
    const graphPath = join(root, 'out', 'graph.json')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })

    writeFileSync(join(root, 'initial.ts'), 'export const initialValue = 1\n', 'utf8')
    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      autoRefreshDebounceSeconds: 0.02,
      input,
      output,
      errorOutput,
    })

    try {
      await waitFor(() => {
        if (!existsSync(graphPath)) {
          return false
        }
        const graph = readCanonicalGraphFixture(graphPath)
        return graph.nodes.some((node) => node.source_file.endsWith('initial.ts'))
      })
      const initialGraph = readCanonicalGraphFixture(graphPath)

      input.write(`${JSON.stringify({ id: 1, method: 'stats' })}\n`)
      await waitFor(() => outputText.includes('"id":1'))

      writeFileSync(join(root, 'added.ts'), 'export function addedDuringSession() { return 2 }\n', 'utf8')
      await waitFor(() => {
        const graph = readCanonicalGraphFixture(graphPath)
        return graph.nodes.some((node) => node.source_file.endsWith('added.ts'))
      })

      input.end(`${JSON.stringify({ id: 2, method: 'stats' })}\n`)
      await serverPromise

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as Array<{ id?: number; result?: string }>
      const before = responses.find((response) => response.id === 1)
      const after = responses.find((response) => response.id === 2)
      const refreshedGraph = readCanonicalGraphFixture(graphPath)

      expect(before?.result).toContain(`Nodes: ${initialGraph.nodes.length}`)
      expect(after?.result).toContain(`Nodes: ${refreshedGraph.nodes.length}`)
      expect(after?.result).not.toBe(before?.result)
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('holds one graph request while an auto-refresh event is pending, then answers it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-stdio-pending-refresh-'))
    const graphPath = join(root, 'out', 'graph.json')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })

    writeFileSync(join(root, 'initial.ts'), 'export const initialValue = 1\n', 'utf8')
    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      autoRefreshDebounceSeconds: 0.5,
      autoRefreshRequestWaitMs: 2_500,
      input,
      output,
      errorOutput,
    })

    try {
      await waitFor(() => existsSync(graphPath) && readWatcherStateForGraph(graphPath)?.status === 'idle')
      writeFileSync(join(root, 'added.ts'), 'export const addedDuringSession = 2\n', 'utf8')
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'pending')

      input.write(`${JSON.stringify({ id: 31, method: 'stats' })}\n`)
      await delay(50)
      expect(outputText).not.toContain('"id":31')

      await waitFor(() => {
        if (readWatcherStateForGraph(graphPath)?.status !== 'idle') {
          return false
        }
        const graph = readCanonicalGraphFixture(graphPath)
        return graph.nodes.some((node) => node.source_file.endsWith('added.ts'))
      })
      await waitFor(() => outputText.includes('"id":31'))
      input.end(`${JSON.stringify({ id: 32, method: 'stats' })}\n`)
      await serverPromise

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as Array<{
          id?: number
          result?: string
          error?: { message?: string; data?: Record<string, unknown> }
        }>
      expect(responses.find((response) => response.id === 31)?.result).toContain('Nodes:')
      expect(responses.find((response) => response.id === 31)?.error).toBeUndefined()
      expect(responses.find((response) => response.id === 32)?.result).toContain('Nodes:')
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('refuses failed, incomplete, reconciling, and policy-mismatched auto-refresh states', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-stdio-watcher-gates-'))
    const graphPath = join(root, 'out', 'graph.json')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      autoRefreshRequestWaitMs: 0,
      input,
      output,
      errorOutput,
    })

    try {
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'idle')
      const idle = readWatcherStateForGraph(graphPath)
      if (!idle) {
        throw new Error('Expected auto-refresh watcher state')
      }
      const cases = [
        { id: 41, state: { ...idle, status: 'failed' as const, coverage: 'failed' as const, failure_reason: 'scan failed' } },
        { id: 42, state: { ...idle, coverage: 'unknown' as const } },
        { id: 43, state: { ...idle, status: 'reconciling' as const } },
        { id: 44, state: { ...idle, policy_match: false } },
      ]

      for (const testCase of cases) {
        writeWatcherState(join(root, 'out'), testCase.state)
        input.write(`${JSON.stringify({ id: testCase.id, method: 'stats' })}\n`)
        await waitFor(() => outputText.includes(`"id":${testCase.id}`))
      }

      const manifestPath = join(root, 'out', 'manifest.json')
      const originalManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { __madar_meta__?: { generation_policy?: unknown } }
      const mismatchedManifest = JSON.parse(JSON.stringify(originalManifest)) as { __madar_meta__?: { generation_policy?: unknown } }
      if (mismatchedManifest.__madar_meta__) {
        delete mismatchedManifest.__madar_meta__.generation_policy
      }
      writeWatcherState(join(root, 'out'), idle)
      writeFileSync(manifestPath, `${JSON.stringify(mismatchedManifest, null, 2)}\n`, 'utf8')
      input.write(`${JSON.stringify({ id: 46, method: 'stats' })}\n`)
      await waitFor(() => outputText.includes('"id":46'))

      writeFileSync(manifestPath, `${JSON.stringify(originalManifest, null, 2)}\n`, 'utf8')
      input.end(`${JSON.stringify({ id: 45, method: 'stats' })}\n`)
      await serverPromise

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as Array<{
          id?: number
          result?: string
          error?: { message?: string; data?: Record<string, unknown> }
        }>
      for (const id of [41, 42, 44, 46]) {
        expect(responses.find((response) => response.id === id)?.error?.message).toContain(
          'auto-refresh cannot guarantee a fresh graph',
        )
        expect(responses.find((response) => response.id === id)?.error?.data).toMatchObject({
          retryable: false,
          suggested_action: 'repair_graph',
        })
      }
      expect(responses.find((response) => response.id === 43)?.error).toMatchObject({
        message: expect.stringContaining('temporarily reconciling'),
        data: {
          state: 'reconciling',
          retryable: true,
          retry_after_ms: 1_000,
          suggested_action: 'retry_same_request',
        },
      })
      expect(responses.find((response) => response.id === 45)?.result).toContain('Nodes:')
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('keeps MCP control requests responsive while another process holds the refresh lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-stdio-refresh-lease-'))
    const graphPath = join(root, 'out', 'graph.json')
    const lockPath = join(root, 'out', '.madar-refresh.lock')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      autoRefreshDebounceSeconds: 0.02,
      autoRefreshRequestWaitMs: 2_500,
      input,
      output,
      errorOutput,
    })

    try {
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'idle')
      writeFileSync(lockPath, `${process.pid} external-test-lease ${new Date().toISOString()}\n`, 'utf8')
      writeFileSync(join(root, 'main.ts'), 'export const value = 2\n', 'utf8')
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'reconciling')

      input.write(`${JSON.stringify({ id: 52, method: 'stats' })}\n`)
      input.write(`${JSON.stringify({ id: 51, method: 'ping' })}\n`)
      await waitFor(() => outputText.includes('"id":51'), 1_000)
      expect(outputText).not.toContain('"id":52')
      rmSync(lockPath, { force: true })
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'idle')
      await waitFor(() => outputText.includes('"id":52'), 1_000)
      input.end(`${JSON.stringify({ id: 53, method: 'stats' })}\n`)
      await serverPromise

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          id?: number
          result?: unknown
          error?: {
            message?: string
            data?: {
              state?: string
              retryable?: boolean
              retry_after_ms?: number
              suggested_action?: string
            }
          }
        })
      expect(responses.find((response) => response.id === 51)?.result).toEqual({ ok: true })
      expect(responses.find((response) => response.id === 52)?.result).toEqual(expect.any(String))
      expect(responses.find((response) => response.id === 52)?.error).toBeUndefined()
      expect(responses.find((response) => response.id === 53)?.result).toEqual(expect.any(String))
    } finally {
      rmSync(lockPath, { force: true })
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('returns JSON-RPC-style errors for invalid requests', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      expect(handleStdioRequest(graphPath, null)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request' },
      })
      expect(handleStdioRequest(graphPath, { id: 9, method: 'mystery' })).toEqual({
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32601, message: 'Method not found: mystery' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the graph regeneration instruction for legacy artifacts across MCP reads', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [] }), 'utf8')

      const responses = await Promise.all([
        Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'stats' })),
        Promise.resolve(handleStdioRequest(graphPath, {
          id: 2,
          method: 'tools/call',
          params: { name: 'graph_stats', arguments: {} },
        })),
        Promise.resolve(handleStdioRequest(graphPath, {
          id: 3,
          method: 'resources/read',
          params: { uri: 'madar://artifact/graph.json' },
        })),
      ])

      for (const response of responses) {
        expect(response?.error?.code).toBe(-32000)
        expect(response?.error?.message).toContain(GRAPH_REGENERATION_INSTRUCTION)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves JSON-line requests over stdio streams', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const input = new PassThrough()
      const output = new PassThrough()
      const errorOutput = new PassThrough()
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
      let outputText = ''
      let errorText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })
      errorOutput.on('data', (chunk) => {
        errorText += chunk.toString('utf8')
      })

      input.end(
        [
          JSON.stringify({ id: 1, method: 'stats' }),
          JSON.stringify({ method: 'notifications/initialized' }),
          '{bad json',
          JSON.stringify({ id: 2, method: 'node', params: { label: 'AuthService' } }),
        ].join('\n'),
      )

      try {
        await serveGraphStdio({ graphPath, input, output, errorOutput })

        const responses = outputText
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const rpcResponses = responses.filter((message) => 'id' in message)
        const notifications = responses.filter((message) => message.method === 'notifications/message')

        expect(consoleLog).not.toHaveBeenCalled()
        expect(errorText).toContain('[madar serve] stdio ready')
        expect(outputText).not.toContain('[madar serve]')
        expect(notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: expect.objectContaining({
                level: 'error',
              }),
            }),
          ]),
        )
        expect(rpcResponses[0]).toMatchObject({ jsonrpc: '2.0', id: 1 })
        expect(rpcResponses[0].result).toContain('Nodes: 3')
        expect(rpcResponses[1]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        expect(rpcResponses[2]).toMatchObject({ jsonrpc: '2.0', id: 2 })
        expect(rpcResponses[2].result).toContain('Node: AuthService')
      } finally {
        consoleLog.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('graph_summary MCP tool', () => {
  it('is listed by tools/list in the default (core) tool profile', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const response = await Promise.resolve(handleStdioRequest(graphPath, { id: 200, method: 'tools/list' }))
      expect(response).not.toBeNull()
      const toolNames = (response as { result?: { tools: Array<{ name: string }> } }).result?.tools.map((tool) => tool.name)
      expect(toolNames).toContain('graph_summary')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tools/call graph_summary returns structured JSON text payload', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const response = await Promise.resolve(
        handleStdioRequest(graphPath, {
          id: 201,
          method: 'tools/call',
          params: { name: 'graph_summary', arguments: {} },
        }),
      )
      expect(response).not.toBeNull()
      const error = (response as { error?: unknown }).error
      expect(error).toBeUndefined()

      const text = (response as { result: { content: Array<{ type: string; text: string }> } }).result.content[0]?.text
      expect(typeof text).toBe('string')

       const payload = JSON.parse(text!) as Record<string, unknown>
       expect(typeof payload['node_count']).toBe('number')
       expect(typeof payload['edge_count']).toBe('number')
       expect(typeof payload['file_count']).toBe('number')
       expect(typeof payload['community_count']).toBe('number')
        expect(Array.isArray(payload['top_modules'])).toBe(true)
        expect(Array.isArray(payload['entrypoints'])).toBe(true)
        expect(Array.isArray(payload['frameworks'])).toBe(true)
        expect(Array.isArray(payload['runtime_paths'])).toBe(true)
        const sourceDomains = payload['source_domains']
        expect(sourceDomains).not.toBeNull()
        expect(sourceDomains).not.toBeUndefined()
        expect(typeof sourceDomains).toBe('object')
        expect(Array.isArray(sourceDomains)).toBe(false)
        expect(Object.prototype.toString.call(sourceDomains)).toBe('[object Object]')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
})
