import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { validateGraphOutputPath } from '../../src/shared/security.js'
import { resolveMadarWorkspace, resolveWorkspaceGraphPath, resolveWorkspaceOutputPath } from '../../src/shared/workspace.js'

function git(directory: string, args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
}

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
}

describe('worktree artifact routing', () => {
  test('keeps a linked worktree graph outside the source checkout and isolated from the primary checkout', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-worktree-'))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')
    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      git(primary, ['config', 'user.email', 'madar-tests@example.com'])
      git(primary, ['config', 'user.name', 'Madar Tests'])
      writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8')
      git(primary, ['add', '.'])
      git(primary, ['commit', '-m', 'initial'])
      git(primary, ['worktree', 'add', '-b', 'feature/worktree-routing', linked])
      mkdirSync(join(linked, 'src'))

      const primaryWorkspace = resolveMadarWorkspace(primary)
      const linkedWorkspace = resolveMadarWorkspace(linked)
      const scopedWorkspace = resolveMadarWorkspace(join(linked, 'src'))

      expect(primaryWorkspace.isLinkedWorktree).toBe(false)
      expect(primaryWorkspace.graphPath).toBe(join(resolve(primary), 'out', 'graph.json'))
      expect(linkedWorkspace.isLinkedWorktree).toBe(true)
      expect(realpathSync(linkedWorkspace.gitCommonDir ?? '')).toBe(realpathSync(join(primary, '.git')))
      expect(linkedWorkspace.graphPath).not.toBe(primaryWorkspace.graphPath)
      expect(isInside(linkedWorkspace.graphPath, linked)).toBe(false)
      expect(scopedWorkspace.graphPath).not.toBe(linkedWorkspace.graphPath)
      expect(resolveWorkspaceGraphPath('out/graph.json', linked)).toBe(linkedWorkspace.graphPath)
      expect(resolveWorkspaceGraphPath('./out/graph.json', linked)).toBe(linkedWorkspace.graphPath)
      expect(resolveWorkspaceOutputPath('out/compare', linked)).toBe(join(linkedWorkspace.outputDir, 'compare'))
      expect(validateGraphOutputPath('out/compare', 'out', linked)).toBe(join(linkedWorkspace.outputDir, 'compare'))

      writeFileSync(join(linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 2 }\n', 'utf8')
      const result = generateGraph(linked, { noHtml: true })
      const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as { root_path?: string; nodes?: Array<{ source_file?: string }> }

      expect(result.outputDir).toBe(linkedWorkspace.outputDir)
      expect(result.graphPath).toBe(linkedWorkspace.graphPath)
      expect(existsSync(join(linked, 'out'))).toBe(false)
      expect(graph.root_path).toBe(resolve(linked))
      expect(graph.nodes?.some((node) => node.source_file?.endsWith('feature.ts'))).toBe(true)

      writeFileSync(join(linked, 'feature.ts'), 'export function worktreeOnlyFeature() { return 3 }\n', 'utf8')
      const update = generateGraph(linked, { update: true, noHtml: true })
      expect(update.outputDir).toBe(linkedWorkspace.outputDir)

      const spi = generateGraph(linked, { useSpi: true, noHtml: true })
      expect(spi.outputDir).toBe(linkedWorkspace.outputDir)
      expect(existsSync(join(linked, 'out'))).toBe(false)
      expect(existsSync(join(linkedWorkspace.outputDir, '.spi-cache'))).toBe(true)
    } finally {
      if (existsSync(primary)) {
        try {
          git(primary, ['worktree', 'remove', '--force', linked])
        } catch {
          // The temp directory cleanup below is still safe if setup failed.
        }
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 20_000)
})
