import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { parseCompareArgs, parseProofReportArgs, parseReviewCompareArgs } from '../../src/cli/parser.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { runProofReportCommand } from '../../src/infrastructure/proof-report.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

function git(directory: string, args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
}

describe('linked-worktree CLI artifact routing', () => {
  test('derives compare, review, and proof artifacts from the external graph directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-worktree-cli-'))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')
    const originalCwd = process.cwd()

    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      git(primary, ['config', 'user.email', 'madar-tests@example.com'])
      git(primary, ['config', 'user.name', 'Madar Tests'])
      writeFileSync(join(primary, 'main.ts'), 'export const value = 1\n', 'utf8')
      git(primary, ['add', '.'])
      git(primary, ['commit', '-m', 'initial'])
      git(primary, ['worktree', 'add', '-b', 'feature/cli-artifacts', linked])

      const workspace = resolveMadarWorkspace(linked)
      // Generated rather than hand-written: the routing under test is about
      // where a cut-over workspace puts its artifacts, and a hand-built v1 file
      // could not exercise the canonical path the parsers now resolve to.
      generateGraph(linked, { noHtml: true })
      expect(classifyWorkspaceGraph(workspace.outputDir).state).toBe('current_v2')

      process.chdir(linked)

      expect(parseCompareArgs([
        'where is value defined?',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
      ])).toMatchObject({
        graphPath: workspace.canonicalGraphPath,
        outputDir: join(workspace.outputDir, 'compare'),
      })
      expect(parseReviewCompareArgs([
        '--exec',
        'claude -p "$(cat {prompt_file})"',
      ])).toMatchObject({
        graphPath: workspace.canonicalGraphPath,
        outputDir: join(workspace.outputDir, 'review-compare'),
      })
      expect(parseProofReportArgs([])).toEqual({
        graphPath: workspace.canonicalGraphPath,
        // No --graph was passed, so the intent must travel as a default.
        graphPathIntent: 'default',
        outputDir: join(workspace.outputDir, 'proof-report'),
        compareDir: join(workspace.outputDir, 'compare'),
        packPath: null,
      })
      expect(parseProofReportArgs([
        '--output-dir', 'out/proof-report/custom',
        '--compare-dir', 'out/compare/custom',
        '--pack', 'out/proof-inputs/context-pack.json',
      ])).toEqual({
        graphPath: workspace.canonicalGraphPath,
        graphPathIntent: 'default',
        outputDir: join(workspace.outputDir, 'proof-report', 'custom'),
        compareDir: join(workspace.outputDir, 'compare', 'custom'),
        packPath: join(workspace.outputDir, 'proof-inputs', 'context-pack.json'),
      })

      const proof = runProofReportCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'default' })
      expect(proof.outputPath).toBe(join(workspace.outputDir, 'proof-report', 'proof-report.md'))
      expect(existsSync(proof.outputPath)).toBe(true)
      expect(existsSync(join(linked, 'out'))).toBe(false)
    } finally {
      process.chdir(originalCwd)
      if (existsSync(primary)) {
        try {
          git(primary, ['worktree', 'remove', '--force', linked])
        } catch {
          // Temp cleanup below handles partially-created worktrees too.
        }
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
