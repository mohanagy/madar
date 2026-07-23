import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeInstall } from '../../src/infrastructure/install.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

function git(directory: string, args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
}

describe('linked-worktree install surface', () => {
  it('keeps graph state external and installs worktree-safe retrieve markers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-worktree-install-'))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')

    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      git(primary, ['config', 'user.email', 'madar-tests@example.com'])
      git(primary, ['config', 'user.name', 'Madar Tests'])
      writeFileSync(join(primary, 'main.ts'), 'export const value = 1\n', 'utf8')
      git(primary, ['add', '.'])
      git(primary, ['commit', '-m', 'initial'])
      git(primary, ['worktree', 'add', '-b', 'feature/retrieve', linked])

      const workspace = resolveMadarWorkspace(linked)
      expect(workspace.graphPath.startsWith(linked)).toBe(false)
      mkdirSync(dirname(workspace.graphPath), { recursive: true })
      writeFileSync(workspace.graphPath, '{}\n', 'utf8')

      const message = claudeInstall(linked)
      const instructions = readFileSync(join(linked, 'CLAUDE.md'), 'utf8')
      const mcp = JSON.parse(readFileSync(join(linked, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          madar?: {
            command?: string
            args?: string[]
            env?: Record<string, string>
          }
        }
      }
      const hook = readFileSync(
        join(linked, '.claude', 'madar-user-prompt-submit.cjs'),
        'utf8',
      )

      expect(message).toContain('call Madar retrieve')
      expect(instructions).toContain('## madar')
      expect(instructions).toContain('`retrieve` MCP tool exactly once')
      expect(mcp.mcpServers?.madar).toEqual({
        command: 'madar',
        args: ['serve', '--stdio', '--auto-refresh'],
      })
      expect(mcp.mcpServers?.madar?.env).toBeUndefined()
      expect(hook).toContain('madar managed Claude UserPromptSubmit hook')
      expect(hook).toContain('`retrieve` tool exactly once')
      expect(hook).not.toContain(workspace.graphPath)
      expect(existsSync(join(linked, 'out'))).toBe(false)
    } finally {
      if (existsSync(primary)) {
        try {
          git(primary, ['worktree', 'remove', '--force', linked])
        } catch {
          // Recursive cleanup below handles a partially-created worktree.
        }
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 20_000)
})
