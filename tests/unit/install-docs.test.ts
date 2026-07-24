import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('install documentation', () => {
  it('documents one retrieve surface across project-local integrations', () => {
    const reference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const quickstarts = readFileSync(resolve('docs/tutorials/agent-quickstarts.md'), 'utf8')

    expect(reference).toContain('There are no install profiles')
    expect(reference).toContain('exactly one tool')
    expect(reference).toContain('`retrieve`')
    for (const agent of ['claude', 'cursor', 'copilot', 'gemini', 'codex', 'opencode', 'aider']) {
      expect(reference).toContain(`madar ${agent}`)
    }
    expect(reference).toContain('.opencode/plugins/madar.js')
    expect(reference).toContain('`~/.codex/config.toml`')
    expect(reference).toContain('`/hooks`')
    expect(reference).toContain('`/mcp`')
    expect(reference).toContain('guidance, not enforcement')
    expect(quickstarts).toContain('call `retrieve` once')
    expect(quickstarts).toContain('on-disk wiring only')

    for (const retired of ['--profile', 'MADAR_TOOL_PROFILE', 'context_pack', 'madar pack']) {
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
