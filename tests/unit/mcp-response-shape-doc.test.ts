import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('mcp response shape documentation', () => {
  it('documents independent evidence dimensions and cumulative recovery', () => {
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
    expect(doc).toContain('evidence_strength')
    expect(doc).toContain('coverage_detail')
    expect(doc).toContain('answerability')
    expect(doc).toContain('ready_with_caveat')
    expect(doc).toContain('verify_targets')
    expect(doc).toContain('insufficient')
    expect(doc).toContain('verification_targets')
    expect(doc).toContain('Cumulative recovery')
    expect(doc).toContain('max_candidate_nodes')
    expect(doc).toContain('compatibility projection')
  })
})
