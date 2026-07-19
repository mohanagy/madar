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
  expect(normalized).toContain('`retrieve`')
  expect(normalized).toContain('`impact`')
  expect(normalized).toContain('`graph_summary`')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
  expect(normalized).toContain('Treat `evidence.answerability.state` as authoritative; `evidence.pack_confidence` is compatibility-only.')
  expect(normalized).toContain('For `verify_targets`, inspect only the listed verification targets. Restart broad search only for `insufficient` with `broad_search_fallback: allowed`.')
}

function expectPlainRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, call the matching Madar MCP tool directly first')
  expect(normalized).toContain('retrieve for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('retrieve for "which files should I open first?"')
  expect(normalized).toContain('graph_summary for "give me a repo overview?"')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar tool')
  expect(normalized).toContain('Treat evidence.answerability.state as authoritative; evidence.pack_confidence is compatibility-only.')
  expect(normalized).toContain('For verify_targets, inspect only the listed verification targets. Restart broad search only for insufficient with broad_search_fallback allowed.')
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
  expect(normalized).toContain('`retrieve` when MCP graph tools are available')
  expect(normalized).toContain('`graph_summary` when MCP graph tools are available')
  expect(normalized).not.toContain('`retrieve` for direct codebase questions')
  expect(normalized).not.toContain('`impact` for blast radius')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar command or graph tool')
  expect(normalized).toContain('Treat `evidence.answerability.state` as authoritative; `evidence.pack_confidence` is compatibility-only.')
  expect(normalized).toContain('For `verify_targets`, inspect only the listed verification targets. Restart broad search only for `insufficient` with `broad_search_fallback: allowed`.')
}

function expectPlainPackRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('For each codebase question, start with the specific Madar command below first')
  expect(normalized).toContain('madar pack "<task or question>" --task explain for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('madar pack "<task or question>" --task impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('retrieve when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "which files should I open first?"')
  expect(normalized).toContain('graph_summary when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "give me a repo overview?"')
  expect(normalized).toContain('Do not run ToolSearch before calling a Madar command or graph tool')
  expect(normalized).toContain('Treat evidence.answerability.state as authoritative; evidence.pack_confidence is compatibility-only.')
  expect(normalized).toContain('For verify_targets, inspect only the listed verification targets. Restart broad search only for insufficient with broad_search_fallback allowed.')
}

function expectPlainStrictPackGuidance(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('call context_pack exactly once per user task')
  expect(normalized).toContain('copy the entire user codebase request byte-for-byte into prompt, including read-only, no-change, scope, and formatting constraints')
  expect(normalized).toContain('Strict MCP exposes only context_pack and context_expand')
  expect(normalized).toContain('use task=impact or task=review on the first pack instead of graph-navigation tools')
  expect(normalized).toContain('For verify_targets, use context_expand once only with a listed verification handle and treat the result as terminal')
  expect(normalized).toContain('do not expand ready or ready_with_caveat packs')
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
      expect(decoded).toContain('retrieve')
      expect(decoded).toContain('impact')
      expect(decoded).toContain('graph_summary')
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
      expectPlainStrictPackGuidance(decoded)
    })
  })
})

describe('built-in install templates', () => {
  it('documents the Codex profile, limitations, manual verification, and uninstall path', () => {
    const content = getBuiltInSkillContent('codex')

    expect(content).toContain('Codex CLI profile')
    expect(content).toContain('context-pack-first')
    expect(content).toContain('madar pack')
    expect(content).toContain('Pass the entire user\'s codebase request byte-for-byte as the pack question, including read-only, no-change, scope, and formatting constraints.')
    expect(content).toContain('`evidence.answerability.state` as authoritative')
    expect(content).toContain('Do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps for `ready`, `ready_with_caveat`, or `verify_targets`.')
    expect(content).toContain('For read-only `explain` tasks, `ready` and `ready_with_caveat` are terminal')
    expect(content).toContain('Do not call another MCP or restart broad exploration unless `evidence.answerability.broad_search_fallback` is `allowed`')
    expect(content).toContain('defer to Madar\'s answerability and exact verification targets')
    expect(content).toContain('`ready`')
    expect(content).toContain('`ready_with_caveat`')
    expect(content).toContain('`verify_targets`')
    expect(content).toContain('`insufficient`')
    expect(content).toContain('bounded cumulative recovery')
    expect(content).toContain('Do not open `out/GRAPH_REPORT.md` unless the context pack or graph tools are unavailable, stale, or insufficient.')
    expect(content).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
    expect(content).toContain('madar codex install')
    expect(content).toContain('madar codex uninstall')
    expect(content).toContain('Manual verification')
    expect(content).toContain('Codex limitations')
    expect(content).toContain('.codex/madar-user-prompt-submit.cjs')
    expect(content).toContain('~/.codex/config.toml')
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
