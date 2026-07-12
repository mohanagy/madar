import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { agentsInstall, claudeInstall } from '../../src/infrastructure/install.js'
import { getBuiltInSkillContent } from '../../src/infrastructure/install-skill-templates.js'

const STALE_PHRASES = ['384x', '397x', '897x', '384×', '397×', '897×']

function withTempDir(callback: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'madar-template-'))
  try {
    callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function decodeHookPayload(projectDir: string, settingsJson: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: {
      PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>
      UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }>
    }
  }
  const command = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command
    ?? parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
    ?? ''

  const hookScriptPath = command === 'node .claude/madar-user-prompt-submit.cjs'
    ? join(projectDir, '.claude', 'madar-user-prompt-submit.cjs')
    : command.includes('madar-user-prompt-submit.cjs') && command.includes('.codex')
      ? join(projectDir, '.codex', 'madar-user-prompt-submit.cjs')
      : undefined
  if (hookScriptPath) {
    if (!existsSync(hookScriptPath)) {
      return ''
    }

    const hookScript = readFileSync(hookScriptPath, 'utf8')
    const matchPayload = hookScript.match(/const matchPayload = ("(?:\\.|[^"])*")/)
    return matchPayload?.[1] ? JSON.parse(matchPayload[1]) : hookScript
  }

  // Hook command embeds the payload as a base64 literal inside a node -e wrapper.
  // Extract every base64-looking chunk and decode each, concatenating the results
  // so we capture both the match and miss payloads when present.
  const decodedPayloads: string[] = []
  const seen = new Set<string>()
  const queue = [command]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    for (const match of current.matchAll(/(['"])([A-Za-z0-9+/=]{40,})\1/g)) {
      const value = match[2]
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

function expectMarkdownRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, use the specific Madar MCP tool below first:')
  expect(normalized).toContain('| Prompt type')
  expect(normalized).toContain('| "how does X work" / explain runtime / flow')
  expect(normalized).toContain('| "what breaks if I change X" / impact analysis')
  expect(normalized).toContain('| "which files should I open first"')
  expect(normalized).toContain('| "give me a repo overview"')
  expect(normalized).toContain('`context_pack`')
  expect(normalized).toContain('`impact`')
  expect(normalized).toContain('`relevant_files`')
  expect(normalized).toContain('`graph_summary`')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
  expect(normalized).toContain('Inspect `evidence.pack_confidence`, `recommended_first_read`, and `evidence.agent_directive` before deciding whether to read files.')
  expect(normalized).toContain('If `evidence.pack_confidence` is low, make one focused follow-up Madar call before broad raw search.')
}

function expectPlainRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, call the matching Madar MCP tool directly first')
  expect(normalized).toContain('context_pack for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('relevant_files for "which files should I open first?"')
  expect(normalized).toContain('graph_summary for "give me a repo overview?"')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
  expect(normalized).toContain('Inspect evidence.pack_confidence, recommended_first_read, and evidence.agent_directive before deciding whether to read files.')
  expect(normalized).toContain('If evidence.pack_confidence is low, make one focused follow-up Madar call before broad raw search.')
}

function expectMarkdownPackRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, start with the specific Madar command below first:')
  expect(normalized).toContain('| Prompt type')
  expect(normalized).toContain('| "how does X work" / explain runtime / flow')
  expect(normalized).toContain('| "what breaks if I change X" / impact analysis')
  expect(normalized).toContain('| "which files should I open first"')
  expect(normalized).toContain('| "give me a repo overview"')
  expect(normalized).toContain('`madar pack "<task or question>" --task explain`')
  expect(normalized).toContain('`madar pack "<task or question>" --task impact`')
  expect(normalized).toContain('`relevant_files` when MCP graph tools are available')
  expect(normalized).toContain('`graph_summary` when MCP graph tools are available')
  expect(normalized).toContain('`retrieve` for direct codebase questions')
  expect(normalized).toContain('`feature_map` for involved areas and entry points')
  expect(normalized).toContain('`risk_map` before editing')
  expect(normalized).toContain('`implementation_checklist` for edit order and validation checkpoints')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar command or graph tool')
  expect(normalized).toContain('Inspect `evidence.pack_confidence`, `recommended_first_read`, and `evidence.agent_directive` before deciding whether to read files.')
  expect(normalized).toContain('If `evidence.pack_confidence` is low, make one focused follow-up Madar call before broad raw search.')
}

function expectPlainPackRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, start with the specific Madar command below first')
  expect(normalized).toContain('madar pack "<task or question>" --task explain for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('madar pack "<task or question>" --task impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('relevant_files when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "which files should I open first?"')
  expect(normalized).toContain('graph_summary when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "give me a repo overview?"')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar command or graph tool')
  expect(normalized).toContain('Inspect evidence.pack_confidence, recommended_first_read, and evidence.agent_directive before deciding whether to read files.')
  expect(normalized).toContain('If evidence.pack_confidence is low, make one focused follow-up Madar call before broad raw search.')
}

describe('install hook payload', () => {
  it('decoded hook payload keeps the graph-first guidance without benchmark marketing copy', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expect(decoded).toContain('Use the graph result as the first bounded pass')
      expect(decoded.toLowerCase()).not.toContain('3x fewer turns')
    })
  })

  it('decoded hook payload does NOT contain stale 384x/397x/897x claims', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      const decodedLower = decoded.toLowerCase()
      for (const stale of STALE_PHRASES) {
        expect(decodedLower).not.toContain(stale.toLowerCase())
      }
    })
  })

  it('decoded hook payload still mentions the retrieve MCP tool', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expect(decoded).toContain('retrieve')
    })
  })

  it('decoded hook payload routes agents to the focused MCP tools by question type', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expectPlainRoutingGuide(decoded)
      expect(decoded).toContain('feature_map')
      expect(decoded).toContain('risk_map')
      expect(decoded).toContain('implementation_checklist')
    })
  })

  it('decoded Codex hook payload includes context-pack-first guidance', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      const settings = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expect(decoded).toContain('context-pack-first')
      expect(decoded).toContain('madar pack')
      expect(decoded).toContain('use Madar tools only')
      expectPlainPackRoutingGuide(decoded)
    })
  })
})

