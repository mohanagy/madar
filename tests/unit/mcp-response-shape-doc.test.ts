import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('mcp response shape documentation', () => {
  it('documents the evidence block and deterministic agent_directive mapping', () => {
    const doc = readFileSync(resolve('docs/mcp-response-shape.md'), 'utf8')

    expect(doc).toContain('# MCP response shape')
    expect(doc).toContain('evidence')
    expect(doc).toContain('pack_confidence')
    expect(doc).toContain('coverage')
    expect(doc).toContain('missing_phases')
    expect(doc).toContain('covered_workflow_owners')
    expect(doc).toContain('agent_directive')
    expect(doc).toContain('answer_from_pack')
    expect(doc).toContain('verify_one_targeted_file')
    expect(doc).toContain('explore_with_caution')
    expect(doc).toContain('confidence >= 0.85')
    expect(doc).toContain('complete coverage')
    expect(doc).toContain('partial coverage')
    expect(doc).toContain('unknown coverage')
  })
})
