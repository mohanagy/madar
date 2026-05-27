import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function decodeHookPayload(settingsJson: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: {
      PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>
      UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }>
    }
  }
  const command = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command
    ?? parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
    ?? ''
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

describe('install hook payload', () => {
  it('decoded hook payload keeps the graph-first guidance without benchmark marketing copy', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      expect(decoded).toContain('Use the graph result as the first bounded pass')
      expect(decoded.toLowerCase()).not.toContain('3x fewer turns')
    })
  })

  it('decoded hook payload does NOT contain stale 384x/397x/897x claims', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
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
      const decoded = decodeHookPayload(settings)
      expect(decoded).toContain('retrieve')
    })
  })

  it('decoded hook payload routes agents to the focused MCP tools by question type', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      expect(decoded).toContain('relevant_files')
      expect(decoded).toContain('feature_map')
      expect(decoded).toContain('risk_map')
      expect(decoded).toContain('implementation_checklist')
      expect(decoded).toContain('impact')
    })
  })

  it('decoded Codex hook payload includes context-pack-first guidance', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      const settings = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      expect(decoded).toContain('context-pack-first')
      expect(decoded).toContain('madar pack')
      expect(decoded).toContain('use Madar tools only')
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
    expect(content).toContain('defer to Madar\'s `agent_directive` first')
    expect(content).toContain('missing_context')
    expect(content).toContain('deeper verification')
    expect(content).toContain('Do not open `out/GRAPH_REPORT.md` unless the context pack or graph tools are unavailable, stale, or insufficient.')
    expect(content).not.toContain('If manual expansion is still required, read `out/GRAPH_REPORT.md` first.')
    expect(content).toContain('madar codex install')
    expect(content).toContain('madar codex uninstall')
    expect(content).toContain('Manual verification')
    expect(content).toContain('Codex limitations')
    expect(content).toContain('spawn_agent')
    expect(content).toContain('npx --yes madar --help')
    expect(content).toContain('Only use madar when the task needs local repository source-code context.')
  })
})
