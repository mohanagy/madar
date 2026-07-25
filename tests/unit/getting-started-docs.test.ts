import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('getting started documentation', () => {
  it('documents generate, install, and one retrieval call as the first-run path', () => {
    const tutorial = read('docs/tutorials/getting-started.md')
    const readme = read('README.md')

    expect(tutorial).toContain('npm install -g @lubab/madar')
    expect(tutorial).toContain('madar generate examples/sample-workspace')
    expect(tutorial).toContain('madar query "how does password reset request enqueue the reset email?"')
    expect(tutorial).toContain('madar install claude')
    expect(tutorial).toContain('madar install codex')
    expect(tutorial).toContain('madar doctor')
    expect(tutorial).toContain('madar status')
    expect(tutorial).toContain('call `retrieve` exactly once')
    expect(tutorial).toContain('zero repository bytes')
    expect(tutorial).toContain('arguments `["mcp"]`')
    expect(tutorial.toLowerCase()).toContain('expected output')
    expect(tutorial.toLowerCase()).toContain('troubleshooting')
    expect(tutorial).toContain('../design-partners.md')

    expect(readme).toContain('## Start in three steps')
    expect(readme).toContain('madar generate .')
    expect(readme).toContain('madar install claude')
    expect(readme).toContain('retrieve(question, budget?)')
    expect(readme).toContain('madar query "how does authentication work?"')
  })

  it('does not advertise retired generation modes or query products', () => {
    const docs = [
      read('README.md'),
      read('docs/tutorials/getting-started.md'),
      read('docs/reference/cli-and-mcp.md'),
    ].join('\n')

    for (const retired of [
      '--legacy',
      '--spi',
      '--include-docs',
      'madar try',
      'madar pack',
      'madar prompt',
      'madar handoff',
      'madar serve',
      'madar watch',
      'madar telemetry',
      'madar hook',
      'madar cursor',
      'madar copilot',
      'madar gemini',
      'madar opencode',
      '--stdio',
      '--auto-refresh',
      '--neo4j',
      'context_pack',
      'context_expand',
      'MADAR_TOOL_PROFILE',
    ]) {
      expect(docs).not.toContain(retired)
    }
  })
})
