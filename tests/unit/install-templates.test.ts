import { SOURCE_RETRIEVAL_ADMISSION, SOURCE_RETRIEVAL_DISCOVERY } from '../../src/shared/source-retrieval-guidance.js'
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
  expect(normalized).toContain('When using Madar, choose the focused MCP tool below:')
  expect(normalized).toContain('| Prompt type')
  expect(normalized).toContain('| "how does X work" / explain runtime / flow')
  expect(normalized).toContain('| "what breaks if I change X" / impact analysis')
  expect(normalized).toContain('| "which files should I open first"')
  expect(normalized).toContain('| "give me a repo overview"')
  expect(normalized).toContain('`retrieve`')
  expect(normalized).toContain('`impact`')
  expect(normalized).toContain('`graph_summary`')
  expect(normalized).toContain(SOURCE_RETRIEVAL_DISCOVERY)
  expect(normalized).toContain('Treat `evidence.answerability` as advisory retrieval coverage; verify claims against source.')
  expect(normalized).toContain('Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks.')
}

function expectPlainRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('When using Madar, choose the matching MCP tool')
  expect(normalized).toContain('retrieve for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('retrieve for "which files should I open first?"')
  expect(normalized).toContain('graph_summary for "give me a repo overview?"')
  expect(normalized).toContain(SOURCE_RETRIEVAL_DISCOVERY)
  expect(normalized).toContain('Treat evidence.answerability as advisory retrieval coverage; verify claims against source.')
  expect(normalized).toContain('Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks.')
}

function expectMarkdownPackRoutingTable(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('When using Madar, choose the focused command below:')
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
  expect(normalized).toContain(SOURCE_RETRIEVAL_DISCOVERY)
  expect(normalized).toContain('Treat `evidence.answerability` as advisory retrieval coverage; verify claims against source.')
  expect(normalized).toContain('Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks.')
}

function expectPlainPackRoutingGuide(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('When using Madar, choose the focused command below')
  expect(normalized).toContain('madar pack "<task or question>" --task explain for "how does X work?" / explain runtime / flow')
  expect(normalized).toContain('madar pack "<task or question>" --task impact for "what breaks if I change X?" / impact analysis')
  expect(normalized).toContain('retrieve when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "which files should I open first?"')
  expect(normalized).toContain('graph_summary when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain for "give me a repo overview?"')
  expect(normalized).toContain(SOURCE_RETRIEVAL_DISCOVERY)
  expect(normalized).toContain('Treat evidence.answerability as advisory retrieval coverage; verify claims against source.')
  expect(normalized).toContain('Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks.')
}

function expectPlainStrictPackGuidance(content: string): void {
  const normalized = content.replaceAll('\\"', '"')
  expect(normalized).toContain('targets: [{file, symbol}]')
  expect(normalized).toContain('For experimental discovery, ask a focused source question.')
  expect(normalized).toContain('Strict MCP exposes only context_pack and context_expand')
  expect(normalized).toContain('use task=impact or task=review on the first pack instead of graph-navigation tools')
  expect(normalized).toContain('Use context_expand with a returned handle whenever source evidence is missing')
  expect(normalized).toContain('focused follow-up queries remain available')
}

describe('install hook payload', () => {
  it('decoded hook payload keeps the graph-first guidance without benchmark marketing copy', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expect(decoded).not.toContain('Use the graph result as the first bounded pass')
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

  it('decoded Codex hook payload includes optional source-retrieval guidance', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      const settings = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const decoded = decodeHookPayload(projectDir, settings)
      expect(decoded).toContain(SOURCE_RETRIEVAL_ADMISSION)
      expect(decoded).not.toContain('context-pack-first')
      expect(decoded).toContain('madar pack')
      expectPlainStrictPackGuidance(decoded)
    })
  })
})

describe('built-in install templates', () => {
  it('keeps source investigation available after advisory retrieval in generated profiles', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      const profile = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
      const hook = decodeHookPayload(projectDir, readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8'))
      const skill = getBuiltInSkillContent('codex')
      for (const content of [profile, hook, skill]) {
        expect(content).not.toMatch(/as authoritative|exactly once per user task|byte-for-byte|are terminal|result as terminal|use Madar tools only|Before broad shell search, raw file reads/)
        expect(content).toMatch(/focused.*(?:question|query)/i)
        expect(content).toMatch(/source.*(?:reads|code)|inspect additional/i)
        expect(content).toContain('source-access policy blocks')
        expect(content).toContain(SOURCE_RETRIEVAL_ADMISSION)
        expect(content.split(SOURCE_RETRIEVAL_DISCOVERY)).toHaveLength(2)
        expect(content).not.toContain('Do not run ToolSearch')
        expect(content).not.toContain('context-pack-first')
      }
      expect(skill).toContain(SOURCE_RETRIEVAL_ADMISSION)
    })
  })

  it('documents the Codex profile, limitations, manual verification, and uninstall path', () => {
    const content = getBuiltInSkillContent('codex')

    expect(content).toContain('Codex CLI profile')
    expect(content).toContain(SOURCE_RETRIEVAL_ADMISSION)
    expect(content).toContain('madar pack')
    expect(content).toContain('Ask a focused source question with relevant identifiers, literals, paths, and scope constraints.')
    expect(content).toContain('`evidence.answerability` as advisory retrieval coverage')
    expect(content).toContain('Prefer focused investigation and avoid repeating evidence already available.')
    expect(content).toContain('Inspect additional source when conditions, dependencies, or failure paths are missing.')
    expect(content).toContain('another focused `context_pack` question, or scoped source reads')
    expect(content).toContain('Follow the user scope and applicable verification requirements.')
    expect(content).toContain('`ready`')
    expect(content).toContain('`ready_with_caveat`')
    expect(content).toContain('`verify_targets`')
    expect(content).toContain('`insufficient`')
    expect(content).toContain('Respect explicit source-access policy blocks.')
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
