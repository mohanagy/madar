import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  agentsInstall,
  agentsUninstall,
  claudeInstall,
  claudeUninstall,
  cursorInstall,
  cursorUninstall,
  geminiInstall,
  geminiUninstall,
  hasManagedClaudePromptHookScript,
  hasManagedCodexPromptHookScript,
  installCopilotMcp,
  uninstallCopilotMcp,
} from '../../src/infrastructure/install.js'

function inSandbox(run: (sandbox: string) => void): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'madar-install-'))
  try {
    run(sandbox)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

function packageRoot(sandbox: string): string {
  const root = join(sandbox, 'package')
  const cli = join(root, 'dist', 'src', 'cli', 'bin.js')
  mkdirSync(join(root, 'dist', 'src', 'cli'), { recursive: true })
  writeJson(join(root, 'package.json'), {
    name: '@lubab/madar-test',
    version: '1.0.0',
    bin: { madar: 'dist/src/cli/bin.js' },
  })
  writeFileSync(cli, '#!/usr/bin/env node\n', 'utf8')
  return root
}

function assertRetrieveOnly(content: string): void {
  expect(content).toContain('retrieve')
  expect(content).toContain('exactly once')
  expect(content).not.toContain('context_pack')
  expect(content).not.toContain('context-pack')
  expect(content).not.toContain('profile')
  expect(content).not.toContain('confidence')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('generic installer', () => {
  it('installs an unconditional Claude hook and one-tool MCP wiring', () => {
    inSandbox((project) => {
      writeJson(join(project, '.mcp.json'), {
        mcpServers: {
          other: { command: 'other-server', args: [] },
          madar: {
            command: 'old-madar',
            args: ['serve'],
            env: {
              MADAR_TOOL_PROFILE: 'strict',
              HTTP_PROXY: 'http://proxy.test',
            },
          },
        },
      })

      claudeInstall(project)

      const instructions = readFileSync(join(project, 'CLAUDE.md'), 'utf8')
      assertRetrieveOnly(instructions)

      const scriptPath = join(project, '.claude', 'madar-user-prompt-submit.cjs')
      expect(hasManagedClaudePromptHookScript(scriptPath)).toBe(true)
      const execution = spawnSync(process.execPath, [scriptPath], {
        input: JSON.stringify({ prompt: 'write marketing copy' }),
        encoding: 'utf8',
      })
      expect(execution.status).toBe(0)
      const hookOutput = JSON.parse(execution.stdout) as {
        hookSpecificOutput: { additionalContext: string }
      }
      assertRetrieveOnly(hookOutput.hookSpecificOutput.additionalContext)

      const settings = readJson(join(project, '.claude', 'settings.json'))
      expect(settings.hooks.UserPromptSubmit).toEqual([
        expect.objectContaining({ name: 'madar', source: 'madar' }),
      ])

      const mcp = readJson(join(project, '.mcp.json'))
      expect(mcp.mcpServers.other).toEqual({ command: 'other-server', args: [] })
      expect(mcp.mcpServers.madar).toEqual({
        command: 'madar',
        args: ['serve', '--stdio', '--auto-refresh'],
        env: { HTTP_PROXY: 'http://proxy.test' },
      })

      claudeUninstall(project)
      const uninstalled = readJson(join(project, '.mcp.json'))
      expect(uninstalled.mcpServers).toEqual({
        other: { command: 'other-server', args: [] },
      })
      expect(existsSync(scriptPath)).toBe(false)
    })
  })

  it('refuses a user hook script but replaces and removes marker-owned scripts', () => {
    inSandbox((project) => {
      const scriptPath = join(project, '.claude', 'madar-user-prompt-submit.cjs')
      mkdirSync(join(project, '.claude'), { recursive: true })
      writeFileSync(scriptPath, 'console.log("user")\n')
      expect(() => claudeInstall(project)).toThrow('Refusing to overwrite user-managed Claude hook script')

      writeFileSync(
        scriptPath,
        '// madar managed Claude UserPromptSubmit hook\nconsole.log("old managed")\n',
      )
      claudeInstall(project)
      expect(hasManagedClaudePromptHookScript(scriptPath)).toBe(true)
      claudeUninstall(project)
      expect(existsSync(scriptPath)).toBe(false)
    })
  })

  it('installs generic Cursor and Copilot MCP entries without retired profile state', () => {
    inSandbox((sandbox) => {
      const cursorProject = join(sandbox, 'cursor')
      const copilotProject = join(sandbox, 'copilot')
      const root = packageRoot(sandbox)
      mkdirSync(cursorProject, { recursive: true })
      mkdirSync(copilotProject, { recursive: true })

      cursorInstall(cursorProject)
      const cursorRule = readFileSync(
        join(cursorProject, '.cursor', 'rules', 'madar.mdc'),
        'utf8',
      )
      assertRetrieveOnly(cursorRule)
      expect(readJson(join(cursorProject, '.cursor', 'mcp.json')).mcpServers.madar)
        .toEqual({
          command: 'madar',
          args: ['serve', '--stdio', '--auto-refresh'],
        })

      installCopilotMcp(copilotProject, root)
      expect(readJson(join(copilotProject, '.vscode', 'mcp.json')).servers.madar)
        .toEqual({
          type: 'stdio',
          command: process.execPath,
          args: [
            join(root, 'dist', 'src', 'cli', 'bin.js'),
            'serve',
            '--stdio',
            '--auto-refresh',
          ],
        })

      expect(cursorUninstall(cursorProject)).toContain('removed')
      expect(uninstallCopilotMcp(copilotProject)).toContain('removed')
    })
  })

  it('installs the generic skill and Gemini hook without classification modes', () => {
    inSandbox((sandbox) => {
      const project = join(sandbox, 'project')
      const home = join(sandbox, 'home')
      mkdirSync(project, { recursive: true })
      geminiInstall(project, {
        homeDir: home,
        packageRoot: packageRoot(sandbox),
        version: '1.0.0',
      })

      assertRetrieveOnly(
        readFileSync(join(home, '.gemini', 'skills', 'madar', 'SKILL.md'), 'utf8'),
      )
      assertRetrieveOnly(readFileSync(join(project, 'GEMINI.md'), 'utf8'))
      const settings = readJson(join(project, '.gemini', 'settings.json'))
      expect(settings.hooks.BeforeTool).toEqual([
        expect.objectContaining({ name: 'madar', source: 'madar' }),
      ])
      expect(settings.mcpServers.madar).toEqual({
        command: 'madar',
        args: ['serve', '--stdio', '--auto-refresh'],
      })

      geminiUninstall(project, { homeDir: home })
      expect(existsSync(join(home, '.gemini', 'skills', 'madar', 'SKILL.md')))
        .toBe(false)
    })
  })

  it('installs marker-owned Codex and OpenCode guidance with generic retrieve wiring', () => {
    inSandbox((sandbox) => {
      const codexHome = join(sandbox, 'codex-home')
      const codexProject = join(sandbox, 'codex-project')
      const opencodeProject = join(sandbox, 'opencode-project')
      const root = packageRoot(sandbox)
      mkdirSync(codexProject, { recursive: true })
      mkdirSync(opencodeProject, { recursive: true })
      vi.stubEnv('CODEX_HOME', codexHome)

      agentsInstall(codexProject, 'codex')
      const codexInstructions = readFileSync(join(codexProject, 'AGENTS.md'), 'utf8')
      assertRetrieveOnly(codexInstructions)
      const codexScript = join(codexProject, '.codex', 'madar-user-prompt-submit.cjs')
      expect(hasManagedCodexPromptHookScript(codexScript)).toBe(true)
      const codexConfig = readFileSync(join(codexHome, 'config.toml'), 'utf8')
      expect(codexConfig).toContain('args = ["serve", "--stdio", "--auto-refresh"]')
      expect(codexConfig).not.toContain('MADAR_TOOL_PROFILE')

      agentsInstall(opencodeProject, 'opencode', { packageRoot: root })
      assertRetrieveOnly(readFileSync(join(opencodeProject, 'AGENTS.md'), 'utf8'))
      const opencode = readJson(join(opencodeProject, 'opencode.json'))
      expect(opencode.mcp.madar).toEqual({
        type: 'local',
        command: [
          process.execPath,
          join(root, 'dist', 'src', 'cli', 'bin.js'),
          'serve',
          '--stdio',
          '--auto-refresh',
        ],
        enabled: true,
      })

      agentsUninstall(codexProject, 'codex')
      agentsUninstall(opencodeProject, 'opencode')
      expect(existsSync(codexScript)).toBe(false)
      expect(existsSync(join(opencodeProject, '.opencode', 'plugins', 'madar.js')))
        .toBe(false)
    })
  })
})
