import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  hasManagedClaudePromptHookScript,
  installCopilotMcp,
  installSkill,
  isAgentPlatform,
  isInstallPlatform,
  uninstallCopilotMcp,
  uninstallSkill,
  CODEX_MCP_STARTUP_TIMEOUT_SECONDS,
  CODEX_MCP_TOOL_TIMEOUT_SECONDS,
  resolveCodexMcpConfigPath,
} from '../../src/infrastructure/install.js'
import { MCP_TOOLS, activeMcpTools, type McpToolProfile } from '../../src/runtime/stdio/definitions.js'
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const PACKAGE_CLI_RELATIVE_PATH = join('dist', 'src', 'cli', 'bin.js')
const STRICT_STOP_RULE_MD =
  'After calling Madar, treat `evidence.answerability.state` as authoritative and `evidence.pack_confidence` as compatibility-only: `ready` means answer from the pack; `ready_with_caveat` means answer with `evidence.answerability.caveats`; `verify_targets` means inspect only `evidence.answerability.verification_targets`; `insufficient` means follow `broad_search_fallback` exactly.'
const STRICT_INVOCATION_RULE_MD =
  'Call `context_pack` exactly once per user task. Copy the entire user codebase request byte-for-byte into `prompt`, including read-only, no-change, scope, and formatting constraints; do not rewrite, omit, expand, enumerate, split, or issue follow-up `context_pack` calls.'
const STRICT_EXPAND_RULE_MD =
  'Madar already ran bounded cumulative recovery. Do not restart repository exploration: for `verify_targets`, call `context_expand` once with a listed handle, then treat that expansion result as terminal; only `insufficient` plus `broad_search_fallback: allowed` permits one directory-scoped search.'
const STRICT_READ_ONLY_READY_RULE_MD =
  'For read-only `explain` tasks, `ready` and `ready_with_caveat` are terminal: cite `source_file`, `label`, `line_number` / `snippet_line_number`, and the included snippets directly. Do not run repository `Read`, `Grep`, `Glob`, or `Bash` merely to verify the pack, obtain exact lines, or reopen selected files.'
const STRICT_GRAPH_REPORT_RULE_MD =
  'Do not open `out/GRAPH_REPORT.md` unless the context pack or graph tools are unavailable, stale, or insufficient. Treat it as a fallback before broader raw file exploration, not a default first read.'
const STRICT_NO_BROAD_EXPLORATION_RULE_MD =
  'Do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps for `ready`, `ready_with_caveat`, or `verify_targets`.'
const STRICT_NON_MADAR_MCP_RULE_MD =
  'For codebase questions, use Madar tools only. Do not call another MCP or restart broad exploration unless `evidence.answerability.broad_search_fallback` is `allowed`.'
const STRICT_SKILL_OVERRIDE_RULE_MD =
  'If an auto-activated skill recommends broad `Read` / `Grep` / `Glob` exploration, defer to Madar\'s `evidence.answerability` first. `ready`, `ready_with_caveat`, and `verify_targets` all override a broad-search recommendation.'
const STRICT_STOP_RULE_PLAIN =
  'after calling Madar, treat evidence.answerability.state as authoritative and evidence.pack_confidence as compatibility-only: ready means answer from the pack; ready_with_caveat means answer with evidence.answerability.caveats; verify_targets means inspect only evidence.answerability.verification_targets; insufficient means follow broad_search_fallback exactly'
const STRICT_INVOCATION_RULE_PLAIN =
  'call context_pack exactly once per user task; copy the entire user codebase request byte-for-byte into prompt, including read-only, no-change, scope, and formatting constraints; do not rewrite, omit, expand, enumerate, split, or issue follow-up context_pack calls'
const STRICT_EXPAND_RULE_PLAIN =
  'Madar already ran bounded cumulative recovery; do not restart repository exploration: for verify_targets, call context_expand once with a listed handle, then treat that expansion result as terminal; only insufficient plus broad_search_fallback allowed permits one directory-scoped search'
const STRICT_READ_ONLY_READY_RULE_PLAIN =
  'for read-only explain tasks, ready and ready_with_caveat are terminal: cite source_file, label, line_number or snippet_line_number, and the included snippets directly; do not run repository Read, Grep, Glob, or Bash merely to verify the pack, obtain exact lines, or reopen selected files'
const STRICT_GRAPH_REPORT_RULE_PLAIN =
  'do not open out/GRAPH_REPORT.md unless the context pack or graph tools are unavailable, stale, or insufficient; treat it as a fallback before broader raw file exploration, not a default first read'
const STRICT_GRAPH_REPORT_RULE_PLAIN_SENTENCE =
  'Do not open out/GRAPH_REPORT.md unless the context pack or graph tools are unavailable, stale, or insufficient; treat it as a fallback before broader raw file exploration, not a default first read'
const STRICT_NO_BROAD_EXPLORATION_RULE_PLAIN =
  'do not run broad glob patterns, repo-wide grep / find searches, or raw file sweeps for ready, ready_with_caveat, or verify_targets'
const STRICT_NON_MADAR_MCP_RULE_PLAIN =
  'for codebase questions, use Madar tools only; do not call another MCP or restart broad exploration unless evidence.answerability.broad_search_fallback is allowed'
const STRICT_NON_MADAR_MCP_RULE_PLAIN_SENTENCE =
  'For codebase questions, use Madar tools only; do not call another MCP or restart broad exploration unless evidence.answerability.broad_search_fallback is allowed'
const STRICT_SKILL_OVERRIDE_RULE_PLAIN =
  'if an auto-activated skill recommends broad Read / Grep / Glob exploration, defer to Madar\'s evidence.answerability first; ready, ready_with_caveat, and verify_targets all override a broad-search recommendation'
const CODEX_MCP_START_MARKER = '# >>> madar managed mcp >>>'
const CODEX_MCP_END_MARKER = '# <<< madar managed mcp <<<'

function expectMarkdownRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, use the specific Madar MCP tool below first:')
  expect(normalized).toContain('| Prompt type')
  expect(normalized).toContain('| "how does X work" / explain runtime / flow')
  expect(normalized).toContain('| "what breaks if I change X" / impact analysis')
  expect(normalized).toContain('| "which files should I open first"')
  expect(normalized).toContain('| "give me a repo overview"')
  expect(normalized).toContain('`retrieve`')
  expect(normalized).toContain('`impact`')
  expect(normalized).toContain('`graph_summary`')
  expect(normalized).not.toMatch(/`(?:context_pack|context_expand|relevant_files|feature_map|risk_map|implementation_checklist)`/)
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
}

function expectPlainRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, call the matching Madar MCP tool directly first')
  expect(normalized).toContain('retrieve for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('retrieve for "which files should I open first?"')
  expect(normalized).toContain('graph_summary for "give me a repo overview?"')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
}

function expectCodexMarkdownRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, start with the specific Madar command below first.')
  expect(normalized).toContain('| Prompt type')
  expect(normalized).toContain('| "how does X work" / explain runtime / flow')
  expect(normalized).toContain('| "what breaks if I change X" / impact analysis')
  expect(normalized).toContain('| "which files should I open first"')
  expect(normalized).toContain('| "give me a repo overview"')
  expect(normalized).toContain('`madar pack "<task or question>" --task explain`')
  expect(normalized).toContain('`madar pack "<task or question>" --task impact`')
  expect(normalized).toContain('`retrieve` when MCP graph tools are available')
  expect(normalized).toContain('`graph_summary` when MCP graph tools are available')
  expect(normalized).toContain('`context_pack` for a fresh task-specific pack')
  expect(normalized).toContain('`context_expand` for a handle returned by a pack')
  expect(normalized).toContain('`retrieve` for direct codebase questions')
  expect(normalized).not.toMatch(/`(?:relevant_files|feature_map|risk_map|implementation_checklist)`/)
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar command or graph tool')
}

function expectStrictCodexMarkdownRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, start with the specific Madar command below first.')
  expect(normalized).toContain('| Prompt type | First strict MCP tool |')
  expect(normalized).toContain('`context_pack` with `task: "explain"`')
  expect(normalized).toContain('`context_pack` with `task: "impact"`')
  expect(normalized).toContain('`context_pack` with `task: "review"`')
  expect(normalized).toContain('`context_pack` with `task: "implement"`')
  expect(normalized).toContain('Strict exposes no general graph-navigation tool after this pack.')
  expect(normalized).toContain('`context_expand` only for a listed `verify_targets` handle')
  expect(normalized).not.toContain('`retrieve` for direct codebase questions')
  expect(normalized).not.toContain('`graph_summary` for repo overview')
}

function mcpToolNamesInGuidance(content: string): string[] {
  return MCP_TOOLS
    .map((tool) => tool.name)
    .filter((name) => content.includes(`\`${name}\``))
}

