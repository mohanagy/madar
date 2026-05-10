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

  describe('docs/benchmarks/2026-05-10-backend-vs-monorepo/', () => {
    const readme = readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/README.md')
    const runSh = readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/run.sh')
    const aggregateSh = readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/aggregate.sh')
    const prompts = JSON.parse(readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/prompts.json')) as {
      version: number
      quick_subset: string[]
      prompts: Array<{ id: string; task: string; text: string }>
    }

    it('declares the spike scope and links the tracking issue (#69)', () => {
      expect(readme).toContain('issue #69')
      expect(readme).toContain('v0.14-substrate')
      expect(readme).toContain('Backend-only vs monorepo')
    })

    it('ships a runnable harness with the documented argument surface', () => {
      expect(runSh).toContain('#!/usr/bin/env bash')
      expect(runSh).toContain('--backend-path')
      expect(runSh).toContain('--monorepo-path')
      expect(runSh).toContain('--exec')
      expect(runSh).toContain('--quick')
      expect(runSh).toContain('graphify-ts compare')
      expect(runSh).toContain('--baseline-mode native_agent')
    })

    it('ships an aggregator that reads summary.json from a results bundle', () => {
      expect(aggregateSh).toContain('#!/usr/bin/env bash')
      expect(aggregateSh).toContain('summary.json')
    })

    it('keeps the prompts.json contract: 12 prompts, 3 in the quick subset, every quick id present', () => {
      expect(prompts.version).toBe(1)
      expect(prompts.prompts).toHaveLength(12)
      expect(prompts.quick_subset).toHaveLength(3)
      const ids = new Set(prompts.prompts.map((p) => p.id))
      for (const quickId of prompts.quick_subset) {
        expect(ids.has(quickId)).toBe(true)
      }
      for (const prompt of prompts.prompts) {
        expect(prompt.id).toMatch(/^[a-z0-9-]+$/)
        expect(['explain', 'debug', 'review', 'impact']).toContain(prompt.task)
        expect(prompt.text.length).toBeGreaterThan(20)
      }
    })
  })

  describe('docs/experiments/2026-05-10-current-vs-slicing/', () => {
    const readme = readDoc('docs/experiments/2026-05-10-current-vs-slicing/README.md')
    const runSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/run.sh')
    const aggregateSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/aggregate.sh')
    const stubSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/slicer-stub.sh')
    const lexicalSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/lexical-baseline.sh')
    const fullSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/full-context.sh')
    const currentSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/current-graphify.sh')
    const prompts = JSON.parse(readDoc('docs/experiments/2026-05-10-current-vs-slicing/prompts.json')) as {
      version: number
      prompts: Array<{ id: string; task: string; text: string }>
    }

    it('declares the spike scope and links the tracking issue (#71)', () => {
      expect(readme).toMatch(/#71|issues\/71/)
      expect(readme).toContain('v0.14-substrate')
      expect(readme).toContain('Current retrieval vs task-conditioned slicing')
    })

    it('explicitly marks the slicer as a stub blocked on #73', () => {
      expect(stubSh).toContain('issues/73')
      expect(stubSh).toContain('exit 78')
      expect(readme).toContain('#73')
    })

    it('ships four strategy adapters with the documented contract', () => {
      for (const script of [currentSh, lexicalSh, stubSh, fullSh]) {
        expect(script).toContain('#!/usr/bin/env bash')
        expect(script).toContain('--prompt')
        expect(script).toContain('--workspace')
        expect(script).toContain('--out')
      }
    })

    it('uses portable Date.now() millisecond timing (no GNU-only date +%s%3N)', () => {
      for (const script of [runSh, currentSh, lexicalSh, fullSh]) {
        expect(script).not.toMatch(/date \+%s%3N/)
      }
    })

    it('keeps the prompts.json contract: 8 prompts, all four task modes covered', () => {
      expect(prompts.version).toBe(1)
      expect(prompts.prompts).toHaveLength(8)
      const tasks = new Set(prompts.prompts.map((p) => p.task))
      for (const expected of ['explain', 'debug', 'review', 'impact']) {
        expect(tasks.has(expected)).toBe(true)
      }
      for (const prompt of prompts.prompts) {
        expect(prompt.id).toMatch(/^[a-z0-9-]+$/)
        expect(['explain', 'debug', 'review', 'impact']).toContain(prompt.task)
        expect(prompt.text.length).toBeGreaterThan(20)
      }
    })

    it('ships the orchestrator and aggregator with the documented argument surface', () => {
      expect(runSh).toContain('--workspace')
      expect(runSh).toContain('--strategies')
      expect(runSh).toContain('--exec')
      expect(runSh).toContain('--prompt-ids')
      expect(aggregateSh).toContain('summary.json')
    })
  })

  describe('docs/benchmarks/2026-05-10-backend-vs-monorepo/ portability', () => {
    const runSh = readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/run.sh')

    it('uses portable Date.now() millisecond timing (no GNU-only date +%s%3N)', () => {
      expect(runSh).not.toMatch(/date \+%s%3N/)
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
