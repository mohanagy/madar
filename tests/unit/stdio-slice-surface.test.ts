import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import * as retrieveRuntime from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

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
    directed: true,
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

function createBackendRuntimeGraphPath(): string {
  mkdirSync(scratchRoot, { recursive: true })
  const root = join(scratchRoot, `madar-stdio-slice-backend-${randomUUID()}`)
  mkdirSync(join(root, 'backend', 'src', 'spi'), { recursive: true })
  mkdirSync(join(root, 'backend', 'src', 'runtime'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })
  tempRoots.push(root)
  const graphPath = join(root, 'out', 'graph.json')
  writeFileSync(join(root, 'backend', 'src', 'auth-route.ts'), 'export const loginRoute = "POST /login"\n', 'utf8')
  writeFileSync(join(root, 'backend', 'src', 'auth-controller.ts'), 'export class AuthController { login() {} }\n', 'utf8')
  writeFileSync(join(root, 'backend', 'src', 'spi', 'auth-service.spi.ts'), 'export interface AuthServiceSpi { login(): Promise<void> }\n', 'utf8')
  writeFileSync(join(root, 'backend', 'src', 'runtime', 'auth-service.ts'), 'export class AuthService { login() {} }\n', 'utf8')
  writeFileSync(join(root, 'out', 'GRAPH_REPORT.md'), '# Graph report\n', 'utf8')
  writeFileSync(graphPath, JSON.stringify({
    directed: true,
    root_path: root,
    nodes: [
      { id: 'auth_route', label: 'POST /login', source_file: join(root, 'backend', 'src', 'auth-route.ts'), source_location: 'L1', file_type: 'code', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0 },
      { id: 'auth_controller', label: 'AuthController.login', source_file: join(root, 'backend', 'src', 'auth-controller.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
      { id: 'auth_spi', label: 'AuthServiceSpi.login', source_file: join(root, 'backend', 'src', 'spi', 'auth-service.spi.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', community: 0 },
      { id: 'auth_service', label: 'AuthService.login', source_file: join(root, 'backend', 'src', 'runtime', 'auth-service.ts'), source_location: 'L1', file_type: 'code', node_kind: 'method', community: 0 },
    ],
    edges: [
      { source: 'auth_route', target: 'auth_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: join(root, 'backend', 'src', 'auth-route.ts') },
      { source: 'auth_controller', target: 'auth_spi', relation: 'calls', confidence: 'EXTRACTED', source_file: join(root, 'backend', 'src', 'auth-controller.ts') },
      { source: 'auth_spi', target: 'auth_service', relation: 'implements', confidence: 'EXTRACTED', source_file: join(root, 'backend', 'src', 'spi', 'auth-service.spi.ts') },
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
  it('adds bounded snippet fields to retrieve responses and keeps top-node snippets aligned with context_pack', async () => {
    const graphPath = createGraphPath()

    const retrieveResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 6,
      method: 'tools/call',
      params: {
        name: 'retrieve',
        arguments: {
          question: 'Explain `AuthService.login`',
          budget: 1000,
          snippet_budget: 12,
          top_n_with_snippet: 1,
        },
      },
    }))

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 7,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Explain `AuthService.login`',
          budget: 1000,
          task: 'explain',
          verbose: true,
        },
      },
    }))

    const retrievePayload = JSON.parse(((retrieveResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      matched_nodes: Array<{
        label: string
        source_file: string
        line_number: number
        snippet: string | null
        snippet_truncated: boolean
      }>
      snippet_budget_tokens_used: number
      snippet_budget_tokens_remaining: number
    }
    const contextPackPayload = JSON.parse(((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      pack: {
        matched_nodes: Array<{
          label: string
          source_file: string
          line_number: number
          snippet: string | null
        }>
      }
    }

    expect(retrievePayload.snippet_budget_tokens_used).toBeLessThanOrEqual(12)
    expect(retrievePayload.snippet_budget_tokens_remaining).toBeGreaterThanOrEqual(0)
    expect(retrievePayload.matched_nodes[0]).toHaveProperty('snippet_truncated')
    expect(retrievePayload.matched_nodes[0]?.snippet).toEqual(expect.any(String))
    expect(retrievePayload.matched_nodes[1]).toEqual(expect.objectContaining({
      snippet: null,
      snippet_truncated: false,
    }))

    const retrieveNode = retrievePayload.matched_nodes.find((node) => typeof node.snippet === 'string')
    const contextPackNode = contextPackPayload.pack.matched_nodes.find((node) => node.label === retrieveNode?.label)

    expect(retrieveNode).toBeDefined()
    expect(contextPackNode).toBeDefined()
    expect(retrieveNode?.source_file).toBe(contextPackNode?.source_file)
    expect(retrieveNode?.line_number).toBe(contextPackNode?.line_number)

    const retrieveSnippetLines = new Set(
      (retrieveNode?.snippet ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )
    const contextPackSnippetLines = new Set(
      (contextPackNode?.snippet ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )

    expect([...retrieveSnippetLines].some((line) => contextPackSnippetLines.has(line))).toBe(true)
  })

  it('honors explain context_pack budgets below 3000', async () => {
    const graphPath = createGraphPath()

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 8,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Explain `AuthService.login`',
          budget: 1500,
          task: 'explain',
        },
      },
    }))

    const contextPackPayload = JSON.parse(((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      serialized_budget?: {
        max_tokens?: number
        token_count?: number
        enforced?: boolean
      }
    }

    expect(contextPackPayload.serialized_budget).toEqual(expect.objectContaining({
      max_tokens: 1500,
      enforced: true,
    }))
    expect(contextPackPayload.serialized_budget?.token_count).toBeLessThanOrEqual(1500)

    const tinyBudgetResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 9,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Explain `AuthService.login`',
          budget: 1,
          task: 'explain',
        },
      },
    }))

    const tinyBudgetPayload = JSON.parse(((tinyBudgetResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      serialized_budget?: {
        max_tokens?: number
      }
    }

    expect(tinyBudgetPayload.serialized_budget).toEqual(expect.objectContaining({
      max_tokens: 1,
    }))
  })

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

  it('does not recognize published benchmark prompts in production retrieval', async () => {
    const graphPath = createGraphPath()
    const question = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const holdoutQuestion = 'How does Acme resolve a short-link request through metrics recording and its final redirect?'
    const originalRetrieveContext = retrieveRuntime.retrieveContext
    const retrieveSpy = vi.spyOn(retrieveRuntime, 'retrieveContext').mockImplementation((inputGraph, options) => ({
      ...originalRetrieveContext(inputGraph, {
        question: 'Explain `AuthService.login`',
        budget: 1000,
      }),
      retrieval_strategy: options.retrievalStrategy ?? 'default',
    }))

    try {
      const retrieveResponse = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 11,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question,
            budget: 1000,
            verbose: true,
          },
        },
      }))

      const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 12,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: question,
            budget: 1000,
            task: 'explain',
            verbose: true,
          },
        },
      }))

      await Promise.resolve(handleStdioRequest(graphPath, {
        id: 13,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question: holdoutQuestion,
            budget: 1000,
            verbose: true,
          },
        },
      }))

      await Promise.resolve(handleStdioRequest(graphPath, {
        id: 14,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: holdoutQuestion,
            budget: 1000,
            task: 'explain',
            verbose: true,
          },
        },
      }))

      expect(retrieveSpy).toHaveBeenCalledTimes(4)
      for (const call of retrieveSpy.mock.calls) {
        expect(call[1]).not.toHaveProperty('runtimeProofProfile')
        expect(call[1]).not.toHaveProperty('retrievalStrategy')
      }

      const retrieveText = ((retrieveResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''
      const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

      expect(retrieveText).toContain('"retrieval_strategy":"default"')
      expect(contextPackText).toContain('"retrieval_strategy":"default"')
    } finally {
      retrieveSpy.mockRestore()
    }
  })

  it('never switches published benchmark prompts to a benchmark-only focused payload', async () => {
    const graphPath = createGraphPath()
    const question = 'How does Formbricks process a survey response from request handling through persistence and analytics/event tracking?'
    const readyResult = {
      question,
      retrieval_strategy: 'slice-v1' as const,
      matched_nodes: [
        {
          label: 'parseAndValidateResponseInput()',
          source_file: 'app/api/v2/client/[workspaceId]/responses/route.ts',
          line_number: 43,
          snippet: 'parseAndValidateResponseInput = async (request: Request, workspaceId: string) => ({ workspaceId, responseInputData });',
          match_score: 10,
          relevance_band: 'direct' as const,
          community: 10,
        },
        {
          label: 'createResponse()',
          source_file: 'app/api/v1/management/responses/lib/response.ts',
          line_number: 89,
          snippet: 'const prismaData = buildPrismaResponseData(responseInput, contact, ttc); return prismaClient.response.create({ data: prismaData });',
          match_score: 9,
          relevance_band: 'direct' as const,
          community: 11,
        },
        {
          label: 'sendToPipeline()',
          source_file: 'app/lib/pipelines.ts',
          line_number: 5,
          snippet: 'return getBackgroundJobProducer().enqueueResponsePipeline(job);',
          match_score: 8,
          relevance_band: 'direct' as const,
          community: 12,
        },
        {
          label: 'irrelevantHelper()',
          source_file: 'app/lib/irrelevant.ts',
          line_number: 1,
          snippet: 'export function irrelevantHelper() {}',
          match_score: 2,
          relevance_band: 'supporting' as const,
          community: 99,
        },
      ],
      relationships: [
        { from: 'parseAndValidateResponseInput()', to: 'createResponse()', relation: 'calls' },
        { from: 'createResponse()', to: 'sendToPipeline()', relation: 'calls' },
      ],
      community_context: [
        { id: 10, label: 'request', node_count: 1 },
        { id: 11, label: 'persistence', node_count: 1 },
        { id: 12, label: 'analytics', node_count: 1 },
      ],
      graph_signals: {
        god_nodes: ['parseAndValidateResponseInput()'],
        bridge_nodes: ['createResponse()'],
      },
      coverage: {
        required_evidence: [],
        semantic_required: [],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 2,
        selected_relationships: 2,
      },
      claims: [
        { claim: 'response flow is covered', evidence_labels: ['parseAndValidateResponseInput()', 'createResponse()', 'sendToPipeline()'] },
      ],
      answer_contract: {
        answer_now: true,
        confidence: 'high' as const,
        missing_phases: [],
        uncertainty_guidance: [],
        runtime_proof: {
          obligations: [
            {
              id: 'request_handling',
              label: 'request handling',
              kind: 'entrypoint',
              required: true,
              evidence: [
                {
                  label: 'parseAndValidateResponseInput()',
                  source_file: 'app/api/v2/client/[workspaceId]/responses/route.ts',
                  line_number: 43,
                },
              ],
            },
            {
              id: 'persistence',
              label: 'persistence',
              kind: 'terminal',
              required: true,
              evidence: [
                {
                  label: 'createResponse()',
                  source_file: 'app/api/v1/management/responses/lib/response.ts',
                  line_number: 89,
                },
              ],
            },
            {
              id: 'analytics_event_tracking',
              label: 'analytics/event tracking',
              kind: 'terminal',
              required: true,
              evidence: [
                {
                  label: 'sendToPipeline()',
                  source_file: 'app/lib/pipelines.ts',
                  line_number: 5,
                },
              ],
            },
          ],
          missing_obligations: [],
        },
      },
      execution_slice: {
        status: 'complete' as const,
        confidence: 'high' as const,
        steps: [
          {
            label: 'parseAndValidateResponseInput()',
            source_file: 'app/api/v2/client/[workspaceId]/responses/route.ts',
            line_number: 43,
          },
          {
            label: 'createResponse()',
            source_file: 'app/api/v1/management/responses/lib/response.ts',
            line_number: 89,
          },
          {
            label: 'sendToPipeline()',
            source_file: 'app/lib/pipelines.ts',
            line_number: 5,
          },
        ],
        primary_path: {
          steps: [
            {
              label: 'parseAndValidateResponseInput()',
              source_file: 'app/api/v2/client/[workspaceId]/responses/route.ts',
              line_number: 43,
            },
            {
              label: 'createResponse()',
              source_file: 'app/api/v1/management/responses/lib/response.ts',
              line_number: 89,
            },
            {
              label: 'sendToPipeline()',
              source_file: 'app/lib/pipelines.ts',
              line_number: 5,
            },
          ],
        },
      },
      retrieval_gate: {
        level: 4,
        reason: 'benchmark strict runtime proof',
        signals: {
          generation_intent: 'runtime_generation',
          target_domain_hint: 'backend_runtime',
        },
      },
    }
    const retrieveSpy = vi.spyOn(retrieveRuntime, 'retrieveContext').mockImplementation(() => readyResult as never)

    try {
      const retrieveResponse = await Promise.resolve(handleStdioRequest(graphPath, {
        id: 13,
        method: 'tools/call',
        params: {
          name: 'retrieve',
          arguments: {
            question,
            budget: 1000,
          },
        },
      }))

      const retrieveText = ((retrieveResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''
      const payload = JSON.parse(retrieveText) as {
        matched_nodes: Array<{ label: string }>
        relationships?: unknown
        community_context?: unknown
        graph_signals?: unknown
        coverage?: unknown
        claims?: unknown
        retrieval_gate?: unknown
        answer_contract: {
          runtime_proof: {
            missing_obligations: string[]
          }
        }
      }

      expect(payload.answer_contract.runtime_proof.missing_obligations).toEqual([])
      expect(payload.matched_nodes.map((node) => node.label)).toEqual([
        'parseAndValidateResponseInput()',
        'createResponse()',
        'sendToPipeline()',
        'irrelevantHelper()',
      ])
      expect(payload).toHaveProperty('relationships')
      expect(payload).toHaveProperty('community_context')
      expect(payload).toHaveProperty('coverage')
      expect(payload).toHaveProperty('claims')
      expect(payload).toHaveProperty('retrieval_gate')
    } finally {
      retrieveSpy.mockRestore()
    }
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
          prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
          budget: 1000,
          task: 'explain',
          retrieval_level: 4,
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

    expect(contextPackText).toContain('"execution_slice"')
    expect(contextPackText).toContain('"confidence"')
    expect(contextPackText).toContain('"confidence_reasons"')
  })

  it('passes graphPath into verbose runtime-generation context_pack evidence', async () => {
    const graphPath = createBackendRuntimeGraphPath()

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 40,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
          budget: 1000,
          task: 'explain',
          retrieval_level: 4,
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

    expect(contextPackText).toContain('"scope quality: runtime evidence is concentrated under backend/')
  })

  it('defaults context_pack runtime-generation output to answer-ready compact JSON and keeps verbose debug paths', async () => {
    const graphPath = createGraphPath()

    const compactResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 8,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
          budget: 3000,
          task: 'explain',
          retrieval_level: 4,
          retrieval_strategy: 'slice-v1',
        },
      },
    }))
    const verboseResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 9,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
          budget: 3000,
          task: 'explain',
          retrieval_level: 4,
          retrieval_strategy: 'slice-v1',
          verbose: true,
        },
      },
    }))

    const compactText = ((compactResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''
    const verboseText = ((verboseResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''
    const compactPayload = JSON.parse(compactText) as {
      serialized_budget?: { max_tokens?: number; token_count?: number; enforced?: boolean }
      diagnostics?: unknown
      pack?: { slice?: { selected_paths?: unknown[]; selected_path_count?: number } }
      recommended_first_read?: Array<{ path?: string }>
    }
    const verbosePayload = JSON.parse(verboseText) as {
      serialized_budget?: unknown
      diagnostics?: unknown
      pack?: { slice?: { selected_paths?: unknown[]; selected_path_count?: number } }
    }

    expect(estimateQueryTokens(compactText)).toBeLessThanOrEqual(3000)
    expect(compactPayload.serialized_budget).toEqual(expect.objectContaining({
      max_tokens: 3000,
      enforced: true,
    }))
    expect(compactPayload.diagnostics).toBeUndefined()
    expect(compactPayload.pack?.slice?.selected_paths).toBeUndefined()
    expect(compactPayload.pack?.slice?.selected_path_count).toBeGreaterThan(0)
    expect(compactPayload.recommended_first_read?.length).toBeGreaterThan(0)
    expect(verbosePayload.serialized_budget).toBeUndefined()
    expect(verbosePayload.diagnostics).toBeDefined()
    expect(verbosePayload.pack?.slice?.selected_paths?.length).toBeGreaterThan(0)
    expect(verbosePayload.pack?.slice?.selected_path_count).toBeUndefined()
  })

  it('emits source-safe governance receipts for context_pack cache and delta flows', async () => {
    const graphPath = createGraphPath()
    const sessionState = {
      logLevel: 'info' as const,
      subscribedResourceUris: new Set<string>(),
      resourceVersions: new Map<string, string>(),
      resourceListSignature: null,
      contextPromptSessions: new Map(),
      contextPackHandles: new Map(),
      contextPackCache: new Map(),
      contextPackNodeIds: new Map(),
    }
    const request = {
      prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
      budget: 3000,
      task: 'explain',
      retrieval_level: 4,
      retrieval_strategy: 'slice-v1',
    }

    const firstResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 41,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: request,
      },
    }, sessionState))
    const secondResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 42,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: request,
      },
    }, sessionState))
    const deltaSessionId = 'delta-session-governance'
    const deltaResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 43,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          ...request,
          delta_session_id: deltaSessionId,
        },
      },
    }, sessionState))

    const firstPayload = JSON.parse((((firstResponse as { result?: { content?: Array<{ text: string }> } }).result?.content) ?? [])[0]?.text ?? '') as {
      cache?: { status?: string }
      governance?: {
        privacy_boundary?: { source_safe?: boolean }
        mcp_call?: { cache_eligible?: boolean; cache_status?: string }
        request?: { retrieval_strategy?: string }
        follow_up?: { expandable_handle_count?: number; focus_file_count?: number }
      }
    }
    const secondPayload = JSON.parse((((secondResponse as { result?: { content?: Array<{ text: string }> } }).result?.content) ?? [])[0]?.text ?? '') as {
      cache?: { status?: string }
      governance?: { mcp_call?: { cache_status?: string } }
    }
    const deltaPayload = JSON.parse((((deltaResponse as { result?: { content?: Array<{ text: string }> } }).result?.content) ?? [])[0]?.text ?? '') as {
      governance?: { mcp_call?: { cache_status?: string; delta_session_hash?: string } }
      pack?: { retrieval_plan?: { version?: number; status?: string } }
    }

    expect(firstPayload.cache?.status).toBe('miss')
    expect(firstPayload.governance).toEqual(expect.objectContaining({
      privacy_boundary: expect.objectContaining({
        source_safe: true,
      }),
      mcp_call: expect.objectContaining({
        cache_eligible: true,
        cache_status: 'miss',
      }),
      request: expect.objectContaining({
        retrieval_strategy: 'slice-v1',
      }),
      follow_up: expect.objectContaining({
        expandable_handle_count: expect.any(Number),
        focus_file_count: expect.any(Number),
      }),
    }))
    expect(secondPayload.cache?.status).toBe('hit')
    expect(secondPayload.governance?.mcp_call?.cache_status).toBe('hit')
    expect(deltaPayload.governance?.mcp_call?.cache_status).toBe('bypass')
    expect(deltaPayload.governance?.mcp_call?.delta_session_hash).toMatch(/^[a-f0-9]{12}$/)
    expect(deltaPayload.pack?.retrieval_plan).toEqual({
      version: 1,
      status: 'not_needed',
      reasons: [],
      initial: expect.any(Object),
      final: expect.any(Object),
      attempts: [],
    })
    expect(JSON.stringify(firstPayload.governance)).not.toContain('AuthController.login')
    expect(JSON.stringify(firstPayload.governance)).not.toContain(graphPath)
    expect(JSON.stringify(deltaPayload.governance)).not.toContain(deltaSessionId)
  })

  it('treats governance-less cached explain context packs as stale and rebuilds them', async () => {
    const graphPath = createGraphPath()
    const sessionState = {
      logLevel: 'info' as const,
      subscribedResourceUris: new Set<string>(),
      resourceVersions: new Map<string, string>(),
      resourceListSignature: null,
      contextPromptSessions: new Map(),
      contextPackHandles: new Map(),
      contextPackCache: new Map<string, string>(),
      contextPackNodeIds: new Map(),
    }
    const request = {
      prompt: 'Trace how `AuthController.login` reaches persistence in the backend runtime pipeline',
      budget: 3000,
      task: 'explain',
      retrieval_level: 4,
      retrieval_strategy: 'slice-v1',
    }

    await Promise.resolve(handleStdioRequest(graphPath, {
      id: 51,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: request,
      },
    }, sessionState))

    const cachedEntry = [...sessionState.contextPackCache.entries()][0]
    expect(cachedEntry).toBeDefined()
    const [cacheKey, cachedPayloadText] = cachedEntry!
    const stalePayload = JSON.parse(cachedPayloadText) as Record<string, unknown>
    delete stalePayload.governance
    sessionState.contextPackCache.set(cacheKey, JSON.stringify(stalePayload))

    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 52,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: request,
      },
    }, sessionState))

    const payload = JSON.parse((((response as { result?: { content?: Array<{ text: string }> } }).result?.content) ?? [])[0]?.text ?? '') as {
      cache?: { status?: string }
      governance?: { mcp_call?: { cache_status?: string } }
    }

    expect(payload.cache?.status).toBe('miss')
    expect(payload.governance?.mcp_call?.cache_status).toBe('miss')
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

  it('infers implement task intent for context_pack when task is omitted', async () => {
    const graphPath = createGraphPath()

    const contextPackResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 5,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'Implement support for login session audit trails',
          budget: 1000,
          verbose: true,
        },
      },
    }))

    const contextPackText = ((contextPackResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? ''

    expect(contextPackText).toContain('"task":"implement"')
    expect(contextPackText).toContain('"task_intent":"implement"')
  })
})
