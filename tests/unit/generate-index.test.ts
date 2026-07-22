import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { readMatchingDiagnostics } from '../../src/adapters/filesystem/index-store.js'
import {
  generateIndex,
  GenerateUnsupportedCorpusError,
  IndexingCompletenessError,
} from '../../src/application/generate-index.js'
import {
  computeBuildId,
  INDEX_ENGINE_ID,
  readBuildState,
} from '../../src/domain/index/build-state.js'
import { deserializeGraphArtifact } from '../../src/domain/graph/artifact.js'

const roots: string[] = []

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-generate-index-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
}

function fixture(): string {
  const root = sandbox()
  write(root, 'src/service.ts', [
    'export function service(value: string): string {',
    '  return value.trim()',
    '}',
  ].join('\n'))
  write(root, 'src/route.ts', [
    "import { service } from './service.js'",
    'export function route(value: string): string {',
    '  return service(value)',
    '}',
  ].join('\n'))
  write(root, 'docs/architecture.md', '# architecture\n')
  write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('generate index', () => {
  it('publishes one authenticated graph with optional matching diagnostics', () => {
    const root = fixture()
    const result = generateIndex(root)
    const graph = loadGraphArtifact(result.graphPath)
    const state = readBuildState(graph)
    const diagnostics = readMatchingDiagnostics(result.graphPath)

    expect(state).toMatchObject({
      engine_id: INDEX_ENGINE_ID,
      build_id: result.buildId,
      corpus: { supported_files: 2, unsupported_files: 1 },
      completeness: {
        summary: { state: 'complete' },
        supported_failures: [],
      },
    })
    expect(state?.sources.supported.map((entry) => entry.path)).toEqual(['src/route.ts', 'src/service.ts'])
    expect(state?.sources.controls.map((entry) => entry.path)).toEqual(['tsconfig.json'])
    expect(state?.sources.unsupported.map((entry) => entry.path)).toEqual(['docs/architecture.md'])
    expect(diagnostics).toMatchObject({ build_id: result.buildId, summary: { state: 'complete' } })
    expect(result.indexing).toMatchObject({ state: 'complete', counts: { unsupported: 1, failed: 0 } })
  })

  it('keeps deterministic build identity portable across absolute roots', () => {
    const first = fixture()
    const second = fixture()

    const firstResult = generateIndex(first)
    const secondResult = generateIndex(second)

    expect(firstResult.buildId).toBe(secondResult.buildId)
    expect(firstResult.buildId).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a supported indexing failure before first publication', () => {
    const root = sandbox()
    write(root, 'broken.ts', 'export const broken =\n')

    expect(() => generateIndex(root)).toThrow(IndexingCompletenessError)
    expect(() => readFileSync(join(root, 'out', 'graph.json'), 'utf8')).toThrow()
  })

  it('rejects an unsupported-only corpus without publishing a graph', () => {
    const root = sandbox()
    write(root, 'main.go', 'package main\n')

    expect(() => generateIndex(root)).toThrow(GenerateUnsupportedCorpusError)
    expect(() => readFileSync(join(root, 'out', 'graph.json'), 'utf8')).toThrow()
  })

  it('reclusters only an authenticated accepted graph', () => {
    const root = fixture()
    const generated = generateIndex(root)

    const reclustered = generateIndex(root, { clusterOnly: true })

    expect(reclustered).toMatchObject({
      mode: 'cluster-only',
      buildId: generated.buildId,
      totalFiles: generated.totalFiles,
      indexedFiles: generated.indexedFiles,
    })
    expect(reclustered.notes.join(' ')).toContain('without scanning or indexing')
  })

  it('fails closed for structurally invalid build state even with a matching payload hash', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const artifact = JSON.parse(readFileSync(generated.graphPath, 'utf8')) as { metadata: Record<string, unknown> }
    const raw = artifact.metadata.index_build as Record<string, unknown>
    const sources = raw.sources as Record<string, unknown>
    sources.supported = 'not-an-array'
    raw.build_id = ''
    raw.build_id = computeBuildId(deserializeGraphArtifact(artifact))
    const graph = deserializeGraphArtifact(artifact)

    expect(readBuildState(graph)).toBeNull()
  })
})
