import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('getting started tutorial', () => {
  it('documents an end-to-end sample workspace walkthrough', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial).toContain('npm install -g @lubab/madar')
    expect(tutorial).not.toContain('migration')
    expect(tutorial).toContain('madar generate examples/sample-workspace --no-html')
    expect(tutorial).toContain('madar pack')
    expect(tutorial).toContain('madar prompt')
    expect(tutorial).toContain('madar compare')
    expect(tutorial).toContain('--exec')
    expect(tutorial).toContain('--yes')
    expect(tutorial.toLowerCase()).toContain('expected output')
    expect(tutorial.toLowerCase()).toContain('troubleshooting')
    expect(tutorial.toLowerCase()).toContain('optional')
    expect(tutorial).toContain('examples/sample-workspace')
    expect(readme).toContain('docs/tutorials/getting-started.md')
  })

  it('keeps the first-run path focused on install, install verification, one pack, and a safe compare', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial).toContain('cd examples/sample-workspace')
    expect(tutorial).toContain('madar claude install')
    expect(tutorial).toContain('madar doctor out/graph.json')
    expect(tutorial).toContain('madar status out/graph.json')
    expect(tutorial).toContain('madar pack "how does password reset request enqueue the reset email"')
    expect(tutorial).toContain('madar generate . --no-html')
    expect(tutorial).toContain('madar generate . --spi --no-html')
    expect(tutorial.toLowerCase()).toContain('paid model')
    expect(tutorial.toLowerCase()).toContain('10-minute')
    expect(readme).toContain('## Choose your agent')
    expect(readme).toContain('Claude Code')
    expect(readme).toContain('Codex CLI')
    expect(readme).toContain('Cursor')
    expect(readme).toContain('GitHub Copilot CLI')
    expect(readme).toContain('Gemini CLI')
    expect(readme).toContain('Aider')
    expect(readme).toContain('OpenCode')
    expect(readme).toContain('compare and benchmark flows can spend paid model tokens')
    expect(readme).toContain('check the local install wiring for Claude Code, Cursor, Gemini CLI, and GitHub Copilot CLI')
    expect(readme).toContain('lint the AGENTS-based Madar instruction profiles for Codex CLI, OpenCode, and Aider')
    expect(readme).toContain('`madar doctor` and `madar status`')
  })
})
