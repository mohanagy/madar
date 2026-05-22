import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const STALE_PHRASES = ['384x', '397x', '897x', '384×', '397×', '897×']

function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8')
}

describe('public marketing copy honesty', () => {
  describe('examples/why-madar.md', () => {
    const content = readDoc('examples/why-madar.md')
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

    it('positions madar as a context plane and context compiler', () => {
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

    it('documents the pack, prompt, and summary command surfaces', () => {
      expect(content).toContain('madar pack')
      expect(content).toContain('madar prompt')
      expect(content).toContain('madar summary')
      expect(lower).toContain('context plane')
    })

    it('surfaces the 0.23.0 user-facing additions in the main README flow', () => {
      expect(lower).toContain("what's new in 0.23.0")
      expect(content).toContain('`madar summary`')
      expect(content).toContain('`graph_summary`')
      expect(content).toContain('`execution_slice`')
      expect(content).toContain('report.share-safe.json')
      expect(content).toContain('--baseline-mode pack_only')
      expect(content).toContain('docs/benchmarks/govalidate-suite/')
    })

    it('explains when users should opt into --spi', () => {
      expect(lower).toContain('when to use `--spi`')
      expect(lower).toContain('still opt-in')
      expect(lower).toContain('storage-oriented prompts')
      expect(lower).toContain('next.js')
      expect(lower).toContain('disk cache')
    })

    it('keeps the README core MCP surface aligned with the shipped graph_summary tool', () => {
      expect(content).toContain('These seven MCP tools')
      expect(content).toContain('`graph_stats`')
      expect(content).toContain('`graph_summary`')
    })

    it('states that core is the default MCP profile and full is opt-in', () => {
      expect(lower).toContain('by default')
      expect(content).toContain('core')
      expect(content).toContain('MADAR_TOOL_PROFILE=full')
      expect(content).toContain('--profile full')
    })

    it('keeps the README full MCP additions list aligned with the shipped get_neighbors tool', () => {
      expect(content).toContain('The full surface is 26 tools')
      expect(content).toContain('`context_expand`')
      expect(content).toContain('`get_neighbors`')
    })

    it('pins the measured post-#82 core-profile schema overhead numbers in the Honest disclosure section', () => {
      // Per the project's doc-honesty rule, a README claim about a measured
      // number must be backed by a test that asserts the README contains the
      // current measurement. If a future PR reduces it further, update both
      // the README number and the regex below in the same PR. The matched
      // numbers come straight from tests/unit/mcp-schema-budget.test.ts.
      expect(lower).toMatch(/~\s*800\s*tokens/)
      expect(lower).toMatch(/~?\s*3[,.]?200\s*bytes/)
      expect(lower).toMatch(/25%/)
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

  describe('docs/tutorials/getting-started.md', () => {
    const content = readDoc('docs/tutorials/getting-started.md')
    const lower = content.toLowerCase()

    it('starts the walkthrough with generate, summary, and compact retrieval surfaces', () => {
      expect(content).toContain('madar generate examples/sample-workspace --no-html')
      expect(content).toContain('madar summary examples/sample-workspace/out/graph.json')
      expect(content).toContain('madar pack')
      expect(content).toContain('madar prompt')
    })

    it('mentions the opt-in SPI path and the compare artifacts users should notice', () => {
      expect(content).toContain('madar generate examples/sample-workspace --spi --no-html')
      expect(content).toContain('--baseline-mode pack_only')
      expect(content).toContain('report.share-safe.json')
      expect(lower).toContain('execution_slice')
    })
  })

  describe('docs/language-capability-matrix.md', () => {
    const content = readDoc('docs/language-capability-matrix.md')

    it('translates the latest runtime retrieval semantics into user-facing capability notes', () => {
      expect(content).toContain('`enqueues_job`')
      expect(content).toContain('`storage_operation`')
      expect(content).toContain('`runtime_boundary`')
      expect(content).toContain('FastAPI')
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
      expect(verify).toContain('out/compare/2026-05-09T23-21-35')
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
      expect(runSh).toContain('madar compare')
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
    const findings = readDoc('docs/experiments/2026-05-10-current-vs-slicing/findings.md')
    const runSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/run.sh')
    const aggregateSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/aggregate.sh')
    const sliceV1Sh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/slice-v1.sh')
    const lexicalSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/lexical-baseline.sh')
    const fullSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/full-context.sh')
    const currentSh = readDoc('docs/experiments/2026-05-10-current-vs-slicing/strategies/current-madar.sh')
    const prompts = JSON.parse(readDoc('docs/experiments/2026-05-10-current-vs-slicing/prompts.json')) as {
      version: number
      prompts: Array<{ id: string; task: string; text: string }>
    }

    it('declares the spike scope and links the tracking issue (#71)', () => {
      expect(readme).toMatch(/#71|issues\/71/)
      expect(readme).toContain('v0.14-substrate')
      expect(readme).toContain('Current retrieval vs task-conditioned slicing')
    })

    it('ships a real slice-v1 strategy adapter instead of the old stub', () => {
      expect(sliceV1Sh).toContain('slice-v1')
      expect(sliceV1Sh).toContain('--retrieval-strategy slice-v1')
      expect(readme).toContain('slice-v1')
      expect(readme).not.toContain('slicer-stub')
    })

    it('ships four strategy adapters with the documented contract', () => {
      for (const script of [currentSh, lexicalSh, sliceV1Sh, fullSh]) {
        expect(script).toContain('#!/usr/bin/env bash')
        expect(script).toContain('--prompt')
        expect(script).toContain('--task')
        expect(script).toContain('--workspace')
        expect(script).toContain('--out')
      }
    })

    it('avoids re-walking snippet payloads in the current-madar pack renderer', () => {
      expect(currentSh).toContain('Object.entries(o)')
      for (const key of ['snippet', 'snippets', 'body', 'claim', 'text']) {
        expect(currentSh).toContain(`key === "${key}"`)
      }
      expect(currentSh).not.toContain('Object.values(o).forEach(walk)')
    })

    it('uses portable Date.now() millisecond timing (no GNU-only date +%s%3N)', () => {
      for (const script of [runSh, currentSh, lexicalSh, sliceV1Sh, fullSh]) {
        expect(script).not.toMatch(/date \+%s%3N/)
      }
      expect(runSh).not.toContain('mapfile')
    })

    it('keeps the prompts.json contract: 8 demo-repo prompts across all four task modes', () => {
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

    it('includes a findings doc with a concrete recommendation', () => {
      expect(findings).toContain('## Recommendation')
      expect(findings).toContain('examples/demo-repo')
      expect(findings).toMatch(/slice-v1|current-madar|lexical-baseline|full-context/)
    })
  })

  describe('docs/benchmarks/2026-05-10-backend-vs-monorepo/ portability', () => {
    const runSh = readDoc('docs/benchmarks/2026-05-10-backend-vs-monorepo/run.sh')

    it('uses portable Date.now() millisecond timing (no GNU-only date +%s%3N)', () => {
      expect(runSh).not.toMatch(/date \+%s%3N/)
    })
  })

  describe('docs/designs/2026-05-10-spi-v1.md', () => {
    const content = readDoc('docs/designs/2026-05-10-spi-v1.md')

    it('declares the design scope and links the tracking issue (#70)', () => {
      expect(content).toMatch(/#70|issues\/70/)
      expect(content).toContain('v0.14-substrate')
      expect(content).toContain('design only')
    })

    it('locks in the SemanticProgramIndex top-level shape', () => {
      expect(content).toContain('type SemanticProgramIndex')
      expect(content).toContain('version: 1')
      expect(content).toContain('files:')
      expect(content).toContain('symbols:')
      expect(content).toContain('edges:')
      expect(content).toContain('diagnostics:')
    })

    it('documents every layer #70 lists in the issue body', () => {
      for (const layer of [
        'File layer',
        'Symbol layer',
        'Call layer',
        'Type layer',
        'Test layer',
        'Diff layer',
        'Framework layer',
      ]) {
        expect(content).toContain(layer)
      }
    })

    it('locks confidence to {high, medium, low} and source provenance to a closed set', () => {
      expect(content).toMatch(/confidence:\s*'high'\s*\|\s*'medium'\s*\|\s*'low'/)
      expect(content).toContain("'typescript-semantic'")
      expect(content).toContain("'tree-sitter'")
      expect(content).toContain("'framework-decorator'")
      expect(content).toContain("'heuristic'")
    })

    it('cross-links the consuming and adjacent issues so the design is discoverable', () => {
      for (const ref of ['#69', '#71', '#72', '#73', '#74', '#77', '#78']) {
        expect(content).toContain(ref)
      }
    })

    it('explicitly lists non-goals and open questions to scope the design honestly', () => {
      expect(content).toContain('## Non-goals')
      expect(content).toContain('## Open questions')
      expect(content).toContain('## Risks')
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
