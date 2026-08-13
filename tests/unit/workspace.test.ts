import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { describe, expect, onTestFinished, test } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { validateGraphOutputPath } from '../../src/shared/security.js'
import { resolveMadarWorkspace, resolveWorkspaceGraphPath, resolveWorkspaceOutputPath } from '../../src/shared/workspace.js'

import { createPhaseRun } from './helpers/phase-run.js'

function git(directory: string, args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
}

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
}

function canonicalPhysicalPath(path: string): string {
  const canonical = realpathSync.native(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function reportPhases(text: string): void {
  process.stdout.write(`${text}\n`)
}

describe('worktree artifact routing', () => {
  test('keeps a nested source root in a primary checkout local', () => {
    const phases = createPhaseRun({ label: 'primary-workspace', report: reportPhases })
    onTestFinished(() => phases.emit())
    const tempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar-primary-workspace-')))
    const primary = join(tempDir, 'primary')
    const nested = join(primary, 'packages', 'api')
    let workSucceeded = false
    try {
      phases.phase('git-init', () => execFileSync('git', ['init', primary], { stdio: 'pipe' }))
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
      if (workSucceeded && phases.cleanupErrors().length > 0) {
        throw new AggregateError(phases.cleanupErrors(), 'primary-workspace cleanup failed')
      }
    }
  })

  test('keeps a linked worktree graph outside the source checkout and isolated from the primary checkout', () => {
    const phases = createPhaseRun({ label: 'linked-worktree', report: reportPhases })
    onTestFinished(() => phases.emit())
    const tempDir = phases.phase('temp-root', () => mkdtempSync(join(tmpdir(), 'madar-worktree-')))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')
    let workSucceeded = false
    try {
      phases.phase('git-init', () => execFileSync('git', ['init', primary], { stdio: 'pipe' }))
      phases.phase('git-config-email', () => git(primary, ['config', 'user.email', 'madar-tests@example.com']))
      phases.phase('git-config-name', () => git(primary, ['config', 'user.name', 'Madar Tests']))
      phases.phase('write-main', () => writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8'))
      phases.phase('git-add', () => git(primary, ['add', '.']))
      phases.phase('git-commit', () => git(primary, ['commit', '-m', 'initial']))
      phases.phase('worktree-add', () => git(primary, ['worktree', 'add', '-b', 'feature/worktree-routing', linked]))
      phases.phase('mkdir-linked-src', () => mkdirSync(join(linked, 'src')))

      const primaryWorkspace = phases.phase('resolve-primary-workspace', () => resolveMadarWorkspace(primary))
      const linkedWorkspace = phases.phase('resolve-linked-workspace', () => resolveMadarWorkspace(linked))
      const scopedWorkspace = phases.phase('resolve-scoped-workspace', () => resolveMadarWorkspace(join(linked, 'src')))

      phases.phase('assert-routing', () => {
        expect(primaryWorkspace.isLinkedWorktree).toBe(false)
        expect(primaryWorkspace.graphPath).toBe(join(resolve(primary), 'out', 'graph.json'))
        expect(linkedWorkspace.isLinkedWorktree).toBe(true)
        expect(canonicalPhysicalPath(linkedWorkspace.gitCommonDir ?? '')).toBe(canonicalPhysicalPath(join(primary, '.git')))
        expect(linkedWorkspace.graphPath).not.toBe(primaryWorkspace.graphPath)
        expect(isInside(linkedWorkspace.graphPath, linked)).toBe(false)
        expect(scopedWorkspace.graphPath).not.toBe(linkedWorkspace.graphPath)
        expect(resolveWorkspaceGraphPath('out/graph.json', linked)).toBe(linkedWorkspace.graphPath)
        expect(resolveWorkspaceGraphPath('./out/graph.json', linked)).toBe(linkedWorkspace.graphPath)
        expect(resolveWorkspaceOutputPath('out/compare', linked)).toBe(join(linkedWorkspace.outputDir, 'compare'))
        expect(validateGraphOutputPath('out/compare', 'out', linked)).toBe(join(linkedWorkspace.outputDir, 'compare'))
      })

      phases.phase('write-feature', () => writeFileSync(join(linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 2 }\n', 'utf8'))
      const result = phases.phase('generate-graph', () => generateGraph(linked, { noHtml: true }))
      const graph = phases.phase('read-graph', () => JSON.parse(readFileSync(result.graphPath, 'utf8')) as { root_path?: string; nodes?: Array<{ source_file?: string }> })

      phases.phase('assert-graph-artifacts', () => {
        expect(result.outputDir).toBe(linkedWorkspace.outputDir)
        expect(result.graphPath).toBe(linkedWorkspace.graphPath)
        expect(existsSync(join(linked, 'out'))).toBe(false)
        expect(graph.root_path).toBe(resolve(linked))
        expect(graph.nodes?.some((node) => node.source_file?.endsWith('feature.ts'))).toBe(true)
      })

      phases.phase('write-feature-update', () => writeFileSync(join(linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 3 }\n', 'utf8'))
      const update = phases.phase('generate-update', () => generateGraph(linked, { update: true, noHtml: true }))
      phases.phase('assert-update', () => {
        expect(update.outputDir).toBe(linkedWorkspace.outputDir)
      })

      const spi = phases.phase('generate-spi', () => generateGraph(linked, { useSpi: true, noHtml: true }))
      phases.phase('assert-spi', () => {
        expect(spi.outputDir).toBe(linkedWorkspace.outputDir)
        expect(existsSync(join(linked, 'out'))).toBe(false)
        expect(existsSync(join(linkedWorkspace.outputDir, '.spi-cache'))).toBe(true)
      })
      workSucceeded = true
    } finally {
      phases.cleanup('worktree-remove', () => {
        if (existsSync(primary)) {
          git(primary, ['worktree', 'remove', '--force', linked])
        }
        // The temp directory cleanup below is still safe if setup failed.
      })
      phases.cleanup('remove-temp-root', () => rmSync(tempDir, { recursive: true, force: true }))
      if (workSucceeded && phases.cleanupErrors().length > 0) {
        throw new AggregateError(phases.cleanupErrors(), 'linked-worktree cleanup failed')
      }
    }
  }, 20_000)
})
