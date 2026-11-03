import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'

let root: string
let graphPath: string
let state: NonNullable<Parameters<typeof handleStdioRequest>[2]>
let requestId = 0

const configuration = (target: string) => JSON.stringify({ compilerOptions: {
  baseUrl: '.', paths: { '@receipt': [`src/${target}.ts`] },
} })

beforeEach(() => {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  root = mkdtempSync(join(tmpdir(), 'madar-module-cache-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/entry.ts'), [
    "import { finishReceipt } from '@receipt';",
    'export function createReceipt(input: string) { return finishReceipt(input); }',
  ].join('\n'))
  for (const target of ['first', 'other']) {
    writeFileSync(join(root, `src/${target}.ts`),
      `export function finishReceipt(input: string) { return { code: '${target.toUpperCase()}', input }; }\n`)
  }
  writeFileSync(join(root, 'tsconfig.json'), configuration('first'))
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null,
    contextPackCache: new Map() }
})

afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

function generate() {
  graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
}

async function call(arguments_ = { prompt: 'Explain createReceipt implementation.', task: 'explain', budget: 6000 }) {
  const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: {
    name: 'context_pack', arguments: arguments_,
  } }, state)
  expect(response?.error).toBeUndefined()
  const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text)
  expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(arguments_.budget)
  expect(text).not.toContain('source_configuration')
  expect(text).not.toContain('root_path')
  return payload
}

function files(payload: { pack: { matched_nodes: Array<{ source_file: string }> } }) {
  return payload.pack.matched_nodes.map(node => node.source_file)
}

