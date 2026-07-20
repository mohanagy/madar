import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContextPackCoverage, ImplementationPackGuidance } from '../../src/contracts/context-pack.js'
import type { RetrievalGateDecision } from '../../src/contracts/retrieval-gate.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'
import type { RetrieveResult } from '../../src/runtime/retrieve.js'

const { buildImplementationPackGuidanceMock } = vi.hoisted(() => ({
  buildImplementationPackGuidanceMock: vi.fn(),
}))

vi.mock('../../src/runtime/implementation-pack.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/implementation-pack.js')>('../../src/runtime/implementation-pack.js')
  return {
    ...actual,
    buildImplementationPackGuidance: buildImplementationPackGuidanceMock,
  }
})

beforeEach(() => {
  buildImplementationPackGuidanceMock.mockReset()
})

function retrievalGate(): RetrievalGateDecision {
  return {
    level: 4,
    skipped_retrieval: false,
    reason: 'manual override',
    intent: 'implement',
    signals: {
      has_pr_diff: false,
      has_stack_trace: false,
      mentioned_paths: ['src/infrastructure/context-pack-command.ts'],
      mentioned_symbols: ['runContextPackCommand'],
      generation_intent: 'unknown',
      target_domain_hint: 'unknown',
    },
  }
}

function lowConfidenceCoverage(): ContextPackCoverage {
  return {
    required_evidence: ['primary', 'structural'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['tests'],
    entries: [
      { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 0, status: 'missing' },
      { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 0, status: 'missing' },
    ],
    semantic_entries: [
      { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 0, status: 'missing' },
      { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 0, status: 'missing' },
      { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
    ],
    missing_required: ['primary', 'structural'],
    missing_semantic: ['implementation', 'structure'],
    available_relationships: 1,
    selected_relationships: 0,
  }
}

function highConfidenceCoverage(): ContextPackCoverage {
  return {
    required_evidence: ['primary', 'structural'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['tests'],
    entries: [
      { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
    ],
    semantic_entries: [
      { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      { category: 'tests', label: 'tests', required: false, available_nodes: 1, selected_nodes: 1, status: 'covered' },
    ],
    missing_required: [],
    missing_semantic: [],
    available_relationships: 1,
    selected_relationships: 1,
  }
}

function missingSemanticCoverage(): ContextPackCoverage {
  return {
    required_evidence: ['primary', 'structural'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['tests'],
    entries: [
      { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
    ],
    semantic_entries: [
      { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 0, status: 'missing' },
      { category: 'tests', label: 'tests', required: false, available_nodes: 1, selected_nodes: 1, status: 'covered' },
    ],
    missing_required: [],
    missing_semantic: ['structure'],
    available_relationships: 1,
    selected_relationships: 1,
  }
}

function lowConfidenceImplementation(): ImplementationPackGuidance {
  return {
    summary: 'Evidence is partial, so the starting file still needs targeted verification.',
    retrieval_pipeline: {
      phases: [
        { phase: 'seed', summary: 'Seeded direct prompt matches.' },
      ],
    },
    workflow_centers: [],
    likely_edit_files: [],
    likely_test_files: [],
    contracts_and_public_surfaces: [],
    existing_patterns: [],
    risk_boundaries: [],
    validation_commands: ['npm run typecheck'],
    acceptance_criteria_summary: [],
    cautions: ['Confirm the starting file before making edits.'],
  }
}

function highConfidenceImplementation(): ImplementationPackGuidance {
  return {
    summary: 'Adapter rendering is isolated to the context pack command.',
    retrieval_pipeline: {
      phases: [
        { phase: 'seed', summary: 'Seeded direct prompt matches.' },
        { phase: 'render', summary: 'Promoted the adapter rendering surface.' },
      ],
    },
    workflow_centers: [
      {
        label: 'runContextPackCommand',
        path: 'src/infrastructure/context-pack-command.ts',
        score: 0.91,
        reasons: ['Adapter rendering is implemented here.'],
        matched_symbols: ['runContextPackCommand'],
        reason: 'Implementation guidance converges on the adapter renderer.',
        phases: ['render'],
      },
    ],
    likely_edit_files: [
      {
        path: 'src/infrastructure/context-pack-command.ts',
        score: 0.91,
        reason: 'Adapter wording is rendered here.',
        matched_symbols: ['runContextPackCommand'],
        phases: ['render'],
      },
    ],
    likely_test_files: [
      {
        path: 'tests/unit/context-pack-command.test.ts',
        score: 0.83,
        reason: 'Adapter output is asserted here.',
        matched_symbols: ['context-pack-command'],
        phases: ['render'],
      },
    ],
    contracts_and_public_surfaces: [
      {
        label: 'ContextPackSchemaV1',
        source_file: 'src/contracts/context-pack.ts',
        line_number: 422,
        kind: 'contract',
        why: 'Adapter wording is derived from schema fields.',
      },
    ],
    existing_patterns: [],
    risk_boundaries: [
      {
        label: 'runContextPackCommand',
        severity: 'medium',
        reason: 'Renderer changes affect the Claude and Copilot pack formats.',
        affected_files: ['src/infrastructure/context-pack-command.ts'],
        affected_communities: ['Context pack rendering'],
      },
    ],
    validation_commands: ['npm run typecheck'],
    acceptance_criteria_summary: [],
    cautions: [],
  }
}

function buildRetrieval(coverage: ContextPackCoverage): RetrieveResult {
  return {
    question: 'Implement issue #312 by gating directive adapter wording on pack quality',
    token_count: 128,
    matched_nodes: [
      {
        label: 'runContextPackCommand',
        source_file: 'src/infrastructure/context-pack-command.ts',
        line_number: 763,
        node_kind: 'function',
        file_type: 'code',
        snippet: 'return gatingDirectiveAdapterWording(packQuality)',
        match_score: 0.91,
        relevance_band: 'direct',
        community: 0,
        community_label: 'Context pack rendering',
      },
    ],
    relationships: [],
    community_context: [],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    claims: [],
    expandable: [],
    coverage,
    retrieval_gate: retrievalGate(),
  }
}

function buildCompactPack(coverage: ContextPackCoverage) {
  return {
    question: 'Implement issue #312 by gating directive adapter wording on pack quality',
    token_count: 128,
    matched_nodes: [
      {
        label: 'runContextPackCommand',
        source_file: 'src/infrastructure/context-pack-command.ts',
        line_number: 763,
        node_kind: 'function',
        file_type: 'code',
        snippet: 'return gatingDirectiveAdapterWording(packQuality)',
        match_score: 0.91,
        relevance_band: 'direct' as const,
        community: 0,
      },
    ],
    relationships: [],
    community_context: [],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    claims: [],
    expandable: [],
    coverage,
    retrieval_gate: retrievalGate(),
  }
}

function buildDependencies(retrieval: RetrieveResult, compactPack: ReturnType<typeof buildCompactPack>): ContextPackCommandDependencies {
  return {
    loadGraph: vi.fn().mockReturnValue(new KnowledgeGraph()),
    retrieveContext: vi.fn().mockReturnValue(retrieval),
    compactRetrieveResult: vi.fn().mockReturnValue(compactPack),
    analyzePrImpact: vi.fn(),
    compactPrImpactResult: vi.fn(),
    analyzeImpact: vi.fn(),
    compactImpactResult: vi.fn(),
  }
}

describe('context-pack adapter gating', () => {
  it('suppresses claude anti-search guidance when implementation evidence is weak', async () => {
    const coverage = lowConfidenceCoverage()
    buildImplementationPackGuidanceMock.mockReturnValue(lowConfidenceImplementation())

    const output = await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'claude',
    } as never, buildDependencies(buildRetrieval(coverage), buildCompactPack(coverage)))

    expect(output).not.toContain('Do not start with a broad repo search.')
    expect(output).toContain('Use targeted verification to confirm the listed starting points before widening the search.')
  })

  it('switches the copilot plan to cautious verification when first-read guidance is fallback-only', async () => {
    const coverage = lowConfidenceCoverage()
    buildImplementationPackGuidanceMock.mockReturnValue(lowConfidenceImplementation())

    const output = await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'copilot',
    } as never, buildDependencies(buildRetrieval(coverage), buildCompactPack(coverage)))

    expect(output).not.toContain('Read `src/infrastructure/context-pack-command.ts` first to anchor the change:')
    expect(output).toContain('Verify the suggested starting file against the prompt and workflow centers before editing.')
  })

  it('keeps claude anti-search guidance for high-confidence implementation packs', async () => {
    const coverage = highConfidenceCoverage()
    buildImplementationPackGuidanceMock.mockReturnValue(highConfidenceImplementation())

    const output = await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'claude',
    } as never, buildDependencies(buildRetrieval(coverage), buildCompactPack(coverage)))

    expect(output).toContain('Do not start with a broad repo search.')
  })

  it('aligns claude anti-search guidance with answer_from_pack evidence', async () => {
    const coverage = highConfidenceCoverage()
    buildImplementationPackGuidanceMock.mockReturnValue(lowConfidenceImplementation())
    const dependencies = buildDependencies(buildRetrieval(coverage), buildCompactPack(coverage))

    const json = JSON.parse(await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'json',
    } as never, dependencies)) as {
      evidence?: {
        agent_directive?: string
      }
    }

    expect(json.evidence?.agent_directive).toBe('answer_from_pack')

    const output = await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'claude',
    } as never, dependencies)

    expect(output).toContain('Do not start with a broad repo search.')
  })

  it('suppresses claude anti-search guidance when required semantic coverage is still missing', async () => {
    const coverage = missingSemanticCoverage()
    buildImplementationPackGuidanceMock.mockReturnValue(highConfidenceImplementation())

    const output = await runContextPackCommand({
      prompt: 'Implement issue #312 by gating directive adapter wording on pack quality',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'claude',
    } as never, buildDependencies(buildRetrieval(coverage), buildCompactPack(coverage)))

    expect(output).not.toContain('Do not start with a broad repo search.')
    expect(output).toContain('Use targeted verification to confirm the listed starting points before widening the search.')
  })
})
