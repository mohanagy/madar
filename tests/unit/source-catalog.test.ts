import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSourceCatalog,
} from '../../src/adapters/filesystem/source-catalog.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

const roots: string[] = []

function sandbox(prefix = 'madar-source-catalog-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
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

describe('source catalog', () => {
  it('creates one deterministic supported/control/informational snapshot', () => {
    const root = sandbox()
    write(root, 'src/a.ts', 'export const a = true\n')
    write(root, 'src/b.tsx', 'export const B = () => <div />\n')
    write(root, 'src/c.js', 'export const c = true\n')
    write(root, 'src/d.jsx', 'export const D = () => <div />\n')
    write(root, 'src/ignored.stories.tsx', 'export const Story = () => <div />\n')
    write(root, 'docs/design.md', '# design\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    write(root, 'package.json', '{"name":"fixture"}\n')

    const first = buildSourceCatalog(root)
    const second = buildSourceCatalog(root)

    expect(first.snapshot).toEqual(second.snapshot)
    expect(first.policy).toEqual(second.policy)
    expect(first.snapshot.supported.map((entry) => entry.path)).toEqual([
      'src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx',
    ])
    expect(first.snapshot.controls.map((entry) => entry.path)).toEqual(['package.json', 'tsconfig.json'])
    expect(first.snapshot.unsupported.map((entry) => entry.path)).toEqual(['docs/design.md'])
    expect(first.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'docs/design.md', status: 'unsupported', reason: 'unsupported_file_type' }),
      expect.objectContaining({ path: 'src/ignored.stories.tsx', status: 'skipped_by_policy', reason: 'noise_path' }),
    ]))
    expect(first.sourceRoot).toMatchObject({ kind: 'directory', root_path: root, scope: '.' })
  })

  it('treats unsupported content as informational but tracks its path identity', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    const unsupported = write(root, 'docs/notes.md', '# one\n')
    const before = buildSourceCatalog(root)
    writeFileSync(unsupported, '# two with different content\n', 'utf8')
    const contentChanged = buildSourceCatalog(root)
    expect(contentChanged.snapshot.unsupported).toEqual(before.snapshot.unsupported)
    expect(contentChanged.snapshot.fingerprint).toBe(before.snapshot.fingerprint)

    rmSync(unsupported)
    write(root, 'docs/renamed.md', '# two with different content\n')
    const renamed = buildSourceCatalog(root)
    expect(renamed.snapshot.unsupported).not.toEqual(before.snapshot.unsupported)
    expect(renamed.snapshot.fingerprint).not.toBe(before.snapshot.fingerprint)
  })

  it('uses .madarignore and optional Git visibility through the same catalog', () => {
    const root = sandbox()
    write(root, 'src/keep.ts', 'export const keep = true\n')
    write(root, 'src/madar-hidden.ts', 'export const hidden = true\n')
    write(root, 'src/git-hidden.ts', 'export const hiddenByGit = true\n')
    write(root, '.madarignore', 'src/madar-hidden.ts\n')
    write(root, '.gitignore', 'src/git-hidden.ts\n')
    git(root, ['init'])

    expect(buildSourceCatalog(root, { respectGitignore: false }).snapshot.supported.map((entry) => entry.path)).toEqual([
      'src/git-hidden.ts', 'src/keep.ts',
    ])
    const respected = buildSourceCatalog(root, { respectGitignore: true })
    expect(respected.snapshot.supported.map((entry) => entry.path)).toEqual(['src/keep.ts'])
    expect(respected.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/madar-hidden.ts', reason: 'madarignore' }),
      expect.objectContaining({ path: 'src/git-hidden.ts', reason: 'gitignored' }),
    ]))
  })

  it('reports safety exclusions separately from supported completeness', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, '.env', 'TOKEN=secret\n')
    write(root, '.secrets/key.ts', 'export const secret = true\n')

    const catalog = buildSourceCatalog(root)

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual(['src/main.ts'])
    expect(catalog.discoverySafety.summary.total).toBeGreaterThan(0)
    expect(catalog.discoverySafety.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env', kind: 'sensitive' }),
      expect.objectContaining({ path: '.secrets', kind: 'sensitive' }),
    ]))
  })

  it.runIf(process.platform !== 'win32')('follows only allowed in-root symlinks and rejects broken/outside targets', () => {
    const root = sandbox()
    const outside = sandbox('madar-source-outside-')
    write(root, 'src/target.ts', 'export const target = true\n')
    write(outside, 'outside.ts', 'export const outside = true\n')
    symlinkSync(join(root, 'src', 'target.ts'), join(root, 'src', 'alias.ts'))
    symlinkSync(join(outside, 'outside.ts'), join(root, 'src', 'outside.ts'))
    symlinkSync(join(root, 'src', 'missing.ts'), join(root, 'src', 'broken.ts'))

    const disabled = buildSourceCatalog(root)
    expect(disabled.snapshot.supported.map((entry) => entry.path)).toEqual(['src/target.ts'])
    expect(disabled.outcomes.filter((entry) => entry.reason === 'symlink_disabled')).toHaveLength(3)

    const followed = buildSourceCatalog(root, { followSymlinks: true })
    expect(followed.snapshot.supported.map((entry) => entry.path)).toEqual(['src/alias.ts', 'src/target.ts'])
    expect(followed.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/outside.ts', reason: 'symlink_outside_root' }),
      expect.objectContaining({ path: 'src/broken.ts', status: 'failed', reason: 'unreadable_path' }),
    ]))
  })

  it('identifies linked worktrees while keeping their artifact state isolated', () => {
    const container = sandbox('madar-source-worktree-')
    const primary = join(container, 'primary')
    const linked = join(container, 'linked')
    mkdirSync(primary, { recursive: true })
    write(primary, 'src/main.ts', 'export const branch = "main"\n')
    git(primary, ['init'])
    git(primary, ['config', 'user.email', 'madar@example.com'])
    git(primary, ['config', 'user.name', 'Madar Tests'])
    git(primary, ['add', '.'])
    git(primary, ['commit', '-m', 'initial'])
    git(primary, ['worktree', 'add', '-b', 'feature', linked])

    const primaryCatalog = buildSourceCatalog(primary)
    const linkedCatalog = buildSourceCatalog(linked)
    const primaryWorkspace = resolveMadarWorkspace(primary)
    const linkedWorkspace = resolveMadarWorkspace(linked)

    expect(primaryCatalog.sourceRoot.kind).toBe('primary_worktree')
    expect(linkedCatalog.sourceRoot).toMatchObject({ kind: 'linked_worktree', scope: '.' })
    expect(linkedWorkspace.outputDir).not.toBe(primaryWorkspace.outputDir)
    expect(linkedWorkspace.outputDir.startsWith(linked)).toBe(false)
  })
})
