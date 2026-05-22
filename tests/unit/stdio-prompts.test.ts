import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { handleCompletion, promptDefinitionsForGraph } from '../../src/runtime/stdio/prompts.js'

function createGraphFixtureRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-prompts-'))
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      community_labels: {
        '0': 'Auth Services',
        '1': 'Transport Layer',
      },
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
  return root
}

describe('stdio prompt helpers', () => {
  it('builds graph-aware prompt definitions and completions', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const prompts = promptDefinitionsForGraph(graphPath)
      const helpers = {
        ok: (id: string | number | null, result: unknown) => ({ jsonrpc: '2.0' as const, id, result }),
        failure: (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } }),
        stringParam: (params: unknown, key: string) => {
          if (!params || typeof params !== 'object' || !(key in params)) {
            return null
          }
          const value = (params as Record<string, unknown>)[key]
          return typeof value === 'string' ? value : null
        },
        stringParamAlias: (params: unknown, keys: readonly string[]) => {
          for (const key of keys) {
            const value = helpers.stringParam(params, key)
            if (value !== null) {
              return value
            }
          }
          return null
        },
        integerLikeParamAlias: (params: unknown, keys: readonly string[], options: { min?: number; max?: number } = {}) => {
          for (const key of keys) {
            if (!params || typeof params !== 'object' || !(key in params)) {
              continue
            }
            const rawValue = (params as Record<string, unknown>)[key]
            const numericValue = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim()) ? Number(rawValue.trim()) : null
            if (numericValue === null) {
              continue
            }
            if (options.min !== undefined && numericValue < options.min) {
              continue
            }
            if (options.max !== undefined && numericValue > options.max) {
              continue
            }
            return numericValue
          }
          return null
        },
        recordParam: (params: unknown, key: string) => {
          if (!params || typeof params !== 'object' || !(key in params)) {
            return null
          }
          const value = (params as Record<string, unknown>)[key]
          return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
        },
        jsonrpcInvalidParams: -32602,
        maxStdioTextLength: 512,
        maxCompletionValues: 25,
      }
      const completion = handleCompletion(1, graphPath, {
        ref: { type: 'ref/prompt', name: 'graph_community_summary_prompt' },
        argument: { name: 'community_id', value: '' },
      }, helpers)
      const contextTaskCompletion = handleCompletion(2, graphPath, {
        ref: { type: 'ref/prompt', name: 'context_pack_prompt' },
        argument: { name: 'task', value: '' },
      }, helpers)
      const contextProviderCompletion = handleCompletion(3, graphPath, {
        ref: { type: 'ref/prompt', name: 'context_prompt_prompt' },
        argument: { name: 'provider', value: '' },
      }, helpers)

      const explainPrompt = prompts.find((prompt) => prompt.name === 'graph_explain_prompt')
      const communityPrompt = prompts.find((prompt) => prompt.name === 'graph_community_summary_prompt')
      const contextPackPrompt = prompts.find((prompt) => prompt.name === 'context_pack_prompt')
      const contextPrompt = prompts.find((prompt) => prompt.name === 'context_prompt_prompt')
      const contextSessionPrompt = prompts.find((prompt) => prompt.name === 'context_session_reset_prompt')

      expect(explainPrompt?.description).toContain('AuthService')
      expect(communityPrompt?.description).toContain('Auth Services')
      expect(contextPackPrompt?.description).toContain('Auth Services')
      expect(contextPrompt?.description).toContain('claude')
      expect(contextSessionPrompt?.description).toContain('session')
      expect(completion).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          completion: {
            values: ['0', '1'],
            hasMore: false,
          },
        },
      })
      expect(contextTaskCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          completion: {
            values: ['explain', 'impact', 'review'],
          },
        },
      })
      expect(contextProviderCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 3,
        result: {
          completion: {
            values: ['claude', 'gemini'],
          },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
