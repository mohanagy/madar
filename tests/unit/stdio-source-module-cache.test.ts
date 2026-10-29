import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

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

async function call() {
  const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: {
    name: 'context_pack', arguments: { prompt: 'Explain createReceipt implementation.', task: 'explain', budget: 6000 },
  } }, state)
  expect(response?.error).toBeUndefined()
  const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text)
  expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(6000)
  expect(text).not.toContain('source_configuration')
  expect(text).not.toContain('root_path')
  return payload
}

function files(payload: { pack: { matched_nodes: Array<{ source_file: string }> } }) {
  return payload.pack.matched_nodes.map(node => node.source_file)
}

describe('configuration-aware explain cache through strict MCP', () => {
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
