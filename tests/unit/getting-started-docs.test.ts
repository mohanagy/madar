import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('getting started tutorial', () => {
  it('documents an end-to-end sample workspace walkthrough', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial).toContain('madar try')
    expect(tutorial).toContain('npm install -g @lubab/madar')
    expect(tutorial).not.toContain('migration')
    expect(tutorial).toContain('madar generate examples/sample-workspace')
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

  it('keeps the first-run path focused on try, install, doctor/status, and the supported agent commands', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial.indexOf('madar try')).toBeGreaterThanOrEqual(0)
    expect(tutorial.indexOf('madar try')).toBeLessThan(tutorial.indexOf('madar generate examples/sample-workspace'))
    expect(tutorial).toContain('cd examples/sample-workspace')
    expect(tutorial).toContain('madar claude install')
    expect(tutorial).toContain('madar doctor out/graph.json')
    expect(tutorial).toContain('madar status out/graph.json')
    expect(tutorial).toContain('`doctor`/`status` also report Codex, Aider, and OpenCode when their AGENTS/hook/plugin/MCP signals are present')
    expect(tutorial).toContain('madar pack "how does password reset request enqueue the reset email"')
    expect(tutorial).toContain('madar generate .')
    expect(tutorial).toContain('madar generate . --spi')
    expect(tutorial.toLowerCase()).toContain('paid model')
    expect(tutorial.toLowerCase()).toContain('10-minute')
    expect(readme).toContain('## Connect Your Agent')
    expect(readme).toContain('madar try')
    expect(readme.indexOf('madar try')).toBeLessThan(readme.indexOf('madar generate .'))
    for (const command of [
      'madar claude install',
      'madar codex install',
      'madar cursor install',
      'madar copilot install',
      'madar gemini install',
      'madar aider install',
      'madar opencode install',
    ]) {
      expect(readme).toContain(command)
    }
    expect(readme).toContain('After installing a profile, run `madar doctor` and `madar status`.')
    expect(readme).toContain('Installer details are in the [CLI and MCP reference]')
    expect(readme).toContain('madar pack "how does auth work?" --task explain --format text')
    expect(readme).toContain('madar prompt "how does auth work?" --provider claude')
    expect(readme).toContain('madar handoff "add auth telemetry" --task implement --consumer copilot')
  })
})
