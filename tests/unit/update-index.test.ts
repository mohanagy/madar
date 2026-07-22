import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { CanonicalTypeScriptIndexSession } from '../../src/adapters/typescript/index.js'
import { generateIndex, IndexingCompletenessError } from '../../src/application/generate-index.js'
import { createUpdateIndexSession, updateIndex } from '../../src/application/update-index.js'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-incremental-'))
  roots.push(root)
  writeFileSync(join(root, 'leaf.ts'), [
    'export function leaf(): string {',
    "  const privateValue = 'one'",
    '  return privateValue',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'app.ts'), [
    "import { leaf } from './leaf.js'",
    'export function app(): string {',
    '  return leaf()',
    '}',
  ].join('\n'))
  return root
}

function graphBytes(root: string): string {
  return readFileSync(join(root, 'out', 'graph.json'), 'utf8')
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
}

function normalizedDiagnostics(path: string): unknown {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete value.generated_at
  return value
}

function expectWarmEqualsClean(
  root: string,
  warm: ReturnType<ReturnType<typeof createUpdateIndexSession>['update']>,
  options: Parameters<typeof generateIndex>[1] = {},
): void {
  const warmGraph = readFileSync(warm.graphPath, 'utf8')
  const warmDiagnostics = normalizedDiagnostics(warm.indexingManifestPath)
  rmSync(warm.outputDir, { recursive: true, force: true })
  const clean = generateIndex(root, options)
  expect(readFileSync(clean.graphPath, 'utf8')).toBe(warmGraph)
  expect(normalizedDiagnostics(clean.indexingManifestPath)).toEqual(warmDiagnostics)
  expect(clean.buildId).toBe(warm.buildId)
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('incremental index updates', () => {
  it('performs a cold no-op without parsing or publication', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const before = graphBytes(root)

    const updated = updateIndex(root)

    expect(updated.updateReceipt).toMatchObject({
      mode: 'cold_noop',
      parsed_files: 0,
      invalidated_files: 0,
      previous_build_id: generated.buildId,
      accepted_build_id: generated.buildId,
      publication_advanced: false,
    })
    expect(graphBytes(root)).toBe(before)
  })

  it('reuses unrelated facts for a private leaf implementation edit', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, 'leaf.ts'), [
      'export function leaf(): string {',
      "  const privateValue = 'two'",
      '  return privateValue',
      '}',
    ].join('\n'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({
      mode: 'warm_incremental',
      parsed_files: 1,
      reused_files: 1,
      invalidated_files: 1,
      dependency_closure_size: 0,
      publication_advanced: true,
    })
    const warm = graphBytes(root)
    rmSync(join(root, 'out'), { recursive: true, force: true })
    generateIndex(root)
    expect(graphBytes(root)).toBe(warm)
  })

  it('invalidates reverse dependants when an exported signature changes', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, 'leaf.ts'), [
      'export function leaf(value: number): string {',
      '  return String(value)',
      '}',
    ].join('\n'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({
      parsed_files: 2,
      reused_files: 0,
      invalidated_files: 2,
      dependency_closure_size: 1,
    })
  })

  it('treats an inferred exported return-type change as a public change', () => {
    const root = fixture()
    writeFileSync(join(root, 'leaf.ts'), [
      'export class Before { before(): string { return "before" } }',
      'export class After { after(): string { return "after" } }',
      'export function leaf() { return new Before() }',
    ].join('\n'))
    writeFileSync(join(root, 'app.ts'), [
      "import { leaf } from './leaf.js'",
      'export function app(): string { return leaf().before() }',
    ].join('\n'))
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, 'leaf.ts'), [
      'export class Before { before(): string { return "before" } }',
      'export class After { after(): string { return "after" } }',
      'export function leaf() { return new After() }',
    ].join('\n'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({ parsed_files: 2, dependency_closure_size: 1 })
    const warm = graphBytes(root)
    rmSync(join(root, 'out'), { recursive: true, force: true })
    generateIndex(root)
    expect(graphBytes(root)).toBe(warm)
  })

  it('adds an imported file without reindexing unrelated accepted facts', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, 'helper.ts'), 'export const helper = (): string => "ok"\n')
    writeFileSync(join(root, 'app.ts'), [
      "import { leaf } from './leaf.js'",
      "import { helper } from './helper.js'",
      'export function app(): string {',
      '  return leaf() + helper()',
      '}',
    ].join('\n'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({
      mode: 'warm_incremental',
      parsed_files: 2,
      reused_files: 1,
      invalidated_files: 2,
      dependency_closure_size: 0,
      publication_advanced: true,
    })
    const warm = graphBytes(root)
    rmSync(join(root, 'out'), { recursive: true, force: true })
    generateIndex(root)
    expect(graphBytes(root)).toBe(warm)
  })

  it('keeps recognized unsupported files informational', () => {
    const root = fixture()
    writeFileSync(join(root, 'README.md'), '# fixture\n')

    const generated = generateIndex(root)

    expect(generated.indexing.state).toBe('complete')
    expect(generated.indexing.counts.unsupported).toBe(1)
  })

  it('removes every stale fact after deleting a file with incoming and outgoing edges', () => {
    const root = fixture()
    write(root, 'middle.ts', [
      "import { leaf } from './leaf.js'",
      'export function middle(): string { return leaf() }',
    ].join('\n'))
    write(root, 'app.ts', [
      "import { middle } from './middle.js'",
      'export function app(): string { return middle() }',
    ].join('\n'))
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    rmSync(join(root, 'middle.ts'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({
      mode: 'warm_incremental',
      parsed_files: 1,
      reused_files: 1,
      dependency_closure_size: 1,
    })
    expect(readFileSync(updated.graphPath, 'utf8')).not.toContain('middle.ts')
    expectWarmEqualsClean(root, updated)
  })

  it('treats rename plus importer edit as one exact incremental transition', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    renameSync(join(root, 'leaf.ts'), join(root, 'renamed.ts'))
    writeFileSync(join(root, 'app.ts'), [
      "import { leaf } from './renamed.js'",
      'export function app(): string { return leaf() }',
    ].join('\n'))

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({ mode: 'warm_incremental', parsed_files: 2, reused_files: 0 })
    expect(readFileSync(updated.graphPath, 'utf8')).not.toContain('leaf.ts')
    expectWarmEqualsClean(root, updated)
  })

  it('discloses a compiler-control fallback and stays clean-equivalent', () => {
    const root = fixture()
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"baseUrl":"."}}\n', 'utf8')

    const updated = session.update()
    expect(updated.updateReceipt).toMatchObject({
      mode: 'warm_incremental',
      parsed_files: 2,
      reused_files: 0,
      fallback_reason: 'compiler_control_changed',
    })
    expectWarmEqualsClean(root, updated)
  })

  it.each([
    ['add', null, 'leaf.ts\n'],
    ['change', '# initial\n', 'leaf.ts\n'],
    ['delete', '# initial\n', null],
  ] as const)('keeps .madarignore %s exact', (_name, initial, next) => {
    const root = fixture()
    if (initial !== null) write(root, '.madarignore', initial)
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    if (next === null) rmSync(join(root, '.madarignore'))
    else writeFileSync(join(root, '.madarignore'), next, 'utf8')

    const updated = session.update()
    expect(updated.updateReceipt?.fallback_reason).toBe('compiler_control_changed')
    expectWarmEqualsClean(root, updated)
  })

  it.each([true, false])('keeps .gitignore changes exact with respectGitignore=%s', (respectGitignore) => {
    const root = fixture()
    write(root, 'ignored.ts', 'export const ignored = true\n')
    write(root, '.gitignore', '# initial\n')
    git(root, ['init'])
    const options = { respectGitignore }
    const generated = generateIndex(root, options)
    const session = createUpdateIndexSession(root, generated)
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n', 'utf8')

    const updated = session.update(options)
    expect(updated.updateReceipt?.fallback_reason).toBe('compiler_control_changed')
    expectWarmEqualsClean(root, updated, options)
  })

  it('updates unsupported inventory without parsing supported files', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    write(root, 'docs/notes.md', '# notes\n')

    const added = session.update()
    expect(added.updateReceipt).toMatchObject({ parsed_files: 0, reused_files: 2, invalidated_files: 0 })
    expectWarmEqualsClean(root, added)
  })

  it('retains both the accepted graph and warm facts after a failed staged update', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const session = createUpdateIndexSession(root, generated)
    const before = graphBytes(root)
    writeFileSync(join(root, 'leaf.ts'), 'export function leaf(: string {\n', 'utf8')

    expect(() => session.update()).toThrow(IndexingCompletenessError)
    expect(graphBytes(root)).toBe(before)

    writeFileSync(join(root, 'leaf.ts'), 'export function leaf(): string { return "fixed" }\n', 'utf8')
    const recovered = session.update()
    expect(recovered.updateReceipt).toMatchObject({
      mode: 'warm_incremental',
      parsed_files: 1,
      reused_files: 1,
      previous_build_id: generated.buildId,
    })
    expectWarmEqualsClean(root, recovered)
  })

  it('falls back honestly when in-memory incremental state is incompatible', () => {
    const root = fixture()
    const generated = generateIndex(root)
    const corrupt = {
      result() { throw new Error('corrupt result') },
      stageUpdate() { throw new Error('corrupt stage') },
    } as unknown as CanonicalTypeScriptIndexSession
    const session = createUpdateIndexSession(root, { buildId: generated.buildId, indexSession: corrupt })
    writeFileSync(join(root, 'leaf.ts'), 'export function leaf(): string { return "reconciled" }\n', 'utf8')

    const recovered = session.update()
    expect(recovered.updateReceipt).toMatchObject({
      mode: 'cold_reconcile',
      parsed_files: 2,
      reused_files: 0,
      fallback_reason: 'corrupt_warm_state',
      previous_build_id: generated.buildId,
    })
    expectWarmEqualsClean(root, recovered)
  })

  it.runIf(process.platform !== 'win32')('updates an allowed symlink and rejects an outside-root symlink', () => {
    const root = fixture()
    const outsideRoot = mkdtempSync(join(tmpdir(), 'madar-incremental-outside-'))
    roots.push(outsideRoot)
    write(root, 'targets/one.ts', 'export const linked = "one"\n')
    write(root, 'targets/two.ts', 'export const linked = "two"\n')
    write(outsideRoot, 'outside.ts', 'export const outside = true\n')
    symlinkSync(join(root, 'targets', 'one.ts'), join(root, 'alias.ts'))
    const options = { followSymlinks: true }
    const generated = generateIndex(root, options)
    const session = createUpdateIndexSession(root, generated)
    rmSync(join(root, 'alias.ts'))
    symlinkSync(join(root, 'targets', 'two.ts'), join(root, 'alias.ts'))
    symlinkSync(join(outsideRoot, 'outside.ts'), join(root, 'outside.ts'))

    const updated = session.update(options)
    expect(updated.updateReceipt).toMatchObject({ mode: 'warm_incremental', parsed_files: 1 })
    expect(readFileSync(updated.graphPath, 'utf8')).not.toContain('outside.ts')
    expectWarmEqualsClean(root, updated, options)
  })

  it('updates inside a linked worktree with isolated accepted state', () => {
    const container = mkdtempSync(join(tmpdir(), 'madar-incremental-worktree-'))
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
    git(primary, ['worktree', 'add', '-b', 'incremental', linked])
    const generated = generateIndex(linked)
    const session = createUpdateIndexSession(linked, generated)
    writeFileSync(join(linked, 'leaf.ts'), 'export function leaf(): string { return "two" }\n', 'utf8')

    const updated = session.update()
    expect(updated.outputDir.startsWith(linked)).toBe(false)
    expect(updated.updateReceipt).toMatchObject({ parsed_files: 1, reused_files: 1 })
    expectWarmEqualsClean(linked, updated)
  }, 20_000)
})
