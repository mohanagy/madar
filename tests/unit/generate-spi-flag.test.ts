// Capability-aware extraction modes. The CLI defaults to auto: SPI supplies
// JS/TS metadata while legacy semantics preserve the established topology.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'

import { parseGenerateArgs } from '../../src/cli/parser.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { buildGenerationPolicy } from '../../src/infrastructure/generation-policy.js'
import { EXTRACTOR_CACHE_VERSION, extractJs } from '../../src/pipeline/extract.js'
import { buildSpiCached } from '../../src/pipeline/spi/cache.js'

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

describe('parseGenerateArgs extraction modes', () => {
  it('defaults to capability-aware auto extraction', () => {
    const opts = parseGenerateArgs([])
    expect(opts.extractionMode).toBe('auto')
  })

  it('selects strict SPI extraction when --spi is present', () => {
    const opts = parseGenerateArgs(['--spi'])
    expect(opts.extractionMode).toBe('spi')
  })

  it('selects strict legacy extraction when --legacy is present', () => {
    const opts = parseGenerateArgs(['--legacy'])
    expect(opts.extractionMode).toBe('legacy')
  })

  it('keeps extraction flags mutually exclusive and co-exists with other flags', () => {
    const opts = parseGenerateArgs(['--spi', '--directed', '--no-html'])
    expect(opts.extractionMode).toBe('spi')
    expect(opts.directed).toBe(true)
    expect(opts.noHtml).toBe(true)
    expect(() => parseGenerateArgs(['--legacy', '--spi'])).toThrow('--legacy and --spi cannot be used together')
    expect(() => parseGenerateArgs(['--spi', '--legacy'])).toThrow('--legacy and --spi cannot be used together')
    expect(() => parseGenerateArgs(['--cluster-only', '--legacy'])).toThrow('--cluster-only cannot be combined with --legacy or --spi')
    expect(() => parseGenerateArgs(['--spi', '--cluster-only'])).toThrow('--cluster-only cannot be combined with --legacy or --spi')
  })
})