describe('built-in install templates', () => {
  it('documents the Codex profile, limitations, manual verification, and uninstall path', () => {
    const content = getBuiltInSkillContent('codex')

    expect(content).toContain('Codex CLI profile')
    expect(content).toContain('context-pack-first')
    expect(content).toContain('madar pack')
    expect(content).toContain('high- or medium-confidence pack')
    expect(content).toContain('Do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps after a high- or medium-confidence pack.')
    expect(content).toContain('Do not call other MCP servers such as `mcp__github` or `mcp__context7`')
    expect(content).toContain('defer to Madar\'s `evidence.agent_directive` first')
    expect(content).toContain('inspect the response\'s evidence.agent_directive')
    expect(content).toContain('`answer_from_pack`')
    expect(content).toContain('`verify_one_targeted_file`')
    expect(content).toContain('`explore_with_caution`')
    expect(content).toContain('missing_context')
    expect(content).toContain('deeper verification')
    expect(content).toContain('Do not open `out/GRAPH_REPORT.md` unless the context pack or graph tools are unavailable, stale, or insufficient.')
    expect(content).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
    expect(content).toContain('madar codex install')
    expect(content).toContain('madar codex uninstall')
    expect(content).toContain('Manual verification')
    expect(content).toContain('Codex limitations')
    expect(content).toContain('.codex/madar-user-prompt-submit.cjs')
    expect(content).toContain('.codex/config.toml')
    expect(content).toContain('UserPromptSubmit')
    expect(content).toContain('`/hooks`')
    expect(content).toContain('`/mcp`')
    expect(content).toContain('`codex mcp list`')
    expect(content).toContain('guidance, not enforcement')
    expect(content).toContain('on-disk')
    expect(content).toContain('spawn_agent')
    expect(content).toContain('npx --yes madar --help')
    expect(content).toContain('Only use madar when the task needs local repository source-code context.')
    expect(content).toContain('Treat every local MCP server, hook, plugin, or AGENTS profile as a trust boundary.')
    expect(content).toContain('Only enable it for repositories and local agent runtimes you trust.')
    expect(content).not.toContain('add <url>')
    expect(content).not.toContain('direct audio/video URL ingests')
    expectMarkdownPackRoutingTable(content)
  })

  it('documents the Copilot routing decision table in the built-in skill', () => {
    const content = getBuiltInSkillContent('copilot')

    expect(content).toContain('# /madar')
    expect(content).toContain('Treat every local MCP server, hook, plugin, or AGENTS profile as a trust boundary.')
    expect(content).not.toContain('add <url>')
    expectMarkdownRoutingTable(content)
  })
})
