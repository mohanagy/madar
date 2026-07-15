import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CORE_TOOL_NAMES,
  MCP_TOOLS,
  STRICT_TOOL_NAMES,
  activeMcpTools,
  resolveToolProfileFromEnv,
} from '../../src/runtime/stdio/definitions.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

function createMinimalGraphRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-tool-profile-'))
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      community_labels: {},
      nodes: [
        { id: 'a', label: 'A', source_file: 'a.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'b', label: 'B', source_file: 'b.ts', source_location: '2', file_type: 'code', community: 0 },
      ],
      edges: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.ts' }],
      hyperedges: [],
    }),
    'utf8',
  )
  return root
}

async function withProfile(profile: 'core' | 'strict' | 'full' | undefined, fn: () => void | Promise<void>): Promise<void> {
  const previous = process.env.MADAR_TOOL_PROFILE
  if (profile === undefined) {
    delete process.env.MADAR_TOOL_PROFILE
  } else {
    process.env.MADAR_TOOL_PROFILE = profile
  }
  try {
    await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.MADAR_TOOL_PROFILE
    } else {
      process.env.MADAR_TOOL_PROFILE = previous
    }
  }
}

describe('MCP tool profile', () => {
  describe('activeMcpTools', () => {
    it('returns exactly the 7 core tools when profile is "core"', () => {
      const tools = activeMcpTools('core')
      expect(tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOL_NAMES].sort())
      expect(tools).toHaveLength(7)
    })

    it('returns the full MCP_TOOLS list when profile is "full"', () => {
      const tools = activeMcpTools('full')
      expect(tools).toEqual(MCP_TOOLS)
      expect(tools.length).toBeGreaterThan(CORE_TOOL_NAMES.length)
    })

    it('returns core plus context_pack and context_expand for the strict profile', () => {
      const tools = activeMcpTools('strict')
      expect(tools.map((tool) => tool.name).sort()).toEqual([...STRICT_TOOL_NAMES].sort())
      expect(tools).toHaveLength(9)
    })

    it('defaults to the core profile when called with no argument', () => {
      const defaulted = activeMcpTools()
      const explicit = activeMcpTools('core')
      expect(defaulted.map((tool) => tool.name)).toEqual(explicit.map((tool) => tool.name))
    })

    it('returns CORE_TOOL_NAMES that all exist in MCP_TOOLS', () => {
      const allNames = new Set(MCP_TOOLS.map((tool) => tool.name))
      for (const coreName of CORE_TOOL_NAMES) {
        expect(allNames.has(coreName)).toBe(true)
      }
    })

    it('preserves the relative order of MCP_TOOLS in the core selection', () => {
      const expectedOrder = MCP_TOOLS.map((tool) => tool.name).filter((name) =>
        (CORE_TOOL_NAMES as readonly string[]).includes(name),
      )
      const actualOrder = activeMcpTools('core').map((tool) => tool.name)
      expect(actualOrder).toEqual(expectedOrder)
    })

    it('adds only the bounded pack and expansion pair to strict while keeping the rest full-only', () => {
      const fullToolNames = activeMcpTools('full').map((tool) => tool.name)
      const coreToolNames = activeMcpTools('core').map((tool) => tool.name)
      const strictToolNames = activeMcpTools('strict').map((tool) => tool.name)

      expect(fullToolNames).toEqual(expect.arrayContaining(['context_pack', 'context_expand', 'context_prompt', 'context_session_reset']))
      expect(coreToolNames).not.toContain('context_pack')
      expect(coreToolNames).not.toContain('context_expand')
      expect(strictToolNames).toEqual(expect.arrayContaining(['context_pack', 'context_expand']))
      expect(strictToolNames).not.toContain('context_prompt')
      expect(strictToolNames).not.toContain('context_session_reset')
      expect(coreToolNames).not.toContain('context_prompt')
      expect(coreToolNames).not.toContain('context_session_reset')
    })

    it('advertises scoped and global freshness guards on context tools', () => {
      const fullTools = activeMcpTools('full')
      const contextPack = fullTools.find((tool) => tool.name === 'context_pack')
      const contextPrompt = fullTools.find((tool) => tool.name === 'context_prompt')

      expect(contextPack?.inputSchema.properties).toEqual(expect.objectContaining({
        require_fresh_graph: expect.any(Object),
        require_fresh_context: expect.any(Object),
      }))
      expect(contextPrompt?.inputSchema.properties).toEqual(expect.objectContaining({
        require_fresh_graph: expect.any(Object),
        require_fresh_context: expect.any(Object),
      }))
    })
  })

  describe('resolveToolProfileFromEnv', () => {
    it('defaults to "core" when MADAR_TOOL_PROFILE is unset', () => {
      expect(resolveToolProfileFromEnv({})).toBe('core')
    })

    it('defaults to "core" when MADAR_TOOL_PROFILE is the empty string', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: '' })).toBe('core')
    })

    it('returns "core" for the literal "core" value', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'core' })).toBe('core')
    })

    it('treats unknown values as "core" rather than throwing', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'invalid' })).toBe('core')
    })

    it('returns "full" for the literal "full" value', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'full' })).toBe('full')
    })

    it('returns "strict" for the literal "strict" value', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'strict' })).toBe('strict')
    })

    it('is case-insensitive', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'FULL' })).toBe('full')
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'STRICT' })).toBe('strict')
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: 'CORE' })).toBe('core')
    })

    it('trims whitespace before matching', () => {
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: ' full ' })).toBe('full')
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: ' strict ' })).toBe('strict')
      expect(resolveToolProfileFromEnv({ MADAR_TOOL_PROFILE: '\tfull\n' })).toBe('full')
    })

    it('reads from process.env when no argument is provided', () => {
      const previous = process.env.MADAR_TOOL_PROFILE
      try {
        delete process.env.MADAR_TOOL_PROFILE
        expect(resolveToolProfileFromEnv()).toBe('core')
        process.env.MADAR_TOOL_PROFILE = 'full'
        expect(resolveToolProfileFromEnv()).toBe('full')
      } finally {
        if (previous === undefined) {
          delete process.env.MADAR_TOOL_PROFILE
        } else {
          process.env.MADAR_TOOL_PROFILE = previous
        }
      }
    })
  })

  describe('core profile composition', () => {
    it('contains exactly retrieve, impact, call_chain, community_overview, pr_impact, graph_stats, graph_summary', () => {
      expect([...CORE_TOOL_NAMES].sort()).toEqual(
        ['retrieve', 'impact', 'call_chain', 'community_overview', 'pr_impact', 'graph_stats', 'graph_summary'].sort(),
      )
    })
  })

  describe('stdio-server tool profile gating', () => {
    it('tools/list returns exactly the 7 core tools when MADAR_TOOL_PROFILE=core', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('core', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), { id: 1, method: 'tools/list' }),
          )
          expect(response).not.toBeNull()
          const result = (response as { result?: { tools: Array<{ name: string }> } }).result
          expect(result).toBeDefined()
          expect(result?.tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOL_NAMES].sort())
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/list returns the full surface when MADAR_TOOL_PROFILE=full', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('full', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), { id: 1, method: 'tools/list' }),
          )
          expect(response).not.toBeNull()
          const result = (response as { result?: { tools: Array<{ name: string }> } }).result
          expect(result?.tools.length).toBe(MCP_TOOLS.length)
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/list returns the strict surface when MADAR_TOOL_PROFILE=strict (#405, #550)', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('strict', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), { id: 1, method: 'tools/list' }),
          )
          const result = (response as { result?: { tools: Array<{ name: string }> } }).result
          expect(result?.tools.map((tool) => tool.name).sort()).toEqual([...STRICT_TOOL_NAMES].sort())
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/call for a non-core tool returns JSONRPC_METHOD_NOT_FOUND with a profile hint', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('core', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), {
              id: 99,
              method: 'tools/call',
              params: { name: 'feature_map', arguments: { question: 'unused' } },
            }),
          )
          expect(response).not.toBeNull()
          const error = (response as { error?: { code: number; message: string } }).error
          expect(error).toBeDefined()
          expect(error?.code).toBe(-32601)
          expect(error?.message).toContain('not enabled in the active madar MCP tool profile')
          expect(error?.message).toContain("tool profile 'core'")
          expect(error?.message).toContain('MADAR_TOOL_PROFILE=strict')
          expect(error?.message).toContain('MADAR_TOOL_PROFILE=full')
          expect(error?.message).toContain('feature_map')
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/call blocks context-plane tools when the core profile is active', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('core', async () => {
          for (const [name, args] of [
            ['context_pack', { prompt: 'unused', task: 'explain' }],
            ['context_expand', { handle_id: 'expand:explain:structural:demo' }],
            ['context_prompt', { prompt: 'unused', provider: 'claude' }],
            ['context_session_reset', { session_id: 'session-1' }],
          ] as const) {
            const response = await Promise.resolve(
              handleStdioRequest(join(root, 'graph.json'), {
                id: 102,
                method: 'tools/call',
                params: { name, arguments: args },
              }),
            )
            expect(response).not.toBeNull()
            const error = (response as { error?: { code: number; message: string } }).error
            expect(error?.code).toBe(-32601)
            expect(error?.message).toContain(name)
            expect(error?.message).toContain("tool profile 'core'")
            expect(error?.message).toContain('MADAR_TOOL_PROFILE=strict')
            expect(error?.message).toContain('MADAR_TOOL_PROFILE=full')
          }
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/call for a non-core tool succeeds when MADAR_TOOL_PROFILE=full', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('full', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), {
              id: 100,
              method: 'tools/call',
              params: { name: 'graph_stats', arguments: {} },
            }),
          )
          expect(response).not.toBeNull()
          const error = (response as { error?: { code: number } }).error
          expect(error).toBeUndefined()
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('accepts context_pack and context_expand calls under the installed strict profile (#405, #550)', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('strict', async () => {
          const sessionState = {
            logLevel: 'info' as const,
            subscribedResourceUris: new Set<string>(),
            resourceVersions: new Map<string, string>(),
            resourceListSignature: null,
            contextPackHandles: new Map<string, unknown>([
              ['strict-profile-handle', {
                prompt: 'Implement the flow from A to B',
                task: 'implement',
                task_intent: 'implement',
                follow_up: {
                  kind: 'context_pack',
                  task_kind: 'implement',
                  evidence_class: 'supporting',
                  focus_files: ['a.ts'],
                  focus_ranges: [],
                },
              }],
            ]),
          }
          const pack = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 103,
            method: 'tools/call',
            params: {
              name: 'context_pack',
              arguments: { prompt: 'Implement the flow from A to B', task: 'implement', budget: 1 },
            },
          }, sessionState))
          expect(pack).not.toHaveProperty('error')

          const expanded = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 104,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'strict-profile-handle' },
            },
          }, sessionState))
          expect(expanded).not.toHaveProperty('error')
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tools/call for a core tool succeeds when MADAR_TOOL_PROFILE=core', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('core', async () => {
          const response = await Promise.resolve(
            handleStdioRequest(join(root, 'graph.json'), {
              id: 101,
              method: 'tools/call',
              params: { name: 'graph_stats', arguments: {} },
            }),
          )
          expect(response).not.toBeNull()
          const error = (response as { error?: { code: number } }).error
          expect(error).toBeUndefined()
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
