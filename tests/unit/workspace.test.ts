import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { validateGraphOutputPath } from '../../src/shared/security.js'
import { resolveMadarWorkspace, resolveWorkspaceGraphPath, resolveWorkspaceOutputPath } from '../../src/shared/workspace.js'

import { createPhaseRun, PhaseFailure, usePhaseRun } from './helpers/phase-run.js'

// The slowest Git command in the six-lane matrix was 177 ms. This 30 s limit
// is roughly 170x that value and is deadlock protection, not a correctness bound.
const GIT_DEADLOCK_LIMIT_MS = 30_000

// The slowest measured phase was 4,102 ms and the slowest healthy total was
// 8,707 ms. This 60 s timeout is only a deadlock alarm (Git hangs are interrupted
// above); elapsed time is never asserted as a correctness criterion.
const TEST_DEADLOCK_LIMIT_MS = 60_000

interface GitProcessError {
  readonly code?: unknown
  readonly signal?: unknown
  readonly stderr?: unknown
}

function git(directory: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: GIT_DEADLOCK_LIMIT_MS,
      windowsHide: true,
    })
  } catch (error) {
    const processError = (typeof error === 'object' && error !== null ? error : {}) as GitProcessError
    const stderr = typeof processError.stderr === 'string'
      ? processError.stderr.trim()
      : Buffer.isBuffer(processError.stderr)
        ? processError.stderr.toString('utf8').trim()
        : ''
    const deadlock = processError.code === 'ETIMEDOUT'
      || (processError.signal !== null && processError.signal !== undefined)
    const argv = JSON.stringify(['git', ...args])
    const message = deadlock
      ? `Git deadlock after ${GIT_DEADLOCK_LIMIT_MS} ms: argv=${argv}; stderr=${stderr || '<empty>'}`
      : `Git command failed: argv=${argv}; stderr=${stderr || '<empty>'}`
    const failure = new Error(message, { cause: error }) as Error & { isDeadlock?: boolean }
    if (deadlock) {
      failure.isDeadlock = true
    }
    throw failure
  }
}

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
}

