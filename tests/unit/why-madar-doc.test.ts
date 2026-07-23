import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('public product copy', () => {
  it('states the current one-query product and its limits honestly', () => {
    const readme = read('README.md')
    const why = read('examples/why-madar.md')
    const claims = read('docs/claims-and-evidence.md')
    const publicCopy = [readme, why, claims].join('\n')
    const lower = publicCopy.toLowerCase()

    expect(readme).toContain('retrieve(question, budget?)')
    expect(readme).toContain('authenticated repository evidence')
    expect(readme).toContain('at most 12 files, 25 snippets')
    expect(readme).toContain('not a runtime tracer, PR reviewer, vulnerability scanner')
    expect(why).toContain('## What it does')
    expect(why).toContain('## What it does not do')
    expect(claims).toContain('## Demonstrated today')
    expect(claims).toContain('## Historical measurements')
    expect(claims).toContain('## Not yet measured')
    expect(lower).toContain('not current universal performance claims')
    expect(lower).not.toMatch(/384x|397x|897x|384×|397×|897×/)
  })

  it('keeps the active MCP examples on retrieve only', () => {
    const examples = read('examples/mcp-tool-examples.md')

    expect(examples).toContain('exactly one MCP tool')
    expect(examples).toContain('"name": "retrieve"')
    expect(examples).toContain('"schema": "madar.retrieve"')
    expect(examples).toContain('madar query')
    for (const retired of [
      'context_pack',
      'context_expand',
      'context_prompt',
      'context_session_reset',
      'pr_impact',
      'time_travel',
    ]) {
      expect(examples).not.toContain(retired)
    }
  })
})
