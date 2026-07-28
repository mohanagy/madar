import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('install documentation', () => {
  it('documents the bounded Claude and Codex external registration surface', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const quickstarts = readFileSync(resolve('docs/tutorials/agent-quickstarts.md'), 'utf8')

    expect(reference).toContain('There are no install profiles')
    expect(reference).toContain('exactly one tool')
    expect(reference).toContain('`retrieve`')
    expect(reference).toContain('There are no MCP resources or prompts')
    expect(reference).toContain('madar install claude')
    expect(reference).toContain('madar install codex')
    expect(reference).toContain('zero repository bytes')
    expect(reference).toContain('`~/.codex/config.toml`')
    expect(reference).toContain('startup_timeout_sec = 180')
    expect(reference).toContain('tool_timeout_sec = 60')
    expect(reference).toContain('Cursor, GitHub Copilot, Gemini, OpenCode, Aider, and other clients are not direct installer targets')
    expect(quickstarts).toContain('call `retrieve` once')
    expect(quickstarts).toContain('validate configuration on disk')

    for (const retired of [
      '--profile',
      'MADAR_TOOL_PROFILE',
      'context_pack',
      'madar pack',
      'madar claude',
      'madar codex',
      'madar cursor',
      'madar copilot',
      'madar gemini',
      'madar opencode',
      '.opencode/plugins/madar.js',
      '/hooks',
    ]) {
      expect(reference).not.toContain(retired)
      expect(quickstarts).not.toContain(retired)
    }
  })

  it('links the local MCP trust boundary', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('your coding agent may still send your question or returned excerpts')
    expect(readme).toContain('part of your local trust boundary')
    expect(readme).toContain('docs/security/mcp-threat-model.md')
  })
})
