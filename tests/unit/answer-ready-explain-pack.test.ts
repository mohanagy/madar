import { describe, test, expect } from 'vitest'
import type { ContextPackExplainAnswerReadySummary, CompiledContextPack, ContextPackTaskContract, ContextPackSchemaV1, ContextPackExecutionSlice } from '../../src/contracts/context-pack.js'
import { generateAnswerReadyFromExecutionSlice } from '../../src/runtime/context-pack.js'

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
      governance: {
        version: 1,
        surface: 'cli_pack',
        privacy_boundary: {
          source_safe: true,
          includes_prompt: false,
          includes_source_content: false,
          includes_answer_content: false,
          includes_file_paths: false,
        },
        graph_freshness: {
          status: 'fresh',
          graph_version: 'fixture-graph',
          graph_modified_ms: 0,
          graph_modified_at: new Date(0).toUTCString(),
          generated_ms: 0,
          generated_at: new Date(0).toUTCString(),
          madar_version: 'test',
          indexed_file_count: 0,
          changed_source_count: 0,
          missing_source_count: 0,
          selected_context_status: 'unknown',
          selected_context_file_count: 0,
          changed_selected_context_count: 0,
          missing_selected_context_count: 0,
          changed_outside_selected_context_count: 0,
          recommendation: 'Graph is fresh.',
        },
        request: {
          task: 'explain',
          task_intent: 'explain',
          budget: 5000,
        },
        directive: {
          pack_confidence: 'high',
          coverage: 'complete',
          agent_directive: 'answer_from_pack',
          missing_phases: [],
        },
        follow_up: {
          expandable_handle_count: 0,
          expandable_evidence_classes: [],
          expansion_task_kinds: [],
          preview_item_count: 0,
          focus_file_count: 0,
          focus_range_count: 0,
        },
      },
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

  test('generateAnswerReadyFromExecutionSlice generates answer_ready for high-confidence explain', () => {
    const executionSlice: ContextPackExecutionSlice = {
      status: 'complete',
      confidence: 'high',
      confidence_reasons: ['All phases observed', 'Complete path traced'],
      steps: [
        { label: 'Controller.handle()', source_file: 'src/controller.ts', line_number: 10 },
        { label: 'Service.process()', source_file: 'src/service.ts', line_number: 25 },
        { label: 'Database.save()', source_file: 'src/db.ts', line_number: 45 },
      ],
    }

    const result = generateAnswerReadyFromExecutionSlice(executionSlice, 'explain')

    expect(result).toBeDefined()
    expect(result?.answer_outline.length).toBeGreaterThan(0)
    expect(result?.must_cite.length).toBeGreaterThan(0)
    expect(result?.stop_condition).toContain('answer now')
  })

  test('generateAnswerReadyFromExecutionSlice returns undefined for non-explain tasks', () => {
    const executionSlice: ContextPackExecutionSlice = {
      status: 'complete',
      confidence: 'high',
      steps: [],
    }

    const result = generateAnswerReadyFromExecutionSlice(executionSlice, 'implement')
    expect(result).toBeUndefined()
  })

  test('generateAnswerReadyFromExecutionSlice returns undefined for low-confidence', () => {
    const executionSlice: ContextPackExecutionSlice = {
      status: 'partial',
      confidence: 'low',
      steps: [],
    }

    const result = generateAnswerReadyFromExecutionSlice(executionSlice, 'explain')
    expect(result).toBeUndefined()
  })

  test('generateAnswerReadyFromExecutionSlice returns undefined when no execution_slice', () => {
    const result = generateAnswerReadyFromExecutionSlice(undefined, 'explain')
    expect(result).toBeUndefined()
  })

  test('generateAnswerReadyFromExecutionSlice falls back to steps when primary_path.steps is empty', () => {
    const executionSlice: ContextPackExecutionSlice = {
      status: 'complete',
      confidence: 'high',
      steps: [
        { label: 'Controller.handle()', source_file: 'src/controller.ts', line_number: 10 },
        { label: 'Service.process()', source_file: 'src/service.ts', line_number: 25 },
      ],
      primary_path: {
        steps: [],
      },
    }

    const result = generateAnswerReadyFromExecutionSlice(executionSlice, 'explain')

    expect(result).toBeDefined()
    expect(result?.answer_outline.length).toBeGreaterThan(0)
    expect(result?.must_cite.length).toBeGreaterThan(0)
  })

  test('generateAnswerReadyFromExecutionSlice returns fallback answer_ready with empty must_cite when no citeable steps exist', () => {
    const executionSlice: ContextPackExecutionSlice = {
      status: 'complete',
      confidence: 'high',
      steps: [],
      primary_path: {
        steps: [],
      },
    }

    const result = generateAnswerReadyFromExecutionSlice(executionSlice, 'explain')

    // Should have empty must_cite but still return the structure with fallback outline
    expect(result).toBeDefined()
    expect(result?.must_cite).toHaveLength(0)
    expect(result?.answer_outline).toEqual(['Flow execution traced'])
  })
})
