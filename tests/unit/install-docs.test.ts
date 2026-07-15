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

  it('documents the Codex project MCP, task-applicable hook, and trust activation boundary', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const quickstarts = readFileSync(resolve('docs/tutorials/agent-quickstarts.md'), 'utf8')

    for (const document of [reference, quickstarts]) {
      expect(document).toContain('`.codex/madar-user-prompt-submit.cjs`')
      expect(document).toContain('`.codex/config.toml`')
      expect(document).toContain('`/hooks`')
      expect(document).toContain('`/mcp`')
      expect(document).toContain('`codex mcp list`')
      expect(document).toContain('guidance, not enforcement')
      expect(document).toContain('on-disk')
    }
  })

  it('documents handoff as the share-safe CLI handoff distinct from local pack and prompt flows', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('madar handoff "add auth telemetry" --task implement --consumer copilot')
    expect(readme).toContain('Create a share-safe handoff for another coding tool')
    expect(readme).toContain('madar pack "how does auth work?" --task explain --format text')
    expect(readme).toContain('madar prompt "how does auth work?" --provider claude')
  })

  it('documents the strict MCP install profile for claude, cursor, copilot, and gemini', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    for (const agent of ['claude', 'cursor', 'copilot', 'gemini']) {
      expect(reference).toContain(`${agent} <install\\|uninstall>`)
    }

    expect(reference).toContain('[--profile core\\|full\\|strict]')
    expect(reference).toContain('`--profile strict` writes `MADAR_TOOL_PROFILE=strict`')
    expect(reference).toContain('call `context_pack` once for the task before broader exploration')
    expect(reference).toContain('`verify_targets` inspects only a listed expansion handle or file')
    expect(reference).toContain('only `insufficient` with `broad_search_fallback: allowed` permits one directory-scoped raw search')
  })

  it('documents that strict installs still use one bounded context_pack call in the CLI reference', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')

    expect(reference).toContain('`--profile strict` exposes those seven core tools plus `context_pack` and `context_expand`')
    expect(reference).toContain('Full-only additions beyond strict')
  })

  it('documents the local trust boundary and links the threat model from the README privacy section', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('Your coding agent may still send prompts or selected file context to its own model provider')
    expect(readme).toContain('Treat every local MCP install, hook, or agent profile as part of your local trust boundary.')
    expect(readme).toContain('docs/security/mcp-threat-model.md')
  })
})
