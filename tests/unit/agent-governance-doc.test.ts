import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('agent governance docs', () => {
  it('documents source-safe governance receipts for pack surfaces', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'agent-governance.md'), 'utf8')

    expect(doc).toContain('source-safe governance receipt')
    expect(doc).toContain('madar pack --format json')
    expect(doc).toContain('context_pack')
    expect(doc).toContain('graph_version')
    expect(doc).toContain('cache_status')
    expect(doc).toContain('delta_session_hash')
    expect(doc).toContain('does **not** include')
    expect(doc).toContain('confidence_reasons')
    expect(doc).toContain('covered_workflow_owners')
    expect(doc).toContain('source_file')
  })
})