describe('generateGraph capability-aware auto extraction', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('generate-auto-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('allocates case-distinct top-level functions in every extraction mode', () => {
    writeFile(sandbox, 'case.ts', [
      'export function Beacon() { return 1 }',
      'export function beacon() { return 2 }',
      'export function Singleton() { return 3 }',
    ].join('\n') + '\n')
    for (const extractionMode of ['auto', 'spi', 'legacy'] as const) {
      const result = generateGraph(sandbox, { noHtml: true, extractionMode })
      const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        extractor_version: number
        nodes: Array<{ id: string; label: string }>
      }
      expect(graph.extractor_version).toBe(EXTRACTOR_CACHE_VERSION)
      expect(graph.nodes.find(node => node.label === 'Singleton()')?.id).toBe('case_singleton')
      const owners = graph.nodes.filter(node => node.label === 'Beacon()' || node.label === 'beacon()')
      expect(owners).toHaveLength(2)
      expect(owners.every(node => node.id.startsWith('case_beacon__case_'))).toBe(true)
      expect(graph.nodes.some(node => node.id === 'case_beacon')).toBe(false)
    }
  })

  it('preserves case-distinct type and callable owners across local, imported and Express bindings', () => {
    const declarations = [
      'export interface RewriteAllowance { free: boolean }',
      'export function rewriteAllowance() { function child() { return finish() } return { free: Beacon() > 0 && child() > 0 } }',
      'export function Beacon() { return beacon() }',
      'export function beacon() { return 1 }',
    ]
    writeFile(sandbox, 'support.ts', 'export function finish() { return 1 }\n')
    writeFile(sandbox, 'consumer.ts', [
      "import express from 'express'",
      "import { rewriteAllowance as calculate } from './pair'",
      "import type { rewriteAllowance as typeOnly } from './pair'",
      'export function consume() { return calculate() }',
      'export function invalidTypeUse() { return typeOnly() }',
      'const app = express()', "app.get('/imported', calculate)",
      "export function installImported(calculate: unknown) { app.get('/shadow-import', calculate) }",
    ].join('\n'))
    writeFile(sandbox, 'optout.ts', [
      'export interface Same { value: number }', 'export function Same() { return 1 }',
      'export interface Foo_bar {}', 'export function foo_BAR() { return 1 }',
      'export class Foo { bar() { return 2 } }',
    ].join('\n'))
    let identities: Record<string, string> | undefined
    for (const reverse of [false, true]) {
      writeFile(sandbox, 'pair.ts', [
        "import express from 'express'", "import { finish } from './support'",
        ...(reverse ? [...declarations].reverse() : declarations),
        'export interface Extended extends RewriteAllowance {}',
        'export function shadow(rewriteAllowance: () => unknown) { return rewriteAllowance() }',
        'export function member(obj: { rewriteAllowance(value: number): unknown }) { return obj.rewriteAllowance(Beacon()) }',
        'const router = express.Router()', "router.get('/local', rewriteAllowance)",
        "export function install(rewriteAllowance: unknown) { router.get('/shadow', rewriteAllowance) }",
      ].join('\n'))
      const raw = extractJs(join(sandbox, 'pair.ts'))
      for (const extractionMode of ['auto', 'legacy'] as const) {
        const result = generateGraph(sandbox, { noHtml: true, includeDocs: false, extractionMode })
        const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
          nodes: Array<{ id: string; label: string; snippet?: string; source_location?: string }>
          links: Array<{ source: string; target: string; relation: string }>
        }
        const owner = (label: string) => {
          const found = graph.nodes.filter(node => node.label === label)
          expect(found, `${extractionMode}:${label}`).toHaveLength(1)
          return found[0]!
        }
        const type = owner('RewriteAllowance'), callable = owner('rewriteAllowance()')
        const upper = owner('Beacon()'), lower = owner('beacon()')
        const ids = Object.fromEntries([type, callable, upper, lower].map(node => [node.label, node.id]))
        if (identities) expect(ids).toEqual(identities)
        else identities = ids
        expect(new Set(Object.values(ids)).size).toBe(4)
        expect(type.snippet).toContain('interface RewriteAllowance')
        expect(callable.snippet).toContain('return { free: Beacon()')
        expect(graph.nodes.some(node => ['pair_rewriteallowance', 'pair_beacon'].includes(node.id))).toBe(false)
        const has = (source: string, target: string, relation = 'calls') => graph.links.some(edge =>
          edge.source === source && edge.target === target && edge.relation === relation)
        expect(has(upper.id, lower.id)).toBe(true)
        expect(has(callable.id, upper.id)).toBe(true)
        expect(has(owner('consume()').id, callable.id)).toBe(true)
        expect(graph.links.some(edge => edge.relation === 'calls' && edge.target === type.id)).toBe(false)
        expect(has(owner('invalidTypeUse()').id, callable.id)).toBe(false)
        expect(has(owner('shadow()').id, callable.id)).toBe(false)
        expect(has(owner('member()').id, callable.id)).toBe(false)
        expect(has(owner('member()').id, upper.id)).toBe(true)
        const child = owner('child()')
        expect(child.id).toBe('pair_rewriteallowance_child')
        expect(raw.edges.some(edge => edge.source === callable.id && edge.target === child.id && edge.relation === 'contains')).toBe(true)
        expect(has(callable.id, child.id)).toBe(true)
        expect(has(child.id, owner('finish()').id)).toBe(true)
        expect(has(owner('Extended').id, type.id, 'inherits')).toBe(true)
        for (const route of ['/local', '/imported']) {
          const targets = graph.links.filter(edge => edge.relation === 'depends_on' && edge.target === callable.id)
          expect(targets.some(edge => graph.nodes.find(node => node.id === edge.source)?.label.includes(route))).toBe(true)
        }
        expect(graph.links.some(edge => edge.relation === 'depends_on' && edge.target === callable.id
          && graph.nodes.find(node => node.id === edge.source)?.label.includes('/shadow'))).toBe(false)
        expect(graph.nodes.filter(node => node.id === 'optout_same')).toHaveLength(1)
        expect(graph.nodes.filter(node => node.id === 'optout_foo_bar')).toHaveLength(1)
        expect(graph.nodes.some(node => node.id.startsWith('optout_') && node.id.includes('__case_'))).toBe(false)
      }
    }
  })

  it.each([false, true])('preserves the full function range and body in the default auto graph (Express metadata: %s)', (withFramework) => {
    const source = [
      'export function processRequest(input: string) {',
      '  if (!input) {',
      '    throw new Error("missing input")',
      '  }',
      '  return input.trim()',
      '}',
    ].join('\n')
    writeFile(sandbox, 'src/request.ts', withFramework
      ? `import express from "express"\nconst app = express()\n${source}\napp.post("/requests", processRequest)\n`
      : `${source}\n`)

    const result = generateGraph(sandbox, { noHtml: true })
    const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as { nodes: Array<Record<string, unknown>> }

    expect(graph.nodes.find((node) => node.label === 'processRequest()')).toMatchObject({
      source_location: withFramework ? 'L3-L8' : 'L1-L6',
      snippet: source,
      extraction_strategy: 'spi',
      provenance: [expect.objectContaining({ capability_id: 'builtin:extract:typescript', stage: 'extract' })],
      ...(withFramework ? { framework: 'express', framework_role: 'express_route', route_path: '/requests' } : {}),
    })
  })

  it('rebuilds old cached auto evidence on update even when source files are unchanged', () => {
    const source = 'export function processRequest(input: string) {\n  return input.trim()\n}'
    const sourcePath = join(sandbox, 'src/request.ts')
    writeFile(sandbox, 'src/request.ts', `${source}\n`)
    const first = generateGraph(sandbox, { noHtml: true })
    const previousVersion = EXTRACTOR_CACHE_VERSION - 1
    const previousPolicy = buildGenerationPolicy(sandbox, {}, previousVersion, null)
    const graph = JSON.parse(readFileSync(first.graphPath, 'utf8')) as {
      extractor_version: number
      generation_policy: unknown
      nodes: Array<Record<string, unknown>>
    }
    graph.extractor_version = previousVersion
    graph.generation_policy = previousPolicy
    const oldNode = graph.nodes.find((node) => node.label === 'processRequest()')!
    oldNode.source_location = 'L1'
    delete oldNode.snippet
    writeFileSync(first.graphPath, JSON.stringify(graph), 'utf8')
    const manifestPath = join(first.outputDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.generation_policy = previousPolicy
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
    buildSpiCached({
      root: sandbox,
      madarVersion: `spi-extractor-${previousVersion}`,
      extractorVersion: `spi-v1.0.0-enqueues-job-${previousVersion}`,
      includedFiles: new Set([sourcePath]),
    })

    const updated = generateGraph(sandbox, { update: true, noHtml: true })
    const updatedGraph = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
      extractor_version: number
      nodes: Array<Record<string, unknown>>
    }

    expect(updated.notes.join('\n')).toContain('Generation policy changed')
    expect(updated.cache).toMatchObject({ strategy: 'spi', hit: false })
    expect(updatedGraph.extractor_version).toBe(EXTRACTOR_CACHE_VERSION)
    expect(updatedGraph.nodes.find((node) => node.label === 'processRequest()')).toMatchObject({
      source_location: 'L1-L3', snippet: source,
    })
  })

  function writeMixedWorkspace(): void {
    writeFile(sandbox, 'src/main.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')
    writeFile(sandbox, 'cmd/main.go', [
      'package main',
      '',
      'func main() {}',
    ].join('\n') + '\n')
    writeFile(sandbox, 'docs/notes.md', '# Notes\nMixed-language graph\n')
  }

  it('keeps SPI metadata, legacy semantics, Go fallback, documents, and collision-safe IDs in one graph', () => {
    writeMixedWorkspace()

    const result = generateGraph(sandbox, { noHtml: true })
    const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      spi_mode?: unknown
      generation_policy?: { version?: unknown; settings?: { extraction_mode?: unknown } }
      extraction_receipt?: Record<string, unknown>
      nodes: Array<Record<string, unknown>>
    }
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath!, 'utf8')) as {
      requested_extraction_mode?: unknown
      outcomes: Array<Record<string, unknown>>
    }

    const listUsers = graph.nodes.find((node) => node.label === 'listUsers()')
    const goMain = graph.nodes.find((node) =>
      node.label === 'main()' && String(node.source_file).endsWith('/cmd/main.go'),
    )
    const codeFileNodes = graph.nodes.filter((node) =>
      node.label === 'main.ts' || node.label === 'main.go',
    )

    expect(graph.spi_mode).toBe(true)
    expect(graph.generation_policy).toMatchObject({
      version: 2,
      settings: { extraction_mode: 'auto' },
    })
    expect(listUsers).toMatchObject({
      framework: 'express',
      framework_role: 'express_route',
      route_path: '/users',
      extraction_strategy: 'spi',
    })
    expect(goMain).toMatchObject({ extraction_strategy: 'legacy_fallback' })
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'notes.md', file_type: 'document' }),
    ]))
    expect(codeFileNodes).toHaveLength(2)
    expect(new Set(codeFileNodes.map((node) => node.id)).size).toBe(2)
    expect(codeFileNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'src_main', label: 'main.ts' }),
      expect.objectContaining({ id: 'cmd_main', label: 'main.go' }),
    ]))
    expect(goMain).toMatchObject({ id: 'cmd_main_main' })
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'cmd/main.go',
        status: 'indexed',
        capability: 'builtin:extract:go',
        extraction_strategy: 'legacy_fallback',
        fallback_reason: 'spi_unsupported_language',
      }),
      expect.objectContaining({
        path: 'src/main.ts',
        status: 'indexed',
        extraction_strategy: 'spi',
      }),
    ]))
    expect(indexing.requested_extraction_mode).toBe('auto')
    expect(graph.extraction_receipt).toMatchObject({
      requested_mode: 'auto',
      strategies: { spi: 1, legacy_fallback: 1, non_code: 1 },
      fallbacks: { spi_unsupported_language: 1 },
    })
    expect(indexing.outcomes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'cmd/main.go', reason: 'unsupported_spi_language' }),
    ]))
    expect(result.notes.join('\n')).toContain('Auto extraction: SPI routed 1 supported source file(s); legacy semantic augmentation routed 1 supported source file(s); legacy fallback routed 1 SPI-unsupported source file(s).')
  })

  it('uses the SPI cache while retaining legacy semantics and re-extracting the fallback on a warm auto build', () => {
    writeMixedWorkspace()

    const first = generateGraph(sandbox, { extractionMode: 'auto', noHtml: true })
    const second = generateGraph(sandbox, { extractionMode: 'auto', noHtml: true })
    const secondGraph = JSON.parse(readFileSync(second.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }

    expect(first.cache).toEqual(expect.objectContaining({ strategy: 'spi', hit: false, fileCount: 1 }))
    expect(second.cache).toEqual(expect.objectContaining({ strategy: 'spi', hit: true, fileCount: 1 }))
    expect(first.extractedFiles).toBe(4)
    expect(second.extractedFiles).toBe(3)
    expect(secondGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'main()', source_file: expect.stringMatching(/cmd\/main\.go$/) }),
    ]))
  })

  it('does not use the fallback in explicit SPI mode', () => {
    writeMixedWorkspace()

    const result = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath!, 'utf8')) as {
      requested_extraction_mode?: unknown
      outcomes: Array<Record<string, unknown>>
    }

    expect(graph.nodes.some((node) => String(node.source_file).endsWith('/cmd/main.go'))).toBe(false)
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'cmd/main.go',
        status: 'unsupported',
        reason: 'unsupported_spi_language',
        extraction_strategy: 'spi',
      }),
    ]))
    expect(indexing.requested_extraction_mode).toBe('spi')
  })

  it('does not mark strict SPI mode when its code candidates produce no SPI evidence', () => {
    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')
    writeFile(sandbox, 'docs/notes.md', '# Retained non-code evidence\n')

    const result = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      spi_mode?: unknown
    }

    expect(graph.spi_mode).toBeUndefined()
  })

  it('preserves an existing auto graph SPI marker during a cluster-only rebuild', () => {
    writeFile(sandbox, 'src/only-spi.ts', 'export const answer = 42\n')
    generateGraph(sandbox, { extractionMode: 'auto', noHtml: true })

    rmSync(join(sandbox, 'src/only-spi.ts'))
    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')

    const clustered = generateGraph(sandbox, { clusterOnly: true, noHtml: true })
    const graph = JSON.parse(readFileSync(clustered.graphPath, 'utf8')) as {
      spi_mode?: unknown
    }
    const indexing = JSON.parse(readFileSync(clustered.indexingManifestPath!, 'utf8')) as {
      outcomes: Array<Record<string, unknown>>
    }

    expect(graph.spi_mode).toBe(true)
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'cmd/main.go',
        reason: 'retained_evidence_missing',
        extraction_strategy: 'not_extracted',
      }),
    ]))
  })

  test.runIf(process.platform !== 'win32')('keeps followed TypeScript symlinks on the SPI path', () => {
    const hiddenTarget = join(sandbox, '.linked-source.ts')
    const linkedSource = join(sandbox, 'linked.ts')
    writeFileSync(hiddenTarget, 'export function fromLinkedSource(): number { return 1 }\n', 'utf8')
    symlinkSync(hiddenTarget, linkedSource)

    const result = generateGraph(sandbox, {
      extractionMode: 'auto',
      followSymlinks: true,
      noHtml: true,
    })
    const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath!, 'utf8')) as {
      outcomes: Array<Record<string, unknown>>
    }

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'fromLinkedSource()', source_file: linkedSource }),
    ]))
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'linked.ts', status: 'indexed' }),
    ]))

    const warm = generateGraph(sandbox, {
      extractionMode: 'auto',
      followSymlinks: true,
      noHtml: true,
    })
    expect(warm.cache).toEqual(expect.objectContaining({ strategy: 'spi', hit: true, fileCount: 1 }))
  })
})

