import { describe, expect, it } from 'vitest'

import type { ContextPackCoverage, ContextPackExpandableRef } from '../../src/contracts/context-pack.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { assessMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import {
  buildRetrievalEvidencePlan,
  interpretRetrievalQuery,
  runRetrievalPackingStage,
  startRetrievalCandidateStage,
  startRetrievalRecoveryStage,
  type RetrievalStageDiagnostic,
} from '../../src/runtime/retrieve/pipeline.js'

const coverage = (covered: boolean): ContextPackCoverage => ({
  required_evidence: ['primary'],
  semantic_required: [],
  semantic_optional: [],
  entries: [{
    evidence_class: 'primary',
    required: true,
    available_nodes: 1,
    selected_nodes: covered ? 1 : 0,
    status: covered ? 'covered' : 'available',
  }],
  semantic_entries: [],
  missing_required: covered ? [] : ['primary'],
  missing_semantic: [],
  available_relationships: covered ? 1 : 0,
  selected_relationships: covered ? 1 : 0,
})

const verificationTarget: ContextPackExpandableRef = {
  kind: 'nodes',
  handle_id: 'expand:primary:auth',
  evidence_class: 'primary',
  count: 1,
  preview: [{ node_id: 'auth', label: 'AuthController.login', source_file: 'src/auth.ts' }],
  follow_up: {
    kind: 'context_pack',
    task_kind: 'explain',
    evidence_class: 'primary',
    focus_files: ['src/auth.ts'],
    focus_ranges: [],
  },
}

const retrievalGraph = (): KnowledgeGraph => {
  const graph = new KnowledgeGraph()
  graph.addNode('controller', {
    label: 'AuthController.login',
    source_file: 'src/auth/controller.ts',
    source_location: 'L10',
    node_kind: 'method',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('service', {
    label: 'AuthService.login',
    source_file: 'src/auth/service.ts',
    source_location: 'L20',
    node_kind: 'method',
    file_type: 'code',
    community: 0,
  })
  graph.addEdge('controller', 'service', { relation: 'calls' })
  return graph
}

describe('retrieval pipeline stages', () => {
  it('interprets the query independently from graph traversal', () => {
    const output = interpretRetrievalQuery({
      question: 'How does the AuthController implement login?',
      budget: 900,
      taskIntent: 'implement',
      retrievalLevel: 0,
    })

    expect(output.question_tokens).toEqual(['auth', 'controller', 'implement', 'login'])
    expect(output.retrieval_gate).toMatchObject({
      level: 0,
      skipped_retrieval: true,
      reason: 'manual override',
    })
    expect(output.effective_retrieval_level).toBe(0)
    expect(output.task_contract).toMatchObject({
      task_kind: 'implement',
      budget: 900,
    })
  })

  it('builds an explicit, normalized evidence plan without ranking signals', () => {
    const plan = buildRetrievalEvidencePlan({
      coverage: coverage(false),
      expandable: [verificationTarget],
      missingPhases: ['controller', 'controller'],
      coveredWorkflowOwners: ['src/auth.ts', 'src/auth.ts'],
      selectedNodeCount: 2.9,
      selectedRelationshipCount: Number.NaN,
    })

    expect(plan).toMatchObject({
      version: 1,
      missing_phases: ['controller'],
      covered_workflow_owners: ['src/auth.ts'],
      selected_node_count: 2,
      selected_relationship_count: 0,
    })
    expect(JSON.stringify(plan)).not.toMatch(/rank|score|boost/i)
  })

  it('makes the evidence plan authoritative for answerability', () => {
    const evidencePlan = buildRetrievalEvidencePlan({
      coverage: coverage(false),
      expandable: [verificationTarget],
      coveredWorkflowOwners: ['src/auth.ts'],
    })
    const evidence = assessMadarResponseEvidence({
      evidencePlan,
      coverage: coverage(true),
      expandable: [],
    })

    expect(evidence.coverage).toBe('partial')
    expect(evidence.coverage_detail.missing_obligations).toContain('evidence:primary')
    expect(evidence.answerability.verification_targets).toEqual([
      expect.objectContaining({ handle_id: verificationTarget.handle_id }),
    ])
  })

  it('exposes typed candidate, packing, and recovery boundaries independently', () => {
    const diagnostics: RetrievalStageDiagnostic[] = []
    for (const stage of ['seed_generation', 'structural_expansion', 'candidate_ranking'] as const) {
      const boundary = startRetrievalCandidateStage(
        stage,
        { candidate_count: 5 },
        (diagnostic) => diagnostics.push(diagnostic),
      )
      boundary.complete({ candidate_count: 3 })
    }
    const packed = runRetrievalPackingStage(
      { candidate_count: 3 },
      () => ({ nodes: ['a', 'b'] }),
      (diagnostic) => diagnostics.push(diagnostic),
    )
    const recovery = startRetrievalRecoveryStage(
      { selected_node_count: 2 },
      (diagnostic) => diagnostics.push(diagnostic),
    )
    recovery.complete({ selected_node_count: 2, insufficient: false })

    expect(packed.nodes).toEqual(['a', 'b'])
    expect(diagnostics.map((diagnostic) => ({
      stage: diagnostic.stage,
      input: diagnostic.input_count,
      output: diagnostic.output_count,
    }))).toEqual([
      { stage: 'seed_generation', input: 5, output: 3 },
      { stage: 'structural_expansion', input: 5, output: 3 },
      { stage: 'candidate_ranking', input: 5, output: 3 },
      { stage: 'budgeted_packing', input: 3, output: 2 },
      { stage: 'recovery_answerability', input: 2, output: 2 },
    ])
  })

  it('exposes every default retrieval stage through source-safe diagnostics', () => {
    const diagnostics: RetrievalStageDiagnostic[] = []
    const result = retrieveContext(retrievalGraph(), {
      question: 'How does AuthController.login call AuthService.login?',
      budget: 1_200,
      onStageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(result.matched_nodes.map((node) => node.node_id)).toEqual(
      expect.arrayContaining(['controller', 'service']),
    )
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.stage))).toEqual(new Set([
      'query_interpretation',
      'seed_generation',
      'structural_expansion',
      'candidate_ranking',
      'evidence_planning',
      'budgeted_packing',
      'recovery_answerability',
    ]))
    for (const diagnostic of diagnostics) {
      expect(Object.keys(diagnostic).sort()).toEqual([
        'duration_ms',
        'input_count',
        'output_count',
        'pipeline',
        'stage',
        'status',
        'version',
        'warning_count',
      ])
      expect(diagnostic.pipeline).toBe('retrieval')
    }
    expect(JSON.stringify(diagnostics)).not.toContain('AuthController')
    expect(JSON.stringify(diagnostics)).not.toContain('src/auth')
  })
})
