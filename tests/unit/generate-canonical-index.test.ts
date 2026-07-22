import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'

import { parseGenerateArgs } from '../../src/cli/parser.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { readCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath)
  mkdirSync(join(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, content, 'utf8')
}

function writeMixedWorkspace(root: string): void {
  writeFile(root, 'src/main.ts', [
    'import express from "express"',
    'export const app = express()',
    'export function listUsers(): void {}',
    'app.get("/users", listUsers)',
  ].join('\n') + '\n')
  writeFile(root, 'cmd/main.go', 'package main\nfunc main() {}\n')
  writeFile(root, 'docs/notes.md', '# Notes\nUnsupported documentation input\n')
}

describe('canonical-only generation', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox('canonical-index-generate-')
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it.each(['--legacy', '--spi', '--include-docs', '--docs', '--wiki'])(
    'rejects the retired %s flag',
    (flag) => {
      expect(() => parseGenerateArgs([flag])).toThrow()
    },
  )

  it('has no extraction-mode option in the default generate arguments', () => {
    expect(parseGenerateArgs([])).not.toHaveProperty('extractionMode')
  })

  it('indexes supported TypeScript once and records other recognized inputs as unsupported', () => {
    writeMixedWorkspace(sandbox)

    const result = generateGraph(sandbox)
    const graph = readCanonicalGraphFixture(result.graphPath)
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath, 'utf8')) as {
      outcomes: Array<Record<string, unknown>>
    }

    expect(result.codeFiles).toBe(1)
    expect(result.indexedFiles).toBe(1)
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'listUsers()',
        source_file: 'src/main.ts',
        framework: 'express',
        framework_role: 'express_route',
        route_path: '/users',
      }),
    ]))
    expect(graph.nodes.some((node) => /cmd\/main\.go|docs\/notes\.md/.test(String(node.source_file)))).toBe(false)
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'cmd/main.go',
        status: 'unsupported',
        reason: 'unsupported_file_type',
        capability: null,
      }),
      expect.objectContaining({
        path: 'docs/notes.md',
        status: 'unsupported',
        reason: 'unsupported_file_type',
        capability: null,
      }),
      expect.objectContaining({
        path: 'src/main.ts',
        status: 'indexed',
        capability: 'builtin:index:typescript',
      }),
    ]))
    expect(graph).not.toHaveProperty('spi_mode')
    expect(graph).not.toHaveProperty('extraction_receipt')
    expect(indexing).not.toHaveProperty('requested_extraction_mode')
    expect(graph.nodes.every((node) => node.extraction_strategy === undefined)).toBe(true)
  })

  it('rebuilds the canonical graph deterministically without an alternate cache path', () => {
    writeMixedWorkspace(sandbox)

    const first = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)
    const second = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)

    expect(second.nodes).toEqual(first.nodes)
    expect(second.edges).toEqual(first.edges)
  })

  it('preserves Express route facts end to end', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function listUsers(): void {}',
      'app.get("/users", listUsers)',
    ].join('\n') + '\n')

    const graph = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)
    expect(graph.nodes.find((node) => node.label === 'listUsers()')).toMatchObject({
      framework: 'express',
      framework_role: 'express_route',
      node_kind: 'route',
      route_path: '/users',
    })
  })

  it('preserves distinct evidence-bearing call sites between the same symbols', () => {
    writeFile(sandbox, 'src/calls.ts', [
      'export function target(): void {}',
      'export function caller(): void {',
      '  target()',
      '  target()',
      '}',
    ].join('\n') + '\n')

    const graph = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)
    const caller = graph.nodes.find((node) => node.label === 'caller()')
    const target = graph.nodes.find((node) => node.label === 'target()')
    const calls = graph.edges.filter((edge) =>
      edge.source === caller?.id && edge.target === target?.id && edge.relation === 'calls')

    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((edge) => edge.source_location))).toEqual(new Set(['L3', 'L4']))
  })

  test.runIf(process.platform !== 'win32')('keeps followed TypeScript symlinks on the canonical path', () => {
    const hiddenTarget = join(sandbox, '.linked-source.ts')
    const linkedSource = join(sandbox, 'linked.ts')
    writeFileSync(hiddenTarget, 'export function fromLinkedSource(): number { return 1 }\n', 'utf8')
    symlinkSync(hiddenTarget, linkedSource)

    const result = generateGraph(sandbox, { followSymlinks: true })
    const graph = readCanonicalGraphFixture(result.graphPath)
    const indexing = JSON.parse(readFileSync(result.indexingManifestPath, 'utf8')) as {
      outcomes: Array<Record<string, unknown>>
    }

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'fromLinkedSource()', source_file: 'linked.ts' }),
    ]))
    expect(indexing.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'linked.ts', status: 'indexed' }),
    ]))
  })

  it('keeps supported source identities stable when unsupported files are added', () => {
    writeFile(sandbox, 'src/main.ts', 'export function answer(): number { return 42 }\n')
    const before = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)
    const beforeSource = before.nodes.find((node) => node.source_file === 'src/main.ts')

    writeFile(sandbox, 'cmd/main.go', 'package main\nfunc main() {}\n')
    const after = readCanonicalGraphFixture(generateGraph(sandbox).graphPath)
    const afterSource = after.nodes.find((node) => node.source_file === 'src/main.ts')

    expect(afterSource?.id).toBe(beforeSource?.id)
    expect(after.nodes.some((node) => node.source_file === 'cmd/main.go')).toBe(false)
  })

  it('replaces a retired graph artifact during update without retaining stale facts', () => {
    writeFile(sandbox, 'src/main.ts', 'export function currentSource(): number { return 1 }\n')
    const outputDir = join(sandbox, 'out')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'graph.json'), JSON.stringify({
      schema: 'madar.graph',
      version: 1,
      directed: true,
      metadata: {
        generation_policy: {
          version: 2,
          fingerprint: '0'.repeat(64),
          settings: {
            use_spi: true,
            extraction_mode: 'auto',
            respect_gitignore: false,
            follow_symlinks: false,
            include_documents: true,
            include_non_code: true,
            extractor_cache_version: 1,
            exclusion_rules_fingerprint: '0'.repeat(64),
            indexing_strict: null,
          },
        },
        requested_extraction_mode: 'auto',
      },
      nodes: [{ id: 'stale', attributes: { label: 'stalePython', source_file: 'legacy.py' } }],
      edges: [],
    }), 'utf8')

    expect(() => generateGraph(sandbox, { clusterOnly: true })).toThrow('madar generate . --update')

    const result = generateGraph(sandbox, { update: true })
    const graph = readCanonicalGraphFixture(result.graphPath)

    expect(existsSync(result.graphPath)).toBe(true)
    expect(graph.nodes.some((node) => node.id === 'stale' || node.source_file === 'legacy.py')).toBe(false)
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'currentSource()', source_file: 'src/main.ts' }),
    ]))
    expect(result.notes.join('\n')).toContain('retired artifact schema')
  })
})
