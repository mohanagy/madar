// The legacy --spi spelling remains a mode selector until #571, but both auto
// and strict mode route supported JS/TS through the one canonical index.

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

  it('uses the canonical index once while retaining temporary unsupported and non-code companions', () => {
    writeMixedWorkspace()

    const result = generateGraph(sandbox, {  })
    const graph = readCanonicalGraphFixture(result.graphPath)
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath!, 'utf8')) as {
      requested_extraction_mode?: unknown
      outcomes: Array<Record<string, unknown>>
    }

    const listUsers = graph.nodes.find((node) => node.label === 'listUsers()')
    const goMain = graph.nodes.find((node) =>
      node.label === 'main()' && String(node.source_file).endsWith('cmd/main.go'),
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
      extraction_strategy: 'canonical',
    })
    expect(goMain).toMatchObject({ extraction_strategy: 'legacy_fallback' })
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'notes.md', file_type: 'document' }),
    ]))
    expect(codeFileNodes).toHaveLength(2)
    expect(new Set(codeFileNodes.map((node) => node.id)).size).toBe(2)
    expect(codeFileNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'main.ts' }),
      expect.objectContaining({ label: 'main.go' }),
    ]))
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'cmd/main.go',
        status: 'indexed',
        capability: 'builtin:extract:go',
        extraction_strategy: 'legacy_fallback',
        fallback_reason: 'canonical_unsupported_language',
      }),
      expect.objectContaining({
        path: 'src/main.ts',
        status: 'indexed',
        extraction_strategy: 'canonical',
      }),
    ]))
    expect(indexing.requested_extraction_mode).toBe('auto')
    expect(graph.extraction_receipt).toMatchObject({
      requested_mode: 'auto',
      strategies: { canonical: 1, legacy_fallback: 1, non_code: 1 },
      fallbacks: { canonical_unsupported_language: 1 },
    })
    expect(indexing.outcomes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'cmd/main.go', reason: 'unsupported_canonical_language' }),
    ]))
    expect(graph.nodes.filter((node) => node.label === 'listUsers()')).toHaveLength(1)
    expect(result.notes.join('\n')).toContain('Auto extraction: canonical TypeScript index routed 1 supported source file(s); legacy fallback routed 1 unsupported source file(s).')
  })

  it('rebuilds the uncached canonical index deterministically on repeated auto generation', () => {
    writeMixedWorkspace()

    const first = generateGraph(sandbox, { extractionMode: 'auto' })
    const second = generateGraph(sandbox, { extractionMode: 'auto' })
    const secondGraph = readCanonicalGraphFixture(second.graphPath)

    expect(first.cache).toBeNull()
    expect(second.cache).toBeNull()
    expect(first.extractedFiles).toBe(3)
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
        reason: 'unsupported_canonical_language',
        extraction_strategy: 'canonical',
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

  test.runIf(process.platform !== 'win32')('keeps followed TypeScript symlinks on the canonical path', () => {
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
      expect.objectContaining({ label: 'fromLinkedSource()', source_file: 'linked.ts' }),
    ]))
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'linked.ts', status: 'indexed' }),
    ]))

    const warm = generateGraph(sandbox, {
      extractionMode: 'auto',
      followSymlinks: true,
    })
    expect(warm.cache).toBeNull()
  })
})

describe('generateGraph strict SPI extraction', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('generate-spi-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('writes graph.json directly when the legacy --spi selector is used', () => {
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

    expect(result.notes.join('\n')).toContain('Canonical TypeScript index built 1 source file(s).')
  })

  it('framework_role + route_path flow end-to-end into graph.json with --spi', () => {
    // The canonical writer must preserve Express route metadata directly in graph.json.
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

  it('preserves distinct evidence-bearing call sites between the same symbols', () => {
    writeFile(sandbox, 'src/calls.ts', [
      'export function target(): void {}',
      'export function caller(): void {',
      '  target()',
      '  target()',
      '}',
    ].join('\n') + '\n')

    const graph = readCanonicalGraphFixture(generateGraph(sandbox, { extractionMode: 'spi' }).graphPath)
    const caller = graph.nodes.find((node) => node.label === 'caller()')
    const target = graph.nodes.find((node) => node.label === 'target()')
    const calls = graph.edges.filter((edge) =>
      edge.source === caller?.id && edge.target === target?.id && edge.relation === 'calls')

    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((edge) => edge.source_location))).toEqual(new Set(['L3', 'L4']))
  })

  it('does not retain an index cache or warm alternate path', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi' })
    expect(first.cache).toBeNull()

    const second = generateGraph(sandbox, { extractionMode: 'spi' })
    expect(second.cache).toBeNull()
    expect(second.notes.join('\n')).not.toContain('cache hit')
  })

  it('keeps non-code extraction alongside canonical code without a second index', () => {
    writeFile(sandbox, 'src/foo.ts', 'export function foo(): number { return 1 }\n')
    writeFile(sandbox, 'docs/notes.md', '# Notes\nGraph docs\n')

    const first = generateGraph(sandbox, { extractionMode: 'spi' })
    const firstGraph = readCanonicalGraphFixture(first.graphPath)
    expect(first.extractableFiles).toBe(2)
    expect(first.extractedFiles).toBe(2)
    expect(first.cache).toBeNull()
    expect(firstGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'foo()', file_type: 'code' }),
        expect.objectContaining({ label: 'notes.md', file_type: 'document' }),
      ]),
    )

    const second = generateGraph(sandbox, { extractionMode: 'spi' })
    expect(second.extractableFiles).toBe(2)
    expect(second.extractedFiles).toBe(2)
    expect(second.cache).toBeNull()
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
