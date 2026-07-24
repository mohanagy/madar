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
  defaultInstallPlatform,
  geminiInstall,
  geminiUninstall,
  hasManagedClaudePromptHookScript,
  hasManagedCodexPromptHookScript,
  installCopilotMcp,
  installSkill,
  isAgentPlatform,
  isCurrentMadarClaudePromptHook,
  isCurrentMadarCodexPromptHook,
  isCurrentMadarGeminiHook,
  isInstallPlatform,
  isMadarCodexLegacyHook,
  isMadarCodexMcpConfig,
  isMadarCodexPromptHook,
  isMadarProjectHook,
  readOpencodeConfig,
  resolveCodexMcpConfigPath,
  resolveOpencodeConfigPath,
  uninstallCopilotMcp,
  uninstallSkill,
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
  it('recognizes every supported platform and host default without legacy profiles', () => {
    expect(defaultInstallPlatform('win32')).toBe('windows')
    expect(defaultInstallPlatform('linux')).toBe('claude')
    for (const platform of [
      'claude', 'gemini', 'codex', 'opencode', 'aider', 'claw', 'droid',
      'trae', 'trae-cn', 'copilot', 'windows', 'cursor',
    ]) expect(isInstallPlatform(platform)).toBe(true)
    for (const platform of [
      'codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn',
    ]) expect(isAgentPlatform(platform)).toBe(true)
    expect(isInstallPlatform('legacy')).toBe(false)
    expect(isAgentPlatform('claude')).toBe(false)
  })

  it('installs and removes each generic home skill using current built-in content', () => {
    inSandbox((sandbox) => {
      const homeDir = join(sandbox, 'home')
      const root = packageRoot(sandbox)
      const platforms = [
        'claude', 'gemini', 'codex', 'opencode', 'aider', 'claw', 'droid',
        'trae', 'trae-cn', 'copilot', 'windows',
      ] as const
      for (const platform of platforms) {
        expect(installSkill(platform, {
          homeDir,
          packageRoot: root,
          version: '1.0.0',
        })).toContain('skill installed')
        expect(uninstallSkill(platform, { homeDir })).toContain('removed')
        expect(uninstallSkill(platform, { homeDir })).toBe('nothing to remove')
      }
    })
  })

  it('classifies only marker-owned project hooks and exact current hook shapes', () => {
    const command = 'node hook.cjs'
    const current = {
      name: 'madar',
      source: 'madar',
      hooks: [{ type: 'command', command }],
    }
    expect(isMadarProjectHook(current)).toBe(true)
    expect(isMadarProjectHook({ ...current, matcher: 'Prompt' }, 'Prompt')).toBe(true)
    expect(isMadarProjectHook({ ...current, matcher: 'Other' }, 'Prompt')).toBe(false)
    expect(isCurrentMadarClaudePromptHook(current, command)).toBe(true)
    expect(isCurrentMadarClaudePromptHook({ ...current, extra: true }, command)).toBe(false)
    expect(isMadarCodexPromptHook(current)).toBe(true)
    expect(isCurrentMadarCodexPromptHook(current, command)).toBe(true)
    expect(isCurrentMadarCodexPromptHook(current, 'other')).toBe(false)
    expect(isMadarCodexLegacyHook({ ...current, matcher: 'Bash' })).toBe(true)
    expect(isMadarCodexLegacyHook({ ...current, matcher: 'Prompt' })).toBe(false)
    expect(isCurrentMadarGeminiHook(current)).toBe(false)
    expect(isMadarProjectHook(null)).toBe(false)
    expect(isMadarCodexPromptHook({ source: 'madar', hooks: [] })).toBe(false)
  })

  it('resolves configured Codex and OpenCode paths and rejects malformed OpenCode config', () => {
    inSandbox((sandbox) => {
      vi.stubEnv('CODEX_HOME', join(sandbox, 'codex'))
      expect(resolveCodexMcpConfigPath()).toBe(join(sandbox, 'codex', 'config.toml'))
      const project = join(sandbox, 'project')
      mkdirSync(project, { recursive: true })
      expect(resolveOpencodeConfigPath(project)).toBe(join(project, 'opencode.json'))
      writeFileSync(join(project, 'opencode.jsonc'), '{ "shell": "zsh", }\n')
      expect(resolveOpencodeConfigPath(project)).toBe(join(project, 'opencode.jsonc'))
      expect(readOpencodeConfig(join(project, 'opencode.jsonc'))).toMatchObject({ shell: 'zsh' })
      writeFileSync(join(project, 'opencode.jsonc'), '{ broken')
      expect(() => readOpencodeConfig(join(project, 'opencode.jsonc'))).toThrow()
    })
  })

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

  it('keeps separate Codex workspaces independent and preserves unrelated config', () => {
    inSandbox((sandbox) => {
      const home = join(sandbox, 'codex-home')
      const first = join(sandbox, 'first')
      const second = join(sandbox, 'second')
      mkdirSync(first, { recursive: true })
      mkdirSync(second, { recursive: true })
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.toml'), 'model = "test"\n', 'utf8')
      vi.stubEnv('CODEX_HOME', home)

      agentsInstall(first, 'codex')
      agentsInstall(second, 'codex')
      let config = readFileSync(join(home, 'config.toml'), 'utf8')
      expect(config).toContain('model = "test"')
      expect(isMadarCodexMcpConfig(config, first)).toBe(true)
      expect(isMadarCodexMcpConfig(config, second)).toBe(true)

      agentsUninstall(first, 'codex')
      config = readFileSync(join(home, 'config.toml'), 'utf8')
      expect(isMadarCodexMcpConfig(config, first)).toBe(false)
      expect(isMadarCodexMcpConfig(config, second)).toBe(true)
      agentsUninstall(second, 'codex')
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "test"\n')
    })
  })

  it('keeps Claude user hooks, settings, and documentation across repeated install and uninstall', () => {
    inSandbox((project) => {
      writeFileSync(
        join(project, 'CLAUDE.md'),
        '# Project\n\nKeep this.\n\n## madar\n\nold guidance\n\n## Next\n\nKeep this too.\n',
      )
      const userPromptHook = {
        name: 'user',
        source: 'user',
        hooks: [{ type: 'command', command: 'node user-prompt.cjs' }],
      }
      const userPreToolHook = {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node user-pre-tool.cjs' }],
      }
      writeJson(join(project, '.claude', 'settings.json'), {
        theme: 'dark',
        hooks: {
          UserPromptSubmit: [
            userPromptHook,
            {
              name: 'madar',
              source: 'madar',
              hooks: [{ type: 'command', command: 'node old-madar.cjs' }],
            },
          ],
          PreToolUse: [
            userPreToolHook,
            {
              name: 'madar',
              source: 'madar',
              matcher: 'Glob|Grep|Bash|Agent|Read',
              hooks: [{ type: 'command', command: 'node legacy-madar.cjs' }],
            },
          ],
        },
        mcpServers: {
          other: { command: 'other-server' },
          madar: { command: 'legacy-madar' },
        },
      })

      claudeInstall(project)
      claudeInstall(project)

      const installed = readJson(join(project, '.claude', 'settings.json'))
      expect(installed.theme).toBe('dark')
      expect(installed.hooks.UserPromptSubmit).toHaveLength(2)
      expect(installed.hooks.UserPromptSubmit).toContainEqual(userPromptHook)
      expect(installed.hooks.UserPromptSubmit.filter(
        (hook: unknown) => isMadarProjectHook(hook),
      )).toHaveLength(1)
      expect(installed.hooks.PreToolUse).toEqual([userPreToolHook])
      expect(installed.mcpServers).toEqual({ other: { command: 'other-server' } })
      expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8').match(/## madar/g))
        .toHaveLength(1)

      claudeUninstall(project)
      const afterFirstUninstall = readFileSync(
        join(project, '.claude', 'settings.json'),
        'utf8',
      )
      claudeUninstall(project)
      expect(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'))
        .toBe(afterFirstUninstall)
      expect(readJson(join(project, '.claude', 'settings.json'))).toEqual({
        theme: 'dark',
        hooks: {
          UserPromptSubmit: [userPromptHook],
          PreToolUse: [userPreToolHook],
        },
        mcpServers: { other: { command: 'other-server' } },
      })
      expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe(
        '# Project\n\nKeep this.\n\n## Next\n\nKeep this too.\n',
      )
    })
  })

  it('preserves OpenCode JSONC comments and user config through idempotent lifecycle', () => {
    inSandbox((sandbox) => {
      const project = join(sandbox, 'project')
      const root = packageRoot(sandbox)
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'AGENTS.md'), '# Project\n\nKeep this.\n')
      writeFileSync(
        join(project, 'opencode.jsonc'),
        `{
  // user settings must survive
  "plugin": [
    "file:///user-plugin.js",
  ],
  "mcp": {
    "other": { "type": "remote", "url": "https://example.test/mcp" },
    "madar": {
      "type": "local",
      "command": ["old-madar"],
      "environment": {
        "HTTP_PROXY": "http://proxy.test",
        "MADAR_TOOL_PROFILE": "strict",
      },
      "enabled": false,
    },
  },
  "theme": "midnight",
}
`,
      )

      agentsInstall(project, 'opencode', { packageRoot: root })
      agentsInstall(project, 'opencode', { packageRoot: root })

      const installedText = readFileSync(join(project, 'opencode.jsonc'), 'utf8')
      const installed = readOpencodeConfig(join(project, 'opencode.jsonc'))
      expect(installedText).toContain('// user settings must survive')
      expect(installed.plugin).toEqual([
        'file:///user-plugin.js',
        '.opencode/plugins/madar.js',
      ])
      expect(installed.mcp).toMatchObject({
        other: { type: 'remote', url: 'https://example.test/mcp' },
        madar: {
          type: 'local',
          environment: { HTTP_PROXY: 'http://proxy.test' },
          enabled: true,
        },
      })
      expect(JSON.stringify(installed.mcp)).not.toContain('MADAR_TOOL_PROFILE')
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8').match(/## madar/g))
        .toHaveLength(1)

      agentsUninstall(project, 'opencode')
      const afterFirstUninstall = readFileSync(join(project, 'opencode.jsonc'), 'utf8')
      agentsUninstall(project, 'opencode')
      expect(readFileSync(join(project, 'opencode.jsonc'), 'utf8'))
        .toBe(afterFirstUninstall)
      expect(afterFirstUninstall).toContain('// user settings must survive')
      expect(readOpencodeConfig(join(project, 'opencode.jsonc'))).toEqual({
        plugin: ['file:///user-plugin.js'],
        mcp: {
          other: { type: 'remote', url: 'https://example.test/mcp' },
        },
        theme: 'midnight',
      })
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8'))
        .toBe('# Project\n\nKeep this.\n')
      expect(existsSync(join(project, '.opencode', 'plugins', 'madar.js')))
        .toBe(false)
    })
  })

  it('rejects user-owned Codex hook scripts and malformed managed blocks before mutation', () => {
    inSandbox((sandbox) => {
      const project = join(sandbox, 'project')
      const home = join(sandbox, 'codex-home')
      const script = join(project, '.codex', 'madar-user-prompt-submit.cjs')
      mkdirSync(join(project, '.codex'), { recursive: true })
      writeFileSync(join(project, 'AGENTS.md'), '# Existing\n')
      writeFileSync(script, 'console.log("user-owned")\n')
      vi.stubEnv('CODEX_HOME', home)

      expect(() => agentsInstall(project, 'codex')).toThrow(
        'Refusing to overwrite user-managed Codex hook script',
      )
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('# Existing\n')
      expect(existsSync(join(home, 'config.toml'))).toBe(false)

      writeFileSync(
        script,
        '// madar managed Codex UserPromptSubmit hook\nconsole.log("old")\n',
      )
      agentsInstall(project, 'codex')
      expect(hasManagedCodexPromptHookScript(script)).toBe(true)
      const configPath = join(home, 'config.toml')
      const validConfig = readFileSync(configPath, 'utf8')
      const malformedConfig = validConfig.replace(
        /^# <<< madar managed mcp:.*$/m,
        '# missing managed end marker',
      )
      writeFileSync(configPath, malformedConfig)
      const instructionsBeforeFailure = readFileSync(join(project, 'AGENTS.md'), 'utf8')

      expect(() => agentsInstall(project, 'codex')).toThrow(
        'Malformed Codex Madar MCP marker block',
      )
      expect(readFileSync(configPath, 'utf8')).toBe(malformedConfig)
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8'))
        .toBe(instructionsBeforeFailure)
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)
    })
  })

  it.each([
    ['claude', '.mcp.json', () => claudeInstall],
    ['cursor', join('.cursor', 'mcp.json'), () => cursorInstall],
    ['gemini', join('.gemini', 'settings.json'), () => geminiInstall],
  ] as const)('fails loudly for malformed %s JSON without replacing it', (
    _platform,
    relativePath,
    operation,
  ) => {
    inSandbox((project) => {
      const path = join(project, relativePath)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '{ broken', 'utf8')
      expect(() => operation()(project)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe('{ broken')
    })
  })
})
