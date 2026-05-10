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

    it('states that core is the default MCP profile and full is opt-in', () => {
      expect(lower).toContain('by default')
      expect(content).toContain('core')
      expect(content).toContain('GRAPHIFY_TOOL_PROFILE=full')
      expect(content).toContain('--profile full')
    })

    it('keeps the README full MCP additions list aligned with the shipped get_neighbors tool', () => {
      expect(content).toContain('The full surface is 25 tools')
      expect(content).toContain('`context_expand`')
      expect(content).toContain('`get_neighbors`')
    })

    it('pins the 2026-05-09 demo-video caption headline reductions', () => {
      expect(content).toMatch(/2[,]?811[,]?682/)
      expect(content).toMatch(/532[,]?021/)
      expect(content).toMatch(/5\.28x|5\.28×/i)
      expect(content).toMatch(/2\.21x|2\.21×/i)
      expect(content).toMatch(/1\.58x|1\.58×/i)
    })

    it('links the 2026-05-09 auth-e2e benchmark folder from the README', () => {
      expect(content).toContain('docs/benchmarks/2026-05-09-govalidate-auth-e2e/')
    })
  })

  describe('docs/benchmarks/2026-05-09-govalidate-auth-e2e/', () => {
    const content = readDoc('docs/benchmarks/2026-05-09-govalidate-auth-e2e/README.md')
    const verify = readDoc('docs/benchmarks/2026-05-09-govalidate-auth-e2e/verify.sh')

    it('pins the captured Anthropic-reported reductions in the benchmark README', () => {
      expect(content).toMatch(/5\.28x|5\.28×/i)
      expect(content).toMatch(/2\.21x|2\.21×/i)
      expect(content).toMatch(/1\.58x|1\.58×/i)
      expect(content).toContain('Anthropic-reported')
      expect(content).toContain('--baseline-mode native_agent')
    })

    it('ships a verify.sh reproducer that reads report.json and exits cleanly when missing', () => {
      expect(verify).toContain('#!/usr/bin/env bash')
      expect(verify).toContain('report.json')
      expect(verify).toContain('not found')
      expect(verify).toContain('graphify-out/compare/2026-05-09T23-21-35')
    })
  })

  describe('examples/mcp-tool-examples.md', () => {
    const content = readDoc('examples/mcp-tool-examples.md')
    const lower = content.toLowerCase()

    it('documents the context-plane MCP tools', () => {
      expect(content).toContain('## context_pack')
      expect(content).toContain('## context_expand')
      expect(content).toContain('## context_prompt')
      expect(content).toContain('## context_session_reset')
      expect(lower).toContain('effective_token_count')
      expect(lower).toContain('coverage')
    })
  })
})
