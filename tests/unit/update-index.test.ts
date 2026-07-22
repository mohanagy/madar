import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateIndex, IndexingCompletenessError } from '../../src/application/generate-index.js'
import { updateIndex } from '../../src/application/update-index.js'
import { loadAcceptedIndex } from '../../src/adapters/filesystem/index-store.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-reconcile-'))
  roots.push(root)
  write(root, 'leaf.ts', 'export function leaf(): string { return "one" }\n')
  write(root, 'app.ts', 'import { leaf } from "./leaf.js"\nexport function app(): string { return leaf() }\n')
  return root
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function graphBytes(root: string): string {
  return readFileSync(join(root, 'out', 'graph.json'), 'utf8')
}

function artifactBytes(root: string): Record<string, string> {
  return Object.fromEntries([
    'graph.json', 'GRAPH_REPORT.md', 'indexing-manifest.json', 'indexing-manifest.share-safe.json',
  ].map((name) => [name, readFileSync(join(root, 'out', name), 'utf8')]))
}

function normalizedDiagnostics(path: string): unknown {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete value.generated_at
  return value
}

function expectUpdateEqualsClean(
  root: string,
  updated: ReturnType<typeof updateIndex>,
  options: Parameters<typeof generateIndex>[1] = {},
): void {
  const updateGraph = readFileSync(updated.graphPath, 'utf8')
  const updateReport = readFileSync(updated.reportPath, 'utf8')
  const updateDiagnostics = normalizedDiagnostics(updated.indexingManifestPath)
  const updateShareSafe = normalizedDiagnostics(join(updated.outputDir, 'indexing-manifest.share-safe.json'))
  rmSync(updated.outputDir, { recursive: true, force: true })
  const clean = generateIndex(root, options)
  expect(readFileSync(clean.graphPath, 'utf8')).toBe(updateGraph)
  expect(readFileSync(clean.reportPath, 'utf8')).toBe(updateReport)
  expect(normalizedDiagnostics(clean.indexingManifestPath)).toEqual(updateDiagnostics)
  expect(normalizedDiagnostics(join(clean.outputDir, 'indexing-manifest.share-safe.json'))).toEqual(updateShareSafe)
  expect(clean.buildId).toBe(updated.buildId)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('index updates', () => {
  it('performs a cold no-op without parsing or publication', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const before = artifactBytes(root)
    const progress: string[] = []
    const writeText = vi.fn(), writeGraph = vi.fn(), remove = vi.fn()

    const updated = updateIndex(root, {
      onProgress: ({ step }) => progress.push(step),
      storeDependencies: { writeText, writeGraph, remove },
    })

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_noop',
      parsed_files: 0,
      reused_files: 2,
      invalidated_files: 0,
      dependency_closure_size: 0,
      fallback_reason: null,
      previous_build_id: generated.buildId,
      accepted_build_id: generated.buildId,
      publication_advanced: false,
    })
    expect(progress).toEqual(['detect'])
    expect([writeText, writeGraph, remove].every((operation) => operation.mock.calls.length === 0)).toBe(true)
    expect(artifactBytes(root)).toEqual(before)
  })

  it('uses one truthful full reconcile for a private or exported source edit', () => {
    for (const source of [
      'export function leaf(): string { const privateValue = "two"; return privateValue }\n',
      'export function leaf(value: number): string { return String(value) }\n',
    ]) {
      const root = fixture()
      const generated = generateIndex(root)
      writeFileSync(join(root, 'leaf.ts'), source)

      const updated = updateIndex(root)

      expect(updated.updateReceipt).toMatchObject({
        mode: 'cold_reconcile',
        parsed_files: 2,
        reused_files: 0,
        invalidated_files: 2,
        dependency_closure_size: 2,
        fallback_reason: 'source_or_policy_changed',
        previous_build_id: generated.buildId,
        publication_advanced: true,
      })
      expectUpdateEqualsClean(root, updated)
    }
  })

  it('adds an imported file and remains exactly clean-equivalent', () => {
    const root = fixture()
    generateIndex(root)
    write(root, 'helper.ts', 'export const helper = (): string => "ok"\n')
    write(root, 'app.ts', [
      'import { leaf } from "./leaf.js"',
      'import { helper } from "./helper.js"',
      'export function app(): string { return leaf() + helper() }',
    ].join('\n'))

    const updated = updateIndex(root)

    expect(updated.updateReceipt).toMatchObject({ mode: 'cold_reconcile', parsed_files: 3, reused_files: 0 })
    expectUpdateEqualsClean(root, updated)
  })

  it('deletes and renames without stale nodes or edges', () => {
    const deletedRoot = fixture()
    write(deletedRoot, 'middle.ts', 'import { leaf } from "./leaf.js"\nexport const middle = (): string => leaf()\n')
    write(deletedRoot, 'app.ts', 'import { middle } from "./middle.js"\nexport const app = (): string => middle()\n')
    generateIndex(deletedRoot)
    rmSync(join(deletedRoot, 'middle.ts'))
    const deleted = updateIndex(deletedRoot)
    expect(readFileSync(deleted.graphPath, 'utf8')).not.toContain('middle.ts')
    expectUpdateEqualsClean(deletedRoot, deleted)

    const renamedRoot = fixture()
    generateIndex(renamedRoot)
    renameSync(join(renamedRoot, 'leaf.ts'), join(renamedRoot, 'renamed.ts'))
    write(renamedRoot, 'app.ts', 'import { leaf } from "./renamed.js"\nexport const app = (): string => leaf()\n')
    const renamed = updateIndex(renamedRoot)
    expect(readFileSync(renamed.graphPath, 'utf8')).not.toContain('leaf.ts')
    expectUpdateEqualsClean(renamedRoot, renamed)
  })

  it('reconciles compiler controls and ignore policies exactly', () => {
    const compilerRoot = fixture()
    write(compilerRoot, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    generateIndex(compilerRoot)
    write(compilerRoot, 'tsconfig.json', '{"compilerOptions":{"strict":true,"baseUrl":".","paths":{"@leaf":["./leaf.ts"]}}}\n')
    const compiler = updateIndex(compilerRoot)
    expect(compiler.updateReceipt?.fallback_reason).toBe('source_or_policy_changed')
    expectUpdateEqualsClean(compilerRoot, compiler)

    for (const [initial, next] of [
      [null, 'leaf.ts\n'],
      ['leaf.ts\n', 'app.ts\n'],
      ['# initial\n', null],
    ] as const) {
      const root = fixture()
      if (initial !== null) write(root, '.madarignore', initial)
      generateIndex(root)
      if (next === null) rmSync(join(root, '.madarignore'))
      else write(root, '.madarignore', next)
      const updated = updateIndex(root)
      expectUpdateEqualsClean(root, updated)
    }
  })

  it('reconciles when an arbitrary extended compiler config changes module resolution', () => {
    const root = fixture()
    write(root, 'one.ts', 'export const dependency = "one"\n')
    write(root, 'two.ts', 'export const dependency = "two"\n')
    write(root, 'app.ts', 'import { dependency } from "@dependency"\nexport const app = (): string => dependency\n')
    write(root, 'tsconfig.json', '{"extends":"./base.json"}\n')
    write(root, 'base.json', '{"compilerOptions":{"baseUrl":".","paths":{"@dependency":["./one.ts"]}}}\n')
    const generated = generateIndex(root)

    write(root, 'base.json', '{"compilerOptions":{"baseUrl":".","paths":{"@dependency":["./two.ts"]}}}\n')
    const updated = updateIndex(root)

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      previous_build_id: generated.buildId,
      fallback_reason: 'source_or_policy_changed',
      publication_advanced: true,
    })
    expect(updated.buildId).not.toBe(generated.buildId)
    expectUpdateEqualsClean(root, updated)
  })

  it.each([false, true])('authenticates ignored compiler-control edits with respectGitignore=%s', (respectGitignore) => {
    const root = fixture()
    write(root, 'tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}\n')
    write(root, '.madarignore', 'tsconfig.json\n')
    write(root, '.gitignore', 'tsconfig.json\n')
    git(root, ['init'])
    const options = { respectGitignore }
    const generated = generateIndex(root, options)

    write(root, 'tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@leaf":["./leaf.ts"]}}}\n')
    const updated = updateIndex(root, options)

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      previous_build_id: generated.buildId,
      fallback_reason: 'source_or_policy_changed',
    })
    expectUpdateEqualsClean(root, updated, options)
  })

  it.each([true, false])('keeps .gitignore changes exact with respectGitignore=%s', (respectGitignore) => {
    const root = fixture()
    write(root, 'ignored.ts', 'export const ignored = true\n')
    write(root, '.gitignore', '# initial\n')
    git(root, ['init'])
    const options = { respectGitignore }
    generateIndex(root, options)
    write(root, '.gitignore', 'ignored.ts\n')

    const updated = updateIndex(root, options)

    expectUpdateEqualsClean(root, updated, options)
  })

  it('tracks recognized unsupported add, delete, and rename with full reconciliation', () => {
    const root = fixture()
    generateIndex(root)
    write(root, 'docs/notes.md', '# notes\n')
    const added = updateIndex(root)
    expect(added.updateReceipt).toMatchObject({ parsed_files: 2, reused_files: 0 })
    expectUpdateEqualsClean(root, added)

    renameSync(join(root, 'docs', 'notes.md'), join(root, 'docs', 'renamed.md'))
    const renamed = updateIndex(root)
    expectUpdateEqualsClean(root, renamed)

    rmSync(join(root, 'docs', 'renamed.md'))
    const deleted = updateIndex(root)
    expectUpdateEqualsClean(root, deleted)
  })

  it('reconciles added and removed safety exclusions without parsing them', () => {
    const root = fixture()
    generateIndex(root)
    write(root, '.env', 'TOKEN=secret\n')

    const added = updateIndex(root)
    expect(added.updateReceipt?.mode).toBe('cold_reconcile')
    expect(added.discoverySafety.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env', reason: 'environment_file' }),
    ]))

    rmSync(join(root, '.env'))
    const removed = updateIndex(root)
    expect(removed.updateReceipt?.mode).toBe('cold_reconcile')
    expect(removed.discoverySafety.exclusions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env' }),
    ]))
    expectUpdateEqualsClean(root, removed)
  })

  it('retains the previous accepted graph after a failed reconcile', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const before = graphBytes(root)
    write(root, 'leaf.ts', 'export function leaf(: string {\n')

    expect(() => updateIndex(root)).toThrow(IndexingCompletenessError)
    expect(graphBytes(root)).toBe(before)

    write(root, 'leaf.ts', 'export function leaf(): string { return "fixed" }\n')
    const recovered = updateIndex(root)
    expect(recovered.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      previous_build_id: generated.buildId,
      fallback_reason: 'source_or_policy_changed',
    })
    expectUpdateEqualsClean(root, recovered)
  })

  it('replaces a corrupt accepted graph through an honest cold reconcile', () => {
    const root = fixture()
    const generated = generateIndex(root)
    writeFileSync(generated.graphPath, '{"corrupt":true}\n', 'utf8')

    const recovered = updateIndex(root)

    expect(recovered.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      fallback_reason: 'cold_process',
      previous_build_id: null,
      parsed_files: 2,
      reused_files: 0,
      publication_advanced: true,
    })
    expectUpdateEqualsClean(root, recovered)
  })

  it('hydrates omitted update controls from the authenticated accepted policy', () => {
    const root = fixture()
    git(root, ['init'])
    const options = {
      respectGitignore: true,
      followSymlinks: true,
      indexingStrict: { maxFailed: 0, maxUnsupported: 5 },
    }
    const generated = generateIndex(root, options)

    const updated = updateIndex(root)

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_noop',
      accepted_build_id: generated.buildId,
      publication_advanced: false,
    })
  })

  it.runIf(process.platform !== 'win32')('adds, retargets, and deletes allowed symlinks while rejecting outside targets', () => {
    const root = fixture()
    const outsideRoot = mkdtempSync(join(tmpdir(), 'madar-reconcile-outside-'))
    roots.push(outsideRoot)
    write(root, 'targets/one.ts', 'export const linked = "one"\n')
    write(root, 'targets/two.ts', 'export const linked = "two"\n')
    write(outsideRoot, 'outside.ts', 'export const outside = true\n')
    const options = { followSymlinks: true }
    generateIndex(root, options)

    symlinkSync(join(root, 'targets', 'one.ts'), join(root, 'alias.ts'))
    const added = updateIndex(root, options)
    expect(added.updateReceipt?.mode).toBe('cold_reconcile')

    rmSync(join(root, 'alias.ts'))
    symlinkSync(join(root, 'targets', 'two.ts'), join(root, 'alias.ts'))
    symlinkSync(join(outsideRoot, 'outside.ts'), join(root, 'outside.ts'))

    const updated = updateIndex(root, options)

    expect(loadGraphArtifact(updated.graphPath).nodeEntries().some(([, attributes]) => attributes.source_file === 'outside.ts')).toBe(false)
    expectUpdateEqualsClean(root, updated, options)

    rmSync(join(root, 'alias.ts'))
    rmSync(join(root, 'outside.ts'))
    const deleted = updateIndex(root, options)
    expect(deleted.updateReceipt?.mode).toBe('cold_reconcile')
    expectUpdateEqualsClean(root, deleted, options)
  })

  it('repairs accepted metadata when a workspace is copied with its output', () => {
    const original = fixture()
    generateIndex(original)
    const container = mkdtempSync(join(tmpdir(), 'madar-reconcile-copy-'))
    roots.push(container)
    const copied = join(container, 'copied')
    cpSync(original, copied, { recursive: true })

    const updated = updateIndex(copied)

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      fallback_reason: 'source_or_policy_changed',
      publication_advanced: true,
    })
    expect(loadAcceptedIndex(updated.graphPath)?.state.source_root.root_path).toBe(copied)
    expectUpdateEqualsClean(copied, updated)
  })

  it('updates inside a linked worktree with isolated accepted state', () => {
    const container = mkdtempSync(join(tmpdir(), 'madar-reconcile-worktree-'))
    roots.push(container)
    const primary = join(container, 'primary')
    const linked = join(container, 'linked')
    mkdirSync(primary, { recursive: true })
    write(primary, 'leaf.ts', 'export function leaf(): string { return "one" }\n')
    write(primary, 'app.ts', 'import { leaf } from "./leaf.js"\nexport const app = (): string => leaf()\n')
    git(primary, ['init'])
    git(primary, ['config', 'user.email', 'madar@example.com'])
    git(primary, ['config', 'user.name', 'Madar Tests'])
    git(primary, ['add', '.'])
    git(primary, ['commit', '-m', 'initial'])
    git(primary, ['worktree', 'add', '-b', 'reconcile', linked])
    generateIndex(linked)
    write(linked, 'leaf.ts', 'export function leaf(): string { return "two" }\n')

    const updated = updateIndex(linked)

    expect(updated.outputDir.startsWith(linked)).toBe(false)
    expect(updated.updateReceipt).toMatchObject({ mode: 'cold_reconcile', parsed_files: 2, reused_files: 0 })
    expectUpdateEqualsClean(linked, updated)

    write(linked, 'helper.ts', 'export const helper = (): string => "helper"\n')
    write(linked, 'app.ts', 'import { leaf } from "./leaf.js"\nimport { helper } from "./helper.js"\nexport const app = (): string => leaf() + helper()\n')
    expectUpdateEqualsClean(linked, updateIndex(linked))

    renameSync(join(linked, 'helper.ts'), join(linked, 'renamed.ts'))
    write(linked, 'app.ts', 'import { leaf } from "./leaf.js"\nimport { helper } from "./renamed.js"\nexport const app = (): string => leaf() + helper()\n')
    expectUpdateEqualsClean(linked, updateIndex(linked))

    rmSync(join(linked, 'renamed.ts'))
    write(linked, 'app.ts', 'import { leaf } from "./leaf.js"\nexport const app = (): string => leaf()\n')
    expectUpdateEqualsClean(linked, updateIndex(linked))
  }, 40_000)
})