function expectGuidanceToolsEnabled(content: string, profile: McpToolProfile): void {
  const enabled = new Set(activeMcpTools(profile).map((tool) => tool.name))
  expect(mcpToolNamesInGuidance(content).filter((name) => !enabled.has(name))).toEqual([])
}

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

    for (const match of current.matchAll(/(?:['\"])?([A-Za-z0-9+/=]{40,})(?:['\"])?/g)) {
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

function encodeGraphCheckedHookCommand(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  return `node -e "try{require('fs').accessSync('out/graph.json');process.stdout.write(Buffer.from('${b64}','base64').toString())}catch(e){}"`
}

function extractHookCommand(settingsJson: string, eventName: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  return parsed.hooks?.[eventName]?.[0]?.hooks?.[0]?.command ?? ''
}

function extractHookEntry(settingsJson: string, eventName: string): Record<string, unknown> {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: Record<string, Array<Record<string, unknown>>>
  }
  return parsed.hooks?.[eventName]?.[0] ?? {}
}

function extractCodexHookEntry(
  hooksJson: string,
  eventName: 'PreToolUse' | 'UserPromptSubmit',
): Record<string, unknown> {
  const parsed = JSON.parse(hooksJson) as {
    hooks?: {
      PreToolUse?: Array<Record<string, unknown>>
      UserPromptSubmit?: Array<Record<string, unknown>>
    }
  }
  const entries = parsed.hooks?.[eventName] ?? []
  return entries.find((entry) => entry.source === 'madar') ?? entries[0] ?? {}
}

function extractCodexHookCommand(
  hooksJson: string,
  eventName: 'PreToolUse' | 'UserPromptSubmit',
): string {
  const entry = extractCodexHookEntry(hooksJson, eventName)
  if (!Array.isArray(entry.hooks)) {
    return ''
  }

  const firstHook = entry.hooks[0]
  return typeof firstHook === 'object' && firstHook !== null && typeof (firstHook as { command?: unknown }).command === 'string'
    ? (firstHook as { command: string }).command
    : ''
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
  const testNodeDir = dirname(process.execPath)
  const controlledCommand = process.platform === 'win32'
    ? command
    : `export PATH="$MADAR_TEST_NODE_DIR:$PATH"; ${command}`
  const shell = shellCommandForPlatform(process.platform, controlledCommand)
  try {
    const result = spawnSync(shell.command, shell.args, {
      cwd,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env, MADAR_TEST_NODE_DIR: testNodeDir },
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
        expect(installedSkill).toContain('local audio/video files land as deterministic file nodes only')
        expect(installedSkill).not.toContain('direct audio/video URL ingests')
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
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('impact')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('Only use madar when the task needs local repository source-code context.')
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain(STRICT_GRAPH_REPORT_RULE_MD)
          expectMarkdownRoutingTable(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8'))
          const geminiSettings = JSON.parse(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')) as {
            mcpServers?: { madar?: { command?: string; args?: string[]; env?: Record<string, string> } }
          }
          expect(geminiSettings.mcpServers?.madar).toEqual(expect.objectContaining({
            command: 'madar',
            args: ['serve', '--stdio', '--auto-refresh'],
            env: { MADAR_TOOL_PROFILE: 'core' },
          }))

          const uninstallMessage = geminiUninstall(projectDir, { homeDir })
          expect(uninstallMessage).toMatch(/madar section removed|GEMINI\.md was empty after removal/)
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'madar', 'SKILL.md'))).toBe(false)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(false)
          const uninstalledSettings = JSON.parse(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')) as {
            mcpServers?: Record<string, unknown>
          }
          expect(uninstalledSettings.mcpServers?.madar).toBeUndefined()
          expect(uninstalledSettings).toEqual({})
        })
      })
    })
  })

  it('writes strict Gemini guidance for compact context-pack-first usage', () => {
    withTempDir((projectDir) => {
      const installGeminiWithProfile = geminiInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      const installMessage = installGeminiWithProfile(projectDir, { profile: 'strict' })

      const geminiMd = readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')
      const geminiSettings = JSON.parse(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')) as {
        mcpServers?: { madar?: { env?: Record<string, string> } }
      }

      expect(geminiSettings.mcpServers?.madar?.env?.MADAR_TOOL_PROFILE).toBe('strict')
      expect(geminiMd).toContain(STRICT_INVOCATION_RULE_MD)
      expect(geminiMd).toContain(STRICT_STOP_RULE_MD)
      expect(geminiMd).toContain(STRICT_READ_ONLY_READY_RULE_MD)
      expect(geminiMd).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_MD)
      expect(geminiMd).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(geminiMd).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
      expect(geminiMd).toContain(STRICT_EXPAND_RULE_MD)
      expect(geminiMd).toContain(STRICT_GRAPH_REPORT_RULE_MD)
      expect(geminiMd).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
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
      expect(decodedHookPayload).toContain(STRICT_INVOCATION_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_STOP_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_READ_ONLY_READY_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_NON_MADAR_MCP_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_SKILL_OVERRIDE_RULE_PLAIN)
      expect(decodedHookPayload).toContain(STRICT_EXPAND_RULE_PLAIN)
      expect(decodedHookPayload).not.toContain('Madar answers most codebase questions in 1 focused MCP call')
    })
  })

  it('keeps Gemini hook guidance active in a linked worktree without a local out graph', () => {
    withTempDir((projectDir) => {
      const nestedDirectory = join(projectDir, 'nested', 'agent-session')
      mkdirSync(nestedDirectory, { recursive: true })
      writeFileSync(join(projectDir, '.git'), 'gitdir: ../.git/worktrees/linked\n', 'utf8')
      geminiInstall(projectDir)

      const settings = readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'BeforeTool')
      const output = runHookCommand(command, nestedDirectory, { tool_name: 'read_file' })

      expect(command).toContain('madar-workspace-graph-check')
      expect(output).toContain('additionalContext')
      expect(output).toContain('madar knowledge graph')
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
      const rule = readFileSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')
      expect(rule).toContain('alwaysApply: true')
      expectMarkdownRoutingTable(rule)

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
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('impact')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('Only use madar when the task needs local repository source-code context.')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
      expectMarkdownRoutingTable(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8'))

      const uninstallMessage = claudeUninstall(projectDir)
      expect(uninstallMessage).toMatch(/madar section removed|CLAUDE\.md was empty after removal/)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
      expect(JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'))).toEqual({})
      expect(existsSync(join(projectDir, '.claude', 'madar-user-prompt-submit.cjs'))).toBe(false)
      expect(JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'))).toEqual({})
    })
  })

  it('preserves pre-existing empty Claude config files on uninstall', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.claude', 'settings.json')
      const mcpPath = join(projectDir, '.mcp.json')
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, '{}\n', 'utf8')
      writeFileSync(mcpPath, '{}\n', 'utf8')

      claudeInstall(projectDir)
      claudeUninstall(projectDir)

      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({})
      expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual({})
    })
  })

  it('preserves unrelated Claude settings while removing Madar hook entries', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.claude', 'settings.json')
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo keep-prompt-hook' }] }],
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo keep-read-hook' }] }],
        },
      }, null, 2), 'utf8')

      claudeInstall(projectDir)
      claudeUninstall(projectDir)

      const settings = readFileSync(settingsPath, 'utf8')
      expect(settings).toContain('keep-prompt-hook')
      expect(settings).toContain('keep-read-hook')
      expect(settings).toContain('"permissions"')
      expect(settings).not.toContain('madar-user-prompt-submit.cjs')
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

  it('installs UserPromptSubmit as a short project-local .cjs hook script', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
      claudeInstall(projectDir)

      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'UserPromptSubmit')
      const hookScriptPath = join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')

      expect(command).toBe('node .claude/madar-user-prompt-submit.cjs')
      expect(command.length).toBeLessThan(80)
      expect(existsSync(hookScriptPath)).toBe(true)

      const output = runHookCommand(command, projectDir, {
        prompt: 'Implement issue #275 by collecting implementation context for changed files',
      })

      expect(output).toContain('retrieve')

      claudeUninstall(projectDir)
      expect(existsSync(hookScriptPath)).toBe(false)
    })
  })

  it('removes the generated Claude hook script even if settings.json is already gone', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const hookScriptPath = join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')
      rmSync(join(projectDir, '.claude', 'settings.json'), { force: true })

      claudeUninstall(projectDir)

      expect(existsSync(hookScriptPath)).toBe(false)
    })
  })

  it('does not remove a Claude prompt script replaced by the user after installation', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const hookScriptPath = join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')
      const userScript = 'console.log("keep user-managed Claude hook")\n'
      writeFileSync(hookScriptPath, userScript, 'utf8')

      claudeUninstall(projectDir)

      expect(readFileSync(hookScriptPath, 'utf8')).toBe(userScript)
      expect(JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'))).toEqual({})
    })
  })

  it('does not overwrite a user-managed Claude prompt script during installation', () => {
    withTempDir((projectDir) => {
      const hookScriptPath = join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')
      const userScript = 'console.log("keep user-managed Claude hook")\n'
      mkdirSync(dirname(hookScriptPath), { recursive: true })
      writeFileSync(hookScriptPath, userScript, 'utf8')

      expect(() => claudeInstall(projectDir)).toThrow(/Refusing to overwrite user-managed Claude hook script/)
      expect(readFileSync(hookScriptPath, 'utf8')).toBe(userScript)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(false)
    })
  })

  it('treats a non-file Claude prompt hook path as user-managed without crashing', () => {
    withTempDir((projectDir) => {
      const hookScriptPath = join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')
      mkdirSync(hookScriptPath, { recursive: true })

      expect(hasManagedClaudePromptHookScript(hookScriptPath)).toBe(false)
      expect(() => claudeInstall(projectDir)).toThrow(/Refusing to overwrite user-managed Claude hook script/)
      expect(() => claudeUninstall(projectDir)).not.toThrow()
      expect(existsSync(hookScriptPath)).toBe(true)
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
      expect(output).not.toContain('3x fewer turns')
      expect(output).not.toContain('2.8x faster')
    })
  })

  it('updates a legacy Claude managed hook in place when reinstalling', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')

      const legacyPromptMessage =
        'STOP. This project has a madar knowledge graph. Use the graph tool that matches the question: retrieve for direct codebase questions, relevant_files for where to open first, feature_map for the main areas and entry points, risk_map before editing, implementation_checklist for edit order and validation, and impact for blast radius. Madar answers most codebase questions in 1 focused MCP call instead of 5–10 sequential file reads (3x fewer turns, ~2.8x faster on a real production codebase). Do not use Glob, Grep, Bash, Read, or Agent tools first. Only fall back to raw file tools if the graph tools cannot answer the question or the MCP server is unavailable.'
      const legacyHookCommand = encodeGraphCheckedHookCommand({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: legacyPromptMessage,
        },
      })
      writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            hooks: [{
              type: 'command',
              command: legacyHookCommand,
            }],
          }],
        },
      }, null, 2), 'utf8')

      const message = claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const command = extractHookCommand(settings, 'UserPromptSubmit')
      const hookScript = readFileSync(join(projectDir, '.claude', 'madar-user-prompt-submit.cjs'), 'utf8')

      expect(message).toContain('hook updated')
      expect(countOccurrences(settings, 'UserPromptSubmit')).toBe(1)
      expect(command).toBe('node .claude/madar-user-prompt-submit.cjs')
      expect(hookScript).not.toContain('3x fewer turns')
      expect(hookScript).toContain('Use the graph result as the first bounded pass')
      expect(hookScript).toContain(STRICT_NON_MADAR_MCP_RULE_PLAIN)
      expect(hookScript).toContain(STRICT_SKILL_OVERRIDE_RULE_PLAIN)
    })
  })

  it('does not overwrite unrelated user Claude hooks that happen to be named madar', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            name: 'madar',
            source: 'user-custom-hook',
            matcher: 'prompt',
            hooks: [{
              type: 'command',
              command: 'echo keep-user-hook',
            }],
          }],
        },
      }, null, 2), 'utf8')

      const message = claudeInstall(projectDir)
      const settings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')) as {
        hooks?: {
          UserPromptSubmit?: Array<Record<string, unknown>>
        }
      }
      const entries = settings.hooks?.UserPromptSubmit ?? []

      expect(message).toContain('registered')
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'madar',
          source: 'user-custom-hook',
        }),
        expect.objectContaining({
          name: 'madar',
          source: 'madar',
        }),
      ]))
      expect(entries).toHaveLength(2)
    })
  })

  it('writes a stable `name: madar` sentinel into installed Claude, Gemini, and Codex hook entries', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      geminiInstall(projectDir)
      agentsInstall(projectDir, 'codex')

      const claudeSettings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const geminiSettings = readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')
      const codexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')

      expect(extractHookEntry(claudeSettings, 'UserPromptSubmit').name).toBe('madar')
      expect(extractHookEntry(geminiSettings, 'BeforeTool').name).toBe('madar')
      expect(extractCodexHookEntry(codexHooks, 'UserPromptSubmit').name).toBe('madar')
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

  it('writes the Claude MCP server as a bare madar launcher without a pinned package version', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            command?: string
            args?: string[]
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.command).toBe('madar')
      expect(mcpConfig.mcpServers?.['madar']?.args).toEqual([
        'serve',
        '--stdio',
        '--auto-refresh',
      ])
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

  it('writes strict Claude guidance with the callable strict MCP tool profile', () => {
    withTempDir((projectDir) => {
      const installClaudeWithProfile = claudeInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      const installMessage = installClaudeWithProfile(projectDir, { profile: 'strict' })

      const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const hookOutput = runHookCommand(extractHookCommand(settings, 'UserPromptSubmit'), projectDir, {
        prompt: 'Explain how a failed monitor check becomes an incident. This is read-only; do not change files.',
      })
      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            env?: Record<string, string>
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('strict')
      expect(claudeMd).toContain(STRICT_INVOCATION_RULE_MD)
      expect(claudeMd).toContain(STRICT_STOP_RULE_MD)
      expect(claudeMd).toContain(STRICT_READ_ONLY_READY_RULE_MD)
      expect(claudeMd).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_MD)
      expect(claudeMd).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(claudeMd).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
      expect(claudeMd).toContain(STRICT_EXPAND_RULE_MD)
      expect(claudeMd).toContain(STRICT_GRAPH_REPORT_RULE_MD)
      expect(claudeMd).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
      expect(hookOutput).toContain(STRICT_READ_ONLY_READY_RULE_PLAIN)
      expect(hookOutput).toContain(STRICT_INVOCATION_RULE_PLAIN)
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

  it('writes the Cursor MCP server as a bare madar launcher without a pinned package version', () => {
    withTempDir((projectDir) => {
      cursorInstall(projectDir)

      const mcpConfig = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers?: {
          'madar'?: {
            command?: string
            args?: string[]
          }
        }
      }

      expect(mcpConfig.mcpServers?.['madar']?.command).toBe('madar')
      expect(mcpConfig.mcpServers?.['madar']?.args).toEqual([
        'serve',
        '--stdio',
        '--auto-refresh',
      ])
    })
  })

  it('writes strict Cursor guidance with the callable strict MCP tool profile', () => {
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

      expect(mcpConfig.mcpServers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('strict')
      expect(rule).toContain(STRICT_INVOCATION_RULE_MD)
      expect(rule).toContain(STRICT_STOP_RULE_MD)
      expect(rule).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_MD)
      expect(rule).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(rule).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
      expect(rule).toContain(STRICT_EXPAND_RULE_MD)
      expect(rule).toContain(STRICT_GRAPH_REPORT_RULE_MD)
      expect(rule).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
      expect(installMessage).toContain('strict compact MCP profile')
    })
  })

  it('updates an existing Cursor rule when switching to the strict profile', () => {
    withTempDir((projectDir) => {
      cursorInstall(projectDir)

      const installCursorWithProfile = cursorInstall as (projectDir?: string, options?: { profile?: 'core' | 'full' | 'strict' }) => string
      installCursorWithProfile(projectDir, { profile: 'strict' })

      const rule = readFileSync(join(projectDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')
      expect(rule).toContain(STRICT_INVOCATION_RULE_MD)
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
          '--auto-refresh',
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

  it('writes strict Copilot guidance with the callable strict MCP tool profile', () => {
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

      expect(mcpConfig.servers?.['madar']?.env?.MADAR_TOOL_PROFILE).toBe('strict')
      expect(installMessage).toContain('strict compact MCP profile')
      expect(installMessage).toContain(STRICT_INVOCATION_RULE_PLAIN)
      expect(installMessage).toContain(STRICT_STOP_RULE_PLAIN)
      expect(installMessage).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_PLAIN)
      expect(installMessage).toContain(STRICT_EXPAND_RULE_PLAIN)
      expect(installMessage).toContain(STRICT_GRAPH_REPORT_RULE_PLAIN)
    })
  })

  it('keeps every tool named by compact agent guidance callable in the installed profile (#405, #550)', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((root) => {
          const claudeDir = join(root, 'claude')
          const cursorDir = join(root, 'cursor')
          const copilotDir = join(root, 'copilot')
          const geminiDir = join(root, 'gemini')
          const codexDir = join(root, 'codex')
          const aiderDir = join(root, 'aider')

          const claudeMessage = claudeInstall(claudeDir, { profile: 'strict' })
          const cursorMessage = cursorInstall(cursorDir, { profile: 'strict' })
          const copilotMessage = installCopilotMcp(copilotDir, { profile: 'strict' })
          const geminiMessage = geminiInstall(geminiDir, {
            profile: 'strict',
            homeDir,
            packageRoot,
            version: 'test-version',
          })
          const codexMessage = agentsInstall(codexDir, 'codex')
          const aiderMessage = agentsInstall(aiderDir, 'aider')

          const guidanceByPlatform = [
            `${readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8')}\n${claudeMessage}`,
            `${readFileSync(join(cursorDir, '.cursor', 'rules', 'madar.mdc'), 'utf8')}\n${cursorMessage}`,
            copilotMessage,
            `${readFileSync(join(geminiDir, 'GEMINI.md'), 'utf8')}\n${geminiMessage}`,
            `${readFileSync(join(codexDir, 'AGENTS.md'), 'utf8')}\n${readFileSync(join(codexDir, '.codex', 'madar-user-prompt-submit.cjs'), 'utf8')}\n${codexMessage}`,
          ]
          for (const guidance of guidanceByPlatform) {
            expectGuidanceToolsEnabled(guidance, 'strict')
          }

          expect(readFileSync(join(claudeDir, '.mcp.json'), 'utf8')).toContain('"MADAR_TOOL_PROFILE": "strict"')
          expect(readFileSync(join(cursorDir, '.cursor', 'mcp.json'), 'utf8')).toContain('"MADAR_TOOL_PROFILE": "strict"')
          expect(readFileSync(join(copilotDir, '.vscode', 'mcp.json'), 'utf8')).toContain('"MADAR_TOOL_PROFILE": "strict"')
          expect(readFileSync(join(geminiDir, '.gemini', 'settings.json'), 'utf8')).toContain('"MADAR_TOOL_PROFILE": "strict"')
          expect(readFileSync(resolveCodexMcpConfigPath(), 'utf8')).toContain('MADAR_TOOL_PROFILE = "strict"')

          const aiderGuidance = `${readFileSync(join(aiderDir, 'AGENTS.md'), 'utf8')}\n${aiderMessage}`
          expectGuidanceToolsEnabled(aiderGuidance, 'strict')
          expect(aiderGuidance).toContain('This profile writes AGENTS.md only.')
        })
      })
    })

    withOpenCodePackageRoot((packageRoot) => {
      withTempDir((projectDir) => {
        const message = agentsInstall(projectDir, 'opencode', { packageRoot })
        const guidance = `${readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')}\n${readFileSync(join(projectDir, '.opencode', 'plugins', 'madar.js'), 'utf8')}\n${message}`
        const config = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as OpenCodeConfig

        expectGuidanceToolsEnabled(guidance, 'strict')
        expect(config.mcp?.madar?.environment?.MADAR_TOOL_PROFILE).toBe('strict')
      })
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
          command: [process.execPath, cliPath, 'serve', '--stdio', '--auto-refresh'],
          environment: { MADAR_TOOL_PROFILE: 'strict' },
          enabled: true,
        })
      })
    })
  })

  it('writes a task-applicable Codex UserPromptSubmit hook with model-visible context', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')

      const installMessage = agentsInstall(projectDir, 'codex')
      const agentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
      const codexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const command = extractCodexHookCommand(codexHooks, 'UserPromptSubmit')
      const hookScriptPath = join(projectDir, '.codex', 'madar-user-prompt-submit.cjs')

      expect(installMessage).toContain('Codex')
      expect(installMessage).toContain('madar codex uninstall')
      expect(agentsMd).toContain('Codex CLI profile')
      expect(agentsMd).toContain('context-pack-first')
      expect(agentsMd).toContain('madar pack')
      expect(agentsMd).toContain(STRICT_INVOCATION_RULE_MD)
      expect(agentsMd).toContain(STRICT_NO_BROAD_EXPLORATION_RULE_MD)
      expect(agentsMd).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(agentsMd).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
      expect(agentsMd).toContain('madar codex uninstall')
      expect(agentsMd).toContain('Manual verification')
      expect(agentsMd).toContain(STRICT_GRAPH_REPORT_RULE_MD)
      expectStrictCodexMarkdownRoutingTable(agentsMd)
      expect(agentsMd).not.toContain('Only fall back to raw file tools** when the context pack or graph tools are missing, stale, or insufficient. In that case, read `out/GRAPH_REPORT.md` first.')
      expect(command).toContain('process.cwd()')
      expect(command).toContain('madar-user-prompt-submit.cjs')
      expect(existsSync(hookScriptPath)).toBe(true)
      expect(extractCodexHookEntry(codexHooks, 'UserPromptSubmit')).toMatchObject({
        name: 'madar',
        source: 'madar',
      })
      expect(JSON.parse(codexHooks) as { hooks?: { PreToolUse?: unknown } }).not.toMatchObject({
        hooks: { PreToolUse: expect.anything() },
      })

      if (!command.includes('madar-user-prompt-submit.cjs')) {
        return
      }

      const localOutput = JSON.parse(runHookCommand(command, projectDir, {
        prompt: 'Implement issue #275 by collecting implementation context for changed files',
      })) as {
        hookSpecificOutput?: {
          hookEventName?: string
          additionalContext?: string
          permissionDecision?: unknown
        }
        systemMessage?: unknown
      }
      const nonCodeOutput = runHookCommand(command, projectDir, {
        prompt: 'Review the Product Hunt launch copy and marketing headline for tomorrow',
      })

      expect(localOutput.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')
      expect(localOutput.hookSpecificOutput?.additionalContext).toContain('context-pack-first')
      expect(localOutput.hookSpecificOutput?.additionalContext).toContain('madar pack')
      expect(localOutput.hookSpecificOutput?.additionalContext).toContain(STRICT_INVOCATION_RULE_PLAIN)
      expect(localOutput).not.toHaveProperty('systemMessage')
      expect(localOutput.hookSpecificOutput).not.toHaveProperty('permissionDecision')
      expect(nonCodeOutput).toBe('')
    })
  })

  it('removes fresh Codex hook entries and script without deleting the config file', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      agentsUninstall(projectDir, 'codex')

      expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
      expect(JSON.parse(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8'))).toEqual({})
      expect(existsSync(join(projectDir, '.codex', 'madar-user-prompt-submit.cjs'))).toBe(false)
    })
  })

  it('preserves a pre-existing empty Codex hooks config on uninstall', () => {
    withTempDir((projectDir) => {
      const hooksPath = join(projectDir, '.codex', 'hooks.json')
      mkdirSync(dirname(hooksPath), { recursive: true })
      writeFileSync(hooksPath, '{}\n', 'utf8')

      agentsInstall(projectDir, 'codex')
      agentsUninstall(projectDir, 'codex')

      expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual({})
    })
  })

  it('does not rewrite an already-current Codex prompt hook', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      const hooksPath = join(projectDir, '.codex', 'hooks.json')
      const before = readFileSync(hooksPath, 'utf8')

      const reinstallMessage = agentsInstall(projectDir, 'codex')
      const after = readFileSync(hooksPath, 'utf8')

      expect(reinstallMessage).toContain('.codex/hooks.json -> UserPromptSubmit hook already registered (no change)')
      expect(after).toBe(before)
    })
  })

  it('finds the workspace graph when the Codex prompt hook runs from a nested directory', () => {
    withTempDir((temporaryDir) => {
      const projectDir = join(temporaryDir, 'repo-$()-`tick`-$HOME')
      mkdirSync(join(projectDir, 'out'), { recursive: true })
      mkdirSync(join(projectDir, 'nested', 'working-directory'), { recursive: true })
      writeFileSync(join(projectDir, 'out', 'graph.json'), '{}', 'utf8')
      agentsInstall(projectDir, 'codex')

      const hookScriptPath = join(projectDir, '.codex', 'madar-user-prompt-submit.cjs')
      expect(existsSync(hookScriptPath)).toBe(true)
      if (!existsSync(hookScriptPath)) {
        return
      }

      const hookScript = readFileSync(hookScriptPath, 'utf8')
      const command = extractCodexHookCommand(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8'), 'UserPromptSubmit')
      const output = runHookCommand(
        command,
        join(projectDir, 'nested', 'working-directory'),
        { prompt: 'Explain how this repository auth module works' },
      )

      expect(hookScript).toContain('function hasMadarGraph()')
      expect(command).not.toContain(projectDir)
      expect(JSON.parse(output)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: expect.stringContaining('context-pack-first'),
        },
      })
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
      expect(agentsMd).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
      expect(agentsMd).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
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
        expect(agentsMd).toContain(STRICT_NON_MADAR_MCP_RULE_MD)
        expect(agentsMd).toContain(STRICT_SKILL_OVERRIDE_RULE_MD)
        expect(agentsMd).toContain('madar opencode uninstall')
        expect(agentsMd).toContain('Manual verification')
        expect(agentsMd).toContain('.opencode/plugins/madar.js')
        expect(agentsMd).toContain('opencode.json')
        expect(agentsMd).toContain(STRICT_GRAPH_REPORT_RULE_MD)
        expect(agentsMd).not.toContain('In that case, read `out/GRAPH_REPORT.md` first.')

        const plugin = readFileSync(join(projectDir, '.opencode', 'plugins', 'madar.js'), 'utf8')
        expect(plugin).toContain(STRICT_NON_MADAR_MCP_RULE_PLAIN_SENTENCE)
        expect(plugin).toContain(STRICT_GRAPH_REPORT_RULE_PLAIN_SENTENCE)
        expectPlainRoutingGuide(plugin)
        expect(plugin).not.toContain('Read out/GRAPH_REPORT.md before raw file search if needed.')
      })
    })
  })

  it('activates the OpenCode reminder in a linked worktree without a local out graph', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'madar-opencode-worktree-'))
    const packageRoot = mkdtempSync(join(tmpdir(), 'madar-opencode-package-'))

    try {
      const cliPath = join(packageRoot, PACKAGE_CLI_RELATIVE_PATH)
      mkdirSync(dirname(cliPath), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'madar-test', bin: { madar: PACKAGE_CLI_RELATIVE_PATH } }), 'utf8')
      writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8')
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
      writeFileSync(join(projectDir, '.git'), 'gitdir: ../.git/worktrees/linked\n', 'utf8')

      agentsInstall(projectDir, 'opencode', { packageRoot })

      const pluginPath = join(projectDir, '.opencode', 'plugins', 'madar.js')
      const pluginModule = await import(pathToFileURL(pluginPath).href) as {
        MadarPlugin: (context: { directory: string }) => Promise<{
          'tool.execute.before': (input: { tool: string }, output: { args: { command: string } }) => Promise<void>
        }>
      }
      const plugin = await pluginModule.MadarPlugin({ directory: join(projectDir, 'nested', 'agent-session') })
      const output = { args: { command: 'pwd' } }

      await plugin['tool.execute.before']({ tool: 'bash' }, output)

      expect(output.args.command).toContain('[madar] Knowledge graph available.')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(packageRoot, { recursive: true, force: true })
    }
  })

  it('migrates recognized legacy Codex PreToolUse hooks while preserving user hooks', () => {
    withTempDir((projectDir) => {
      const stalePayload = JSON.stringify({
        systemMessage: 'Legacy madar knowledge graph retrieve-first guidance',
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
              UserPromptSubmit: [
                {
                  name: 'madar',
                  source: 'user-custom-hook',
                  hooks: [{ type: 'command', command: 'echo keep-user-prompt-hook' }],
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
      const parsed = JSON.parse(codexHooks) as {
        hooks?: {
          PreToolUse?: Array<{ matcher?: string, hooks?: Array<{ command?: string }> }>
          UserPromptSubmit?: Array<{ source?: string, hooks?: Array<{ command?: string }> }>
        }
      }

      expect(installMessage).toContain('.codex/hooks.json -> hook updated')
      expect(parsed.hooks?.PreToolUse).toEqual([
        expect.objectContaining({ matcher: 'Read' }),
        expect.objectContaining({ matcher: 'Bash' }),
      ])
      expect(codexHooks).toContain('keep-me')
      expect(codexHooks).toContain('custom.log')
      expect(codexHooks).toContain('keep-user-prompt-hook')
      expect(parsed.hooks?.UserPromptSubmit).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'user-custom-hook' }),
        expect.objectContaining({ source: 'madar' }),
      ]))
      expect(extractCodexHookCommand(codexHooks, 'UserPromptSubmit')).toContain('madar-user-prompt-submit.cjs')
      expect(existsSync(join(projectDir, '.codex', 'madar-user-prompt-submit.cjs'))).toBe(true)
    })
  })

  it('replaces stale sentinel-owned Codex prompt hooks without duplicating them', () => {
    withTempDir((projectDir) => {
      mkdirSync(join(projectDir, '.codex'), { recursive: true })
      writeFileSync(join(projectDir, '.codex', 'hooks.json'), JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            name: 'madar',
            source: 'madar',
            hooks: [{ type: 'command', command: 'echo stale-madar-prompt-hook' }],
          }],
        },
      }, null, 2), 'utf8')

      agentsInstall(projectDir, 'codex')
      const hooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const parsed = JSON.parse(hooks) as {
        hooks?: { UserPromptSubmit?: Array<{ source?: string, hooks?: Array<{ command?: string }> }> }
      }
      const madarEntries = (parsed.hooks?.UserPromptSubmit ?? []).filter((entry) => entry.source === 'madar')

      expect(madarEntries).toHaveLength(1)
      expect(madarEntries[0]?.hooks?.[0]?.command).toContain('madar-user-prompt-submit.cjs')
      expect(hooks).not.toContain('stale-madar-prompt-hook')
    })
  })

  it('does not overwrite or remove a user-managed Codex prompt script', () => {
    withTempDir((projectDir) => {
      const hookScriptPath = join(projectDir, '.codex', 'madar-user-prompt-submit.cjs')
      const userScript = 'console.log("keep user-managed Codex hook")\n'
      mkdirSync(join(projectDir, '.codex'), { recursive: true })
      writeFileSync(hookScriptPath, userScript, 'utf8')

      expect(() => agentsInstall(projectDir, 'codex')).toThrow(/Refusing to overwrite user-managed Codex hook script/)
      expect(readFileSync(hookScriptPath, 'utf8')).toBe(userScript)
      expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(projectDir, '.codex', 'hooks.json'))).toBe(false)

      agentsUninstall(projectDir, 'codex')
      expect(readFileSync(hookScriptPath, 'utf8')).toBe(userScript)
    })
  })

  it('uninstalls modern and recognized legacy Codex hooks without touching unrelated hooks', () => {
    withTempDir((projectDir) => {
      const legacyPayload = JSON.stringify({ systemMessage: 'Legacy madar knowledge graph retrieve-first guidance' })
      const legacyPayloadB64 = Buffer.from(legacyPayload).toString('base64')
      mkdirSync(join(projectDir, '.codex'), { recursive: true })
      writeFileSync(join(projectDir, '.codex', 'hooks.json'), JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{
                type: 'command',
                command: `node -e "require('fs').accessSync('out/graph.json');process.stdout.write(Buffer.from('${legacyPayloadB64}','base64').toString())"`,
              }],
            },
            { matcher: 'Read', hooks: [{ type: 'command', command: 'echo keep-read-hook' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-bash-hook' }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo keep-user-prompt-hook' }] },
          ],
        },
      }, null, 2), 'utf8')

      agentsInstall(projectDir, 'codex')
      const uninstallMessage = agentsUninstall(projectDir, 'codex')
      const hooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')

      expect(uninstallMessage).toContain('.codex/hooks.json -> UserPromptSubmit hook removed')
      expect(existsSync(join(projectDir, '.codex', 'madar-user-prompt-submit.cjs'))).toBe(false)
      expect(hooks).toContain('keep-read-hook')
      expect(hooks).toContain('keep-bash-hook')
      expect(hooks).toContain('keep-user-prompt-hook')
      expect(hooks).not.toContain('Legacy madar knowledge graph retrieve-first guidance')
      expect(hooks).not.toContain('madar-user-prompt-submit.cjs')
    })
  })

  it('writes an idempotent workspace-scoped Codex MCP block in the configuration Codex CLI loads', () => {
    withTempDir((projectDir) => {
      const configPath = resolveCodexMcpConfigPath()
      const unrelatedToml = '# Preserve this user comment\r\n[features]\r\nparallel = true\r\n'
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, unrelatedToml, 'utf8')

      const firstInstallMessage = agentsInstall(projectDir, 'codex')
      const firstContent = readFileSync(configPath, 'utf8')
      const secondInstallMessage = agentsInstall(projectDir, 'codex')

      expect(firstInstallMessage).toContain(`${configPath} -> MCP server madar_`)
      expect(firstContent).toContain(unrelatedToml)
      expect(firstContent).toMatch(/# >>> madar managed mcp: madar_[a-f0-9]{12} >>>/)
      expect(firstContent).toMatch(/\[mcp_servers\.madar_[a-f0-9]{12}\]/)
      expect(firstContent).toContain(`cwd = ${JSON.stringify(projectDir)}`)
      expect(firstContent).toContain(`startup_timeout_sec = ${CODEX_MCP_STARTUP_TIMEOUT_SECONDS}`)
      expect(firstContent).toContain(`tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SECONDS}`)
      expect(firstContent).toContain('MADAR_TOOL_PROFILE = "strict"')
      expect(secondInstallMessage).toContain('already registered (no change)')
      expect(readFileSync(configPath, 'utf8')).toBe(firstContent)

      const uninstallMessage = agentsUninstall(projectDir, 'codex')
      expect(uninstallMessage).toContain('MCP server madar_')
      expect(readFileSync(configPath, 'utf8')).toBe(unrelatedToml)
    })
  })

  it('atomically updates Codex user config while preserving its permissions for install and uninstall', () => {
    withTempDir((projectDir) => {
      const configPath = resolveCodexMcpConfigPath()
      const original = '# preserve this user config\n[features]\nparallel = true\n'
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, original, 'utf8')
      if (process.platform !== 'win32') {
        chmodSync(configPath, 0o640)
      }
      const originalInode = process.platform === 'win32' ? null : statSync(configPath).ino

      agentsInstall(projectDir, 'codex')

      const managedContent = readFileSync(configPath, 'utf8')
      expect(managedContent).toContain(original)
      expect(managedContent).toContain('[mcp_servers.madar_')
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)
      expect(readdirSync(dirname(configPath)).filter((entry) => entry.startsWith('.config.toml.madar-'))).toEqual([])
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o640)
        expect(statSync(configPath).ino).not.toBe(originalInode)
      }
      const managedInode = process.platform === 'win32' ? null : statSync(configPath).ino

      agentsUninstall(projectDir, 'codex')

      expect(readFileSync(configPath, 'utf8')).toBe(original)
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)
      expect(readdirSync(dirname(configPath)).filter((entry) => entry.startsWith('.config.toml.madar-'))).toEqual([])
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o640)
        expect(statSync(configPath).ino).not.toBe(managedInode)
      }
    })
  })

  it('keeps Codex MCP registrations for separate workspaces independent', () => {
    withTempDir((root) => {
      const firstProject = join(root, 'first')
      const secondProject = join(root, 'second')
      mkdirSync(firstProject, { recursive: true })
      mkdirSync(secondProject, { recursive: true })
      const configPath = resolveCodexMcpConfigPath()
      const preserved = '# keep this user configuration\n'
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, preserved, 'utf8')

      agentsInstall(firstProject, 'codex')
      agentsInstall(secondProject, 'codex')
      const both = readFileSync(configPath, 'utf8')
      expect([...both.matchAll(/\[mcp_servers\.(madar_[a-f0-9]{12})\]/g)]).toHaveLength(2)
      expect(both).toContain(`cwd = ${JSON.stringify(firstProject)}`)
      expect(both).toContain(`cwd = ${JSON.stringify(secondProject)}`)

      agentsUninstall(firstProject, 'codex')
      const afterFirstUninstall = readFileSync(configPath, 'utf8')
      expect(afterFirstUninstall).not.toContain(`cwd = ${JSON.stringify(firstProject)}`)
      expect(afterFirstUninstall).toContain(`cwd = ${JSON.stringify(secondProject)}`)

      agentsUninstall(secondProject, 'codex')
      expect(readFileSync(configPath, 'utf8')).toBe(preserved)
    })
  })

  it('migrates only its obsolete project-local Codex MCP marker block', () => {
    withTempDir((projectDir) => {
      const legacyConfigPath = join(projectDir, '.codex', 'config.toml')
      const legacyBlock = `${CODEX_MCP_START_MARKER}\n[mcp_servers.madar]\ncommand = "madar"\nargs = ["serve", "--stdio", "--auto-refresh"]\nenv = { MADAR_TOOL_PROFILE = "core" }\n${CODEX_MCP_END_MARKER}\n`
      mkdirSync(dirname(legacyConfigPath), { recursive: true })
      writeFileSync(legacyConfigPath, `# preserved local config\n${legacyBlock}`, 'utf8')

      const message = agentsInstall(projectDir, 'codex')
      const globalConfig = readFileSync(resolveCodexMcpConfigPath(), 'utf8')

      expect(message).toContain('obsolete project-local MCP registration removed')
      expect(readFileSync(legacyConfigPath, 'utf8')).toBe('# preserved local config\n')
      expect(globalConfig).toContain(`cwd = ${JSON.stringify(projectDir)}`)
      expect(globalConfig).toContain(`tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SECONDS}`)
    })
  })

  it('fails without mutating either Codex config when the legacy marker block is malformed', () => {
    withTempDir((projectDir) => {
      const legacyConfigPath = join(projectDir, '.codex', 'config.toml')
      const malformed = `# keep\n${CODEX_MCP_START_MARKER}\n[mcp_servers.madar]\ncommand = "madar"\n`
      mkdirSync(dirname(legacyConfigPath), { recursive: true })
      writeFileSync(legacyConfigPath, malformed, 'utf8')
      const globalConfigPath = resolveCodexMcpConfigPath()
      const globalBefore = existsSync(globalConfigPath) ? readFileSync(globalConfigPath, 'utf8') : null

      expect(() => agentsInstall(projectDir, 'codex')).toThrow(/marker block/i)
      expect(readFileSync(legacyConfigPath, 'utf8')).toBe(malformed)
      expect(existsSync(globalConfigPath) ? readFileSync(globalConfigPath, 'utf8') : null).toBe(globalBefore)
    })
  })

  it('releases the Codex user-config lock when a managed block is malformed', () => {
    withTempDir((projectDir) => {
      const configPath = resolveCodexMcpConfigPath()
      const serverName = `madar_${createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12)}`
      const malformed = `# preserve this user config\n# >>> madar managed mcp: ${serverName} >>>\n[mcp_servers.${serverName}]\n`
      const priorContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
      mkdirSync(dirname(configPath), { recursive: true })
      try {
        writeFileSync(configPath, malformed, 'utf8')

        expect(() => agentsInstall(projectDir, 'codex')).toThrow(/marker block/i)
        expect(readFileSync(configPath, 'utf8')).toBe(malformed)
        expect(existsSync(`${configPath}.madar.lock`)).toBe(false)
        expect(readdirSync(dirname(configPath)).filter((entry) => entry.startsWith('.config.toml.madar-'))).toEqual([])
        expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
      } finally {
        if (priorContent === null) {
          rmSync(configPath, { force: true })
        } else {
          writeFileSync(configPath, priorContent, 'utf8')
        }
      }
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
          command: [process.execPath, cliPath, 'serve', '--stdio', '--auto-refresh'],
          enabled: true,
          environment: { MADAR_TOOL_PROFILE: 'strict', HTTP_PROXY: 'http://proxy.example' },
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
          command: [process.execPath, cliPath, 'serve', '--stdio', '--auto-refresh'],
          environment: { MADAR_TOOL_PROFILE: 'strict' },
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
        const firstCodexHookScript = readFileSync(join(projectDir, '.codex', 'madar-user-prompt-submit.cjs'), 'utf8')
        const firstCodexConfig = readFileSync(resolveCodexMcpConfigPath(), 'utf8')
        const firstOpenCodeConfig = readFileSync(join(projectDir, 'opencode.json'), 'utf8')

        agentsInstall(projectDir, 'codex')
        agentsInstall(projectDir, 'opencode', { packageRoot })

        expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toBe(firstAgentsMd)
        expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).toBe(firstCodexHooks)
        expect(readFileSync(join(projectDir, '.codex', 'madar-user-prompt-submit.cjs'), 'utf8')).toBe(firstCodexHookScript)
        expect(readFileSync(resolveCodexMcpConfigPath(), 'utf8')).toBe(firstCodexConfig)
        expect(readFileSync(join(projectDir, 'opencode.json'), 'utf8')).toBe(firstOpenCodeConfig)
        expect(countOccurrences(firstAgentsMd, '## madar')).toBe(1)
        expect(firstCodexHookScript).toContain('out')
        expect(firstCodexConfig).toMatch(/\[mcp_servers\.madar_[a-f0-9]{12}\]/)
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
      expect(JSON.parse(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8'))).toEqual({})
    })
  })
})