describe('configuration-aware explain cache through strict MCP', () => {
  it('preserves raw source recovery when optional module configuration is unusable from the outset', async () => {
    const source = [
      'export function calculateReceipt(input: string) {',
      '  let total = 0;',
      ...Array.from({ length: 180 }, (_, index) => `  total += ${index + 1};`),
      '  return input + total;',
      '}',
    ]
    writeFileSync(join(root, 'src/local.ts'), source.join('\n'))
    writeFileSync(join(root, 'src/entry.ts'), [
      "import { calculateReceipt } from './local.js';",
      "import { finishReceipt } from '@receipt';",
      'export function createReceipt(input: string) { return finishReceipt(calculateReceipt(input)); }',
    ].join('\n'))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      ...JSON.parse(configuration('first')), extends: '@unsupported/tsconfig',
    }))
    generate()
    const payload = await call({ prompt: 'Explain createReceipt implementation.', task: 'explain', budget: 3000 })
    expect(payload.serialized_budget).toMatchObject({ max_tokens: 3000, enforced: true })
    expect(payload.omitted_evidence).not.toBe('source recovery could not be verified')
    expect(payload.cache).toBeUndefined()
    expect(state.contextPackCache!.size).toBe(0)
    expect(payload.pack.source_dependencies.bounded).toBe(true)
    expect(payload.pack.source_dependencies.unresolved_calls).toBeGreaterThan(0)
    expect(files(payload)).not.toContain('src/first.ts')
    expect(files(payload)).not.toContain('src/other.ts')
    expect((payload.pack.relationships ?? []).some((edge: { relation: string; to_id?: string }) =>
      edge.relation === 'calls' && ['first_finishreceipt', 'other_finishreceipt'].includes(edge.to_id ?? ''))).toBe(false)
    const nodes = payload.pack.matched_nodes
    const owner = nodes.find((node: { source_file: string; source_expand_handle?: string }) =>
      node.source_file === 'src/local.ts' && node.source_expand_handle)
    expect(owner).toBeDefined()
    expect(owner.snippet_line_range).toEqual({ start_line: 1, end_line: source.length })
    expect(owner.snippet_omitted_ranges.length).toBeGreaterThan(0)
    const expected: string[] = []
    for (let line = owner.snippet_line_range.start_line; line <= owner.snippet_line_range.end_line; line++) {
      const gap = owner.snippet_omitted_ranges.find((range: { start_line: number }) => range.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else expected.push(source[line - 1]!)
    }
    expect(resolveSourceSnippet(owner, nodes)).toBe(expected.join('\n'))
    const handle = state.contextPackHandles?.get(owner.source_expand_handle) as { kind: string; source_file: string }
    expect(handle.kind).toBe('source_continuation')
    expect(resolve(root, handle.source_file)).toBe(join(root, 'src/local.ts'))
    expect(payload.evidence.answerability).toMatchObject({ advisory: true })
    expect(payload.evidence.answerability.answer_scope).not.toBe('complete')
  })

  it('invalidates a changed alias even when graph, source files, config size and mtime are unchanged', async () => {
    generate()
    const graphBefore = readFileSync(graphPath)
    expect(files(await call())).toContain('src/first.ts')
    expect((await call()).cache.status).toBe('hit')
    const path = join(root, 'tsconfig.json'), before = statSync(path)
    writeFileSync(path, configuration('other'))
    utimesSync(path, before.atime, before.mtime)
    expect(statSync(path).size).toBe(before.size)
    const redirected = await call()
    expect(redirected.cache.status).toBe('miss')
    expect(files(redirected)).toContain('src/other.ts')
    expect(files(redirected)).not.toContain('src/first.ts')
    expect((await call()).cache.status).toBe('hit')
    expect(readFileSync(graphPath)).toEqual(graphBefore)
  })

  it('invalidates on creation of a nearer config that was absent when cached', async () => {
    generate()
    expect(files(await call())).toContain('src/first.ts')
    expect((await call()).cache.status).toBe('hit')
    writeFileSync(join(root, 'src/tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', compilerOptions: {
      paths: { '@receipt': ['src/other.ts'] },
    } }))
    const redirected = await call()
    expect(redirected.cache.status).toBe('miss')
    expect(files(redirected)).toContain('src/other.ts')
    expect(files(redirected)).not.toContain('src/first.ts')
  })

  it('tracks an extended config and bypasses caching if it disappears', async () => {
    mkdirSync(join(root, 'config'))
    const base = join(root, 'config/base.json')
    const baseConfiguration = (target: string) => JSON.stringify({ compilerOptions: {
      baseUrl: '..', paths: { '@receipt': [`src/${target}.ts`] },
    } })
    writeFileSync(base, baseConfiguration('first'))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './config/base.json' }))
    generate()
    expect(files(await call())).toContain('src/first.ts')
    expect((await call()).cache.status).toBe('hit')
    writeFileSync(base, baseConfiguration('other'))
    const redirected = await call()
    expect(redirected.cache.status).toBe('miss')
    expect(files(redirected)).toContain('src/other.ts')
    unlinkSync(base)
    const unresolved = await call()
    expect(unresolved.cache).toBeUndefined()
    expect(files(unresolved)).not.toContain('src/first.ts')
    expect(files(unresolved)).not.toContain('src/other.ts')
    expect(unresolved.pack.source_dependencies.unresolved_calls).toBeGreaterThan(0)
    expect(state.contextPackCache!.size).toBe(0)
  })

  it('invalidates a relative dependency when its source becomes ignored', async () => {
    writeFileSync(join(root, 'src/entry.ts'), [
      "import { finishReceipt } from './first.js';",
      'export function createReceipt(input: string) { return finishReceipt(input); }',
    ].join('\n'))
    generate()
    expect(files(await call())).toContain('src/first.ts')
    expect((await call()).cache.status).toBe('hit')
    writeFileSync(join(root, '.madarignore'), 'src/first.ts\n')
    const blocked = await call()
    expect(blocked.cache.status).toBe('miss')
    expect(files(blocked)).not.toContain('src/first.ts')
    expect(blocked.pack.source_dependencies.unresolved_calls).toBeGreaterThan(0)
  })
})
