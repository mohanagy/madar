import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const PACKAGE_CLI_RELATIVE_PATH = join('dist', 'src', 'cli', 'bin.js')
const STRICT_STOP_RULE_MD =
  'Answer after one high- or medium-confidence pack when `diagnostics.quality_score >= 0.5`, `missing_context` is empty, and diagnostics show no error-severity gaps.'
const STRICT_EXPAND_RULE_MD =
  'Only expand with `context_expand` or focused graph/search tools when `missing_context` / `missing_semantic` are non-empty, diagnostics show warn/error gaps, or the user asks for deeper verification.'
const STRICT_STOP_RULE_PLAIN =
  'answer after one high- or medium-confidence pack when diagnostics.quality_score >= 0.5, missing_context is empty, and diagnostics show no error-severity gaps'
const STRICT_EXPAND_RULE_PLAIN =
  'expand only when missing_context / missing_semantic is non-empty, diagnostics show warn/error gaps, or the user asks for deeper verification'

const BUNDLED_ASSET_CONTENT = {
  'skill.md': '# madar\n\nLocal bundled Claude skill\n',
  'skill-aider.md': '# madar\n\nAider bundled skill.\n',
  'skill-codex.md': '# madar\n\nUse spawn_agent for Codex installs.\n',
  'skill-copilot.md': '# madar\n\nGitHub Copilot bundled skill.\n',
  'skill-opencode.md': '# madar\n\nUse @mention syntax for OpenCode installs.\n',
  'skill-claw.md': '# madar\n\nSequential execution guidance for Claw installs.\n',
  'skill-droid.md': '# madar\n\nFactory Droid bundled skill.\n',
  'skill-trae.md': '# madar\n\nTrae bundled skill.\n',
  'skill-windows.md': '# madar\n\nWindows bundled skill.\n',
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
    madar?: {
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
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-install-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function withBundledPackageRoot(callback: (packageRoot: string) => void): void {
  withTempDir((packageRoot) => {
    mkdirSync(join(packageRoot, 'assets', 'skills'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', version: '0.1.0' }), 'utf8')

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
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', bin: { 'madar': PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')
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
  const decodedPayloads: string[] = []
  const seen = new Set<string>()
  const queue = [content]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    for (const match of current.matchAll(/'([A-Za-z0-9+/=]{40,})'/g)) {
      const value = match[1]
      if (typeof value !== 'string' || seen.has(value)) {
        continue
      }

      seen.add(value)
      const decoded = Buffer.from(value, 'base64').toString('utf8')
      decodedPayloads.push(decoded)
      queue.push(decoded)
    }
  }

  return decodedPayloads.join('\n')
}

function extractHookCommand(settingsJson: string, eventName: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  return parsed.hooks?.[eventName]?.[0]?.hooks?.[0]?.command ?? ''
}

function shellCommandForPlatform(
  platform: NodeJS.Platform,
  command: string,
): { command: string; args: string[]; cleanupPath?: string } {
  if (platform === 'win32') {
    const scriptDir = mkdtempSync(join(tmpdir(), 'madar-hook-'))
    const scriptPath = join(scriptDir, 'run-hook.cmd')
    writeFileSync(scriptPath, `@echo off\r\n${command}\r\n`, 'utf8')

    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', scriptPath],
      cleanupPath: scriptPath,
    }
  }

  return {
    command: '/bin/sh',
    args: ['-lc', command],
  }
}

function runHookCommand(
  command: string,
  cwd: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): string {
  const shell = shellCommandForPlatform(process.platform, command)
  try {
    const result = spawnSync(shell.command, shell.args, {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })

    if (result.status !== 0) {
      throw new Error(result.stderr || `hook command failed with exit code ${result.status ?? 'unknown'}`)
    }

    return result.stdout
  } finally {
    if (shell.cleanupPath) {
      rmSync(shell.cleanupPath, { force: true })
      rmSync(dirname(shell.cleanupPath), { recursive: true, force: true })
    }
  }
}

describe('install helpers', () => {
  it('chooses a platform-appropriate shell for generated hook commands', () => {
    expect(shellCommandForPlatform('darwin', 'node -e "console.log(1)"')).toEqual({
      command: '/bin/sh',
      args: ['-lc', 'node -e "console.log(1)"'],
    })
  })

  it('wraps Windows hook commands in a cmd script to avoid command-length limits', () => {
    const longCommand = `node -e "${'console.log(1);'.repeat(1200)}"`
    const shell = shellCommandForPlatform('win32', longCommand)

    try {
      expect(shell.command).toBe(process.env.ComSpec ?? 'cmd.exe')
      expect(shell.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      const scriptPath = shell.args[3]
      expect(scriptPath).toBeDefined()
      if (!scriptPath) {
        throw new Error('missing Windows hook script path')
      }

      expect(scriptPath).toMatch(/\.cmd$/i)
      expect(scriptPath).not.toContain('console.log(1);')
      expect(readFileSync(scriptPath, 'utf8')).toContain(longCommand)
    } finally {
      const scriptPath = shell.args[3]
      if (scriptPath) {
        rmSync(scriptPath, { force: true })
        rmSync(dirname(scriptPath), { recursive: true, force: true })
      }
    }
  })

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
      claude: '.claude/skills/madar/SKILL.md',
      gemini: '.gemini/skills/madar/SKILL.md',
      aider: '.aider/madar/SKILL.md',
      codex: '.agents/skills/madar/SKILL.md',
      copilot: '.copilot/skills/madar/SKILL.md',
      opencode: '.config/opencode/skills/madar/SKILL.md',
      claw: '.claw/skills/madar/SKILL.md',
      droid: '.factory/skills/madar/SKILL.md',
      trae: '.trae/skills/madar/SKILL.md',
      'trae-cn': '.trae-cn/skills/madar/SKILL.md',
      windows: '.claude/skills/madar/SKILL.md',
    } as const

    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        for (const [platform, relativePath] of Object.entries(expectedPaths)) {
          installSkill(platform as keyof typeof expectedPaths, { homeDir, packageRoot, version: 'test-version' })
          expect(existsSync(join(homeDir, relativePath))).toBe(true)
          expect(readFileSync(join(homeDir, relativePath.replace('SKILL.md', '.madar_version')), 'utf8')).toBe('test-version')
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
        expect(countOccurrences(secondClaudeMd, '- **madar**')).toBe(1)
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

        expect(readFileSync(join(homeDir, '.aider', 'madar', 'SKILL.md'), 'utf8')).toContain('Aider bundled skill')
        expect(readFileSync(join(homeDir, '.gemini', 'skills', 'madar', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
        expect(readFileSync(join(homeDir, '.agents', 'skills', 'madar', 'SKILL.md'), 'utf8')).toContain('spawn_agent')
        expect(readFileSync(join(homeDir, '.copilot', 'skills', 'madar', 'SKILL.md'), 'utf8')).toContain('GitHub Copilot bundled skill')
        expect(readFileSync(join(homeDir, '.config', 'opencode', 'skills', 'madar', 'SKILL.md'), 'utf8')).toContain('@mention')
        expect(readFileSync(join(homeDir, '.claw', 'skills', 'madar', 'SKILL.md'), 'utf8').toLowerCase()).toContain('sequential')
      })
    })
  })

  it('installs from bundled local assets without needing the Python reference checkout', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        expect(existsSync(join(packageRoot, 'madar'))).toBe(false)

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.claude', 'skills', 'madar', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
      })
    })
  })

  it('falls back to built-in templates when package assets are unavailable', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', version: '0.1.0' }), 'utf8')

      withTempDir((homeDir) => {
        installSkill('gemini', { homeDir, packageRoot, version: 'test-version' })
        installSkill('aider', { homeDir, packageRoot, version: 'test-version' })
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })

        const geminiSkill = readFileSync(join(homeDir, '.gemini', 'skills', 'madar', 'SKILL.md'), 'utf8')
        const aiderSkill = readFileSync(join(homeDir, '.aider', 'madar', 'SKILL.md'), 'utf8')
        const installedSkill = readFileSync(join(homeDir, '.agents', 'skills', 'madar', 'SKILL.md'), 'utf8')
        const copilotSkill = readFileSync(join(homeDir, '.copilot', 'skills', 'madar', 'SKILL.md'), 'utf8')
        expect(geminiSkill).toMatch(/^---\nname: madar\n/)
        expect(geminiSkill).toContain('# /madar')
        expect(aiderSkill).toMatch(/^---\nname: madar\n/)
        expect(aiderSkill).toContain('Aider')
        expect(installedSkill).toMatch(/^---\nname: madar\n/)
        expect(installedSkill).toContain('spawn_agent')
        expect(installedSkill).toContain('# /madar')
        expect(installedSkill).toContain('## Honesty Rules')
        expect(installedSkill).toContain('code/docs/papers/images/audio/video counts')
        expect(installedSkill).toContain('"schema_version":2')
        expect(installedSkill).toContain('"file_type":"code|document|paper|image|audio|video|rationale"')
        expect(installedSkill).toContain('"provenance":[{"capability_id":"')
        expect(installedSkill).toContain('local audio/video, plus direct audio/video URL ingests that download into the same hidden-sidecar path, currently land as deterministic file nodes only')
        expect(installedSkill).toContain('```bash')
        expect(installedSkill.length).toBeGreaterThan(1000)
        expect(installedSkill).not.toContain('[[[MADAR_CODE_BLOCK_START]]]')
        expect(installedSkill).not.toContain('[[[MADAR_CODE_BLOCK_END]]]')
        expect(installedSkill).not.toContain('[[[MADAR_CODE_SPAN_START]]]')
        expect(installedSkill).not.toContain('[[[MADAR_CODE_SPAN_END]]]')
        expect(installedSkill).not.toContain('\u0000')
        expect(installedSkill).not.toContain('python3 -c')
        expect(installedSkill).not.toContain('madary')
        expect(installedSkill).not.toContain('from madar.')
        expect(copilotSkill).toMatch(/^---\nname: madar\n/)
        expect(copilotSkill).toContain('# /madar')
      })
    })
  })

  it('uninstalls copilot skills from the home-directory location', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'madar', 'SKILL.md'))).toBe(true)

        const message = uninstallSkill('copilot', { homeDir })

        expect(message).toContain('skill removed')
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'madar', 'SKILL.md'))).toBe(false)
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'madar', '.madar_version'))).toBe(false)
      })
    })
  })

  it('writes and removes local Gemini project instructions, hook config, and home skill', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((projectDir) => {
          const installMessage = geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })
          expect(installMessage).toContain('GEMINI.md')
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'madar', 'SKILL.md'))).toBe(true)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(true)
          expect(existsSync(join(projectDir, '.gemini', 'settings.json'))).toBe(true)
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('retrieve')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('relevant_files')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('feature_map')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('risk_map')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('implementation_checklist')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('impact')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('Only use madar when the task needs local repository source-code context.')
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).toContain('out')

          const uninstallMessage = geminiUninstall(projectDir, { homeDir })
          expect(uninstallMessage).toMatch(/madar section removed|GEMINI\.md was empty after removal/)
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'madar', 'SKILL.md'))).toBe(false)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(false)
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).not.toContain('out')
        })
      })
    })
  })

  it('writes strict Gemini guidance for compact context-pack-first usage', () => {
    withTempDir((projectDir) => {
      const installGeminiWithProfile = geminiInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      const installMessage = installGeminiWithProfile(projectDir, { profile: 'strict' })

      const geminiMd = readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')

      expect(geminiMd).toContain('Call `context_pack` once for the task before broader exploration.')
      expect(geminiMd).toContain(STRICT_STOP_RULE_MD)
      expect(geminiMd).toContain(STRICT_EXPAND_RULE_MD)
      expect(geminiMd).toContain('Avoid raw file search unless the pack is insufficient.')
      expect(installMessage).toContain('strict compact MCP profile')
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
          expect(countOccurrences(firstGeminiMd, '## madar')).toBe(1)
          expect(countOccurrences(firstSettings, 'out')).toBeGreaterThan(0)
        })
      })
    })
  })

  it('updates an existing Gemini hook when switching to the strict profile', () => {
    withTempDir((projectDir) => {
      geminiInstall(projectDir)

      const installGeminiWithProfile = geminiInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      installGeminiWithProfile(projectDir, { profile: 'strict' })

      const settings = readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')
      const decodedHookPayload = decodeHookPayloads(settings)

      expect(decodedHookPayload).toContain('strict compact MCP mode')
      expect(decodedHookPayload).toContain('call context_pack once for the task before broader exploration')
      expect(decodedHookPayload).toContain(STRICT_STOP_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_EXPAND_RULE_PLAIN)
      expect(decodedHookPayload).not.toContain('Madar answers most codebase questions in 1 focused MCP call')
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
      expect(normalizeAssertionPath(installMessage)).toContain('.cursor/rules/madar.mdc')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'))).toBe(true)
      expect(readFileSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')).toContain('alwaysApply: true')

      const uninstallMessage = cursorUninstall(projectDir)
      expect(uninstallMessage).toContain('removed')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'))).toBe(false)
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
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('Only use madar when the task needs local repository source-code context.')

      const uninstallMessage = claudeUninstall(projectDir)
      expect(uninstallMessage).toMatch(/madar section removed|CLAUDE\.md was empty after removal/)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    })
  })

  it('keeps the Claude prompt hook silent for GitHub Projects roadmap review prompts', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      claudeInstall(projectDir)

      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'UserPromptSubmit')
      const output = runHookCommand(command, projectDir, {
        prompt: 'I need you to access https://github.com/users/mohanagy/projects/9/views/3 and to review the roadmap, do not take any action for now',
      })

      expect(output).toBe('')
    })
  })

  it('injects Claude prompt guidance only for local code tasks', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      claudeInstall(projectDir)

      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'UserPromptSubmit')
      const output = runHookCommand(command, projectDir, {
        prompt: 'Implement issue #275 by collecting implementation context for changed files',
      })

      expect(output).toContain('retrieve')
      expect(output).toContain('3x fewer turns')
    })
  })

  it('emits the Claude skip reason in debug mode', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      claudeInstall(projectDir)

      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'UserPromptSubmit')
      const output = runHookCommand(
        command,
        projectDir,
        {
          prompt: 'Review the Product Hunt launch copy and marketing headline for tomorrow',
        },
        { MADAR_HOOK_DEBUG: '1' },
      )

      expect(output).toContain('Skipped Madar:')
      expect(output).toContain('marketing copy review')
    })
  })

  it('pins the Claude MCP server package to the installed madar version', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            args?: string[]
          }
        }
      }
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

      expect(mcpConfig.mcpServers?.['madar']?.args?.[1]).toBe(`@lubab/madar@${packageJson.version}`)
    })
  })

  it('writes MADAR_TOOL_PROFILE=core in the generated Claude .mcp.json env block', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env).toBeDefined()
      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
    })
  })

  it('writes MADAR_TOOL_PROFILE=full when the Claude installer opts into the full MCP profile', () => {
    withTempDir((projectDir) => {
      const installClaudeWithProfile = claudeInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' }) => string
      installClaudeWithProfile(projectDir, { profile: 'full' })

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('full')
    })
  })

  it('writes strict Claude guidance while keeping the MCP env on the lean core tool profile', () => {
    withTempDir((projectDir) => {
      const installClaudeWithProfile = claudeInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      const installMessage = installClaudeWithProfile(projectDir, { profile: 'strict' })

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
      expect(claudeMd).toContain('Call `context_pack` once for the task before broader exploration.')
      expect(claudeMd).toContain(STRICT_STOP_RULE_MD)
      expect(claudeMd).toContain(STRICT_EXPAND_RULE_MD)
      expect(claudeMd).toContain('Avoid raw file search unless the pack is insufficient.')
      expect(installMessage).toContain('strict compact MCP profile')
    })
  })

  it('writes MADAR_TOOL_PROFILE=core in the generated Cursor .cursor/mcp.json env block', () => {
    withTempDir((projectDir) => {
      cursorInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
    })
  })

  it('writes strict Cursor guidance while keeping the MCP env on the lean core tool profile', () => {
    withTempDir((projectDir) => {
      const installCursorWithProfile = cursorInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      const installMessage = installCursorWithProfile(projectDir, { profile: 'strict' })

      const rule = readFileSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')
      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
      expect(rule).toContain('Call `context_pack` once for the task before broader exploration.')
      expect(rule).toContain(STRICT_STOP_RULE_MD)
      expect(rule).toContain(STRICT_EXPAND_RULE_MD)
      expect(rule).toContain('Avoid raw file search unless the pack is insufficient.')
      expect(installMessage).toContain('strict compact MCP profile')
    })
  })

  it('updates an existing Cursor rule when switching to the strict profile', () => {
    withTempDir((projectDir) => {
      cursorInstall(projectDir)

      const installCursorWithProfile = cursorInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      installCursorWithProfile(projectDir, { profile: 'strict' })

      const rule = readFileSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')
      expect(rule).toContain('Call `context_pack` once for the task before broader exploration.')
      expect(rule).not.toContain('start with the graph tool that matches the question')
    })
  })

  it('preserves a user-customized MADAR_TOOL_PROFILE=full when re-running claude install', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      // Simulate a user opting into the legacy 21-tool surface plus an unrelated env entry.
      const mcpJsonPath = join(projectDir, '.mcp.json')
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers: { 'madar': { env: Record<string, string> } }
      }
      mcpConfig.mcpServers['madar'].env.MADAR_TOOL_PROFILE = 'full'
      mcpConfig.mcpServers['madar'].env.HTTP_PROXY = 'http://corp.example:8080'
      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8')

      claudeInstall(projectDir)

      const reinstalled = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers: { 'madar': { env: Record<string, string> } }
      }
      expect(reinstalled.mcpServers['madar'].env.MADAR_TOOL_PROFILE).toBe('full')
      expect(reinstalled.mcpServers['madar'].env.HTTP_PROXY).toBe('http://corp.example:8080')
    })
  })

  it('writes MADAR_TOOL_PROFILE=core in the generated VS Code Copilot .vscode/mcp.json env block', () => {
    withTempDir((projectDir) => {
      installCopilotMcp(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
        servers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.servers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
    })
  })

  it('writes the VS Code Copilot MCP server as a direct CLI launch instead of npx', () => {
    withOpenCodePackageRoot((packageRoot, cliPath) => {
      withTempDir((projectDir) => {
        const installCopilotWithPackageRoot = installCopilotMcp as (
          projectDir?: string,
          options?: { profile?: 'core' | 'full' | 'strict' },
          packageRoot?: string,
        ) => string
        installCopilotWithPackageRoot(projectDir, {}, packageRoot)

        const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
          servers?: {
            'madar'?: {
              type?: string
              command?: string
              args?: string[]
            }
          }
        }

        expect(mcpConfig.servers?.['madar']?.type).toBe('stdio')
        expect(normalizeAssertionPath(mcpConfig.servers?.['madar']?.command ?? '')).toBe(normalizeAssertionPath(process.execPath))
        expect(normalizeAssertionPaths(mcpConfig.servers?.['madar']?.args ?? [])).toEqual([
          normalizeAssertionPath(cliPath),
          'serve',
          '--stdio',
          normalizeAssertionPath(join(projectDir, 'out', 'graph.json')),
        ])
      })
    })
  })

  it('resolves a relative Copilot packageRoot before writing the CLI launcher path', () => {
    withOpenCodePackageRoot((packageRoot, cliPath) => {
      withTempDir((projectDir) => {
        const installCopilotWithPackageRoot = installCopilotMcp as (
          projectDir?: string,
          options?: { profile?: 'core' | 'full' | 'strict' },
          packageRoot?: string,
        ) => string
        installCopilotWithPackageRoot(projectDir, {}, normalizeAssertionPath(relative(process.cwd(), packageRoot)))

        const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
          servers?: {
            'madar'?: {
              args?: string[]
            }
          }
        }

        expect(normalizeAssertionPaths(mcpConfig.servers?.['madar']?.args ?? []).at(0)).toBe(normalizeAssertionPath(cliPath))
      })
    })
  })

  it('writes MADAR_TOOL_PROFILE=full when the VS Code Copilot installer opts into the full MCP profile', () => {
    withTempDir((projectDir) => {
      const installCopilotWithProfile = installCopilotMcp as (projectDir?: string, options?: { profile?: 'core' | 'full' }) => string
      installCopilotWithProfile(projectDir, { profile: 'full' })

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
        servers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.servers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('full')
    })
  })

  it('writes strict Copilot guidance while keeping the MCP env on the lean core tool profile', () => {
    withTempDir((projectDir) => {
      const installCopilotWithProfile = installCopilotMcp as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      const installMessage = installCopilotWithProfile(projectDir, { profile: 'strict' })

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.vscode', 'mcp.json'), 'utf8')) as {
        servers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.servers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('core')
      expect(installMessage).toContain('strict compact MCP profile')
      expect(installMessage).toContain('call context_pack once')
      expect(installMessage).toContain(STRICT_STOP_RULE_PLAIN)
      expect(installMessage).toContain(STRICT_EXPAND_RULE_PLAIN)
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
      expect(uninstalled.servers?.['madar']).toBeUndefined()
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
      expect(countOccurrences(firstClaudeMd, '## madar')).toBe(1)
      expect(countOccurrences(firstSettings, 'UserPromptSubmit')).toBeGreaterThan(0)
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
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## madar')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('python3 -c')
      expect(existsSync(join(projectDir, '.codex', 'hooks.json'))).toBe(true)

      withOpenCodePackageRoot((packageRoot, cliPath) => {
        const opencodeMessage = agentsInstall(projectDir, 'opencode', { packageRoot })
        expect(opencodeMessage).toMatch(/madar section (written|updated) in/)
        expect(opencodeMessage).toContain('opencode.json -> MCP server registered')
        expect(existsSync(join(projectDir, '.opencode', 'plugins', 'madar.js'))).toBe(true)
        expect(existsSync(join(projectDir, 'opencode.json'))).toBe(true)

        const opencodeConfig = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as OpenCodeConfig
        expect(opencodeConfig.plugin).toContain('.opencode/plugins/madar.js')
        expect(opencodeConfig.mcp?.madar).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'out', 'graph.json')],
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
      expect(installMessage).toContain('madar codex uninstall')
      expect(agentsMd).toContain('Codex CLI profile')
      expect(agentsMd).toContain('context-pack-first')
      expect(agentsMd).toContain('madar pack')
      expect(agentsMd).toContain('madar codex uninstall')
      expect(agentsMd).toContain('Manual verification')
      expect(decodedHookPayload).toContain('context-pack-first')
      expect(decodedHookPayload).toContain('madar pack')
    })
  })

  it('writes Aider-specific context-pack-first guidance and uninstall behavior', () => {
    withTempDir((projectDir) => {
      const installMessage = agentsInstall(projectDir, 'aider')
      const agentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')

      expect(installMessage).toContain('Aider')
      expect(installMessage).toContain('madar aider uninstall')
      expect(agentsMd).toContain('Aider profile')
      expect(agentsMd).toContain('context-pack-first')
      expect(agentsMd).toContain('madar pack')
      expect(agentsMd).toContain('madar aider uninstall')
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
        expect(installMessage).toContain('madar opencode uninstall')
        expect(agentsMd).toContain('OpenCode profile')
        expect(agentsMd).toContain('context-pack-first')
        expect(agentsMd).toContain('madar pack')
        expect(agentsMd).toContain('madar opencode uninstall')
        expect(agentsMd).toContain('Manual verification')
        expect(agentsMd).toContain('.opencode/plugins/madar.js')
        expect(agentsMd).toContain('opencode.json')
      })
    })
  })

  it('updates existing Codex madar hooks during reinstall', () => {
    withTempDir((projectDir) => {
      const stalePayload = JSON.stringify({
        systemMessage: 'Legacy out retrieve-first guidance',
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
                      command: `node -e "require('fs').accessSync('out/graph.json');process.stdout.write(Buffer.from('${stalePayloadB64}','base64').toString())"`,
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
                      command: `node -e "require('fs').appendFileSync('out/custom.log','custom')"`,
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
      expect(decodedHookPayload).toContain('madar pack')
      expect(decodedHookPayload).not.toContain('Legacy out retrieve-first guidance')
    })
  })

  it('preserves unrelated OpenCode config while updating madar MCP', () => {
    withTempDir((projectDir) => {
      writeFileSync(
        join(projectDir, 'opencode.json'),
        JSON.stringify(
          {
            plugin: ['custom-plugin'],
            mcp: {
              other: { type: 'remote', url: 'https://example.com/mcp' },
              madar: {
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
        expect(opencodeConfig.plugin).toEqual(['custom-plugin', '.opencode/plugins/madar.js'])
        expect(opencodeConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
        expect(opencodeConfig.mcp?.madar).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'out', 'graph.json')],
          enabled: true,
          environment: { HTTP_PROXY: 'http://proxy.example' },
        })
      })
    })
  })

  it('fails OpenCode install when the resolved package CLI is missing', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', bin: { 'madar': PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')

      withTempDir((projectDir) => {
        expect(() => agentsInstall(projectDir, 'opencode', { packageRoot })).toThrow(
          `Could not locate a madar CLI at ${join(packageRoot, PACKAGE_CLI_RELATIVE_PATH)} declared by ${join(packageRoot, 'package.json')}`,
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
        expect(installedContent).toContain('"plugin": ["custom-plugin", ".opencode/plugins/madar.js",]')
        expect(installedContent).toContain('"other": { "type": "remote", "url": "https://example.com/mcp", },')
        expect(installedConfig.plugin).toEqual(['custom-plugin', '.opencode/plugins/madar.js'])
        expect(installedConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
        expect(installedConfig.mcp?.madar).toEqual({
          type: 'local',
          command: [process.execPath, cliPath, 'serve', '--stdio', join(projectDir, 'out', 'graph.json')],
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
        expect(uninstalledConfig.mcp?.madar).toBeUndefined()
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
      expect(existsSync(join(projectDir, '.opencode', 'plugins', 'madar.js'))).toBe(false)
      expect(opencodeConfig.shell).toBe('/bin/zsh')
      expect(opencodeConfig.plugin).toEqual(['custom-plugin'])
      expect(opencodeConfig.mcp?.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' })
      expect(opencodeConfig.mcp?.madar).toBeUndefined()
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
        expect(countOccurrences(firstAgentsMd, '## madar')).toBe(1)
        expect(countOccurrences(firstCodexHooks, 'out')).toBeGreaterThan(0)
        expect(countOccurrences(firstOpenCodeConfig, '.opencode/plugins/madar.js')).toBe(1)
      })
    })
  })

  it('uninstalls agent/project config while preserving unrelated content', () => {
    withTempDir((projectDir) => {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing rules\n\nKeep calm.\n', 'utf8')
      agentsInstall(projectDir, 'codex')
      const uninstallMessage = agentsUninstall(projectDir, 'codex')

      expect(uninstallMessage).toContain('madar section removed')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Keep calm.')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('## madar')
      expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).not.toContain('madar')
    })
  })
})