function canonicalPhysicalPath(path: string): string {
  const canonical = realpathSync.native(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function normalizedWorktreePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/').normalize('NFC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function hasWorktreeRegistration(porcelain: string, linked: string): boolean {
  const expected = normalizedWorktreePath(linked)
  return porcelain.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizedWorktreePath(line.slice('worktree '.length).trim()) === expected)
}

function assertNoWorktreeRegistration(porcelain: string, linked: string): void {
  if (hasWorktreeRegistration(porcelain, linked)) {
    throw new Error(`Git still registers removed worktree path: ${linked}`)
  }
}

function throwCleanupErrors(label: string, phases: ReturnType<typeof createPhaseRun>): void {
  const failures = phases.cleanupErrors()
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} cleanup failed`)
  }
}

describe('worktree artifact routing', () => {
  test('keeps a nested source root in a primary checkout local', () => {
    const phases = usePhaseRun('primary-workspace')
    const tempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar-primary-workspace-')))
    const primary = join(tempDir, 'primary')
    const nested = join(primary, 'packages', 'api')
    let workSucceeded = false
    try {
      phases.phase('git-init', () => git(tempDir, ['init', primary]))
      phases.phase('mkdir-nested', () => mkdirSync(nested, { recursive: true }))

      const workspace = phases.phase('resolve-workspace', () => resolveMadarWorkspace(nested))

      phases.phase('assert-workspace', () => {
        expect(canonicalPhysicalPath(workspace.worktreeRoot ?? '')).toBe(canonicalPhysicalPath(primary))
        expect(workspace.isLinkedWorktree).toBe(false)
        expect(workspace.outputDir).toBe(join(resolve(nested), 'out'))
        expect(workspace.graphPath).toBe(join(resolve(nested), 'out', 'graph.json'))
      })
      workSucceeded = true
    } finally {
      phases.cleanup('remove-temp-root', () => rmSync(tempDir, { recursive: true, force: true }))
      if (workSucceeded) {
        throwCleanupErrors('primary-workspace', phases)
      }
    }
  })
})

describe('linked worktree artifact routing', () => {
  type Workspace = ReturnType<typeof resolveMadarWorkspace>

  let tempDir: string | undefined
  let primary: string | undefined
  let linked: string | undefined
  let primaryWorkspace: Workspace | undefined
  let linkedWorkspace: Workspace | undefined
  let scopedWorkspace: Workspace | undefined

  const fixturePaths = (): { tempDir: string; primary: string; linked: string } => {
    if (!tempDir || !primary || !linked) {
      throw new Error('Linked worktree fixture was not initialized')
    }
    return { tempDir, primary, linked }
  }

  const resolvedWorkspaces = (): { primary: Workspace; linked: Workspace; scoped: Workspace } => {
    if (!primaryWorkspace || !linkedWorkspace || !scopedWorkspace) {
      throw new Error('Linked worktree fixture was not resolved')
    }
    return { primary: primaryWorkspace, linked: linkedWorkspace, scoped: scopedWorkspace }
  }

  beforeAll(() => {
    const phases = createPhaseRun({ label: 'linked-worktree-setup' })
    try {
      const createdTempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar worktree ünïcode ')))
      const createdPrimary = join(createdTempDir, 'primary')
      const createdLinked = join(createdTempDir, 'linked')
      tempDir = createdTempDir
      primary = createdPrimary
      linked = createdLinked
      phases.phase('git-init', () => git(createdTempDir, ['init', createdPrimary]))
      phases.phase('git-config-email', () => git(createdPrimary, ['config', 'user.email', 'madar-tests@example.com']))
      phases.phase('git-config-name', () => git(createdPrimary, ['config', 'user.name', 'Madar Tests']))
      phases.phase('write-main', () => writeFileSync(join(createdPrimary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8'))
      phases.phase('git-add', () => git(createdPrimary, ['add', '.']))
      phases.phase('git-commit', () => git(createdPrimary, ['commit', '-m', 'initial']))
      phases.phase('worktree-add', () => git(createdPrimary, ['worktree', 'add', '-b', 'feature/worktree-routing', createdLinked]))
      phases.phase('mkdir-linked-src', () => mkdirSync(join(createdLinked, 'src')))
    } finally {
      phases.emit()
    }
  }, TEST_DEADLOCK_LIMIT_MS)

  test('resolves the linked worktree to the primary Git common directory', () => {
    const phases = usePhaseRun('linked-worktree-resolve')
    const paths = fixturePaths()

    const resolvedPrimary = phases.phase('resolve-primary-workspace', () => resolveMadarWorkspace(paths.primary))
    const resolvedLinked = phases.phase('resolve-linked-workspace', () => resolveMadarWorkspace(paths.linked))
    const resolvedScoped = phases.phase('resolve-scoped-workspace', () => resolveMadarWorkspace(join(paths.linked, 'src')))
    primaryWorkspace = resolvedPrimary
    linkedWorkspace = resolvedLinked
    scopedWorkspace = resolvedScoped

    phases.phase('assert-routing', () => {
      expect(resolvedPrimary.isLinkedWorktree).toBe(false)
      expect(resolvedPrimary.graphPath).toBe(join(resolve(paths.primary), 'out', 'graph.json'))
      expect(resolvedLinked.isLinkedWorktree).toBe(true)
      expect(canonicalPhysicalPath(resolvedLinked.gitCommonDir ?? '')).toBe(canonicalPhysicalPath(join(paths.primary, '.git')))
      expect(resolvedLinked.graphPath).not.toBe(resolvedPrimary.graphPath)
      expect(isInside(resolvedLinked.graphPath, paths.linked)).toBe(false)
      expect(resolvedScoped.graphPath).not.toBe(resolvedLinked.graphPath)
    })
  }, TEST_DEADLOCK_LIMIT_MS)

  test('routes conventional out paths outside the linked source checkout', () => {
    const phases = usePhaseRun('linked-worktree-conventional-paths')
    const paths = fixturePaths()
    const workspace = resolvedWorkspaces().linked

    phases.phase('assert-routing', () => {
      expect(resolveWorkspaceGraphPath('out/graph.json', paths.linked)).toBe(workspace.graphPath)
      expect(resolveWorkspaceGraphPath('./out/graph.json', paths.linked)).toBe(workspace.graphPath)
      expect(resolveWorkspaceOutputPath('out/compare', paths.linked)).toBe(join(workspace.outputDir, 'compare'))
      expect(validateGraphOutputPath('out/compare', 'out', paths.linked)).toBe(join(workspace.outputDir, 'compare'))
      expect(resolveWorkspaceGraphPath('out\\graph.json', paths.linked)).toBe(workspace.graphPath)
      expect(resolveWorkspaceGraphPath('.\\out\\graph.json', paths.linked)).toBe(workspace.graphPath)
      expect(resolveWorkspaceOutputPath('out\\compare', paths.linked)).toBe(join(workspace.outputDir, 'compare'))
      expect(validateGraphOutputPath('out\\compare', 'out', paths.linked)).toBe(join(workspace.outputDir, 'compare'))
    })
  }, TEST_DEADLOCK_LIMIT_MS)

  test('writes generated graph artifacts outside the linked source checkout', () => {
    const phases = usePhaseRun('linked-worktree-graph')
    const paths = fixturePaths()
    const workspace = resolvedWorkspaces().linked

    phases.phase('write-feature', () => writeFileSync(join(paths.linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 2 }\n', 'utf8'))
    const result = phases.phase('generate-graph', () => generateGraph(paths.linked, { noHtml: true }))
    const graph = phases.phase('read-graph', () => JSON.parse(readFileSync(result.graphPath, 'utf8')) as { root_path?: string; nodes?: Array<{ source_file?: string }> })

    phases.phase('assert-graph-artifacts', () => {
      expect(result.outputDir).toBe(workspace.outputDir)
      expect(result.graphPath).toBe(workspace.graphPath)
      expect(existsSync(join(paths.linked, 'out'))).toBe(false)
      expect(graph.root_path).toBe(resolve(paths.linked))
      expect(graph.nodes?.some((node) => node.source_file?.endsWith('feature.ts'))).toBe(true)
    })
  }, TEST_DEADLOCK_LIMIT_MS)

  test('keeps an incremental update routed to the linked artifact directory', () => {
    const phases = usePhaseRun('linked-worktree-update')
    const paths = fixturePaths()
    const workspace = resolvedWorkspaces().linked

    phases.phase('write-feature-update', () => writeFileSync(join(paths.linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 3 }\n', 'utf8'))
    const update = phases.phase('generate-update', () => generateGraph(paths.linked, { update: true, noHtml: true }))
    phases.phase('assert-update', () => {
      expect(update.outputDir).toBe(workspace.outputDir)
    })
  }, TEST_DEADLOCK_LIMIT_MS)

  test('keeps the SPI cache outside the linked source checkout', () => {
    const phases = usePhaseRun('linked-worktree-spi')
    const paths = fixturePaths()
    const workspace = resolvedWorkspaces().linked

    const spi = phases.phase('generate-spi', () => generateGraph(paths.linked, { useSpi: true, noHtml: true }))
    phases.phase('assert-spi', () => {
      expect(spi.outputDir).toBe(workspace.outputDir)
      expect(existsSync(join(paths.linked, 'out'))).toBe(false)
      expect(existsSync(join(workspace.outputDir, '.spi-cache'))).toBe(true)
    })
  }, TEST_DEADLOCK_LIMIT_MS)

  afterAll(() => {
    const phases = createPhaseRun({ label: 'linked-worktree-cleanup' })
    phases.cleanup('worktree-remove', () => {
      if (primary && linked && existsSync(primary) && existsSync(linked)) {
        git(primary, ['worktree', 'remove', '--force', linked])
      }
    })
    phases.cleanup('verify-no-stale-registration', () => {
      if (primary && linked && existsSync(primary)) {
        const porcelain = git(primary, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'])
        assertNoWorktreeRegistration(porcelain, linked)
      }
    })
    phases.cleanup('remove-temp-root', () => {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
    phases.emit()
    throwCleanupErrors('linked-worktree', phases)
  }, TEST_DEADLOCK_LIMIT_MS)
})

test('names the worktree-add phase when linked worktree creation fails', () => {
  const phases = createPhaseRun({ label: 'worktree-add-failure', report: () => undefined })
  const tempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar-worktree-add-failure-')))
  const primary = join(tempDir, 'primary')
  const linked = join(tempDir, 'non-empty-linked')
  let workSucceeded = false
  try {
    phases.phase('git-init', () => git(tempDir, ['init', primary]))
    phases.phase('git-config-email', () => git(primary, ['config', 'user.email', 'madar-tests@example.com']))
    phases.phase('git-config-name', () => git(primary, ['config', 'user.name', 'Madar Tests']))
    phases.phase('write-main', () => writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8'))
    phases.phase('git-add', () => git(primary, ['add', '.']))
    phases.phase('git-commit', () => git(primary, ['commit', '-m', 'initial']))
    phases.phase('mkdir-non-empty-target', () => mkdirSync(linked))
    phases.phase('write-target-blocker', () => writeFileSync(join(linked, 'occupied.txt'), 'occupied\n', 'utf8'))

    let caught: unknown
    try {
      phases.phase('worktree-add', () => git(primary, ['worktree', 'add', '-b', 'feature/worktree-add-failure', linked]))
    } catch (error) {
      caught = error
    }

    phases.phase('assert-worktree-add-failure', () => {
      expect(caught).toBeInstanceOf(PhaseFailure)
      expect((caught as PhaseFailure).phase).toBe('worktree-add')
      expect((caught as PhaseFailure).message).toContain('phase "worktree-add" failed')
      expect((caught as PhaseFailure).cause).toBeInstanceOf(Error)
      expect(((caught as PhaseFailure).cause as Error).message).toContain('argv=["git","worktree","add"')
      expect(((caught as PhaseFailure).cause as Error).message).toContain('stderr=')
    })
    workSucceeded = true
  } finally {
    phases.cleanup('worktree-remove', () => {
      if (existsSync(primary) && existsSync(linked)) {
        const porcelain = git(primary, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'])
        if (hasWorktreeRegistration(porcelain, linked)) {
          git(primary, ['worktree', 'remove', '--force', linked])
        }
      }
    })
    phases.cleanup('remove-temp-root', () => rmSync(tempDir, { recursive: true, force: true }))
    phases.emit()
    if (workSucceeded) {
      throwCleanupErrors('worktree-add-failure', phases)
    }
  }
}, TEST_DEADLOCK_LIMIT_MS)

test('leaves no stale linked worktree registration after removal', () => {
  const phases = usePhaseRun('worktree-registration-removal')
  const tempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar-worktree-registration-')))
  const primary = join(tempDir, 'primary')
  const linked = join(tempDir, 'linked')
  let workSucceeded = false
  try {
    phases.phase('git-init', () => git(tempDir, ['init', primary]))
    phases.phase('git-config-email', () => git(primary, ['config', 'user.email', 'madar-tests@example.com']))
    phases.phase('git-config-name', () => git(primary, ['config', 'user.name', 'Madar Tests']))
    phases.phase('write-main', () => writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8'))
    phases.phase('git-add', () => git(primary, ['add', '.']))
    phases.phase('git-commit', () => git(primary, ['commit', '-m', 'initial']))
    phases.phase('worktree-add', () => git(primary, ['worktree', 'add', '-b', 'feature/worktree-registration', linked]))
    phases.phase('worktree-remove', () => git(primary, ['worktree', 'remove', '--force', linked]))
    const porcelain = phases.phase('worktree-list', () => git(primary, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']))
    phases.phase('assert-no-stale-registration', () => {
      expect(hasWorktreeRegistration(porcelain, linked)).toBe(false)
    })
    workSucceeded = true
  } finally {
    phases.cleanup('ensure-worktree-remove', () => {
      if (existsSync(primary) && existsSync(linked)) {
        git(primary, ['worktree', 'remove', '--force', linked])
      }
    })
    phases.cleanup('remove-temp-root', () => rmSync(tempDir, { recursive: true, force: true }))
    if (workSucceeded) {
      throwCleanupErrors('worktree-registration-removal', phases)
    }
  }
}, TEST_DEADLOCK_LIMIT_MS)
