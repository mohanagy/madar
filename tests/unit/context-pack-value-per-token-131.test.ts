// v0.20 #131 — value-per-token selection_strategy on compileContextPack.

import { describe, expect, it } from 'vitest'

import type {
  ContextPackTaskContract,
} from '../../src/contracts/context-pack.js'
import {
  compileContextPack,
  type ContextPackNodeCandidate,
} from '../../src/runtime/context-pack.js'

function task(overrides: Partial<ContextPackTaskContract> = {}): ContextPackTaskContract {
  return {
    version: 1,
    task_kind: 'explain',
    evidence_recipe_id: 'explain',
    budget: 200,
    required_evidence: ['primary'],
    preferred_evidence: ['supporting'],
    semantic_required: ['implementation'],
    semantic_optional: [],
    ...overrides,
  }
}

function candidate(
  label: string,
  evidenceClass: 'primary' | 'supporting' | 'structural' | 'change' | 'impact',
  tokenCost: number,
): ContextPackNodeCandidate {
  return {
    label,
    node_id: label,
    source_file: '/src/' + label + '.ts',
    line_number: 1,
    file_type: 'code',
    snippet: `// ${label} body`,
    evidence_class: evidenceClass,
    estimate_tokens: () => tokenCost,
    build_entry: () => ({
      label,
      node_id: label,
      source_file: '/src/' + label + '.ts',
      line_number: 1,
      snippet: `// ${label} body`,
      evidence_class: evidenceClass,
    }),
  }
}

describe('compileContextPack selection_strategy=value-per-token (#131)', () => {
  it('still includes required-evidence-class candidates first (must-include)', () => {
    const pack = compileContextPack({
      task_contract: task({ budget: 200, required_evidence: ['primary'] }),
      nodes: [
        candidate('primary-a', 'primary', 100),
        candidate('primary-b', 'primary', 100),
        candidate('supp-cheap', 'supporting', 10),
        candidate('supp-expensive', 'supporting', 500),
      ],
      selection_strategy: 'value-per-token',
    })

    // Both primary candidates fit at 200 budget total → must be in.
    const labels = pack.nodes.map((n) => n.label)
    expect(labels).toContain('primary-a')
    expect(labels).toContain('primary-b')
  })

  it('picks dense (cheap, high-rank) optional candidates over expensive ones at the same rank', () => {
    const pack = compileContextPack({
      task_contract: task({ budget: 60, required_evidence: ['primary'] }),
      nodes: [
        // Budget = 60. The required primary takes 20. Remaining = 40.
        candidate('primary-a', 'primary', 20),
        // Optional candidates — earlier in orderedNodes = higher rank.
        // Density-greedy should prefer the cheap one (40 tokens fits) over the
        // expensive one (50 tokens overflows the remaining 40).
        candidate('supp-cheap', 'supporting', 40),
        candidate('supp-expensive', 'supporting', 50),
      ],
      selection_strategy: 'value-per-token',
    })

    const labels = pack.nodes.map((n) => n.label)
    expect(labels).toContain('primary-a')
    expect(labels).toContain('supp-cheap')
    expect(labels).not.toContain('supp-expensive')
  })

  it('default strategy (evidence-order) selects first candidate even if expensive', () => {
    const pack = compileContextPack({
      task_contract: task({ budget: 60, required_evidence: ['primary'] }),
      nodes: [
        candidate('primary-a', 'primary', 20),
        // No selection_strategy = default 'evidence-order'. Should pick
        // supp-expensive first since it comes first in orderedNodes.
        candidate('supp-expensive', 'supporting', 30),
        candidate('supp-cheap', 'supporting', 5),
      ],
    })

    // Default greedy fills in evidence order, so primary + supp-expensive
    // both fit (20 + 30 = 50 ≤ 60), then supp-cheap (50 + 5 = 55 ≤ 60).
    const labels = pack.nodes.map((n) => n.label)
    expect(labels).toContain('primary-a')
    expect(labels).toContain('supp-expensive')
  })

  it('reports omitted candidates correctly when value-per-token drops one', () => {
    const pack = compileContextPack({
      task_contract: task({ budget: 30, required_evidence: ['primary'] }),
      nodes: [
        candidate('primary-a', 'primary', 20),
        candidate('expensive', 'supporting', 100),  // can't fit in remaining 10
      ],
      selection_strategy: 'value-per-token',
    })

    expect(pack.nodes.map((n) => n.label)).toEqual(['primary-a'])
    expect(pack.expandable.length).toBeGreaterThan(0)
  })
})
