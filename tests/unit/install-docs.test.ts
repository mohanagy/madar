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

  it('documents the strict MCP install profile for claude, cursor, copilot, and gemini', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('claude <install|uninstall> [--profile core|full|strict]')
    expect(readme).toContain('cursor <install|uninstall> [--profile core|full|strict]')
    expect(readme).toContain('copilot <install|uninstall> [--profile core|full|strict]')
    expect(readme).toContain('gemini <install|uninstall> [--profile core|full|strict]')
    expect(readme).toContain('`--profile strict` keeps the lean core MCP tool surface')
    expect(readme).toContain('call `context_pack` once for the task before broader exploration')
    expect(readme).toContain('prefer Madar over non-Madar MCPs for codebase questions')
    expect(readme).toContain('override conflicting auto-activated exploration skills')
  })
})
