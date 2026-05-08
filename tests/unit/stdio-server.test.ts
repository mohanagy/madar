import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleStdioRequest, serveGraphStdio } from '../../src/runtime/stdio-server.js'

function createGraphFixtureRoot(): string {
  const parentDir = resolve('graphify-out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'graphify-ts-stdio-'))
  writeFileSync(
    join(root, 'baseline.graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code', community: 0 },
      ],
      edges: [{ source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' }],
      hyperedges: [],
    }),
    'utf8',
  )
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
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
      hyperedges: [],
    }),
    'utf8',
  )
  writeFileSync(join(root, 'GRAPH_REPORT.md'), '# Graph Report\n\n- AuthService calls HttpClient\n', 'utf8')
  writeFileSync(join(root, 'graph.html'), '<!doctype html><title>graphify-ts</title>', 'utf8')
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

describe('stdio runtime', () => {
  // These tests exercise tools across the full MCP surface (query_graph, shortest_path,
  // relevant_files, feature_map, risk_map, implementation_checklist, etc.). The default
  // tool profile in v0.10.1+ is "core" which gates non-core tools, so opt into "full"
  // for the lifetime of this describe. Gating-specific assertions live in
  // tests/unit/stdio-tool-profile.test.ts.
  let previousToolProfile: string | undefined
  beforeAll(() => {
    previousToolProfile = process.env.GRAPHIFY_TOOL_PROFILE
    process.env.GRAPHIFY_TOOL_PROFILE = 'full'
  })
  afterAll(() => {
    if (previousToolProfile === undefined) {
      delete process.env.GRAPHIFY_TOOL_PROFILE
    } else {
      process.env.GRAPHIFY_TOOL_PROFILE = previousToolProfile
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
        params: { uri: 'graphify://artifact/GRAPH_REPORT.md' },
      }))
      const communityPrompt = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 8,
        method: 'prompts/get',
        params: {
          name: 'graph_community_summary_prompt',
          arguments: { community_id: '0' },
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
          serverInfo: { name: 'graphify-ts' },
        },
      })
      expect((prompts?.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(['graph_query_prompt', 'graph_path_prompt', 'graph_explain_prompt', 'graph_community_summary_prompt']),
      )
      expect((resources?.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['graphify://artifact/graph.json', 'graphify://artifact/GRAPH_REPORT.md', 'graphify://artifact/graph.html']),
      )
      const graphResource = (resources?.result as { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> }).resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
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
      input.write(`${JSON.stringify({ id: 2, method: 'resources/subscribe', params: { uri: 'graphify://artifact/graph.json' } })}\n`)

      await delay(25)
      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [{ id: 'updated', label: 'UpdatedNode', source_file: 'updated.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
          hyperedges: [],
        }),
        'utf8',
      )

      input.write(`${JSON.stringify({ id: 3, method: 'ping' })}\n`)
      await delay(25)
      input.write(`${JSON.stringify({ id: 4, method: 'resources/unsubscribe', params: { uri: 'graphify://artifact/graph.json' } })}\n`)

      await delay(25)
      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [{ id: 'updated-again', label: 'UpdatedAgain', source_file: 'updated-again.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
          hyperedges: [],
        }),
        'utf8',
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
          uri: 'graphify://artifact/graph.json',
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
            name: 'graphify-ts',
            title: 'Graphify TS',
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
      writeFileSync(
        graphPath,
        JSON.stringify({
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
          hyperedges: [],
        }),
        'utf8',
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

      expect(retrieveVerbosePayload.matched_nodes.length).toBeGreaterThan(retrieveDefaultPayload.matched_nodes.length)
      expect(retrieveVerbosePayload.matched_nodes.map((node: { label: string }) => node.label)).toEqual(
        expect.arrayContaining(['dashboardRouter', 'DashboardPage']),
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

      expect(retrieveDefaultPayload.matched_nodes).toHaveLength(5)
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
      const explainPackPayload = JSON.parse((explainPack?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const firstPromptPayload = JSON.parse((firstPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const followUpPromptPayload = JSON.parse((followUpPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const resetSessionPayload = JSON.parse((resetSession?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const resetPromptPayload = JSON.parse((resetPrompt?.result as { content: Array<{ text: string }> }).content[0]!.text)

      expect(toolNames).toEqual(expect.arrayContaining(['context_pack', 'context_prompt', 'context_session_reset']))

      expect(explainPackPayload).toEqual(expect.objectContaining({
        task: 'explain',
        prompt: 'How does AuthService reach Transport?',
        budget: 1,
        pack: expect.objectContaining({
          matched_nodes: expect.any(Array),
          community_context: expect.any(Array),
        }),
      }))
      expect(explainPackPayload.coverage).toEqual(expect.objectContaining({
        missing_required: expect.arrayContaining(['supporting', 'structural']),
      }))
      expect(explainPackPayload.expandable).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'nodes' }),
      ]))
      expect(explainPackPayload.missing_context).toEqual(expect.arrayContaining(['supporting', 'structural']))

      expect(firstPromptPayload).toEqual(expect.objectContaining({
        provider: 'claude',
        task: 'explain',
        prompt: 'How does AuthService reach Transport?',
        compiled: expect.objectContaining({
          provider: 'claude',
          format: 'session_payload',
          session_id: 'auth-thread',
          reused_context_tokens: 0,
          session_state: expect.objectContaining({ revision: 1 }),
        }),
      }))
      expect(firstPromptPayload.missing_context).toEqual(expect.any(Array))
      expect(followUpPromptPayload.compiled.session_id).toBe('auth-thread')
      expect(followUpPromptPayload.compiled.session_state.revision).toBe(2)
      expect(followUpPromptPayload.compiled.reused_context_tokens).toBeGreaterThan(0)
      expect(followUpPromptPayload.compiled.effective_token_count).toBeLessThan(followUpPromptPayload.compiled.token_count)

      expect(resetSessionPayload).toEqual({
        session_id: 'auth-thread',
        cleared: true,
      })
      expect(resetPromptPayload.compiled.session_state.revision).toBe(1)
      expect(resetPromptPayload.compiled.reused_context_tokens).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a relevant_files tool that returns ranked files with reasons', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeFileSync(
        graphPath,
        JSON.stringify({
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
          hyperedges: [],
        }),
        'utf8',
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
          matched_symbols: expect.arrayContaining(['GET /users/:id', 'showUserProfile']),
        }),
      )
      expect(relevantFilesPayload.relevant_files[0].why).toContain('GET /users/:id')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a feature_map tool that returns communities, entry points, and starter files', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      writeFileSync(
        graphPath,
        JSON.stringify({
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
          hyperedges: [],
        }),
        'utf8',
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
      expect(featureMapPayload.communities.map((community: { label: string }) => community.label)).toEqual(['Routes', 'Services'])
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
      writeFileSync(
        graphPath,
        JSON.stringify({
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
          hyperedges: [],
        }),
        'utf8',
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
      expect(riskMapPayload.summary).toContain('getUserProfile')
      expect(riskMapPayload.top_risks[0]).toEqual(
        expect.objectContaining({
          label: 'getUserProfile',
          severity: 'high',
        }),
      )
      expect(riskMapPayload.structural_hotspots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'getUserProfile',
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
      writeFileSync(
        graphPath,
        JSON.stringify({
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
          hyperedges: [],
        }),
        'utf8',
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
            title: expect.stringContaining('getUserProfile'),
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

      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [{ id: 'replacement', label: 'ReplacementNode', source_file: 'replacement.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
          hyperedges: [],
        }),
        'utf8',
      )

      const after = handleStdioRequest(graphPath, { id: 2, method: 'node', params: { label: 'ReplacementNode' } })
      const freshnessAfter = handleStdioRequest(graphPath, { id: 12, method: 'resources/list' })

      const versionBefore = (freshnessBefore as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
      )?.annotations?.graph_version
      const versionAfter = (freshnessAfter as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
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
        expect(errorText).toContain('[graphify serve] stdio ready')
        expect(outputText).not.toContain('[graphify serve]')
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
