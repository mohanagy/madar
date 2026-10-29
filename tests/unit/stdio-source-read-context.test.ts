import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import * as completion from '../../src/runtime/source-read-context.js'

let root: string, graphPath: string
let state: Parameters<typeof handleStdioRequest>[2]
let id = 0
const helper = 'export function normalizeItem(value: string) {\n  return value.trim();\n}\n'
const source = "import { normalizeItem } from './normalize.js';\n\nexport function processBatch(items: string[]) {\n  return items.map(normalizeItem);\n}\n"

beforeEach(() => {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'full')
  root = mkdtempSync(join(tmpdir(), 'madar-source-read-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/batch.ts'), source)
  writeFileSync(join(root, 'src/normalize.ts'), helper)
  graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

async function call(extra: Record<string, unknown> = {}) {
  const response = await handleStdioRequest(graphPath, { id: ++id, method: 'tools/call', params: {
    name: 'context_pack', arguments: {
      prompt: 'How do processBatch in src/batch.ts and normalizeItem in src/normalize.ts process and normalize each item?',
      task: 'implement', budget: 3000, ...extra,
    },
  } }, state)
  expect(response?.error).toBeUndefined()
  const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text)
  expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(Number(extra.budget ?? 3000))
  return payload
}

describe('default implementation source reads', () => {
  it('refuses source excluded by current policy before a request or during complete-file enrichment', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const allowed = await call()
    expect(allowed.pack.matched_nodes.some((node: Record<string, unknown>) => node.snippet_file_complete)).toBe(true)
    const real = completion.completeSourceFileCandidates
    let changed = false
    const spy = vi.spyOn(completion, 'completeSourceFileCandidates').mockImplementation((nodes, path) => {
      if (!changed) { changed = true; writeFileSync(join(root, '.madarignore'), 'src/batch.ts\n') }
      return real(nodes, path)
    })
    const interrupted = await call()
    spy.mockRestore()
    expect(changed).toBe(true)
    for (const payload of [interrupted, await call()]) {
      const nodes = payload.pack?.matched_nodes ?? []
      expect(nodes.map((node: Record<string, unknown>) => resolveSourceSnippet(node, nodes)).join('\n'))
        .not.toContain('return items.map(normalizeItem)')
      expect(nodes.some((node: Record<string, unknown>) => String(node.source_file).endsWith('src/batch.ts'))).toBe(false)
      expect(payload.expandable ?? []).toEqual([])
    }
    expect(interrupted.omitted_evidence).toMatch(/current policy/)
    // The policy excludes one file, not the whole workspace.
    const unaffected = await call({ prompt: 'Show the normalizeItem function in src/normalize.ts.' })
    const nodes = unaffected.pack?.matched_nodes ?? []
    expect(nodes.map((node: Record<string, unknown>) => resolveSourceSnippet(node, nodes)).join('\n')).toContain('return value.trim()')
  })

  it('does not offer a verification reread of already complete files while retaining missing tests and unresolved calls', async () => {
    const dynamic = 'export function normalizeItem(value: string, supplied: (value: string) => string) {\n  return supplied(value);\n}\n'
    writeFileSync(join(root, 'src/normalize.ts'), dynamic)
    graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
    const payload = await call({ prompt: 'Show processBatch in src/batch.ts and normalizeItem in src/normalize.ts. Include their tests.' })
    expect(payload.pack.matched_nodes.filter((node: Record<string, unknown>) => node.snippet_file_complete)).toHaveLength(2)
    expect(payload.expandable ?? []).toEqual([])
    expect(payload.evidence.answerability.verification_targets ?? []).toEqual([])
    expect(payload.evidence.answerability.missing_obligations.some((gap: string) => gap.startsWith('query:obligation:'))).toBe(true)
    const unresolved = payload.pack.source_dependencies.unresolved
      ?? payload.pack.source_dependencies.unresolved_groups?.flatMap((group: { calls: Array<{ callee: string }> }) => group.calls) ?? []
    expect(unresolved
      .some((call: { callee: string }) => call.callee === 'supplied')).toBe(true)
    expect(payload.evidence.agent_directive).not.toBe('answer_from_pack')
  })

  it('preserves original primary evidence roles through the actual stored continuation', async () => {
    const payload = await call({ verbose: true, budget: 5000 })
    const handle = payload.expandable?.[0]?.handle_id
    expect(handle).toBeTruthy()
    const primaryIds = payload.pack.matched_nodes.filter((node: Record<string, unknown>) => node.relevance_band === 'direct')
      .map((node: Record<string, unknown>) => node.node_id)
    expect(primaryIds.length).toBeGreaterThan(0)
    const response = await handleStdioRequest(graphPath, { id: ++id, method: 'tools/call', params: {
      name: 'context_expand', arguments: { handle_id: handle, budget: 5000, verbose: true },
    } }, state)
    expect(response?.error).toBeUndefined()
    const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
    const expanded = JSON.parse(text)
    for (const nodeId of primaryIds) {
      expect(expanded.pack.matched_nodes.find((node: Record<string, unknown>) => node.node_id === nodeId)?.relevance_band).toBe('direct')
    }
    expect(expanded.evidence.answerability.missing_obligations).not.toContain('evidence:primary')
    expect(expanded.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  })

  it('retains follow-ups when files are incomplete or stale instead of treating them as verified reads', async () => {
    const incomplete = await call({ verbose: true })
    expect(incomplete.pack.matched_nodes.some((node: Record<string, unknown>) => node.snippet_file_complete)).toBe(false)
    expect(incomplete.expandable.length).toBeGreaterThan(0)
    writeFileSync(join(root, 'src/batch.ts'), source.replace('./normalize.js', './missing.js'))
    const future = new Date(Date.now() + 10_000)
    utimesSync(join(root, 'src/batch.ts'), future, future)
    const stale = await call()
    expect(stale.governance.graph_freshness.status).not.toBe('fresh')
    expect(stale.expandable.length).toBeGreaterThan(0)
  })

  it('retains budget omission warnings and evidence gaps when source does not fit', async () => {
    const payload = await call({ budget: 300 })
    expect(payload.omitted_evidence ?? payload.evidence.answerability.caveats?.join(' ')).toMatch(/budget|omitted/i)
    expect(payload.evidence.agent_directive ?? 'explore_with_caution').toBe('explore_with_caution')
  })

  it.each([{}, { delta_session_id: 'validation-discovery' }])(
    'refreshes root validation discovery when an unindexed package changes: %j', async extra => {
      vi.stubEnv('MADAR_TOOL_PROFILE', 'delta_session_id' in extra ? 'full' : 'strict')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
      const first = await call(extra)
      expect(first.implementation.validation_discovery).toMatchObject({ source_file: 'package.json',
        scope: 'root_package_validation_scripts', status: 'inspected', result: 'no_scripts' })
      expect(first.implementation.validation_commands).toBeUndefined()
      expect(Number.isFinite(Date.parse(first.implementation.validation_discovery.observed_at))).toBe(true)

      // Reuse the same graph, prompt and server state; inspection must read the new manifest.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
      const second = await call(extra)
      expect(second.implementation.validation_discovery).toMatchObject({ status: 'inspected', result: 'commands_available' })
      expect(second.implementation.validation_commands).toEqual(['npm run test'])
    },
  )

  it('delivers the verified file including imports without duplicate function bodies', async () => {
    const payload = await call()
    const nodes = payload.pack.matched_nodes as Array<Record<string, unknown>>
    const batch = nodes.find(node => String(node.source_file).endsWith('src/batch.ts') && node.snippet_file_complete)
    expect(batch).toMatchObject({ snippet: source, snippet_scope: 'source_file', snippet_line_range: { start_line: 1, end_line: 6 } })
    expect(payload.pack.source_read).toContain('read again if files change')
    const snippets = nodes.map(node => resolveSourceSnippet(node, nodes)).join('\n')
    expect(snippets).toContain('return items.map(normalizeItem)')
    expect(snippets).toContain('return value.trim()')
    expect(nodes.map(node => String(node.snippet ?? '')).join('\n').match(/return items.map\(normalizeItem\)/g)).toHaveLength(1)
  })

  it('reads changed imports anew instead of attaching a cached header', async () => {
    await call()
    const changed = source.replace('./normalize.js', './renamed.js')
    writeFileSync(join(root, 'src/batch.ts'), changed)
    const payload = await call()
    const batch = payload.pack.matched_nodes.find((node: Record<string, unknown>) => node.snippet_file_complete && String(node.source_file).endsWith('src/batch.ts'))
    expect(batch?.snippet).toBe(changed)
  })

  it.each([{ task: 'explain' }, { resolution: 'signature' }, { verbose: true }, { delta_session_id: 'existing-delta' }])(
    'leaves other response modes outside this optional enrichment: %j', async extra => {
      const payload = await call(extra)
      expect(payload.pack.source_read).toBeUndefined()
      expect(payload.pack.matched_nodes.some((node: Record<string, unknown>) => node.snippet_file_complete)).toBe(false)
    },
  )
})
