import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'

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
  installCopilotMcp,
  installSkill,
  isAgentPlatform,
  isInstallPlatform,
  uninstallCopilotMcp,
  uninstallSkill,
} from '../../src/infrastructure/install.js'
import { normalizeAssertionPath } from './helpers/platform.js'

const PACKAGE_CLI_RELATIVE_PATH = join('dist', 'src', 'cli', 'bin.js')

const BUNDLED_ASSET_CONTENT = {
  'skill.md': '# graphify-ts\n\nLocal bundled Claude skill\n',
  'skill-aider.md': '# graphify-ts\n\nAider bundled skill.\n',
  'skill-codex.md': '# graphify-ts\n\nUse spawn_agent for Codex installs.\n',
  'skill-copilot.md': '# graphify-ts\n\nGitHub Copilot bundled skill.\n',
  'skill-opencode.md': '# graphify-ts\n\nUse @mention syntax for OpenCode installs.\n',
  'skill-claw.md': '# graphify-ts\n\nSequential execution guidance for Claw installs.\n',
  'skill-droid.md': '# graphify-ts\n\nFactory Droid bundled skill.\n',
  'skill-trae.md': '# graphify-ts\n\nTrae bundled skill.\n',
  'skill-windows.md': '# graphify-ts\n\nWindows bundled skill.\n',
} as const

interface OpenCodeConfig {
  shell?: string
  plugin?: string[]
  mcp?: {
    [name: string]:
      | {
          type?: string
          command?: string[]
          enabled?: boolean
          environment?: Record<string, string>
          url?: string
        }
      | undefined
    graphify?: {
      type?: string
      command?: string[]
      enabled?: boolean
      environment?: Record<string, string>
    }
    other?: {
      type?: string
      command?: string[]
      enabled?: boolean
      environment?: Record<string, string>
      url?: string
    }
  }
}

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-install-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function withBundledPackageRoot(callback: (packageRoot: string) => void): void {
  withTempDir((packageRoot) => {
    mkdirSync(join(packageRoot, 'assets', 'skills'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', version: '0.1.0' }), 'utf8')

    for (const [fileName, content] of Object.entries(BUNDLED_ASSET_CONTENT)) {
      writeFileSync(join(packageRoot, 'assets', 'skills', fileName), content, 'utf8')
    }

    callback(packageRoot)
  })
}

function withOpenCodePackageRoot(callback: (packageRoot: string, cliPath: string) => void): void {
  withTempDir((packageRoot) => {
    const cliPath = join(packageRoot, PACKAGE_CLI_RELATIVE_PATH)
    mkdirSync(join(packageRoot, 'dist', 'src', 'cli'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', bin: { 'graphify-ts': PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')
    writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8')

    callback(packageRoot, cliPath)
  })
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0
  }

  return content.split(needle).length - 1
}

function readJsoncConfig(filePath: string): OpenCodeConfig {
  const parsed = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, 'utf8'))
  if (parsed.error) {
    throw new Error(String(parsed.error.messageText))
  }
  return parsed.config as OpenCodeConfig
}

