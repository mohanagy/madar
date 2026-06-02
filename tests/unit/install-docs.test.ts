import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('install documentation', () => {
  it('documents Aider and OpenCode install artifacts and context-pack-first workflow', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    expect(reference).toContain('Aider')
    expect(reference).toContain('AGENTS.md context-pack-first profile')
    expect(reference).toContain('madar aider install')
    expect(reference).toContain('OpenCode')
    expect(reference).toContain('.opencode/plugins/madar.js')
    expect(reference).toContain('opencode.json')
    expect(reference).toContain('madar opencode install')
    expect(reference).toContain('context-pack-first')
    expect(reference).toContain('madar pack "<task>" --task explain')
    expect(reference).toContain('madar aider uninstall')
    expect(reference).toContain('madar opencode uninstall')
  })

  it('documents doctor/status instruction lint surfaces per agent', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    expect(reference).toContain('`doctor` / `status` lint surface')
    expect(reference).toContain('Claude Code')
    expect(reference).toContain('madar claude <install\\|uninstall>')
    expect(reference).toContain('CLAUDE.md')
    expect(reference).toContain('.claude/settings.json')
    expect(reference).toContain('.mcp.json')
    expect(reference).toContain('Aider profile')
    expect(reference).toContain('OpenCode profile')
    expect(reference).toContain('plugin registration')
    expect(reference).toContain('MCP entry')
    expect(reference).toContain('Codex CLI')
    expect(reference).toContain('madar codex install')
    expect(reference).toContain('.codex/hooks.json')
    expect(reference).toContain('mark the agent as `partial` and suggest the matching reinstall command')
  })

  it('documents handoff as the share-safe remote-agent artifact distinct from local pack and prompt flows', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('madar handoff "add auth telemetry" --task implement --consumer copilot')
    expect(readme).toContain('share-safe remote/background-agent artifact')
    expect(readme).toContain('`madar pack` stays the richer local/full-context surface')
    expect(readme).toContain('`madar prompt` stays local')
  })

  it('documents the strict MCP install profile for claude, cursor, copilot, and gemini', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    for (const agent of ['claude', 'cursor', 'copilot', 'gemini']) {
      expect(reference).toContain(`${agent} <install\\|uninstall>`)
    }

    expect(reference).toContain('[--profile core\\|full\\|strict]')
    expect(reference).toContain('`--profile strict` keeps the lean core MCP tool surface')
    expect(reference).toContain('call `context_pack` once for the task before broader exploration')
    expect(reference).toContain('prefer Madar over non-Madar MCPs for codebase questions')
    expect(reference).toContain('override conflicting auto-activated exploration skills')
  })

  it('clarifies that strict installs still use one bounded context_pack call', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(reference).toContain('`--profile strict` keeps the seven core MCP tools but adds one bounded `context_pack` call per task')
    expect(reference).toContain('Full-profile additions beyond that strict one-pack flow')
    expect(readme).toContain('`--profile strict` keeps the lean core MCP tools but still uses one bounded `context_pack` call per task before broader exploration')
  })

  it('documents the local trust boundary and least-privilege install guidance', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('Treat every Madar MCP install, plugin, hook, or AGENTS profile as a local trust boundary.')
    expect(readme).toContain('Only enable it for repositories and local agent runtimes you trust.')
    expect(readme).toContain('Prefer `--profile strict` when you only need the lean core MCP tools.')
    expect(readme).toContain('docs/security/mcp-threat-model.md')
  })
})
