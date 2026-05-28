import { describe, test, expect } from 'vitest'
import type { ContextPackExplainAnswerReadySummary, CompiledContextPack, ContextPackTaskContract, ContextPackSchemaV1 } from '../../src/contracts/context-pack.js'

describe('answer-ready explain pack', () => {
  test('defines answer_outline structure', () => {
    const summary: ContextPackExplainAnswerReadySummary = {
      answer_outline: ['Step 1', 'Step 2'],
      must_cite: [{ source_file: 'src/file.ts', line_number: 42, label: 'func()' }],
      stop_condition: 'answer now; do not raw-search',
      allowed_followups: ['retrieve with focus on X'],
    }
    expect(summary.answer_outline).toHaveLength(2)
    expect(summary.must_cite).toHaveLength(1)
    expect(summary.stop_condition).toBe('answer now; do not raw-search')
    expect(summary.allowed_followups).toHaveLength(1)
  })

  test('answer_outline is ordered list', () => {
    const summary: ContextPackExplainAnswerReadySummary = {
      answer_outline: ['First', 'Second', 'Third'],
      must_cite: [],
      stop_condition: 'answer now',
      allowed_followups: [],
    }
    expect(summary.answer_outline[0]).toBe('First')
    expect(summary.answer_outline[1]).toBe('Second')
    expect(summary.answer_outline[2]).toBe('Third')
  })

  test('must_cite includes source location and label', () => {
    const cite = { source_file: 'src/controller.ts', line_number: 10, label: 'handleRequest()' }
    const summary: ContextPackExplainAnswerReadySummary = {
      answer_outline: ['Usage in controller'],
      must_cite: [cite],
      stop_condition: 'answer now',
      allowed_followups: [],
    }
    expect(summary.must_cite[0]).toHaveProperty('source_file')
    expect(summary.must_cite[0]).toHaveProperty('line_number')
    expect(summary.must_cite[0]).toHaveProperty('label')
  })

  test('CompiledContextPack includes optional answer_ready field', () => {
    const taskContract: ContextPackTaskContract = {
      version: 1,
      task_kind: 'explain',
      evidence_recipe_id: 'explain',
      budget: 5000,
      required_evidence: [],
      preferred_evidence: [],
      semantic_required: [],
      semantic_optional: [],
    }
    
    const pack: CompiledContextPack = {
      task_contract: taskContract,
      token_count: 1000,
      nodes: [],
      relationships: [],
      community_context: [],
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: [],
        semantic_required: [],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
      answer_ready: {
        answer_outline: ['Flow starts in controller'],
        must_cite: [{ source_file: 'src/controller.ts', line_number: 10, label: 'handleRequest()' }],
        stop_condition: 'answer now; missing_context empty',
        allowed_followups: [],
      },
    }
    expect(pack.answer_ready).toBeDefined()
    expect(pack.answer_ready?.answer_outline).toHaveLength(1)
  })

  test('ContextPackSchemaV1 exposes answer_ready field', () => {
    // Note: This test validates the type; the actual schema generation happens at runtime
    // We use 'as' to bypass strict validation since we're just testing the optional field exists
    const schema = {
      schema_version: 1,
      task: 'explain',
      task_intent: 'explain',
      prompt: 'Explain this flow',
      budget: 5000,
      graph_path: '/path/to/graph.json',
      plan: {} as any,
      workflow_centers: [],
      recommended_first_read: [],
      likely_edit_files: [],
      likely_test_files: [],
      public_contracts: [],
      risk_boundaries: [],
      validation_commands: [],
      negative_guidance: [],
      confidence_score: 0.95,
      why_explanation: [],
      pack: {},
      evidence: {} as any,
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: [],
        semantic_required: [],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
      missing_context: [],
      missing_semantic: [],
      answer_ready: {
        answer_outline: ['Initialization', 'Processing', 'Completion'],
        must_cite: [{ source_file: 'src/main.ts', line_number: 1, label: 'main()' }],
        stop_condition: 'answer now',
        allowed_followups: [],
      },
    } as const satisfies ContextPackSchemaV1

    expect(schema.answer_ready).toBeDefined()
    expect(schema.answer_ready?.answer_outline).toHaveLength(3)
  })
})