function decodeHookPayloads(content: string): string {
  return [...content.matchAll(/'([A-Za-z0-9+/=]{40,})'/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string')
    .map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
    .join('\n')
}

describe('install helpers', () => {
  it('chooses the default platform from the host OS', () => {
    expect(defaultInstallPlatform('win32')).toBe('windows')
    expect(defaultInstallPlatform('darwin')).toBe('claude')
  })

  it('recognizes aider and copilot install platforms and treats aider as an agent platform', () => {
    expect(isInstallPlatform('aider')).toBe(true)
    expect(isInstallPlatform('copilot')).toBe(true)
    expect(isInstallPlatform('gemini')).toBe(true)
    expect(isInstallPlatform('cursor')).toBe(true)
    expect(isAgentPlatform('aider')).toBe(true)
    expect(isAgentPlatform('copilot')).toBe(false)
    expect(isAgentPlatform('gemini')).toBe(false)
    expect(isAgentPlatform('cursor')).toBe(false)
  })

  it('installs skills into the expected home-directory locations', () => {
    const expectedPaths = {
      claude: '.claude/skills/graphify-ts/SKILL.md',
      gemini: '.gemini/skills/graphify-ts/SKILL.md',
      aider: '.aider/graphify-ts/SKILL.md',
      codex: '.agents/skills/graphify-ts/SKILL.md',
      copilot: '.copilot/skills/graphify-ts/SKILL.md',
      opencode: '.config/opencode/skills/graphify-ts/SKILL.md',
      claw: '.claw/skills/graphify-ts/SKILL.md',
      droid: '.factory/skills/graphify-ts/SKILL.md',
      trae: '.trae/skills/graphify-ts/SKILL.md',
      'trae-cn': '.trae-cn/skills/graphify-ts/SKILL.md',
      windows: '.claude/skills/graphify-ts/SKILL.md',
    } as const

    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        for (const [platform, relativePath] of Object.entries(expectedPaths)) {
          installSkill(platform as keyof typeof expectedPaths, { homeDir, packageRoot, version: 'test-version' })
          expect(existsSync(join(homeDir, relativePath))).toBe(true)
          expect(readFileSync(join(homeDir, relativePath.replace('SKILL.md', '.graphify_version')), 'utf8')).toBe('test-version')
        }
      })
    })
  })

  it('registers CLAUDE.md for claude installs but not codex installs', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })
        expect(existsSync(join(homeDir, '.claude', 'CLAUDE.md'))).toBe(true)

        const secondHome = join(homeDir, 'other-home')
        installSkill('codex', { homeDir: secondHome, packageRoot, version: 'test-version' })
        expect(existsSync(join(secondHome, '.claude', 'CLAUDE.md'))).toBe(false)
      })
    })
  })

  it('does not duplicate the home CLAUDE.md registration when claude skill install runs twice', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })
        const firstClaudeMd = readFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        const secondClaudeMd = readFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')
        expect(secondClaudeMd).toBe(firstClaudeMd)
        expect(countOccurrences(secondClaudeMd, '- **graphify-ts**')).toBe(1)
      })
    })
  })

  it('copies the expected skill content variants', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('aider', { homeDir, packageRoot, version: 'test-version' })
        installSkill('gemini', { homeDir, packageRoot, version: 'test-version' })
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })
        installSkill('opencode', { homeDir, packageRoot, version: 'test-version' })
        installSkill('claw', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.aider', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Aider bundled skill')
        expect(readFileSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
        expect(readFileSync(join(homeDir, '.agents', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('spawn_agent')
        expect(readFileSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('GitHub Copilot bundled skill')
        expect(readFileSync(join(homeDir, '.config', 'opencode', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('@mention')
        expect(readFileSync(join(homeDir, '.claw', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8').toLowerCase()).toContain('sequential')
      })
    })
  })

  it('installs from bundled local assets without needing the Python reference checkout', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        expect(existsSync(join(packageRoot, 'graphify'))).toBe(false)

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.claude', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
      })
    })
  })

  it('falls back to built-in templates when package assets are unavailable', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', version: '0.1.0' }), 'utf8')

      withTempDir((homeDir) => {
        installSkill('gemini', { homeDir, packageRoot, version: 'test-version' })
        installSkill('aider', { homeDir, packageRoot, version: 'test-version' })
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })

        const geminiSkill = readFileSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        const aiderSkill = readFileSync(join(homeDir, '.aider', 'graphify-ts', 'SKILL.md'), 'utf8')
        const installedSkill = readFileSync(join(homeDir, '.agents', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        const copilotSkill = readFileSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        expect(geminiSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(geminiSkill).toContain('# /graphify-ts')
        expect(aiderSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(aiderSkill).toContain('Aider')
        expect(installedSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(installedSkill).toContain('spawn_agent')
        expect(installedSkill).toContain('# /graphify-ts')
        expect(installedSkill).toContain('## Honesty Rules')
        expect(installedSkill).toContain('code/docs/papers/images/audio/video counts')
        expect(installedSkill).toContain('"schema_version":2')
        expect(installedSkill).toContain('"file_type":"code|document|paper|image|audio|video|rationale"')
        expect(installedSkill).toContain('"provenance":[{"capability_id":"')
        expect(installedSkill).toContain('local audio/video, plus direct audio/video URL ingests that download into the same hidden-sidecar path, currently land as deterministic file nodes only')
        expect(installedSkill).toContain('```bash')
        expect(installedSkill.length).toBeGreaterThan(1000)
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_BLOCK_START]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_BLOCK_END]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_SPAN_START]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_SPAN_END]]]')
        expect(installedSkill).not.toContain('\u0000')
        expect(installedSkill).not.toContain('python3 -c')
        expect(installedSkill).not.toContain('graphifyy')
        expect(installedSkill).not.toContain('from graphify.')
        expect(copilotSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(copilotSkill).toContain('# /graphify-ts')
      })
    })
  })

  it('uninstalls copilot skills from the home-directory location', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(true)

        const message = uninstallSkill('copilot', { homeDir })

        expect(message).toContain('skill removed')
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(false)
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', '.graphify_version'))).toBe(false)
      })
    })
  })

  it('writes and removes local Gemini project instructions, hook config, and home skill', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((projectDir) => {
          const installMessage = geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })
          expect(installMessage).toContain('GEMINI.md')
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(true)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(true)
          expect(existsSync(join(projectDir, '.gemini', 'settings.json'))).toBe(true)
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('retrieve')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('relevant_files')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('feature_map')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('risk_map')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('implementation_checklist')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('impact')
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).toContain('graphify-out')

          const uninstallMessage = geminiUninstall(projectDir, { homeDir })
          expect(uninstallMessage).toMatch(/graphify-ts section removed|GEMINI\.md was empty after removal/)
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(false)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(false)
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).not.toContain('graphify-out')
        })
      })
    })
  })

  it('keeps Gemini project instructions and hooks idempotent across repeated installs', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((projectDir) => {
          geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })
          const firstGeminiMd = readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')
          const firstSettings = readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')

          geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })

          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toBe(firstGeminiMd)
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).toBe(firstSettings)
          expect(countOccurrences(firstGeminiMd, '## graphify-ts')).toBe(1)
          expect(countOccurrences(firstSettings, 'graphify-out')).toBeGreaterThan(0)
        })
      })
    })
  })

  it('fails loudly for malformed existing Gemini JSON config files', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.gemini', 'settings.json')
      mkdirSync(join(projectDir, '.gemini'), { recursive: true })
      writeFileSync(settingsPath, '{ not valid json', 'utf8')

      expect(() => geminiInstall(projectDir)).toThrow(`Failed to parse ${settingsPath}`)
    })
  })

  it('writes and removes the local Cursor rule file', () => {
    withTempDir((projectDir) => {
      const installMessage = cursorInstall(projectDir)
      expect(normalizeAssertionPath(installMessage)).toContain('.cursor/rules/graphify-ts.mdc')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'))).toBe(true)
      expect(readFileSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'), 'utf8')).toContain('alwaysApply: true')

      const uninstallMessage = cursorUninstall(projectDir)
      expect(uninstallMessage).toContain('removed')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'))).toBe(false)
    })
  })

  it('writes and removes local Claude project instructions', () => {
    withTempDir((projectDir) => {
      const installMessage = claudeInstall(projectDir)
      expect(installMessage).toContain('CLAUDE.md')
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).not.toContain('python3 -c')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('retrieve')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('relevant_files')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('feature_map')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('risk_map')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('implementation_checklist')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('impact')

      const uninstallMessage = claudeUninstall(projectDir)
      expect(uninstallMessage).toMatch(/graphify-ts section removed|CLAUDE\.md was empty after removal/)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    })
  })

  it('pins the Claude MCP server package to the installed graphify-ts version', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'graphify-ts'?: {
            args?: string[]
          }
        }
      }
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

      expect(mcpConfig.mcpServers?.['graphify-ts']?.args?.[1]).toBe(`@mohammednagy/graphify-ts@${packageJson.version}`)
    })
  })

  it('writes GRAPHIFY_TOOL_PROFILE=core in the generated Claude .mcp.json env block', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'graphify-ts'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['graphify-ts']?.env).toBeDefined()
      expect(mcpConfig.mcpServers?.['graphify-ts']?.env?.GRAPHIFY_TOOL_PROFILE).toBe('core')
    })
  })

  it('writes GRAPHIFY_TOOL_PROFILE=full when the Claude installer opts into the full MCP profile', () => {
    withTempDir((projectDir) => {
      const installClaudeWithProfile = claudeInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' }) => string
      installClaudeWithProfile(projectDir, { profile: 'full' })

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'graphify-ts'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['graphify-ts']?.env?.GRAPHIFY_TOOL_PROFILE).toBe('full')
    })
  })

  it('writes GRAPHIFY_TOOL_PROFILE=core in the generated Cursor .cursor/mcp.json env block', () => {
    withTempDir((projectDir) => {
      cursorInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers?: {
          'graphify-ts'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['graphify-ts']?.env?.GRAPHIFY_TOOL_PROFILE).toBe('core')
    })
  })

  it('preserves a user-customized GRAPHIFY_TOOL_PROFILE=full when re-running claude install', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      // Simulate a user opting into the legacy 21-tool surface plus an unrelated env entry.
      const mcpJsonPath = join(projectDir, '.mcp.json')
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers: { 'graphify-ts': { env: Record<string, string> } }
      }
      mcpConfig.mcpServers['graphify-ts'].env.GRAPHIFY_TOOL_PROFILE = 'full'
      mcpConfig.mcpServers['graphify-ts'].env.HTTP_PROXY = 'http://corp.example:8080'
      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8')

      claudeInstall(projectDir)

      const reinstalled = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers: { 'graphify-ts': { env: Record<string, string> } }
      }
      expect(reinstalled.mcpServers['graphify-ts'].env.GRAPHIFY_TOOL_PROFILE).toBe('full')
      expect(reinstalled.mcpServers['graphify-ts'].env.HTTP_PROXY).toBe('http://corp.example:8080')
    })
  })

  it('writes GRAPHIFY_TOOL_PROFILE=core in the generated VS Code Copilot .vscode/mcp.json env block', () => {
    withTempDir((projectDir) => {
      installCopilotMcp(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
        servers?: {
          'graphify-ts'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.servers?.['graphify-ts']?.env?.GRAPHIFY_TOOL_PROFILE).toBe('core')
    })
  })

  it('writes GRAPHIFY_TOOL_PROFILE=full when the VS Code Copilot installer opts into the full MCP profile', () => {
    withTempDir((projectDir) => {
      const installCopilotWithProfile = installCopilotMcp as (projectDir?: string, options?: { profile?: 'core' | 'full' }) => string
      installCopilotWithProfile(projectDir, { profile: 'full' })

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
        servers?: {
          'graphify-ts'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.servers?.['graphify-ts']?.env?.GRAPHIFY_TOOL_PROFILE).toBe('full')
    })
  })

  it('removes the VS Code Copilot MCP server while preserving unrelated workspace entries', () => {
    withTempDir((projectDir) => {
      installCopilotMcp(projectDir)

      const mcpPath = join(projectDir, '.vscode', 'mcp.json')
      const config = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        servers?: Record<string, Record<string, unknown>>
      }
      config.servers = {
        ...config.servers,
        companion: {
          command: 'node',
          args: ['companion.js'],
        },
      }
      writeFileSync(mcpPath, JSON.stringify(config, null, 2), 'utf8')

      uninstallCopilotMcp(projectDir)

      const uninstalled = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        servers?: Record<string, Record<string, unknown>>
      }
      expect(uninstalled.servers?.['graphify-ts']).toBeUndefined()
      expect(uninstalled.servers?.companion).toEqual({
        command: 'node',
        args: ['companion.js'],
      })
    })
  })

  it('keeps Claude project instructions and hooks idempotent across repeated installs', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const firstClaudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
      const firstSettings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')

      claudeInstall(projectDir)

      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(firstClaudeMd)
      expect(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')).toBe(firstSettings)
      expect(countOccurrences(firstClaudeMd, '## graphify-ts')).toBe(1)
      expect(countOccurrences(firstSettings, 'graphify-out')).toBeGreaterThan(0)
    })
  })

  it('fails loudly for malformed existing JSON config files', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.claude', 'settings.json')
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      writeFileSync(settingsPath, '{ not valid json', 'utf8')

      expect(() => claudeInstall(projectDir)).toThrow(`Failed to parse ${settingsPath}`)
    })
  })

  it('writes agents instructions and platform-specific plugin files', () => {
    withTempDir((projectDir) => {
      const aiderMessage = agentsInstall(projectDir, 'aider')
      const codexMessage = agentsInstall(projectDir, 'codex')
      expect(aiderMessage).toContain('AGENTS.md')
      expect(aiderMessage).toContain('Aider')
      expect(codexMessage).toContain('AGENTS.md')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## graphify-ts')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('python3 -c')
      expect(existsSync(join(projectDir, '.codex', 'hooks.json'))).toBe(true)

      withOpenCodePackageRoot((packageRoot, cliPath) => {
        const opencodeMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        expect(opencodeMessage).toMatch(/graphify-ts section (written|updated) in/)
        expect(opencodeMessage).toContain('opencode.json -> MCP server registered')
        expect(existsSync(join(projectDir, '.opencode', 'plugins', 'graphify-ts.js'))).toBe(true)
        expect(existsSync(join(projectDir, 'opencode.json'))).toBe(true)

        const opencodeConfig = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as OpenCodeConfig
        expect(opencodeConfig.plugin).toContain('.opencode/plugins/graphify-ts.js')
        expect(opencodeConfig.mcp?.graphify).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'graphify-out', 'graph.json')],
          enabled: true,
        })
      })
    })
  })

  it('writes Codex-specific context-pack-first guidance and uninstall behavior', () => {
    withTempDir((projectDir) => {
      const installMessage = agentsInstall(projectDir, 'codex')
      const agentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
      const codexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const decodedHookPayload = decodeHookPayloads(codexHooks)

      expect(installMessage).toContain('Codex')
      expect(installMessage).toContain('graphify-ts codex uninstall')
      expect(agentsMd).toContain('Codex CLI profile')
      expect(agentsMd).toContain('context-pack-first')
      expect(agentsMd).toContain('graphify-ts pack')
      expect(agentsMd).toContain('graphify-ts codex uninstall')
      expect(agentsMd).toContain('Manual verification')
      expect(decodedHookPayload).toContain('context-pack-first')
      expect(decodedHookPayload).toContain('graphify-ts pack')
    })
  })

  it('writes Aider-specific context-pack-first guidance and uninstall behavior', () => {
    withTempDir((projectDir) => {
      const installMessage = agentsInstall(projectDir, 'aider')
      const agentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')

      expect(installMessage).toContain('Aider')
      expect(installMessage).toContain('graphify-ts aider uninstall')
      expect(agentsMd).toContain('Aider profile')
      expect(agentsMd).toContain('context-pack-first')
      expect(agentsMd).toContain('graphify-ts pack')
      expect(agentsMd).toContain('graphify-ts aider uninstall')
      expect(agentsMd).toContain('Manual verification')
      expect(agentsMd).toContain('AGENTS.md')
    })
  })

  it('writes OpenCode-specific context-pack-first guidance and uninstall behavior', () => {
    withTempDir((projectDir) => {
      withOpenCodePackageRoot((packageRoot) => {
        const installMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        const agentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')

        expect(installMessage).toContain('OpenCode')
        expect(installMessage).toContain('graphify-ts opencode uninstall')
        expect(agentsMd).toContain('OpenCode profile')
        expect(agentsMd).toContain('context-pack-first')
        expect(agentsMd).toContain('graphify-ts pack')
        expect(agentsMd).toContain('graphify-ts opencode uninstall')
        expect(agentsMd).toContain('Manual verification')
        expect(agentsMd).toContain('.opencode/plugins/graphify-ts.js')
        expect(agentsMd).toContain('opencode.json')
      })
    })
  })

  it('updates existing Codex graphify hooks during reinstall', () => {
    withTempDir((projectDir) => {
      const stalePayload = JSON.stringify({
        systemMessage: 'Legacy graphify-out retrieve-first guidance',
      })
      const stalePayloadB64 = Buffer.from(stalePayload).toString('base64')

      mkdirSync(join(projectDir, '.codex'), { recursive: true })
      writeFileSync(
        join(projectDir, '.codex', 'hooks.json'),
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "require('fs').accessSync('graphify-out/graph.json');process.stdout.write(Buffer.from('${stalePayloadB64}','base64').toString())"`,
                    },
                  ],
                },
                {
                  matcher: 'Read',
                  hooks: [{ type: 'command', command: 'echo keep-me' }],
                },
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "require('fs').appendFileSync('graphify-out/custom.log','custom')"`,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      )

      const installMessage = agentsInstall(projectDir, 'codex')
      const codexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const decodedHookPayload = decodeHookPayloads(codexHooks)

      expect(installMessage).toContain('.codex/hooks.json -> hook updated')
      expect(codexHooks).toContain('keep-me')
      expect(codexHooks).toContain('custom.log')
      expect(decodedHookPayload).toContain('context-pack-first')
      expect(decodedHookPayload).toContain('graphify-ts pack')
      expect(decodedHookPayload).not.toContain('Legacy graphify-out retrieve-first guidance')
    })
  })

  it('preserves unrelated OpenCode config while updating graphify MCP', () => {
    withTempDir((projectDir) => {
      writeFileSync(
        join(projectDir, 'opencode.json'),
        JSON.stringify(
          {
            plugin: ['custom-plugin'],
            mcp: {
              other: { type: 'remote', url: 'https://example.com/mcp' },
              graphify: {
                type: 'local',
                command: ['old-command'],
                environment: { HTTP_PROXY: 'http://proxy.example' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      )

      withOpenCodePackageRoot((packageRoot, cliPath) => {
        const installMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        const opencodeConfig = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as OpenCodeConfig

        expect(installMessage).toContain('opencode.json -> MCP server updated')
        expect(opencodeConfig.plugin).toEqual(['custom-plugin', '.opencode/plugins/graphify-ts.js'])
        expect(opencodeConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
        expect(opencodeConfig.mcp?.graphify).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'graphify-out', 'graph.json')],
          enabled: true,
          environment: { HTTP_PROXY: 'http://proxy.example' },
        })
      })
    })
  })

  it('fails OpenCode install when the resolved package CLI is missing', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', bin: { 'graphify-ts': PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')

      withTempDir((projectDir) => {
        expect(() => agentsInstall(projectDir, 'opencode', { packageRoot })).toThrow(
          `Could not locate graphify-ts CLI at ${join(packageRoot, PACKAGE_CLI_RELATIVE_PATH)} declared by ${join(packageRoot, 'package.json')}`,
        )
      })
    })
  })

  it('uses an existing OpenCode JSONC config instead of creating duplicate JSON config', () => {
    withTempDir((projectDir) => {
      writeFileSync(
        join(projectDir, 'opencode.jsonc'),
        `{
          // Existing project-specific OpenCode config.
          "plugin": ["custom-plugin",],
          "mcp": {
            "other": { "type": "remote", "url": "https://example.com/mcp", },
          },
        }
        `,
        'utf8',
      )

      withOpenCodePackageRoot((packageRoot, cliPath) => {
        const installMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        const installedContent = readFileSync(join(projectDir, 'opencode.jsonc'), 'utf8')
        const installedConfig = readJsoncConfig(join(projectDir, 'opencode.jsonc'))

        expect(installMessage).toContain('opencode.jsonc -> plugin registered')
        expect(installMessage).toContain('opencode.jsonc -> MCP server registered')
        expect(existsSync(join(projectDir, 'opencode.json'))).toBe(false)
        expect(installedContent).toContain('// Existing project-specific OpenCode config.')
        expect(installedContent).toContain('"plugin": ["custom-plugin", ".opencode/plugins/graphify-ts.js",]')
        expect(installedContent).toContain('"other": { "type": "remote", "url": "https://example.com/mcp", },')
        expect(installedConfig.plugin).toEqual(['custom-plugin', '.opencode/plugins/graphify-ts.js'])
        expect(installedConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
        expect(installedConfig.mcp?.graphify).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'graphify-out', 'graph.json')],
          enabled: true,
        })

        const reinstallMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        expect(reinstallMessage).toContain('opencode.jsonc -> plugin already registered (no change)')
        expect(readFileSync(join(projectDir, 'opencode.jsonc'), 'utf8')).toBe(installedContent)

        const uninstallMessage = agentsUninstall(projectDir, 'opencode')
        const uninstalledContent = readFileSync(join(projectDir, 'opencode.jsonc'), 'utf8')
        const uninstalledConfig = readJsoncConfig(join(projectDir, 'opencode.jsonc'))

        expect(uninstallMessage).toContain('opencode.jsonc -> plugin deregistered')
        expect(uninstallMessage).toContain('opencode.jsonc -> MCP server removed')
        expect(existsSync(join(projectDir, 'opencode.json'))).toBe(false)
        expect(uninstalledContent).toContain('// Existing project-specific OpenCode config.')
        expect(uninstalledConfig.plugin).toEqual(['custom-plugin'])
        expect(uninstalledConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
        expect(uninstalledConfig.mcp?.graphify).toBeUndefined()
      })
    })
  })

  it('uninstalls OpenCode plugin and MCP config while preserving unrelated config', () => {
    withTempDir((projectDir) => {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing rules\n\nKeep calm.\n', 'utf8')
      writeFileSync(
        join(projectDir, 'opencode.json'),
        JSON.stringify(
          {
            shell: '/bin/zsh',
            plugin: ['custom-plugin'],
            mcp: { other: { type: 'remote', url: 'https://example.com/mcp' } },
          },
          null,
          2,
        ),
        'utf8',
      )
      withOpenCodePackageRoot((packageRoot) => {
        agentsInstall(projectDir, 'opencode', { packageRoot })
      })

      const uninstallMessage = agentsUninstall(projectDir, 'opencode')
      const opencodeConfig = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as OpenCodeConfig

      expect(uninstallMessage).toContain('opencode.json -> plugin deregistered')
      expect(uninstallMessage).toContain('opencode.json -> MCP server removed')
      expect(existsSync(join(projectDir, '.opencode', 'plugins', 'graphify-ts.js'))).toBe(false)
      expect(opencodeConfig.shell).toBe('/bin/zsh')
      expect(opencodeConfig.plugin).toEqual(['custom-plugin'])
      expect(opencodeConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
      expect(opencodeConfig.mcp?.graphify).toBeUndefined()
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Keep calm.')
    })
  })

  it('keeps codex and opencode project integrations idempotent across repeated installs', () => {
    withTempDir((projectDir) => {
      withOpenCodePackageRoot((packageRoot) => {
        agentsInstall(projectDir, 'codex')
        agentsInstall(projectDir, 'opencode', { packageRoot })
        const firstAgentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
        const firstCodexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
        const firstOpenCodeConfig = readFileSync(join(projectDir, 'opencode.json'), 'utf8')

        agentsInstall(projectDir, 'codex')
        agentsInstall(projectDir, 'opencode', { packageRoot })

        expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toBe(firstAgentsMd)
        expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).toBe(firstCodexHooks)
        expect(readFileSync(join(projectDir, 'opencode.json'), 'utf8')).toBe(firstOpenCodeConfig)
        expect(countOccurrences(firstAgentsMd, '## graphify-ts')).toBe(1)
        expect(countOccurrences(firstCodexHooks, 'graphify-out')).toBeGreaterThan(0)
        expect(countOccurrences(firstOpenCodeConfig, '.opencode/plugins/graphify-ts.js')).toBe(1)
      })
    })
  })

  it('uninstalls agent/project config while preserving unrelated content', () => {
    withTempDir((projectDir) => {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing rules\n\nKeep calm.\n', 'utf8')
      agentsInstall(projectDir, 'codex')
      const uninstallMessage = agentsUninstall(projectDir, 'codex')

      expect(uninstallMessage).toContain('graphify-ts section removed')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Keep calm.')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('## graphify-ts')
      expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).not.toContain('graphify-ts')
    })
  })
})
