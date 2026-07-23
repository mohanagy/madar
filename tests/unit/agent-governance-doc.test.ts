import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('agent governance documentation', () => {
  it('requires one retrieve call, authenticated evidence, and explicit boundaries', () => {
    const doc = readFileSync(resolve('docs/agent-governance.md'), 'utf8')

    expect(doc).toContain('call `retrieve` once')
    expect(doc).toContain('authenticated nodes')
    expect(doc).toContain('directed relationships')
    expect(doc).toContain('state every returned evidence boundary')
    expect(doc).toContain('guidance, not enforcement')
    expect(doc).not.toContain('context_pack')
    expect(doc).not.toContain('pack_confidence')
  })
})
