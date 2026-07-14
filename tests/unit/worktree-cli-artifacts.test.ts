import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { parseCompareArgs, parseProofReportArgs, parseReviewCompareArgs } from '../../src/cli/parser.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runProofReportCommand } from '../../src/infrastructure/proof-report.js'
import { toJson } from '../../src/pipeline/export.js'
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
      mkdirSync(dirname(workspace.graphPath), { recursive: true })
      const graph = new KnowledgeGraph()
      graph.graph.root_path = linked
      graph.addNode('entry', {
        label: 'value',
        source_file: 'main.ts',
        source_location: 'L1',
        node_kind: 'variable',
        file_type: 'code',
      })
      toJson(graph, { 0: ['entry'] }, workspace.graphPath)

      process.chdir(linked)

      expect(parseCompareArgs([
        'where is value defined?',
        '--exec',
        'claude -p "$(cat {prompt_file})"',
      ])).toMatchObject({
        graphPath: workspace.graphPath,
        outputDir: join(workspace.outputDir, 'compare'),
      })
      expect(parseReviewCompareArgs([
        '--exec',
        'claude -p "$(cat {prompt_file})"',
      ])).toMatchObject({
        graphPath: workspace.graphPath,
        outputDir: join(workspace.outputDir, 'review-compare'),
      })
      expect(parseProofReportArgs([])).toEqual({
        graphPath: workspace.graphPath,
        outputDir: join(workspace.outputDir, 'proof-report'),
        compareDir: join(workspace.outputDir, 'compare'),
        packPath: null,
      })
      expect(parseProofReportArgs([
        '--output-dir', 'out/proof-report/custom',
        '--compare-dir', 'out/compare/custom',
        '--pack', 'out/proof-inputs/context-pack.json',
      ])).toEqual({
        graphPath: workspace.graphPath,
        outputDir: join(workspace.outputDir, 'proof-report', 'custom'),
        compareDir: join(workspace.outputDir, 'compare', 'custom'),
        packPath: join(workspace.outputDir, 'proof-inputs', 'context-pack.json'),
      })

      const proof = runProofReportCommand({ graphPath: 'out/graph.json' })
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
