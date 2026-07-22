import { execFileSync } from 'node:child_process'
import {
  cpSync,
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GenerateUnsupportedCorpusError, generateGraph, type ProgressStep } from '../../src/infrastructure/generate.js'
import { analyzeImpact, callChains } from '../../src/runtime/impact.js'
import { loadGraph } from '../../src/runtime/serve.js'
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
    rmSync(root, { recursive: true, force: true })
  })

  it('publishes a canonical graph, report, and completeness manifests', () => {
    writeSource(
      root,
      'src/service.ts',
      [
        'export function loadUser(): number { return 1 }',
        'export function handleRequest(): number { return loadUser() }',
      ].join('\n'),
    )

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
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'handleRequest()', source_file: 'src/service.ts' }),
        expect.objectContaining({ label: 'loadUser()', source_file: 'src/service.ts' }),
      ]),
    )
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'calls' })]))
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
    expect(manifest.outcomes).toContainEqual(
      expect.objectContaining({
        path: 'src/legacy.py',
        status: 'unsupported',
        reason: 'unsupported_file_type',
      }),
    )
  })

  it('persists local discovery safety metadata and never creates nodes for excluded paths', () => {
    writeSource(root, 'token.ts', 'export function issueToken(): string { return "opaque" }\n')
    writeSource(root, 'credentials.json', '{"token":"do-not-read"}\n')

    const result = generateGraph(root)
    const graph = readCanonicalGraphFixture(result.graphPath) as {
      discovery_safety?: typeof result.discoverySafety
      nodes: Array<{ source_file?: string }>
    }

    expect(result.codeFiles).toBe(1)
    expect(result.discoverySafety.summary).toMatchObject({ total: 1, sensitive: 1, unreadable: 0 })
    expect(result.discoveryExclusions).toContainEqual({
      path: 'credentials.json',
      kind: 'sensitive',
      reason: 'secret_config',
    })
    expect(graph.discovery_safety).toEqual(result.discoverySafety)
    expect(graph.nodes.some((node) => node.source_file === 'token.ts')).toBe(true)
    expect(graph.nodes.some((node) => node.source_file === 'credentials.json')).toBe(false)
  })

  it('reports safety exclusions when they leave no supported canonical corpus', () => {
    writeSource(root, 'credentials.json', '{"token":"do-not-read"}\n')

    expect(() => generateGraph(root)).toThrowError(
      expect.objectContaining({
        code: 'NO_SUPPORTED_FILES',
        message: expect.stringContaining('"credentials.json" (secret_config)'),
        discoverySafety: expect.objectContaining({
          summary: expect.objectContaining({ total: 1, sensitive: 1, unreadable: 0 }),
        }),
      }),
    )
  })

  it('excludes Git-ignored files while retaining tracked and visible untracked sources', () => {
    writeSource(root, '.gitignore', 'ignored.ts\n')
    writeSource(root, 'tracked.ts', 'export const tracked = true\n')
    writeSource(root, 'untracked.ts', 'export const untracked = true\n')
    writeSource(root, 'ignored.ts', 'export const ignored = true\n')
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['add', '.gitignore', 'tracked.ts'], { cwd: root, stdio: 'pipe' })

    const result = generateGraph(root, { respectGitignore: true })
    const graph = readCanonicalGraphFixture(result.graphPath)
    const sourceFiles = new Set(graph.nodes.map((node) => node.source_file))

    expect(sourceFiles).toContain('tracked.ts')
    expect(sourceFiles).toContain('untracked.ts')
    expect(sourceFiles).not.toContain('ignored.ts')
  })

  it('applies repository Git-ignore rules from a nested generation root', () => {
    const nestedRoot = join(root, 'workspace')
    writeSource(root, '.gitignore', 'workspace/ignored.ts\n')
    writeSource(root, 'workspace/tracked.ts', 'export const tracked = true\n')
    writeSource(root, 'workspace/untracked.ts', 'export const untracked = true\n')
    writeSource(root, 'workspace/ignored.ts', 'export const ignored = true\n')
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['add', '.gitignore', 'workspace/tracked.ts'], {
      cwd: root,
      stdio: 'pipe',
    })

    const result = generateGraph(nestedRoot, { respectGitignore: true })
    const graph = readCanonicalGraphFixture(result.graphPath)
    const sourceFiles = new Set(graph.nodes.map((node) => node.source_file))

    expect(sourceFiles).toContain('tracked.ts')
    expect(sourceFiles).toContain('untracked.ts')
    expect(sourceFiles).not.toContain('ignored.ts')
  })

  it('rejects cluster-only after an ancestor Git-ignore changes for a nested generation root', () => {
    const nestedRoot = join(root, 'workspace')
    writeSource(root, '.gitignore', 'workspace/generated/**\n')
    writeSource(root, 'workspace/main.ts', 'export const value = 1\n')
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['add', '.gitignore', 'workspace/main.ts'], { cwd: root, stdio: 'pipe' })
    generateGraph(nestedRoot, { respectGitignore: true })

    expect(generateGraph(nestedRoot, { clusterOnly: true }).mode).toBe('cluster-only')
    writeFileSync(join(root, '.gitignore'), 'workspace/generated/**\nworkspace/cache/**\n', 'utf8')
    expect(() => generateGraph(nestedRoot, { clusterOnly: true })).toThrow('source controls changed')
  })

  it.runIf(process.platform !== 'win32')('applies Git-ignore rules through a symlinked generation root', () => {
    writeSource(root, '.gitignore', 'ignored.ts\n')
    writeSource(root, 'tracked.ts', 'export const tracked = true\n')
    writeSource(root, 'untracked.ts', 'export const untracked = true\n')
    writeSource(root, 'ignored.ts', 'export const ignored = true\n')
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['add', '.gitignore', 'tracked.ts'], { cwd: root, stdio: 'pipe' })
    const aliasParent = mkdtempSync(join(tmpdir(), 'madar-generate-alias-'))
    const aliasedRoot = join(aliasParent, 'workspace')
    symlinkSync(root, aliasedRoot, 'dir')

    try {
      const result = generateGraph(aliasedRoot, { respectGitignore: true })
      const graph = readCanonicalGraphFixture(result.graphPath)
      const sourceFiles = new Set(graph.nodes.map((node) => node.source_file))

      expect(sourceFiles).toContain('tracked.ts')
      expect(sourceFiles).toContain('untracked.ts')
      expect(sourceFiles).not.toContain('ignored.ts')
      expect(generateGraph(root, { clusterOnly: true }).mode).toBe('cluster-only')
    } finally {
      rmSync(aliasParent, { recursive: true, force: true })
    }
  })

  it('generates semantic community labels in the report and graph metadata', () => {
    writeSource(
      root,
      'src/infrastructure/install.ts',
      [
        'export function claudeInstall(): unknown[] { return ensureArray() }',
        'export function ensureArray(): unknown[] { return [] }',
      ].join('\n'),
    )
    writeSource(
      root,
      'src/pipeline/export.ts',
      ['export function toHtml(): number { return toSvg() }', 'export function toSvg(): number { return 1 }'].join(
        '\n',
      ),
    )

    const result = generateGraph(root)
    const report = readFileSync(result.reportPath, 'utf8')
    const graph = readCanonicalGraphFixture(result.graphPath) as {
      community_labels?: Record<string, string>
    }

    expect(report).toContain('Infrastructure Install')
    expect(report).toContain('Pipeline Export')
    expect(Object.values(graph.community_labels ?? {})).toEqual(
      expect.arrayContaining(['Infrastructure Install', 'Pipeline Export']),
    )
  })

  it('preserves one-way directed call-chain and impact semantics', () => {
    writeSource(
      root,
      'backend/api.ts',
      [
        "import { createSession } from '../shared/auth.js'",
        'export function loginUser(): string { return createSession() }',
      ].join('\n'),
    )
    writeSource(root, 'shared/auth.ts', 'export function createSession(): string { return "session" }\n')

    const result = generateGraph(root)
    const graph = loadGraph(result.graphPath)
    const artifact = readCanonicalGraphFixture(result.graphPath) as { directed?: boolean }

    expect(graph.isDirected()).toBe(true)
    expect(artifact.directed).toBe(true)
    expect(callChains(graph, 'loginUser()', 'createSession()')).toEqual(
      expect.arrayContaining([['loginUser()', 'createSession()']]),
    )
    expect(callChains(graph, 'createSession()', 'loginUser()')).toEqual([])
    expect(analyzeImpact(graph, {}, { label: 'createSession()' }).direct_dependents).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'loginUser()' })]),
    )
    expect(analyzeImpact(graph, {}, { label: 'loginUser()' }).direct_dependents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'createSession()' })]),
    )
  })

  it('writes the resolved generation root into graph.json', () => {
    writeSource(root, 'main.ts', 'export function hello(): number { return 1 }\n')

    const result = generateGraph(root)
    const graph = readCanonicalGraphFixture(result.graphPath) as { root_path?: string }

    expect(graph.root_path).toBe(root)
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

  it('rejects cluster-only when canonical policy or indexing sidecars are missing', () => {
    writeSource(root, 'src/main.ts', 'export const current = true\n')
    const generated = generateGraph(root)
    const sourceManifest = join(generated.outputDir, 'manifest.json')
    const sourceManifestContents = readFileSync(sourceManifest, 'utf8')

    rmSync(sourceManifest)
    expect(() => generateGraph(root, { clusterOnly: true })).toThrow('current canonical generation policy')
    writeFileSync(sourceManifest, sourceManifestContents, 'utf8')

    const indexingContents = readFileSync(generated.indexingManifestPath, 'utf8')
    rmSync(generated.indexingManifestPath)
    expect(() => generateGraph(root, { clusterOnly: true })).toThrow('current indexing manifest')
    writeFileSync(generated.indexingManifestPath, indexingContents, 'utf8')
  })

  it('rejects cluster-only artifacts copied from another workspace', () => {
    writeSource(root, 'src/main.ts', 'export const current = true\n')
    const generated = generateGraph(root)
    const foreignRoot = mkdtempSync(join(tmpdir(), 'madar-generate-foreign-'))
    try {
      cpSync(generated.outputDir, join(foreignRoot, 'out'), { recursive: true })
      expect(() => generateGraph(foreignRoot, { clusterOnly: true })).toThrow(/source workspace.*--update/)
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true })
    }
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
