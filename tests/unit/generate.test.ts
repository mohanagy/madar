import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GenerateUnsupportedCorpusError,
  generateGraph,
  type ProgressStep,
} from '../../src/infrastructure/generate.js'
import { readCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function writeSource(root: string, path: string, contents: string): void {
  const absolutePath = join(root, path)
  mkdirSync(join(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, contents, 'utf8')
}

describe('generateGraph canonical pipeline', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'madar-generate-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('publishes a canonical graph, report, and completeness manifests', () => {
    writeSource(root, 'src/service.ts', [
      'export function loadUser(): number { return 1 }',
      'export function handleRequest(): number { return loadUser() }',
    ].join('\n'))

    const result = generateGraph(root)
    const graph = readCanonicalGraphFixture(result.graphPath)

    expect(result).toMatchObject({
      mode: 'generate',
      totalFiles: 1,
      codeFiles: 1,
      indexedFiles: 1,
    })
    expect(existsSync(result.reportPath)).toBe(true)
    expect(existsSync(result.indexingManifestPath)).toBe(true)
    expect(existsSync(result.indexingShareSafeManifestPath)).toBe(true)
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'handleRequest()', source_file: 'src/service.ts' }),
      expect.objectContaining({ label: 'loadUser()', source_file: 'src/service.ts' }),
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'calls' }),
    ]))
  })

  it('runs one canonical indexing phase for a whole generation', () => {
    writeSource(root, 'src/a.ts', 'export const a = 1\n')
    writeSource(root, 'src/b.ts', 'export const b = 2\n')
    const progress: ProgressStep[] = []

    generateGraph(root, { onProgress: (entry) => progress.push(entry) })

    expect(progress.filter((entry) => entry.step === 'index')).toEqual([
      expect.objectContaining({ current: 0, total: 2 }),
    ])
  })

  it('records recognized unsupported files without adding their facts to the graph', () => {
    writeSource(root, 'src/main.ts', 'export function supported(): void {}\n')
    writeSource(root, 'src/legacy.py', 'def unsupported():\n    pass\n')

    const result = generateGraph(root)
    const graph = readCanonicalGraphFixture(result.graphPath)
    const manifest = JSON.parse(readFileSync(result.indexingManifestPath, 'utf8')) as {
      outcomes: Array<{ path: string; status: string; reason: string }>
    }

    expect(graph.nodes.some((node) => node.source_file === 'src/legacy.py')).toBe(false)
    expect(manifest.outcomes).toContainEqual(expect.objectContaining({
      path: 'src/legacy.py',
      status: 'unsupported',
      reason: 'unsupported_file_type',
    }))
  })

  it('performs update as a full canonical rebuild and removes deleted facts', () => {
    writeSource(root, 'src/main.ts', 'export function beforeUpdate(): void {}\n')
    generateGraph(root)
    writeSource(root, 'src/main.ts', 'export function afterUpdate(): void {}\n')

    const result = generateGraph(root, { update: true })
    const graph = readCanonicalGraphFixture(result.graphPath)

    expect(result.mode).toBe('update')
    expect(result.notes).toContain('--update performs a full canonical TypeScript/JavaScript rebuild.')
    expect(graph.nodes.some((node) => node.label === 'beforeUpdate()')).toBe(false)
    expect(graph.nodes.some((node) => node.label === 'afterUpdate()')).toBe(true)
  })

  it('reclusters an existing canonical graph without indexing source again', () => {
    writeSource(root, 'src/main.ts', 'export function current(): void {}\n')
    generateGraph(root)
    const progress: ProgressStep[] = []

    const result = generateGraph(root, {
      clusterOnly: true,
      onProgress: (entry) => progress.push(entry),
    })

    expect(result.mode).toBe('cluster-only')
    expect(progress.some((entry) => entry.step === 'detect' || entry.step === 'index')).toBe(false)
    expect(result.notes).toContain(
      'Re-clustered and re-analyzed the existing canonical graph without scanning or indexing source files.',
    )
  })

  it('rejects cluster-only when canonical sidecars are missing or from another generation', () => {
    writeSource(root, 'src/main.ts', 'export const current = true\n')
    const generated = generateGraph(root)
    const sourceManifest = join(generated.outputDir, 'manifest.json')
    const sourceManifestContents = readFileSync(sourceManifest, 'utf8')

    rmSync(sourceManifest)
    expect(() => generateGraph(root, { clusterOnly: true })).toThrow('current canonical generation policy')
    writeFileSync(sourceManifest, sourceManifestContents, 'utf8')

    const foreignSourceManifest = JSON.parse(sourceManifestContents) as Record<string, unknown>
    foreignSourceManifest['/foreign/source.ts'] = 0
    writeFileSync(sourceManifest, `${JSON.stringify(foreignSourceManifest, null, 2)}\n`, 'utf8')
    expect(() => generateGraph(root, { clusterOnly: true })).toThrow('same generation')
    writeFileSync(sourceManifest, sourceManifestContents, 'utf8')

    const indexing = JSON.parse(readFileSync(generated.indexingManifestPath, 'utf8')) as {
      outcomes: Array<{ path: string }>
    }
    indexing.outcomes[0]!.path = 'foreign/source.ts'
    writeFileSync(generated.indexingManifestPath, `${JSON.stringify(indexing, null, 2)}\n`, 'utf8')
    expect(() => generateGraph(root, { clusterOnly: true })).toThrow('same generation')
  })

  it('preserves published artifacts and retired outputs when staging fails', () => {
    writeSource(root, 'src/main.ts', 'export const before = true\n')
    const generated = generateGraph(root)
    const published = [generated.graphPath, generated.reportPath, generated.indexingManifestPath,
      generated.indexingShareSafeManifestPath, join(generated.outputDir, 'manifest.json')]
    const before = published.map((path) => readFileSync(path, 'utf8'))
    for (const retiredPath of ['cache', 'docs']) {
      mkdirSync(join(generated.outputDir, retiredPath), { recursive: true })
      writeFileSync(join(generated.outputDir, retiredPath, 'stale.txt'), 'preserve-on-failure', 'utf8')
    }
    writeSource(root, 'src/main.ts', 'export const after = true\n')

    vi.spyOn(Date, 'now').mockReturnValue(123)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    mkdirSync(join(generated.outputDir, `.madar-publication-${process.pid}-123-8`, 'staged', 'graph.json'), {
      recursive: true,
    })

    expect(() => generateGraph(root, { update: true })).toThrow()
    expect(published.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    for (const retiredPath of ['cache', 'docs']) {
      expect(readFileSync(join(generated.outputDir, retiredPath, 'stale.txt'), 'utf8')).toBe('preserve-on-failure')
    }
  })

  it('rolls back every touched artifact when publication fails partway through', () => {
    writeSource(root, 'src/main.ts', 'export const before = true\n')
    const generated = generateGraph(root)
    const published = [generated.graphPath, generated.reportPath, generated.indexingManifestPath,
      generated.indexingShareSafeManifestPath, join(generated.outputDir, 'manifest.json')]
    const before = published.map((path) => readFileSync(path, 'utf8'))
    mkdirSync(join(generated.outputDir, 'cache'), { recursive: true })
    writeFileSync(join(generated.outputDir, 'cache', 'stale.txt'), 'restore-me', 'utf8')
    writeSource(root, 'src/main.ts', 'export const after = true\n')

    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source).replaceAll('\\', '/').includes('/staged/indexing-manifest.json')
        && target === generated.indexingManifestPath) throw new Error('injected publication failure')
      rename(source, target)
    })
    syncBuiltinESMExports()
    try {
      expect(() => generateGraph(root, { update: true })).toThrow('injected publication failure')
    } finally {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    }

    expect(published.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    expect(readFileSync(join(generated.outputDir, 'cache', 'stale.txt'), 'utf8')).toBe('restore-me')
  })

  it('fails clearly when the corpus has no supported TypeScript or JavaScript', () => {
    writeSource(root, 'src/main.py', 'def main():\n    pass\n')

    expect(() => generateGraph(root)).toThrow(GenerateUnsupportedCorpusError)
    try {
      generateGraph(root)
    } catch (error) {
      expect(error).toMatchObject({ code: 'NO_SUPPORTED_FILES' })
      expect(String(error)).toContain('No supported TypeScript or JavaScript files')
    }
  })

  it('cleans retired generated outputs after a successful publication', () => {
    writeSource(root, 'src/main.ts', 'export const current = true\n')
    for (const retiredPath of ['cache', 'docs', 'wiki', 'graph-pages']) {
      mkdirSync(join(root, 'out', retiredPath), { recursive: true })
      writeFileSync(join(root, 'out', retiredPath, 'stale.txt'), 'stale', 'utf8')
    }
    writeFileSync(join(root, 'out', 'graph.html'), 'stale', 'utf8')

    generateGraph(root)

    expect(existsSync(join(root, 'out', 'cache'))).toBe(false)
    expect(existsSync(join(root, 'out', 'docs'))).toBe(false)
    expect(existsSync(join(root, 'out', 'wiki'))).toBe(false)
    expect(existsSync(join(root, 'out', 'graph-pages'))).toBe(false)
    expect(existsSync(join(root, 'out', 'graph.html'))).toBe(false)
  })
})
