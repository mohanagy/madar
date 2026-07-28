import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('mcp threat model documentation', () => {
  it('documents the trust boundary, key threats, and least-privilege guidance', () => {
    const doc = readFileSync(resolve('docs/security/mcp-threat-model.md'), 'utf8')

    expect(doc).toContain('# MCP security threat model')
    expect(doc.toLowerCase()).toContain('trust boundary')
    expect(doc).toContain('prompt injection')
    expect(doc).toContain('path traversal')
    expect(doc).toContain('overly broad tool surfaces')
    expect(doc).toContain('authenticated')
    expect(doc.toLowerCase()).toContain('least privilege')
    expect(doc).toContain('exactly one tool')
    expect(doc).toContain('4,000 serialized tokens')
    expect(doc).not.toContain('MADAR_TOOL_PROFILE')
  })
})
