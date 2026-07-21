// Capability-aware extraction modes. The CLI defaults to auto: SPI supplies
// JS/TS metadata while legacy semantics preserve the established topology.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'

import { parseGenerateArgs } from '../../src/cli/parser.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { readCanonicalGraphFixture } from '../helpers/graph-artifact.js'

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
    const opts = parseGenerateArgs(['--spi'])
    expect(opts.extractionMode).toBe('spi')
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

    const result = generateGraph(sandbox, {  })
    const graph = readCanonicalGraphFixture(result.graphPath)
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

    const first = generateGraph(sandbox, { extractionMode: 'auto' })
    const second = generateGraph(sandbox, { extractionMode: 'auto' })
    const secondGraph = readCanonicalGraphFixture(second.graphPath)

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

    const result = generateGraph(sandbox, { extractionMode: 'spi' })
    const graph = readCanonicalGraphFixture(result.graphPath)
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

    const result = generateGraph(sandbox, { extractionMode: 'spi' })
    const graph = readCanonicalGraphFixture(result.graphPath)

    expect(graph.spi_mode).toBeUndefined()
  })

  it('preserves an existing auto graph SPI marker during a cluster-only rebuild', () => {
    writeFile(sandbox, 'src/only-spi.ts', 'export const answer = 42\n')
    generateGraph(sandbox, { extractionMode: 'auto' })

    rmSync(join(sandbox, 'src/only-spi.ts'))
    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')

    const clustered = generateGraph(sandbox, { clusterOnly: true })
    const graph = readCanonicalGraphFixture(clustered.graphPath)
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
    })
    const graph = readCanonicalGraphFixture(result.graphPath)
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

    const result = generateGraph(sandbox, { extractionMode: 'spi' })
    const parsed = readCanonicalGraphFixture(result.graphPath)

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

    const result = generateGraph(sandbox, { extractionMode: 'spi' })
    const parsed = readCanonicalGraphFixture(result.graphPath)
    const listUsersNode = parsed.nodes.find((n) => n.label === 'listUsers()')
    expect(listUsersNode).toBeDefined()
    expect(listUsersNode?.framework).toBe('express')
    expect(listUsersNode?.framework_role).toBe('express_route')
    expect(listUsersNode?.node_kind).toBe('route')
    expect(listUsersNode?.route_path).toBe('/users')
  })

  it('uses the SPI cache on the second call (notes include "cache hit")', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi' })
    expect(first.notes.some((n) => n.includes('SPI build'))).toBe(true)

    const second = generateGraph(sandbox, { extractionMode: 'spi' })
    expect(second.notes.some((n) => n.toLowerCase().includes('cache hit'))).toBe(true)
  })

  it('keeps non-code extraction alongside SPI-projected code and reports only the code subset as cached', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    writeFile(sandbox, 'docs/notes.md', '# Notes\nGraph docs\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi' })
    const firstGraph = readCanonicalGraphFixture(first.graphPath)
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

    const second = generateGraph(sandbox, { extractionMode: 'spi' })
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

    const result = generateGraph(sandbox, { extractionMode: 'legacy' })
    const parsed = readCanonicalGraphFixture(result.graphPath)

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

    const spiResult = generateGraph(sandbox, { extractionMode: 'spi' })
    const spiGraph = readCanonicalGraphFixture(spiResult.graphPath)
    expect(spiGraph.spi_mode).toBe(true)

    const updated = generateGraph(sandbox, { extractionMode: 'legacy', update: true })
    const updatedGraph = readCanonicalGraphFixture(updated.graphPath)
    expect(updatedGraph.spi_mode).toBeUndefined()
  })

  it('does not let unsupported files alter strict SPI source IDs', () => {
    writeFile(sandbox, 'src/main.ts', 'export function answer(): number { return 42 }\n')
    const before = generateGraph(sandbox, { extractionMode: 'spi' })
    const beforeGraph = readCanonicalGraphFixture(before.graphPath)
    const beforeSource = beforeGraph.nodes.find((node) => String(node.source_file).endsWith('/src/main.ts'))

    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')
    const after = generateGraph(sandbox, { extractionMode: 'spi' })
    const afterGraph = readCanonicalGraphFixture(after.graphPath)
    const afterSource = afterGraph.nodes.find((node) => String(node.source_file).endsWith('/src/main.ts'))

    expect(afterSource?.id).toBe(beforeSource?.id)
  })

  it('rejects a programmatic cluster-only request that conflicts with the stored extraction mode', () => {
    writeFile(sandbox, 'src/foo.ts', 'export const foo = 1\n')
    generateGraph(sandbox, { extractionMode: 'spi' })

    expect(() => generateGraph(sandbox, {
      clusterOnly: true,
      extractionMode: 'legacy',
    })).toThrow('cannot change extraction mode from spi to legacy')
  })
})
