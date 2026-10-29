import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { selectSourceDependencies } from '../../src/runtime/retrieve/source-dependencies.js'
import { createSourceModuleResolver, getSourceModuleConfigurationSnapshot, sourceModuleConfigurationSnapshotIsFresh } from '../../src/runtime/retrieve/source-modules.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const config = (paths: Record<string, string[]>, baseUrl = '.') => JSON.stringify({ compilerOptions: { baseUrl, paths } })

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-module-config-')); roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source)
  }
  const graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
  const graph = loadGraph(graphPath)
  const idFor = (label: string, suffix: string) => graph.nodeEntries().find(([, node]) => node.label === label && String(node.source_file).endsWith(suffix))![0]
  return { root, graph, graphPath, idFor }
}

const bodies = {
  'src/domain/receipt.ts': 'export const limit = 4;\nexport function issueReceipt(value: string) { return "BOUND_RECEIPT:" + value; }',
  'src/metrics/receipt.ts': 'export const limit = 999;\nexport function issueReceipt(value: string) { return "UNRELATED_METRIC:" + value; }',
}

describe('bounded TypeScript source module resolution', () => {
  it.each([
    { name: 'paths', specifier: '@domain/receipt', configs: { 'tsconfig.json': config({ '@domain/*': ['src/domain/*'] }) } },
    { name: 'paths without baseUrl', specifier: '@domain/receipt', configs: { 'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@domain/*': ['./src/domain/*'] } } }) } },
    { name: 'baseUrl', specifier: 'domain/receipt', configs: { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src' } }) } },
    { name: 'nearest extended config', specifier: '@domain/receipt', configs: {
      'tsconfig.json': config({ '@domain/*': ['src/metrics/*'] }),
      'src/tsconfig.json': '{"extends":"../config/domain"}',
      'config/domain.json': config({ '@domain/*': ['src/domain/*'] }, '..'),
    } },
    { name: 'nearer jsconfig', specifier: '@domain/receipt', configs: {
      'tsconfig.json': config({ '@domain/*': ['src/metrics/*'] }),
      'src/jsconfig.json': config({ '@domain/*': ['domain/*'] }),
    } },
  ])('serves the actual bound implementation through default generation and MCP: $name', async ({ specifier, configs }) => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const { graphPath } = fixture({ ...bodies, ...configs,
      'src/service.ts': `import { issueReceipt as finishReceipt } from '${specifier}';\nexport function dispatchNotice(value: string) { return finishReceipt(value); }`,
    })
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: {
      prompt: 'Trace dispatchNotice and the concrete implementation it calls.', task: 'explain', budget: 3000,
    } } })
    expect(response?.error).toBeUndefined()
    const payload = JSON.parse((response!.result as { content: Array<{ text: string }> }).content[0]!.text)
    const nodes = payload.pack.matched_nodes
    const text = nodes.map((node: Parameters<typeof resolveSourceSnippet>[0]) => resolveSourceSnippet(node, nodes)).join('\n')
    expect(text).toContain('BOUND_RECEIPT:')
    expect(text).not.toContain('UNRELATED_METRIC:')
    expect(payload.pack.source_dependencies).toMatchObject({ resolved_calls: 1, unresolved_calls: 0, bounded: false })
  })

  it('rereads same-size config edits with restored timestamps and keeps targets inside the index', () => {
    const { root, graph, idFor } = fixture({ ...bodies, 'tsconfig.json': config({ '@domain/*': ['src/domain/*'] }),
      'src/service.ts': "import { issueReceipt } from '@domain/receipt';\nexport function dispatchNotice(value: string) { return issueReceipt(value); }",
    })
    const cache = new Map<string, string[] | null>()
    const select = () => selectSourceDependencies(graph, [idFor('dispatchNotice()', 'service.ts')], root, cache, { includeCallers: false })
    expect(select().node_ids).toContain(idFor('issueReceipt()', 'domain/receipt.ts'))
    const path = join(root, 'tsconfig.json'), before = statSync(path)
    // Both directories have six characters; this also defeats metadata-only caching.
    writeFileSync(path, config({ '@domain/*': ['src/metric/*'] }))
    mkdirSync(join(root, 'src/metric')); writeFileSync(join(root, 'src/metric/receipt.ts'), bodies['src/metrics/receipt.ts'])
    utimesSync(path, before.atime, before.mtime)
    expect(statSync(path).size).toBe(before.size)
    const absentFromIndex = select()
    expect(absentFromIndex.node_ids).toEqual([])
    expect(absentFromIndex.receipt.unresolved_calls).toBe(1)
    writeFileSync(path, config({ '@domain/*': ['src/metrics/*'] }))
    expect(select().node_ids).toEqual([idFor('issueReceipt()', 'metrics/receipt.ts')])
  })

  it('keeps configuration cache fingerprints off the wire and invalidates content, absence, policy, and root changes', () => {
    const { root, graph, idFor } = fixture({ ...bodies, 'tsconfig.json': '{"extends":"./base.json"}',
      'base.json': config({ '@domain/*': ['src/domain/*'] }),
      'src/service.ts': "import { issueReceipt } from '@domain/receipt';\nexport function dispatchNotice(value: string) { return issueReceipt(value); }",
    })
    const selected = selectSourceDependencies(graph, [idFor('dispatchNotice()', 'service.ts')], root, new Map(), { includeCallers: false })
    const snapshot = getSourceModuleConfigurationSnapshot({ ...selected.receipt })!
    expect(snapshot.cacheable).toBe(true)
    expect(snapshot.files[join(root, 'src/tsconfig.json')]).toBe('missing')
    expect(snapshot.files[join(root, 'src/jsconfig.json')]).toBe('missing')
    expect(snapshot.files[join(root, 'base.json')]).toMatch(/^sha256:/)
    expect(JSON.stringify(selected.receipt)).not.toContain('root_path')
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, root)).toBe(true)
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, dirname(root))).toBe(false)
    const original = config({ '@domain/*': ['src/domain/*'] })
    const before = statSync(join(root, 'base.json'))
    writeFileSync(join(root, 'base.json'), config({ '@domain/*': ['src/metric/*'] }))
    utimesSync(join(root, 'base.json'), before.atime, before.mtime)
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, root)).toBe(false)
    writeFileSync(join(root, 'base.json'), original)
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, root)).toBe(true)
    writeFileSync(join(root, 'src/tsconfig.json'), '{}')
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, root)).toBe(false)
    rmSync(join(root, 'src/tsconfig.json'))
    writeFileSync(join(root, '.madarignore'), 'base.json\n')
    expect(sourceModuleConfigurationSnapshotIsFresh(snapshot, root)).toBe(false)
  })

  it('rejects invalid, package, cyclic, outside-root, sensitive and policy-blocked configuration without guessing', () => {
    const { root, graph, idFor } = fixture({ ...bodies, 'tsconfig.json': config({ '@domain/*': ['src/domain/*'] }),
      'src/service.ts': "import { issueReceipt } from '@domain/receipt';\nexport function dispatchNotice(value: string) { return issueReceipt(value); }",
    })
    const select = () => selectSourceDependencies(graph, [idFor('dispatchNotice()', 'service.ts')], root, new Map(), { includeCallers: false })
    const path = join(root, 'tsconfig.json')
    const outside = mkdtempSync(join(tmpdir(), 'madar-outside-config-')); roots.push(outside)
    writeFileSync(join(outside, 'config.json'), config({ '@domain/*': [join(root, 'src/domain/*')] }))
    for (const invalid of [
      '{', '{"extends":"some-config-package","compilerOptions":{"baseUrl":".","paths":{"@domain/*":["src/domain/*"]}}}',
      '{"extends":"./tsconfig.json"}', JSON.stringify({ extends: join(outside, 'config.json') }),
      '{"extends":"./secrets.json"}', ' '.repeat(256 * 1024 + 1),
    ]) {
      writeFileSync(path, invalid)
      const selected = select()
      expect(selected.node_ids).toEqual([])
      expect(selected.receipt).toMatchObject({ resolved_calls: 0, unresolved_calls: 1, bounded: true })
    }
    writeFileSync(path, config({ '@domain/*': ['src/domain/*'] }))
    writeFileSync(join(root, '.madarignore'), 'tsconfig.json\n')
    expect(select().receipt).toMatchObject({ resolved_calls: 0, unresolved_calls: 1, bounded: true })
    rmSync(join(root, '.madarignore')); rmSync(path); symlinkSync(join(outside, 'config.json'), path)
    expect(select().receipt).toMatchObject({ resolved_calls: 0, unresolved_calls: 1, bounded: true })
  })

  it('does not turn type-only imports or barrel exports into runtime calls or data bindings', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    for (const [imports, barrel] of [
      ["import type { issueReceipt, limit } from '@domain/receipt';", ''],
      ["import { issueReceipt, limit } from './public.js';", "export type { issueReceipt, limit } from '@domain/receipt';"],
      ["import { issueReceipt, limit } from './public.js';", "export type * from '@domain/receipt';"],
      ["import * as receipt from './public.js';", "export type * from '@domain/receipt';"],
    ]) {
      const namespace = imports!.includes('* as')
      const { root, graph, graphPath, idFor } = fixture({ ...bodies, 'tsconfig.json': config({ '@domain/*': ['src/domain/*'] }),
        'src/public.ts': barrel!,
        'src/service.ts': `${imports}\nexport function dispatchNotice(value: string) { return ${namespace ? 'receipt.' : ''}issueReceipt(value) + ${namespace ? 'receipt.' : ''}limit; }`,
      })
      const selected = selectSourceDependencies(graph, [idFor('dispatchNotice()', 'service.ts')], root, new Map(), { includeCallers: false })
      expect(selected.node_ids, imports).toEqual([])
      expect(selected.relationships, imports).toEqual([])
      expect(selected.receipt, imports).toMatchObject({ resolved_calls: 0, unresolved_calls: 1 })
      const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: {
        prompt: 'Trace dispatchNotice and the concrete implementation it calls.', task: 'explain', budget: 3000,
      } } })
      const payload = JSON.parse((response!.result as { content: Array<{ text: string }> }).content[0]!.text)
      const nodes = payload.pack.matched_nodes
      const text = nodes.map((node: Parameters<typeof resolveSourceSnippet>[0]) => resolveSourceSnippet(node, nodes)).join('\n')
      expect(text).not.toContain('BOUND_RECEIPT:')
      expect(text).not.toContain('UNRELATED_METRIC:')
      expect(payload.pack.source_dependencies).toMatchObject({ resolved_calls: 0, unresolved_calls: 1 })
    }
  })

  it('retains real named and export-star value bindings beside unrelated type-only exports', () => {
    const { root, graph, idFor } = fixture({ ...bodies, 'tsconfig.json': config({ '@domain/*': ['src/domain/*'] }),
      'src/public.ts': "export * from '@domain/receipt';\nexport type * from './types.js';",
      'src/types.ts': 'export interface Other { id: string }',
      'src/service.ts': "import { issueReceipt } from './public.js';\nimport * as receipt from './public.js';\nexport function dispatchNotice(value: string) { return issueReceipt(value) + receipt.issueReceipt(value) + receipt.limit; }",
    })
    const selected = selectSourceDependencies(graph, [idFor('dispatchNotice()', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toEqual(expect.arrayContaining([idFor('issueReceipt()', 'domain/receipt.ts'), idFor('limit', 'domain/receipt.ts')]))
    expect(selected.receipt).toMatchObject({ resolved_calls: 2, unresolved_calls: 0, resolved_references: 1 })
  })

  it('does not resolve an excluded target or an ancestor config outside the graph root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'madar-config-parent-')); roots.push(parent)
    writeFileSync(join(parent, 'tsconfig.json'), config({ '@domain/*': ['src/domain/*'] }))
    const root = join(parent, 'nested'); mkdirSync(root)
    const importer = join(root, 'service.ts'), target = join(root, 'receipt.ts')
    writeFileSync(importer, 'export {}'); writeFileSync(target, 'export function issueReceipt() {}')
    let incomplete = false
    const resolver = createSourceModuleResolver(new Set([importer, target]), root, () => { incomplete = true })
    expect(resolver('@domain/receipt', importer)).toBeUndefined()
    expect(incomplete).toBe(false)
    writeFileSync(join(root, 'tsconfig.json'), config({ '@domain/*': ['./*'] }))
    writeFileSync(join(root, '.madarignore'), 'receipt.ts\n')
    expect(createSourceModuleResolver(new Set([importer, target]), root, () => {})('@domain/receipt', importer)).toBeUndefined()
    const receipt = {}
    expect(createSourceModuleResolver(new Set([importer, target]), root, () => {}, receipt)('./receipt.js', importer)).toBeUndefined()
    expect(getSourceModuleConfigurationSnapshot(receipt)?.files[join(root, '.madarignore')]).toMatch(/^sha256:/)
  })
})
