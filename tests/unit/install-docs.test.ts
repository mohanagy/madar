import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('install documentation', () => {
  it('documents Aider and OpenCode install artifacts and context-pack-first workflow', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('| Aider | AGENTS.md context-pack-first profile | `madar aider install` |')
    expect(readme).toContain(
      '| OpenCode | AGENTS.md + `.opencode/plugins/madar.js` + MCP via `opencode.json` / `opencode.jsonc` | `madar opencode install` |',
    )
    expect(readme).toContain('Aider and OpenCode are intentionally context-pack-first')
    expect(readme).toContain('madar pack "<task>" --task explain')
    expect(readme).toContain('madar aider uninstall')
    expect(readme).toContain('madar opencode uninstall')
  })

  it('documents doctor/status instruction lint surfaces per agent', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('`doctor` / `status` lint surface')
    expect(readme).toContain('| Claude Code | MCP via `.mcp.json` | `madar claude <install\\|uninstall> [--profile core\\|full\\|strict]` | `CLAUDE.md` + `.claude/settings.json` hook + `.mcp.json` |')
    expect(readme).toContain('| Aider | AGENTS.md context-pack-first profile | `madar aider install` | `AGENTS.md` Aider profile |')
    expect(readme).toContain('| OpenCode | AGENTS.md + `.opencode/plugins/madar.js` + MCP via `opencode.json` / `opencode.jsonc` | `madar opencode install` | `AGENTS.md` OpenCode profile + plugin registration + MCP entry |')
    expect(readme).toContain('| Codex CLI | AGENTS.md + `.codex/hooks.json` context-pack-first profile | `madar codex install` | `AGENTS.md` Codex profile + `.codex/hooks.json` |')
    expect(readme).toContain('mark the agent as `partial` and suggest the matching reinstall command')
  })

  it('documents handoff as the share-safe remote-agent artifact distinct from local pack and prompt flows', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('madar handoff "add auth telemetry" --task implement --consumer copilot')
    expect(readme).toContain('share-safe remote/background-agent artifact')
    expect(readme).toContain('`madar pack` stays the richer local/full-context surface')
    expect(readme).toContain('`madar prompt` stays local')
  })

  it('documents the strict MCP install profile for claude, cursor, copilot, and gemini', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('claude <install\\|uninstall> [--profile core\\|full\\|strict]')
    expect(readme).toContain('cursor <install\\|uninstall> [--profile core\\|full\\|strict]')
    expect(readme).toContain('copilot <install\\|uninstall> [--profile core\\|full\\|strict]')
    expect(readme).toContain('gemini <install\\|uninstall> [--profile core\\|full\\|strict]')
    expect(readme).toContain('`--profile strict` keeps the lean core MCP tool surface')
    expect(readme).toContain('call `context_pack` once for the task before broader exploration')
    expect(readme).toContain('prefer Madar over non-Madar MCPs for codebase questions')
    expect(readme).toContain('override conflicting auto-activated exploration skills')
  })

  it('documents the local trust boundary and least-privilege install guidance', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('Treat every Madar MCP install, plugin, hook, or AGENTS profile as a local trust boundary.')
    expect(readme).toContain('Only enable it for repositories and local agent runtimes you trust.')
    expect(readme).toContain('Prefer `--profile strict` when you only need the lean core MCP tools.')
    expect(readme).toContain('docs/security/mcp-threat-model.md')
  })
})
