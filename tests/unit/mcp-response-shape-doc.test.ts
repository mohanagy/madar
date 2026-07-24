import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('MCP response documentation', () => {
  it('documents the deterministic retrieve v1 envelope and its hard boundaries', () => {
    const doc = readFileSync(resolve('docs/mcp-response-shape.md'), 'utf8')

    expect(doc).toContain('# MCP response shape')
    expect(doc).toContain('"schema": "madar.retrieve"')
    expect(doc).toContain('"version": 1')
    expect(doc).toContain('matched_nodes')
    expect(doc).toContain('relationships')
    expect(doc).toContain('boundaries')
    expect(doc).toContain('metrics')
    expect(doc).toContain('content_hash')
    expect(doc).toContain('SHA-256')
    for (const boundary of [
      'missing',
      'disconnected',
      'unsupported',
      'stale',
      'unavailable',
      'corrupt',
      'truncated',
    ]) {
      expect(doc).toContain(`\`${boundary}\``)
    }
    expect(doc).toContain('at most 12 source files')
    expect(doc).toContain('at most 25 snippets')
    expect(doc).toContain('at most 4,000')
    expect(doc).not.toContain('pack_confidence')
    expect(doc).not.toContain('answerability')
  })
})
