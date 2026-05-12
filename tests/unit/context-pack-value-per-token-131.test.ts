// v0.20 #131 — value-per-token selection_strategy on compileContextPack.

import { describe, expect, it } from 'vitest'

import type {
  ContextPackNode,
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
  overrides: Partial<ContextPackNodeCandidate> = {},
): ContextPackNodeCandidate<ContextPackNode> {
  const sourceFile = overrides.source_file ?? '/src/' + label + '.ts'
  const lineNumber = overrides.line_number ?? 1
  const snippet = overrides.snippet ?? `// ${label} body`
  return {
    label,
    node_id: overrides.node_id ?? label,
    source_file: sourceFile,
    line_number: lineNumber,
    file_type: overrides.file_type ?? 'code',
    snippet,
    evidence_class: evidenceClass,
    estimate_tokens: () => tokenCost,
    build_entry: () => ({
      label,
      node_id: overrides.node_id ?? label,
      source_file: sourceFile,
      line_number: lineNumber,
      file_type: overrides.file_type ?? 'code',
      snippet,
      evidence_class: evidenceClass,
    }),
    ...overrides,
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

  it('prefers framework-relevant candidates over generic label matches for framework-shaped prompts', () => {
    const pack = compileContextPack({
      task_contract: task({
        budget: 50,
        prompt: 'Which express route handles POST /users?',
        required_evidence: [],
        preferred_evidence: ['supporting'],
        semantic_required: ['implementation'],
      }),
      nodes: [
        candidate('usersIndex', 'supporting', 45, {
          source_file: '/src/users/index.ts',
          match_score: 8.5,
          framework_boost: 0,
        }),
        candidate('createUser', 'supporting', 25, {
          source_file: '/src/routes/users.ts',
          match_score: 5.5,
          framework: 'express',
          framework_role: 'express_route',
          framework_boost: 4,
          exact_anchor_match: true,
        }),
      ],
      selection_strategy: 'value-per-token',
    })

    expect(pack.nodes.map((node) => node.label)).toEqual(['createUser'])
    expect(pack.selection_diagnostics?.ranking.map((entry) => ({
      label: entry.label,
      included: entry.included,
    }))).toEqual([
      { label: 'createUser', included: true },
      { label: 'usersIndex', included: false },
    ])
  })

  it('favors smaller high-value candidates over larger low-value ones', () => {
    const pack = compileContextPack({
      task_contract: task({
        budget: 60,
        prompt: 'Explain the login flow',
        required_evidence: ['primary'],
      }),
      nodes: [
        candidate('loginFlow', 'primary', 20, {
          match_score: 9,
          exact_anchor_match: true,
        }),
        candidate('AuthController', 'supporting', 35, {
          match_score: 5,
          framework_role: 'express_handler',
          framework_boost: 1.5,
        }),
        candidate('AuthArchitectureOverview', 'supporting', 80, {
          source_file: '/src/docs/auth-architecture.md',
          file_type: 'document',
          match_score: 4.5,
        }),
      ],
      selection_strategy: 'value-per-token',
    })

    expect(pack.nodes.map((node) => node.label)).toEqual(['loginFlow', 'AuthController'])
    expect(pack.nodes.map((node) => node.label)).not.toContain('AuthArchitectureOverview')
  })

  it('records deterministic selection reasons and penalties for included and omitted candidates', () => {
    const pack = compileContextPack({
      task_contract: task({
        budget: 50,
        prompt: 'Review the auth route contract and tests',
        required_evidence: [],
        preferred_evidence: ['supporting'],
        semantic_required: ['contracts'],
        semantic_optional: ['tests', 'implementation'],
      }),
      nodes: [
        candidate('AuthRouteContract', 'supporting', 18, {
          source_file: '/src/contracts/auth-route.ts',
          match_score: 6,
          framework_role: 'express_route',
          framework_boost: 2,
          exact_anchor_match: true,
        }),
        candidate('authRoute.test', 'supporting', 16, {
          source_file: '/tests/auth-route.test.ts',
          match_score: 4.5,
        }),
        candidate('index', 'supporting', 26, {
          source_file: '/src/auth/index.ts',
          match_score: 7,
        }),
      ],
      selection_strategy: 'value-per-token',
    })

    expect(pack.selection_diagnostics).toEqual(expect.objectContaining({
      selection_strategy: 'value-per-token',
      budget: 50,
      used_tokens: 34,
      required_overflow: false,
    }))

    const byLabel = new Map(pack.selection_diagnostics?.ranking.map((entry) => [entry.label, entry]) ?? [])
    expect(byLabel.get('AuthRouteContract')).toEqual(expect.objectContaining({
      included: true,
      reasons: expect.arrayContaining(['exact anchor match', 'contracts evidence', 'framework role match']),
      penalties: [],
    }))
    expect(byLabel.get('authRoute.test')).toEqual(expect.objectContaining({
      included: true,
      reasons: expect.arrayContaining(['tests evidence']),
      penalties: [],
    }))
    expect(byLabel.get('index')).toEqual(expect.objectContaining({
      included: false,
      reasons: expect.arrayContaining(['match score']),
      penalties: expect.arrayContaining(['barrel export penalty']),
    }))
  })

  it('does not treat graph seed prompts as permission to include script seed files', () => {
    const pack = compileContextPack({
      task_contract: task({
        budget: 10,
        prompt: 'Explain how graph seed nodes affect retrieval ranking',
        required_evidence: [],
        preferred_evidence: ['supporting'],
        semantic_required: ['implementation'],
      }),
      nodes: [
        candidate('seedOldReports', 'supporting', 10, {
          source_file: '/src/scripts/seed-old-reports.ts',
          match_score: 5,
        }),
        candidate('GraphSeedNode', 'supporting', 10, {
          source_file: '/src/runtime/retrieve.ts',
          match_score: 4,
        }),
      ],
      selection_strategy: 'value-per-token',
    })

    expect(pack.nodes.map((node) => node.label)).toEqual(['GraphSeedNode'])
    const byLabel = new Map(pack.selection_diagnostics?.ranking.map((entry) => [entry.label, entry]) ?? [])
    expect(byLabel.get('seedOldReports')).toEqual(expect.objectContaining({
      included: false,
      penalties: expect.arrayContaining(['script/migration penalty']),
    }))
    expect(byLabel.get('GraphSeedNode')).toEqual(expect.objectContaining({
      included: true,
      penalties: expect.not.arrayContaining(['script/migration penalty']),
    }))
  })
})
