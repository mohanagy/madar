import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const STALE_PHRASES = ['384x', '397x', '897x', '384×', '397×', '897×']

function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8')
}

describe('public marketing copy honesty', () => {
  describe('examples/why-graphify.md', () => {
    const content = readDoc('examples/why-graphify.md')
    const lower = content.toLowerCase()

    for (const stale of STALE_PHRASES) {
      it(`does not contain the stale "${stale}" claim`, () => {
        expect(lower).not.toContain(stale.toLowerCase())
      })
    }

    it('cites the measured benchmark headline numbers', () => {
      expect(content).toMatch(/3x fewer turns|3× fewer turns/i)
      expect(content).toMatch(/2\.8x|2\.8×/i)
      expect(content).toMatch(/2\.6x|2\.6×/i)
    })

    it('discloses the cold-start cost premium honestly', () => {
      expect(lower).toMatch(/cold[- ]start|cost parity|amortize/i)
    })

    it('positions graphify-ts as a context plane and context compiler', () => {
      expect(lower).toContain('context plane')
      expect(lower).toContain('context compiler')
    })
  })

  describe('README.md', () => {
    const content = readDoc('README.md')
    const lower = content.toLowerCase()

    for (const stale of STALE_PHRASES) {
      it(`does not contain the stale "${stale}" claim`, () => {
        expect(lower).not.toContain(stale.toLowerCase())
      })
    }

    it('documents the measured latency benchmark with current README wording', () => {
      expect(content).toContain('| **Latency**')
      expect(content).toMatch(/35 sec|35 ?s/i)
      expect(content).toMatch(/96 sec|96 ?s/i)
    })

    it('documents the pack and prompt command surfaces', () => {
      expect(content).toContain('graphify-ts pack')
      expect(content).toContain('graphify-ts prompt')
      expect(lower).toContain('context plane')
    })

    it('keeps the README core MCP surface aligned with the shipped graph_stats tool', () => {
      expect(content).toContain('These six MCP tools')
      expect(content).toContain('`graph_stats`')
    })

    it('keeps the README full MCP additions list aligned with the shipped get_neighbors tool', () => {
      expect(content).toContain('The full surface is 24 tools')
      expect(content).toContain('`get_neighbors`')
    })
  })

  describe('examples/mcp-tool-examples.md', () => {
    const content = readDoc('examples/mcp-tool-examples.md')
    const lower = content.toLowerCase()

    it('documents the context-plane MCP tools', () => {
      expect(content).toContain('## context_pack')
      expect(content).toContain('## context_prompt')
      expect(content).toContain('## context_session_reset')
      expect(lower).toContain('effective_token_count')
      expect(lower).toContain('coverage')
    })
  })
})
