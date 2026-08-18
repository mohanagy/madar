import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync} from 'node:fs'
import { tmpdir, devNull } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runContextPackCommand } from '../../src/infrastructure/context-pack-command.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { analyzeGraphContextFreshness } from '../../src/runtime/freshness.js'
import { resolvedLoadPath } from '../../src/runtime/serve.js'
import { logicalGraphPath, resolveMadarWorkspace } from '../../src/shared/workspace.js'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    timeout: 30_000,
    windowsHide: true,
    // user.email and user.name are set locally below, but a contributor's
    // other globals still apply: commit.gpgsign makes `git commit` fail or
    // block on a passphrase, and a global core.hooksPath runs their hooks in
    // this fixture. Either failure reads as a bug in the pack path.
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
  })
}

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
}

describe('paths reported to Pack consumers', () => {
  let plain: string

  beforeAll(() => {
    plain = mkdtempSync(join(tmpdir(), 'pack-logical-'))
    mkdirSync(join(plain, 'src'), { recursive: true })
    writeFileSync(join(plain, 'src', 'a.ts'), 'export function a() {}\n')
    generateGraph(plain, { noHtml: true })
  })

  afterAll(() => {
    rmSync(plain, { recursive: true, force: true })
  })

  it('names the canonical artifact for the current workspace', () => {
    expect(logicalGraphPath(join(plain, 'out', 'graph.madar'), plain)).toBe('out/graph.madar')
  })

  it('names the canonical artifact for a tombstone request', () => {
    // A caller may still hand over the legacy spelling, and what gets reported
    // is the artifact the answer actually came from. This case previously
    // passed the canonical path, so it duplicated the one above and proved
    // nothing about a tombstone request -- the resolution step is the point.
    const requested = join(plain, 'out', 'graph.json')
    const resolved = resolvedLoadPath(requested)

    // The resolver canonicalizes symlinks, so the workspace root is compared in
    // the same form; on macOS /var and /private/var are the same directory.
    expect(resolved.endsWith('graph.madar')).toBe(true)
    expect(logicalGraphPath(resolved, realpathSync(plain))).toBe('out/graph.madar')
  })

  it('names a preserved backup when that is what was read', () => {
    expect(logicalGraphPath(join(plain, 'out', 'graph.v1.json'), plain)).toBe('out/graph.v1.json')
  })

  it('leaves a deliberate path outside the workspace unchanged', () => {
    const elsewhere = join(tmpdir(), 'somewhere-else', 'graph.json')
    expect(logicalGraphPath(elsewhere, plain)).toBe(elsewhere)
  })
})

describe('a linked worktree reports the conventional path', () => {
  let tempDir: string
  let linked: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pack-logical-wt-'))
    const primary = join(tempDir, 'primary')
    linked = join(tempDir, 'linked')
    git(tempDir, ['init', primary])
    git(primary, ['config', 'user.email', 'madar-tests@example.com'])
    git(primary, ['config', 'user.name', 'Madar Tests'])
    writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n')
    git(primary, ['add', '.'])
    git(primary, ['commit', '-m', 'initial'])
    git(primary, ['worktree', 'add', '-b', 'feature/pack-logical', linked])
    mkdirSync(join(linked, 'src'), { recursive: true })
    writeFileSync(join(linked, 'src', 'b.ts'), 'export function b() {}\n')
    generateGraph(linked, { noHtml: true })
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reports the conventional path through governance freshness', () => {
    const workspace = resolveMadarWorkspace(linked)

    // Goes through the real reporter rather than the helper, so reverting the
    // call site fails here even though the helper itself still works.
    const reported = analyzeGraphContextFreshness(workspace.canonicalGraphPath).graph_path

    expect(reported).toBe('out/graph.madar')
    expect(reported).not.toContain('worktrees')
  })

  it('reports the conventional path in the emitted pack', async () => {
    const workspace = resolveMadarWorkspace(linked)

    // A large verbose budget: graph_path is one of the fields trimmed first
    // when the budget is tight, so a small budget would assert on its absence
    // rather than its value.
    const payload = await runContextPackCommand({
      prompt: 'what does b do?',
      budget: 60_000,
      task: 'explain',
      graphPath: workspace.canonicalGraphPath,
      graphPathIntent: 'default',
      format: 'json',
      verbose: true,
    })
    const schema = JSON.parse(payload) as { graph_path?: string }

    expect(schema.graph_path).toBe('out/graph.madar')
    expect(schema.graph_path).not.toContain('worktrees')
  })

  it('does not leak the private artifact directory', () => {
    const workspace = resolveMadarWorkspace(linked)
    expect(workspace.isLinkedWorktree).toBe(true)
    // Only meaningful because the physical artifact lives outside the checkout.
    expect(isInside(workspace.canonicalGraphPath, linked)).toBe(false)

    const reported = logicalGraphPath(workspace.canonicalGraphPath, linked)

    expect(reported).toBe('out/graph.madar')
    expect(reported).not.toContain('worktrees')
    expect(reported).not.toContain('.git')
    expect(reported).not.toContain(workspace.outputDir)
  })
})
