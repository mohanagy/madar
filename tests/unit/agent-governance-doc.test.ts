import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('agent governance documentation', () => {
  it('requires one retrieve call, a ready dossier, and exact non-ready gaps', () => {
    const doc = readFileSync(resolve('docs/agent-governance.md'), 'utf8')

    expect(doc).toContain('call `retrieve` once')
    expect(doc).toContain('`ready` dossier')
    expect(doc).toContain('authenticated evidence')
    expect(doc).toContain('exact non-ready `missing`, `reason`, or `failure`')
    expect(doc).toContain('guidance, not enforcement')
    expect(doc).not.toContain('context_pack')
    expect(doc).not.toContain('pack_confidence')
  })
})
