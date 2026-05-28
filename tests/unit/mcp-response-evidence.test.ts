import { describe, expect, it } from 'vitest'

import { buildMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'

describe('mcp-response-evidence', () => {
  it('uses the first non-generic path segment when checking scope quality', () => {
    const evidence = buildMadarResponseEvidence({
      graphPath: 'out/graph.json',
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
        semantic_optional: ['tests'],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      coveredWorkflowOwners: ['packages/spi/runtime.ts'],
      executionSlice: {
        status: 'partial',
        confidence: 'high',
        confidence_reasons: ['missing_phase:persistence'],
        steps: [
          {
            node_id: 'runtime_entry',
            label: 'RuntimeSpi.execute',
            source_file: 'packages/spi/runtime.ts',
            line_number: 10,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['controller', 'service', 'persistence'],
          observed: ['controller', 'service'],
          missing: ['persistence'],
        },
      },
      answerContract: {
        version: 1,
        answer_focus: 'runtime_generation',
        entrypoint_scope: 'setup_context',
        required_elements: ['main_pipeline_phases'],
        do_not_claim: [],
        observed_phases: ['controller', 'service'],
        missing_phases: ['persistence'],
        confidence: 'high',
      },
    })

    expect(evidence.confidence_reasons).toContain(
      'scope quality: runtime evidence is concentrated under spi/ while the graph is rooted at out/graph.json',
    )
  })

  it('adds a confidence reason when runtime confidence lowers the cap', () => {
    const evidence = buildMadarResponseEvidence({
      graphPath: 'backend/out/graph.json',
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
        semantic_optional: ['tests'],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      coveredWorkflowOwners: ['backend/src/spi/runtime.ts'],
      executionSlice: {
        status: 'complete',
        confidence: 'medium',
        confidence_reasons: ['runtime_handoff_evidence'],
        steps: [
          {
            node_id: 'runtime_entry',
            label: 'RuntimeSpi.execute',
            source_file: 'backend/src/spi/runtime.ts',
            line_number: 10,
            node_kind: 'method',
          },
          {
            node_id: 'runtime_store',
            label: 'RuntimeStore.save',
            source_file: 'backend/src/runtime/store.ts',
            line_number: 30,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['controller', 'service', 'persistence'],
          observed: ['controller', 'service', 'persistence'],
          missing: [],
        },
      },
      answerContract: {
        version: 1,
        answer_focus: 'runtime_generation',
        entrypoint_scope: 'setup_context',
        required_elements: ['main_pipeline_phases'],
        do_not_claim: [],
        observed_phases: ['controller', 'service', 'persistence'],
        missing_phases: [],
        confidence: 'medium',
      },
    })

    expect(evidence.confidence_reasons).toContain(
      'runtime confidence: answer contract reported medium confidence and lowered the cap from high to medium',
    )
  })

  it('derives scope quality from absolute workflow-owner paths', () => {
    const evidence = buildMadarResponseEvidence({
      graphPath: 'C:/repo/backend/out/graph.json',
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
        semantic_optional: ['tests'],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      coveredWorkflowOwners: ['C:\\repo\\backend\\src\\spi\\runtime.ts'],
      executionSlice: {
        status: 'complete',
        confidence: 'high',
        confidence_reasons: [],
        steps: [
          {
            node_id: 'runtime_entry',
            label: 'RuntimeSpi.execute',
            source_file: 'C:\\repo\\backend\\src\\spi\\runtime.ts',
            line_number: 10,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['controller', 'service', 'persistence'],
          observed: ['controller', 'service', 'persistence'],
          missing: [],
        },
      },
      answerContract: {
        version: 1,
        answer_focus: 'runtime_generation',
        entrypoint_scope: 'setup_context',
        required_elements: ['main_pipeline_phases'],
        do_not_claim: [],
        observed_phases: ['controller', 'service', 'persistence'],
        missing_phases: [],
        confidence: 'high',
      },
    })

    expect(evidence.confidence_reasons).toContain(
      'scope quality: graph scope is aligned with the backend runtime evidence',
    )
  })

  it('does not mark runtime-generation answers as contained when no execution slice exists', () => {
    const evidence = buildMadarResponseEvidence({
      graphPath: 'backend/out/graph.json',
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
        semantic_optional: ['tests'],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      coveredWorkflowOwners: ['backend/src/spi/idea-report.spi.ts'],
      answerContract: {
        version: 1,
        answer_focus: 'runtime_generation',
        entrypoint_scope: 'setup_context',
        required_elements: ['main_pipeline_phases'],
        do_not_claim: [],
        observed_phases: ['planner', 'report_builder', 'persistence'],
        missing_phases: [],
        confidence: 'high',
      },
    })

    expect(evidence.agent_directive).toBe('verify_one_targeted_file')
    expect(evidence.confidence_reasons).toContain(
      'answer containedness: the pack does not contain a complete runtime answer without raw reads',
    )
  })
})