describe('generateGraph strict SPI extraction', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('generate-spi-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('produces a graph.json via the SPI projector when SPI is selected', () => {
    writeFile(sandbox, 'src/foo.ts', [
      'export function foo(): number { return 1 }',
      'export function bar(): number { return foo() }',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const parsed = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      spi_mode?: unknown
      nodes: Array<Record<string, unknown>>
    }

    // Standard graph.json should exist with code nodes for foo + bar.
    expect(existsSync(result.graphPath)).toBe(true)
    expect(result.nodeCount).toBeGreaterThan(0)
    expect(parsed.spi_mode).toBe(true)

    // Notes should reference the SPI pipeline.
    const hasSpiNote = result.notes.some((note) => note.toLowerCase().includes('spi'))
    expect(hasSpiNote).toBe(true)
  })

  it('framework_role + route_path flow end-to-end into graph.json with --spi', () => {
    // Confirms the v0.18 user-visible win: the SPI projector tags
    // Express route handlers with framework=express + framework_role=
    // express_route + node_kind=route + route_path, and the graph.json
    // serializer preserves all of these as plain node attributes.
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const result = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const parsed = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const listUsersNode = parsed.nodes.find((n) => n.label === 'listUsers()')
    expect(listUsersNode).toBeDefined()
    expect(listUsersNode?.framework).toBe('express')
    expect(listUsersNode?.framework_role).toBe('express_route')
    expect(listUsersNode?.node_kind).toBe('route')
    expect(listUsersNode?.route_path).toBe('/users')
  })

  it('uses the SPI cache on the second call (notes include "cache hit")', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    expect(first.notes.some((n) => n.includes('SPI build'))).toBe(true)

    const second = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    expect(second.notes.some((n) => n.toLowerCase().includes('cache hit'))).toBe(true)
  })

  it('keeps non-code extraction alongside SPI-projected code and reports only the code subset as cached', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    writeFile(sandbox, 'docs/notes.md', '# Notes\nGraph docs\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const firstGraph = JSON.parse(readFileSync(first.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    expect(first.extractableFiles).toBe(2)
    expect(first.extractedFiles).toBe(2)
    expect(first.cache).toEqual(expect.objectContaining({
      strategy: 'spi',
      hit: false,
      reason: 'no-cache',
      fileCount: 1,
    }))
    expect(firstGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'foo()', file_type: 'code' }),
        expect.objectContaining({ label: 'notes.md', file_type: 'document' }),
      ]),
    )

    const second = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    expect(second.extractableFiles).toBe(2)
    expect(second.extractedFiles).toBe(1)
    expect(second.cache).toEqual(expect.objectContaining({
      strategy: 'spi',
      hit: true,
      reason: 'fresh-cache',
      fileCount: 1,
    }))
  })

  it('uses the legacy extract pipeline when explicitly selected', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const result = generateGraph(sandbox, { extractionMode: 'legacy', noHtml: true })
    const parsed = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
      spi_mode?: unknown
      nodes: Array<Record<string, unknown>>
    }

    // No SPI notes in the legacy path.
    const hasSpiNote = result.notes.some((note) => note.toLowerCase().includes('spi'))
    expect(hasSpiNote).toBe(false)
    expect(parsed.spi_mode).toBeUndefined()
    expect(parsed.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'foo()', extraction_strategy: 'legacy' }),
    ]))
  })

  it('clears stale spi_mode on an explicit legacy update after an SPI build', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const spiResult = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const spiGraph = JSON.parse(readFileSync(spiResult.graphPath, 'utf8')) as {
      spi_mode?: unknown
    }
    expect(spiGraph.spi_mode).toBe(true)

    const updated = generateGraph(sandbox, { extractionMode: 'legacy', update: true, noHtml: true })
    const updatedGraph = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
      spi_mode?: unknown
    }
    expect(updatedGraph.spi_mode).toBeUndefined()
  })

  it('does not let unsupported files alter strict SPI source IDs', () => {
    writeFile(sandbox, 'src/main.ts', 'export function answer(): number { return 42 }\n')
    const before = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const beforeGraph = JSON.parse(readFileSync(before.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const beforeSource = beforeGraph.nodes.find((node) => String(node.source_file).endsWith('/src/main.ts'))

    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')
    const after = generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })
    const afterGraph = JSON.parse(readFileSync(after.graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const afterSource = afterGraph.nodes.find((node) => String(node.source_file).endsWith('/src/main.ts'))

    expect(afterSource?.id).toBe(beforeSource?.id)
  })

  it('rejects a programmatic cluster-only request that conflicts with the stored extraction mode', () => {
    writeFile(sandbox, 'src/foo.ts', 'export const foo = 1\n')
    generateGraph(sandbox, { extractionMode: 'spi', noHtml: true })

    expect(() => generateGraph(sandbox, {
      clusterOnly: true,
      extractionMode: 'legacy',
      noHtml: true,
    })).toThrow('cannot change extraction mode from spi to legacy')
  })
})
