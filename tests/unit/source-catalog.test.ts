import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
  vi.resetModules()
  vi.doUnmock('node:fs')
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

  it('orders snapshot paths by canonical code units instead of host locale', () => {
    const root = sandbox()
    const names = ['src/z.ts', 'src/B.ts', 'src/ä.ts', 'src/a.ts']
    for (const name of names) write(root, name, `export const value = ${JSON.stringify(name)}\n`)

    expect(buildSourceCatalog(root).snapshot.supported.map((entry) => entry.path)).toEqual([...names].sort())
  })

  it('authenticates arbitrary and transitive TypeScript extends dependencies', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'import { dependency } from "@dependency"\nexport const main = dependency\n')
    write(root, 'tsconfig.json', '{"extends":"./config/compiler-base.json"}\n')
    write(root, 'config/compiler-base.json', '{"extends":"./strictness.json","compilerOptions":{"baseUrl":"..","paths":{"@dependency":["src/one.ts"]}}}\n')
    const strictness = write(root, 'config/strictness.json', '{"compilerOptions":{"strict":true}}\n')

    const before = buildSourceCatalog(root)
    expect(before.snapshot.controls.map((entry) => entry.path)).toEqual([
      'config/compiler-base.json',
      'config/strictness.json',
      'tsconfig.json',
    ])

    writeFileSync(strictness, '{"compilerOptions":{"strict":false}}\n', 'utf8')
    const after = buildSourceCatalog(root)
    expect(after.snapshot.fingerprint).not.toBe(before.snapshot.fingerprint)
  })

  it('rejects compiler configuration outside the workspace instead of hashing unscoped content', () => {
    const root = sandbox(), outside = sandbox('madar-external-config-')
    const external = write(outside, 'base.json', '{"compilerOptions":{"strict":true}}\n')
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'tsconfig.json', `${JSON.stringify({ extends: external })}\n`)

    expect(() => buildSourceCatalog(root)).toThrow('outside the workspace safety boundary')
  })

  it('rejects a project reference hidden behind a sensitive-directory exclusion', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'tsconfig.json', '{"files":["src/main.ts"],"references":[{"path":"./.secrets"}]}\n')
    write(root, '.secrets/tsconfig.json', '{"compilerOptions":{"composite":true}}\n')

    expect(() => buildSourceCatalog(root)).toThrow('outside the workspace safety boundary')
  })

  it.runIf(process.platform !== 'win32')('does not apply a symlinked or oversized Madar ignore file', () => {
    const root = sandbox(), outside = sandbox('madar-external-ignore-')
    write(root, 'src/main.ts', 'export const main = true\n')
    const external = write(outside, 'ignore', 'src/**\n')
    symlinkSync(external, join(root, '.madarignore'))
    expect(buildSourceCatalog(root).snapshot.supported.map((entry) => entry.path)).toContain('src/main.ts')
    rmSync(join(root, '.madarignore'))
    write(root, '.madarignore', `${'#'.repeat(1_000_001)}\nsrc/**\n`)
    expect(buildSourceCatalog(root).snapshot.supported.map((entry) => entry.path)).toContain('src/main.ts')
  })

  it('authenticates package-based TypeScript extends dependencies outside the discovery walk', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'tsconfig.json', '{"extends":"@fixture/tsconfig"}\n')
    const packageConfig = write(root, 'node_modules/@fixture/tsconfig/tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    write(root, 'node_modules/@fixture/tsconfig/package.json', '{"name":"@fixture/tsconfig","version":"1.0.0"}\n')

    const before = buildSourceCatalog(root)
    expect(before.snapshot.controls.map((entry) => entry.path)).toContain('node_modules/@fixture/tsconfig/package.json')
    expect(before.snapshot.controls.map((entry) => entry.path)).toContain('node_modules/@fixture/tsconfig/tsconfig.json')

    writeFileSync(packageConfig, '{"compilerOptions":{"strict":false}}\n', 'utf8')
    expect(buildSourceCatalog(root).snapshot.fingerprint).not.toBe(before.snapshot.fingerprint)
  })

  it('uses portable identities for identical hoisted compiler configs across copied roots', () => {
    const firstContainer = sandbox('madar-hoisted-config-first-')
    const firstRoot = join(firstContainer, 'workspace')
    write(firstRoot, 'src/main.ts', 'export const main = true\n')
    write(firstRoot, 'tsconfig.json', '{"extends":"@fixture/tsconfig"}\n')
    write(firstContainer, 'node_modules/@fixture/tsconfig/tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    write(firstContainer, 'node_modules/@fixture/tsconfig/package.json', '{"name":"@fixture/tsconfig","version":"1.0.0"}\n')

    const secondContainer = sandbox('madar-hoisted-config-second-')
    const secondRoot = join(secondContainer, 'workspace-copy')
    cpSync(firstRoot, secondRoot, { recursive: true })
    cpSync(join(firstContainer, 'node_modules'), join(secondContainer, 'node_modules'), { recursive: true })

    const first = buildSourceCatalog(firstRoot)
    const copied = buildSourceCatalog(secondRoot)

    expect(copied.snapshot.controls).toEqual(first.snapshot.controls)
    expect(copied.snapshot.fingerprint).toBe(first.snapshot.fingerprint)
    expect(first.snapshot.controls.filter((entry) => entry.path.startsWith('.madar-config-dependencies/'))).toHaveLength(2)
    expect(first.snapshot.controls.some((entry) => entry.path.includes(firstContainer))).toBe(false)

    write(secondContainer, 'node_modules/@fixture/tsconfig/tsconfig.json', '{"compilerOptions":{"strict":false}}\n')
    expect(buildSourceCatalog(secondRoot).snapshot.fingerprint).not.toBe(first.snapshot.fingerprint)
  })

  it('hashes and counts each supported source from the same single read', async () => {
    const root = sandbox()
    const sourcePath = write(root, 'src/main.ts', 'export const first = true\nexport const second = false\n')
    const readFile = vi.fn((path: nodeFs.PathOrFileDescriptor, encoding?: BufferEncoding | null) =>
      encoding === undefined ? nodeFs.readFileSync(path) : nodeFs.readFileSync(path, encoding),
    )
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...actual, readFileSync: readFile }
    })
    const { buildSourceCatalog: buildWithObservedReads } = await import('../../src/adapters/filesystem/source-catalog.js')

    const catalog = buildWithObservedReads(root)

    expect(readFile.mock.calls.filter(([path]) => String(path).endsWith(join('src', 'main.ts')))).toHaveLength(1)
    expect(catalog.totalWords).toBe(10)
    expect(catalog.snapshot.supported[0]?.hash).toBe(
      createHash('sha256').update(nodeFs.readFileSync(sourcePath)).digest('hex'),
    )
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

  it('authenticates safety and skipped-path inventory without treating it as source', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    const before = buildSourceCatalog(root)

    write(root, '.env', 'TOKEN=secret\n')
    write(root, '.hidden.ts', 'export const hidden = true\n')
    const after = buildSourceCatalog(root)

    expect(after.snapshot.supported).toEqual(before.snapshot.supported)
    expect(after.snapshot.inventory).not.toEqual(before.snapshot.inventory)
    expect(after.snapshot.fingerprint).not.toBe(before.snapshot.fingerprint)
    expect(after.snapshot.inventory.map((entry) => entry.path)).toEqual(expect.arrayContaining(['.env', '.hidden.ts']))
  })

  it('does not stale the source catalog when Madar agent integrations are installed', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    const before = buildSourceCatalog(root)
    for (const directory of ['.claude', '.codex', '.cursor', '.gemini', '.opencode', '.vscode']) {
      write(root, `${directory}/madar.json`, '{}\n')
    }

    expect(buildSourceCatalog(root).snapshot).toEqual(before.snapshot)
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
      expect.objectContaining({
        path: 'src/broken.ts',
        status: 'failed',
        reason: 'unreadable_path',
        capability: 'builtin:index:typescript',
      }),
    ]))
  })

  it.runIf(process.platform !== 'win32')('does not let safe-looking symlinks bypass sensitive-target policy', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, '.env', 'TOKEN=secret\n')
    write(root, '.secrets/key.ts', 'export const secret = true\n')
    symlinkSync(join(root, '.env'), join(root, 'safe.ts'))
    symlinkSync(join(root, '.secrets', 'key.ts'), join(root, 'also-safe.ts'))

    const catalog = buildSourceCatalog(root, { followSymlinks: true })

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual(['src/main.ts'])
    expect(catalog.discoverySafety.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'safe.ts', kind: 'sensitive', reason: 'environment_file' }),
      expect.objectContaining({ path: 'also-safe.ts', kind: 'sensitive', reason: 'sensitive_directory' }),
    ]))
  })

  it.runIf(process.platform !== 'win32')('applies hard-ignore, Madar-ignore, and Git visibility to symlink targets', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'build/generated.ts', 'export const generated = true\n')
    write(root, 'internal/madar-hidden.ts', 'export const hidden = true\n')
    write(root, 'git-target/git-hidden.ts', 'export const hidden = true\n')
    write(root, '.madarignore', 'internal/madar-hidden.ts\n')
    write(root, '.gitignore', 'git-target/git-hidden.ts\n')
    symlinkSync(join(root, 'build', 'generated.ts'), join(root, 'generated-alias.ts'))
    symlinkSync(join(root, 'internal', 'madar-hidden.ts'), join(root, 'madar-alias.ts'))
    symlinkSync(join(root, 'git-target', 'git-hidden.ts'), join(root, 'git-alias.ts'))
    git(root, ['init'])

    const catalog = buildSourceCatalog(root, { followSymlinks: true, respectGitignore: true })

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual(['src/main.ts'])
    expect(catalog.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'generated-alias.ts', reason: 'hard_ignored' }),
      expect.objectContaining({ path: 'madar-alias.ts', reason: 'madarignore' }),
      expect.objectContaining({ path: 'git-alias.ts', reason: 'gitignored' }),
    ]))
  })

  it.runIf(process.platform !== 'win32')('keeps a Git-visible physical tree reachable through a directory symlink', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'z-target/child.ts', 'export const child = true\n')
    symlinkSync(join(root, 'z-target'), join(root, 'a-linked'))
    git(root, ['init'])
    git(root, ['add', '.'])

    const catalog = buildSourceCatalog(root, { followSymlinks: true, respectGitignore: true })

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual([
      'a-linked/child.ts',
      'src/main.ts',
    ])
    expect(catalog.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a-linked/child.ts', status: 'indexed' }),
    ]))
  })

  it.runIf(process.platform !== 'win32')('does not let a tracked directory symlink expose a Git-ignored nested symlink', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'real-target/child.ts', 'export const child = true\n')
    write(root, '.gitignore', 'z-target/nested\n')
    mkdirSync(join(root, 'z-target'), { recursive: true })
    symlinkSync(join(root, 'real-target'), join(root, 'z-target', 'nested'))
    symlinkSync(join(root, 'z-target'), join(root, 'a-linked'))
    git(root, ['init'])
    git(root, ['add', '.'])

    const catalog = buildSourceCatalog(root, { followSymlinks: true, respectGitignore: true })

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual([
      'real-target/child.ts',
      'src/main.ts',
    ])
    expect(catalog.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a-linked/nested', reason: 'gitignored' }),
    ]))
  })

  it('always authenticates compiler controls even when ignore rules hide them', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}\n')
    write(root, 'package.json', '{"name":"fixture"}\n')
    write(root, '.madarignore', 'tsconfig.json\npackage.json\n')
    write(root, '.gitignore', 'tsconfig.json\npackage.json\n')
    git(root, ['init'])

    const catalog = buildSourceCatalog(root, { respectGitignore: true })

    expect(catalog.snapshot.controls.map((entry) => entry.path)).toEqual([
      '.gitignore', '.madarignore', 'package.json', 'tsconfig.json',
    ])
  })

  it('keeps generated environments out while inventorying recognized media formats', () => {
    const root = sandbox()
    write(root, 'src/main.ts', 'export const main = true\n')
    write(root, 'site-packages/generated.ts', 'export const generated = true\n')
    write(root, 'storybook-static/bundle.js', 'export const generated = true\n')
    write(root, 'Dist/generated.ts', 'export const generated = true\n')
    write(root, 'assets/demo.mp4', 'not really video\n')

    const catalog = buildSourceCatalog(root)

    expect(catalog.snapshot.supported.map((entry) => entry.path)).toEqual(['src/main.ts'])
    expect(catalog.snapshot.unsupported.map((entry) => entry.path)).toEqual(['assets/demo.mp4'])
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
