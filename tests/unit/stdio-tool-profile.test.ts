import { SOURCE_RETRIEVAL_ADMISSION } from '../../src/shared/source-retrieval-guidance.js'
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
import { constrainStrictContextPackPayload } from '../../src/runtime/stdio/tools.js'
import { buildMadarResponseEvidenceWithPlanning } from '../../src/runtime/mcp-response-evidence.js'

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

function createOverflowExpansionGraphRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-tool-profile-overflow-'))
  const sourceDir = join(root, 'src')
  mkdirSync(sourceDir, { recursive: true })
  const sourceFile = join(sourceDir, 'large.ts')
  const sourceLines = Array.from(
    { length: 220 },
    (_, index) => `export const evidence_${index + 1} = '${'cross layer runtime status evidence '.repeat(12)}'`,
  )
  writeFileSync(sourceFile, `${sourceLines.join('\n')}\n`, 'utf8')
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      community_labels: {},
      nodes: Array.from({ length: 600 }, (_, index) => ({
        id: `overflow-${index + 1}`,
        label: `OverflowEvidence${index + 1}`,
        source_file: 'src/large.ts',
        source_location: 'L10',
        file_type: 'code',
        community: 0,
      })),
      edges: [],
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

    it('returns only the bounded pack and expansion pair for the strict profile', () => {
      const tools = activeMcpTools('strict')
      expect(tools.map((tool) => tool.name).sort()).toEqual([...STRICT_TOOL_NAMES].sort())
      expect(tools).toHaveLength(2)
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

    it('keeps strict to the bounded pack and expansion pair while core/full retain navigation', () => {
      const fullToolNames = activeMcpTools('full').map((tool) => tool.name)
      const coreToolNames = activeMcpTools('core').map((tool) => tool.name)
      const strictToolNames = activeMcpTools('strict').map((tool) => tool.name)

      expect(fullToolNames).toEqual(expect.arrayContaining(['context_pack', 'context_expand', 'context_prompt', 'context_session_reset']))
      expect(coreToolNames).not.toContain('context_pack')
      expect(coreToolNames).not.toContain('context_expand')
      expect(strictToolNames).toEqual(['context_pack', 'context_expand'])
      expect(strictToolNames).not.toContain('retrieve')
      expect(strictToolNames).not.toContain('impact')
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

    it('exposes compact budgets and permits focused follow-up investigation', async () => {
      const pack = activeMcpTools('strict').find((tool) => tool.name === 'context_pack')
      const expand = activeMcpTools('strict').find((tool) => tool.name === 'context_expand')
      expect(Object.keys(pack?.inputSchema.properties ?? {})).toEqual(['prompt', 'task', 'budget', 'targets'])
      expect(Object.keys(expand?.inputSchema.properties ?? {})).toEqual(['handle_id', 'budget', 'symbol'])
      expect(pack?.inputSchema.properties.budget).toMatchObject({ minimum: 128 })
      expect(pack?.description).toContain('focused follow-up')
      expect(expand?.description).toContain('related evidence')
      for (const tool of [pack, expand]) {
        expect(tool?.description).not.toMatch(/exactly once|terminal|Never call for ready|byte-for-byte/)
      }
      await withProfile('strict', async () => {
        const response = await handleStdioRequest('out/graph.json', { id: 1, method: 'initialize' })
        const instructions = (response?.result as { instructions: string }).instructions
        expect(instructions).toContain(SOURCE_RETRIEVAL_ADMISSION)
        expect(instructions).not.toContain('context-pack-first')
        expect(activeMcpTools('strict').map((tool) => tool.name)).toEqual(['context_pack', 'context_expand'])
        expect(instructions).toContain('focused source questions')
        expect(instructions).toContain('Continue investigating when evidence is incomplete')
        expect(instructions).not.toMatch(/once|verbatim|verify_targets/)
      })
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

    it('removes graph prompts, resources, and completions from the strict MCP boundary', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('strict', async () => {
          const graphPath = join(root, 'graph.json')
          const initialize = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'initialize' }))
          const capabilities = (initialize as {
            result?: { capabilities?: Record<string, unknown> }
          }).result?.capabilities
          expect(capabilities).toEqual(expect.objectContaining({
            logging: {},
            tools: { listChanged: false },
          }))
          expect(capabilities).not.toHaveProperty('prompts')
          expect(capabilities).not.toHaveProperty('resources')
          expect(capabilities).not.toHaveProperty('completions')

          const prompts = await Promise.resolve(handleStdioRequest(graphPath, { id: 2, method: 'prompts/list' }))
          const resources = await Promise.resolve(handleStdioRequest(graphPath, { id: 3, method: 'resources/list' }))
          expect((prompts as { result?: { prompts?: unknown[] } }).result?.prompts).toEqual([])
          expect((resources as { result?: { resources?: unknown[] } }).result?.resources).toEqual([])

          for (const request of [
            { id: 4, method: 'prompts/get', params: { name: 'graph_query_prompt', arguments: {} } },
            { id: 5, method: 'resources/read', params: { uri: 'madar://artifact/graph.json' } },
            { id: 6, method: 'resources/subscribe', params: { uri: 'madar://artifact/graph.json' } },
            { id: 7, method: 'completion/complete', params: { ref: {}, argument: {} } },
          ]) {
            const response = await Promise.resolve(handleStdioRequest(graphPath, request))
            expect(response).toMatchObject({ error: { code: -32601 } })
          }
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects legacy direct graph methods in the strict profile', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('strict', async () => {
          const graphPath = join(root, 'graph.json')
          for (const [method, params] of [
            ['query', { question: 'How does A reach B?' }],
            ['diff', {}],
            ['anomalies', {}],
            ['node', { label: 'A' }],
            ['neighbors', { label: 'A' }],
            ['path', { source: 'A', target: 'B' }],
            ['explain', { label: 'A' }],
            ['stats', {}],
            ['god_nodes', {}],
            ['community', { community_id: 0 }],
          ] as const) {
            const response = await Promise.resolve(handleStdioRequest(graphPath, {
              id: 88,
              method,
              params,
            }))
            expect(response).toMatchObject({
              error: {
                code: -32601,
                message: expect.stringContaining(`Legacy graph method '${method}' is disabled`),
              },
            })
          }
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

    it('keeps strict packs minimal and permits repeated session-owned expansions', async () => {
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
              ['second-strict-profile-handle', {
                prompt: 'Implement the flow from A to B',
                task: 'implement',
                task_intent: 'implement',
                follow_up: {
                  kind: 'context_pack',
                  task_kind: 'implement',
                  evidence_class: 'supporting',
                  focus_files: ['b.ts'],
                  focus_ranges: [],
                },
              }],
            ]),
          }
          const expanded = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 103,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'strict-profile-handle' },
            },
          }, sessionState))
          expect(expanded).not.toHaveProperty('error')

          const repeated = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 104,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'strict-profile-handle' },
            },
          }, sessionState))
          expect(repeated).not.toHaveProperty('error')

          const secondTarget = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 1041,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'second-strict-profile-handle' },
            },
          }, sessionState))
          expect(secondTarget).not.toHaveProperty('error')

          sessionState.contextPackHandles.set('preserved-after-invalid-request', {
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
          })
          const invalidPack = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 1042,
            method: 'tools/call',
            params: {
              name: 'context_pack',
              arguments: { prompt: 'Implement the flow from A to B', task: 'not-a-task' },
            },
          }, sessionState))
          expect(invalidPack).toMatchObject({
            error: { message: expect.stringContaining('task must be one of') },
          })
          const preserved = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 1043,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'preserved-after-invalid-request' },
            },
          }, sessionState))
          expect(preserved).not.toHaveProperty('error')

          sessionState.contextPackHandles.set('stale-handle', {
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
          })
          const pack = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 105,
            method: 'tools/call',
            params: {
              name: 'context_pack',
              arguments: { prompt: 'Implement the flow from A to B', task: 'implement' },
            },
          }, sessionState))
          expect(pack).not.toHaveProperty('error')

          const stale = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 106,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: 'stale-handle' },
            },
          }, sessionState))
          expect(stale).not.toHaveProperty('error')
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('keeps private navigation independent of public answerability and withheld targets', () => {
      const { evidence, navigation } = buildMadarResponseEvidenceWithPlanning({
        coverage: {
          required_evidence: ['primary', 'supporting'], semantic_required: [], semantic_optional: [],
          entries: [
            { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
            { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 0, status: 'available' },
          ],
          semantic_entries: [], missing_required: ['supporting'], missing_semantic: [],
          available_relationships: 1, selected_relationships: 0,
        },
        coveredWorkflowOwners: ['a.ts'],
      })
      expect(navigation).toMatchObject({ state: 'verify_targets', candidate: { focus_files: ['a.ts'] } })
      const originalPlan = structuredClone(navigation)
      const payload = () => ({
        prompt: 'Explain A', task: 'explain', pack: { expandable: [] }, expandable: [],
        evidence: structuredClone(evidence),
      })
      const baseline = constrainStrictContextPackPayload(payload(), { strictContextPackMode: true }, navigation)
      expect(baseline.expandable).toEqual([expect.objectContaining({
        handle_id: expect.stringMatching(/^verify-/),
        follow_up: expect.objectContaining({ focus_files: ['a.ts'] }),
      })])
      for (const state of ['ready', 'insufficient', 'verify_targets'] as const) {
        const changed = payload()
        changed.evidence.answerability.state = state
        changed.evidence.answerability.verification_targets = []
        const result = constrainStrictContextPackPayload(changed, { strictContextPackMode: true }, navigation)
        expect(result.expandable).toEqual(baseline.expandable)
        expect(result.evidence.answerability.state).toBe(state)
        expect(result.evidence.answerability.verification_targets).toEqual([])
      }
      const redirected = payload()
      redirected.evidence.answerability.verification_targets = [{
        focus_files: ['unrelated.ts'], focus_ranges: [], reason: 'public suggestion only',
      }]
      expect(constrainStrictContextPackPayload(redirected, { strictContextPackMode: true }, navigation).expandable)
        .toEqual(baseline.expandable)
      const noAnswerability = constrainStrictContextPackPayload({ ...payload(), evidence: {} },
        { strictContextPackMode: true }, navigation)
      expect(noAnswerability.expandable).toEqual(baseline.expandable)
      expect(noAnswerability.evidence).not.toHaveProperty('answerability')
      const suppressed = constrainStrictContextPackPayload(payload(), { strictContextPackMode: true }, null)
      expect(suppressed.expandable).toEqual([])
      expect(constrainStrictContextPackPayload(payload(), { strictContextPackMode: true }).expandable)
        .toEqual(baseline.expandable)
      expect(navigation).toEqual(originalPlan)
    })

    it('turns a strict file-only verification target into one authorized expansion', async () => {
      const root = createMinimalGraphRoot()
      const graphPath = join(root, 'graph.json')
      try {
        const payload = constrainStrictContextPackPayload({
          task: 'explain',
          pack: { expandable: [] },
          expandable: [],
          evidence: {
            pack_confidence: 'medium',
            agent_directive: 'verify_one_targeted_file',
            answerability: {
              state: 'verify_targets',
              answer_scope: 'partial',
              caveats: [],
              missing_obligations: ['evidence:supporting'],
              verification_targets: [{
                evidence_class: 'supporting',
                focus_files: ['a.ts'],
                focus_ranges: [],
                reason: 'verify missing evidence:supporting',
              }],
              broad_search_fallback: 'targeted_only',
            },
          },
        }, { strictContextPackMode: true })
        const authorization = payload.evidence.answerability.verification_targets[0] as {
          handle_id?: string
          evidence_class?: string
          focus_files?: string[]
        }
        expect(authorization).toMatchObject({
          handle_id: expect.stringMatching(/^verify-/),
          evidence_class: 'supporting',
          focus_files: ['a.ts'],
        })
        expect(payload.expandable).toEqual([
          expect.objectContaining({ handle_id: expect.stringMatching(/^verify-/) }),
        ])
        expect(payload.expandable?.length).toBeGreaterThan(0)

        await withProfile('strict', async () => {
          const sessionState = {
            logLevel: 'info' as const,
            subscribedResourceUris: new Set<string>(),
            resourceVersions: new Map<string, string>(),
            resourceListSignature: null,
            contextPackHandles: new Map<string, unknown>([
              ['strict-verify-target', {
                prompt: 'Explain the flow from A to B',
                task: 'explain',
                task_intent: 'explain',
                follow_up: {
                  kind: 'context_pack',
                  task_kind: 'explain',
                  evidence_class: 'supporting',
                  focus_files: ['a.ts'],
                  focus_ranges: [],
                },
              }],
            ]),
            contextPackCache: new Map<string, string>(),
            contextPackNodeIds: new Map<string, Set<string>>(),
          }

          const expanded = await Promise.resolve(handleStdioRequest(graphPath, {
            id: 108,
            method: 'tools/call',
            params: { name: 'context_expand', arguments: { handle_id: 'strict-verify-target' } },
          }, sessionState))
          expect(expanded).not.toHaveProperty('error')
          const repeated = await Promise.resolve(handleStdioRequest(graphPath, {
            id: 109,
            method: 'tools/call',
            params: { name: 'context_expand', arguments: { handle_id: 'strict-verify-target' } },
          }, sessionState))
          expect(repeated).not.toHaveProperty('error')
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('keeps follow-on expansion handles callable in the strict profile', async () => {
      const root = createOverflowExpansionGraphRoot()
      const graphPath = join(root, 'graph.json')
      const storedHandle = {
        prompt: 'Trace the cross-layer runtime status path and identify the remaining uncertainty',
        task: 'explain' as const,
        task_intent: 'explain',
        follow_up: {
          kind: 'context_pack' as const,
          task_kind: 'explain' as const,
          evidence_class: 'supporting' as const,
          focus_files: ['src/large.ts'],
          focus_ranges: [],
        },
      }
      const makeSessionState = () => ({
        logLevel: 'info' as const,
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
        contextPackHandles: new Map<string, unknown>([['overflow-handle', storedHandle]]),
      })
      try {
        let fullPayload: {
          expandable?: Array<{ handle_id: string }>
          pack?: { expandable?: Array<{ handle_id: string }> }
          evidence: { answerability: { state: string; verification_targets: Array<{ handle_id?: string }> } }
        } | undefined
        await withProfile('full', async () => {
          const response = await Promise.resolve(handleStdioRequest(graphPath, {
            id: 110,
            method: 'tools/call',
            params: { name: 'context_expand', arguments: { handle_id: 'overflow-handle' } },
          }, makeSessionState()))
          expect(response).not.toHaveProperty('error')
          fullPayload = JSON.parse(
            (response?.result as { content: Array<{ text: string }> }).content[0]!.text,
          )
          expect(fullPayload?.expandable?.length).toBeGreaterThan(0)
        })

        await withProfile('strict', async () => {
          const sessionState = makeSessionState()
          const response = await Promise.resolve(handleStdioRequest(graphPath, {
            id: 111,
            method: 'tools/call',
            params: { name: 'context_expand', arguments: { handle_id: 'overflow-handle' } },
          }, sessionState))
          expect(response).not.toHaveProperty('error')
          const payload = JSON.parse(
            (response?.result as { content: Array<{ text: string }> }).content[0]!.text,
          ) as {
            handle_id?: string
            expandable?: Array<{ handle_id: string }>
            pack?: { expandable?: Array<{ handle_id: string }> }
            evidence: {
              pack_confidence: string
              agent_directive: string
              answerability: {
                state: string
                verification_targets: Array<{ handle_id: string }>
                broad_search_fallback: string
                caveats: string[]
              }
            }
          }
          expect(payload.handle_id).toBe('overflow-handle')
          expect(payload.expandable?.length).toBeGreaterThan(0)
          expect(payload.evidence).toMatchObject({
            agent_directive: 'explore_with_caution',
            answerability: { advisory: true, broad_search_fallback: 'allowed' },
          })
          expect(sessionState.contextPackHandles.size).toBeGreaterThan(0)
          const followOnHandle = fullPayload?.expandable?.[0]?.handle_id
          expect(followOnHandle).toEqual(expect.any(String))

          const retried = await Promise.resolve(handleStdioRequest(graphPath, {
            id: 112,
            method: 'tools/call',
            params: {
              name: 'context_expand',
              arguments: { handle_id: followOnHandle },
            },
          }, sessionState))
          expect(retried).not.toHaveProperty('error')
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects all context-pack diagnostics and tuning fields under the strict profile', async () => {
      const root = createMinimalGraphRoot()
      try {
        await withProfile('strict', async () => {
          const response = await Promise.resolve(handleStdioRequest(join(root, 'graph.json'), {
            id: 105,
            method: 'tools/call',
            params: {
              name: 'context_pack',
              arguments: {
                prompt: 'Explain the flow from A to B',
                task: 'explain',
                verbose: true,
              },
            },
          }))

          expect(response).toMatchObject({
            error: {
              message: expect.stringContaining('strict context_pack accepts prompt and optional task/budget'),
            },
          })
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
