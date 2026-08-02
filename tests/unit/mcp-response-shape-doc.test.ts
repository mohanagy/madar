import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('MCP response documentation', () => {
  it('documents the deterministic retrieve v2 dossier and its hard boundaries', () => {
    const doc = readFileSync(resolve('docs/mcp-response-shape.md'), 'utf8')

    expect(doc).toContain('# MCP response shape')
    expect(doc).toContain('"schema": "madar.retrieve"')
    expect(doc).toContain('"version": 2')
    expect(doc).toContain('"state": "ready"')
    expect(doc).toContain('"dossier"')
    expect(doc).toContain('"obligations"')
    expect(doc).toContain('"flow"')
    expect(doc).toContain('"roots": []')
    expect(doc).toContain('"evidence"')
    expect(doc).not.toContain('"node_kind": "function"')
    expect(doc).toContain('metrics')
    expect(doc).toContain('sha256-base64url')
    for (const state of [
      'ready',
      'incomplete',
      'unsupported',
      'stale',
      'unavailable',
      'corrupt',
    ]) {
      expect(doc).toContain(`\`${state}\``)
    }
    expect(doc).toContain('at most 12 source files')
    expect(doc).toContain('25 authenticated excerpts')
    expect(doc).toContain('at most 4,000')
    expect(doc).toContain('at most two recovery passes')
    expect(doc).not.toContain('"version": 1')
    expect(doc).not.toContain('matched_nodes')
  })
})
