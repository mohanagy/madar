import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

import type { ContextPackCoverage } from '../../src/contracts/context-pack.js'
import {
  attachBuildState,
  CANONICAL_INDEX_FORMAT_VERSION,
  createGenerationPolicy,
  createSourceSnapshot,
  INDEX_BUILD_STATE_VERSION,
  INDEX_ENGINE_ID,
} from '../../src/domain/index/build-state.js'
import { deserializeGraphArtifact, serializeGraphArtifact } from '../../src/domain/graph/artifact.js'
import { buildMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { buildDiscoverySafetyMetadata, relevantDiscoveryExclusions } from '../../src/shared/discovery-safety.js'

describe('mcp-response-evidence', () => {
  it('separates useful partial evidence from answerability instead of returning an abandonment signal', () => {
    const evidence = buildMadarResponseEvidence({
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation'],
        semantic_optional: [],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 0, status: 'available' },
          { evidence_class: 'structural', required: true, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        missing_required: ['supporting', 'structural'],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 0,
      },
      coveredWorkflowOwners: ['src/auth/controller.ts'],
      expandable: [{
        kind: 'nodes',
        handle_id: 'expand:explain:supporting:auth',
        evidence_class: 'supporting',
        count: 1,
        preview: [{ node_id: 'auth-store', label: 'AuthStore.save', source_file: 'src/auth/store.ts' }],
        follow_up: {
          kind: 'context_pack',
          task_kind: 'explain',
          evidence_class: 'supporting',
          focus_files: ['src/auth/store.ts'],
          focus_ranges: [],
        },
      }, {
        kind: 'nodes',
        handle_id: 'expand:explain:primary:auth',
        evidence_class: 'primary',
        count: 1,
        preview: [{ node_id: 'auth-controller', label: 'AuthController.login', source_file: 'src/auth/controller.ts' }],
        follow_up: {
          kind: 'context_pack',
          task_kind: 'explain',
          evidence_class: 'primary',
          focus_files: ['src/auth/controller.ts'],
          focus_ranges: [],
        },
      }],
    })

    expect(evidence.evidence_strength.level).toBe('moderate')
    expect(evidence.coverage_detail.missing_obligations).toEqual([
      'evidence:supporting',
      'evidence:structural',
    ])
    expect(evidence.answerability).toMatchObject({
      state: 'verify_targets',
      answer_scope: 'partial',
      broad_search_fallback: 'targeted_only',
      verification_targets: [expect.objectContaining({
        handle_id: 'expand:explain:supporting:auth',
        focus_files: ['src/auth/store.ts'],
      })],
    })
    expect(evidence.pack_confidence).toBe('medium')
    expect(evidence.agent_directive).toBe('verify_one_targeted_file')
  })

  it('returns ready_with_caveat for complete but weakly connected evidence', () => {
    const evidence = buildMadarResponseEvidence({
      coverage: {
        required_evidence: ['primary'],
        semantic_required: [],
        semantic_optional: [],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    })

    expect(evidence.evidence_strength.level).toBe('moderate')
    expect(evidence.answerability.state).toBe('ready_with_caveat')
    expect(evidence.answerability.caveats).toContain('selected_evidence_without_complete_relationship_support')
    expect(evidence.answerability.broad_search_fallback).toBe('not_needed')
    expect(evidence.pack_confidence).toBe('medium')
    expect(evidence.agent_directive).toBe('answer_from_pack')
  })

  it('returns insufficient only when there is no usable evidence or verification target', () => {
    const evidence = buildMadarResponseEvidence({})

    expect(evidence.evidence_strength.level).toBe('weak')
    expect(evidence.coverage_detail.status).toBe('unknown')
    expect(evidence.answerability).toMatchObject({
      state: 'insufficient',
      answer_scope: 'none',
      broad_search_fallback: 'allowed',
      verification_targets: [],
    })
    expect(evidence.pack_confidence).toBe('low')
    expect(evidence.agent_directive).toBe('explore_with_caution')
  })

  it('keeps an exact file target actionable even when the initial pack selected no evidence', () => {
    const evidence = buildMadarResponseEvidence({
      coverage: {
        required_evidence: ['primary'],
        semantic_required: [],
        semantic_optional: [],
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 0, status: 'available' },
        ],
        semantic_entries: [],
        missing_required: ['primary'],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
      coveredWorkflowOwners: ['src/auth/controller.ts'],
    })

    expect(evidence.evidence_strength.level).toBe('weak')
    expect(evidence.answerability).toMatchObject({
      state: 'verify_targets',
      answer_scope: 'none',
      caveats: ['no selected evidence; verify the exact target'],
      broad_search_fallback: 'targeted_only',
      verification_targets: [expect.objectContaining({
        focus_files: ['src/auth/controller.ts'],
        reason: 'verify evidence:primary',
      })],
    })
    expect(evidence.pack_confidence).toBe('medium')
    expect(evidence.agent_directive).toBe('verify_one_targeted_file')
  })

  it('uses authenticated graph completeness and keeps unsupported inventory informational', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-index-evidence-'))
    const graphPath = join(root, 'out', 'graph.json')
    const coverage: ContextPackCoverage = {
      required_evidence: ['primary'],
      semantic_required: [],
      semantic_optional: [],
      entries: [
        { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      ],
      semantic_entries: [],
      missing_required: [],
      missing_semantic: [],
      available_relationships: 1,
      selected_relationships: 1,
    }
    try {
      mkdirSync(dirname(graphPath), { recursive: true })
      writeCanonicalGraphFixture(graphPath, { root_path: root })
      const graph = deserializeGraphArtifact(readFileSync(graphPath, 'utf8'))
      attachBuildState(graph, {
        version: INDEX_BUILD_STATE_VERSION,
        engine_id: INDEX_ENGINE_ID,
        policy: createGenerationPolicy({
          index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
          respect_gitignore: true,
          follow_symlinks: false,
          exclusion_rules_fingerprint: '0'.repeat(64),
          indexing_strict: null,
        }),
        sources: createSourceSnapshot({
          supported: [
            { path: 'src/index.ts', hash: '1'.repeat(64) },
            { path: 'src/auth/token-loader.ts', hash: '2'.repeat(64) },
          ],
          controls: [],
          unsupported: [{ path: 'src/billing/legacy.vue', hash: '3'.repeat(64) }],
        }),
        source_root: {
          kind: 'directory',
          root_path: root,
          worktree_root: null,
          scope: '.',
        },
        corpus: {
          supported_files: 2,
          unsupported_files: 1,
          total_words: 20,
          warning: null,
        },
        completeness: {
          summary: {
            state: 'partial',
            candidates: 3,
            counts: {
              indexed: 1,
              indexed_with_warnings: 0,
              skipped_by_policy: 0,
              unsupported: 1,
              failed: 1,
            },
            reason_buckets: {
              indexed: 1,
              canonical_file_missing: 1,
              unsupported_file_type: 1,
            },
            capability_buckets: { 'builtin:index:typescript': 2 },
          },
          supported_failures: [{ path: 'src/auth/token-loader.ts', reason: 'canonical_file_missing' }],
        },
      })
      writeFileSync(graphPath, serializeGraphArtifact(graph), 'utf8')

      const relevant = buildMadarResponseEvidence({
        graphPath,
        question: 'How does the auth token loader work?',
        coveredWorkflowOwners: ['src/auth/auth-service.ts'],
        coverage,
      })
      const unrelated = buildMadarResponseEvidence({
        graphPath,
        question: 'How are invoices rendered?',
        coveredWorkflowOwners: ['src/invoices/render.ts'],
        coverage,
      })

      expect(relevant.pack_confidence).toBe('low')
      expect(relevant.coverage).toBe('partial')
      expect(relevant.answerability).toMatchObject({
        state: 'insufficient',
        broad_search_fallback: 'allowed',
      })
      expect(relevant.indexing_completeness).toEqual({
        state: 'partial',
        total_uncertain: 1,
        relevant_uncertain: 1,
        reasons: { canonical_file_missing: 1 },
        relevant_reasons: { canonical_file_missing: 1 },
      })
      expect(JSON.stringify(relevant)).not.toContain('token-loader.ts')
      expect(JSON.stringify(relevant)).not.toContain('legacy.vue')
      expect(unrelated.pack_confidence).toBe('high')
      expect(unrelated.coverage).toBe('complete')
      expect(unrelated.indexing_completeness).toEqual({
        state: 'partial',
        total_uncertain: 1,
        relevant_uncertain: 0,
        reasons: { canonical_file_missing: 1 },
        relevant_reasons: {},
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('matches hidden credential-store reasons and indirect workflow-owner paths', () => {
    const metadata = buildDiscoverySafetyMetadata([
      { path: '.aws', kind: 'sensitive', reason: 'credential_store' },
      { path: 'src/auth/secrets/production.yml', kind: 'sensitive', reason: 'sensitive_directory' },
    ])

    const credentialQuestion = relevantDiscoveryExclusions(metadata, {
      question: 'Where are cloud credentials loaded?',
    })
    const authOwner = relevantDiscoveryExclusions(metadata, {
      coveredWorkflowOwners: ['src/auth/services/login.ts'],
    })

    expect(credentialQuestion).toMatchObject({
      relevant: 1,
      relevantReasons: { credential_store: 1 },
    })
    expect(authOwner).toMatchObject({
      relevant: 1,
      relevantReasons: { sensitive_directory: 1 },
    })
  })

  it('does not let an adjacent environment example lower code-flow confidence', () => {
    const metadata = buildDiscoverySafetyMetadata([
      { path: 'apps/status-page/.env.example', kind: 'sensitive', reason: 'environment_file' },
    ])

    expect(relevantDiscoveryExclusions(metadata, {
      question: 'How does an incident affect the public status page?',
      coveredWorkflowOwners: ['apps/status-page/src/content/status-json.ts'],
    }).relevant).toBe(0)
    expect(relevantDiscoveryExclusions(metadata, {
      question: 'Which environment config controls the status page?',
    }).relevant).toBe(1)
  })

  it('downgrades answerability for relevant exclusions without exposing their paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-discovery-evidence-'))
    const graphPath = join(root, 'out', 'graph.json')
    try {
      mkdirSync(dirname(graphPath), { recursive: true })
      writeCanonicalGraphFixture(graphPath, {
        discovery_safety: {
          version: 1,
          summary: {
            total: 2,
            sensitive: 1,
            unreadable: 1,
            reasons: {
              secret_config: 1,
              unreadable_path: 1,
            },
          },
          exclusions: [
            { path: 'src/auth/credentials.json', kind: 'sensitive', reason: 'secret_config' },
            { path: 'src/auth/token-loader.ts', kind: 'unreadable', reason: 'unreadable_path' },
          ],
        },
      })

      const evidence = buildMadarResponseEvidence({
        graphPath,
        question: 'How does the auth token loader read credentials?',
        coveredWorkflowOwners: ['src/auth/auth-service.ts'],
        coverage: {
          required_evidence: ['primary'],
          semantic_required: [],
          semantic_optional: [],
          entries: [
            { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          ],
          semantic_entries: [],
          missing_required: [],
          missing_semantic: [],
          available_relationships: 1,
          selected_relationships: 1,
        },
      })

      expect(evidence.pack_confidence).toBe('low')
      expect(evidence.coverage).toBe('partial')
      expect(evidence.agent_directive).toBe('explore_with_caution')
      expect(evidence.answerability).toMatchObject({
        state: 'insufficient',
        broad_search_fallback: 'blocked',
        verification_targets: [],
      })
      expect(evidence.discovery_exclusions).toEqual({
        policy: 'artifact_path_only',
        total: 2,
        relevant: 2,
        reasons: {
          secret_config: 1,
          unreadable_path: 1,
        },
        relevant_reasons: {
          secret_config: 1,
          unreadable_path: 1,
        },
      })
      expect(JSON.stringify(evidence)).not.toContain('credentials.json')
      expect(JSON.stringify(evidence)).not.toContain('token-loader.ts')

      const unrelatedEvidence = buildMadarResponseEvidence({
        graphPath,
        question: 'How does invoice rendering work?',
        coveredWorkflowOwners: ['src/billing/invoice-renderer.ts'],
        coverage: {
          required_evidence: ['primary'],
          semantic_required: [],
          semantic_optional: [],
          entries: [
            { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          ],
          semantic_entries: [],
          missing_required: [],
          missing_semantic: [],
          available_relationships: 1,
          selected_relationships: 1,
        },
      })

      expect(unrelatedEvidence.pack_confidence).toBe('high')
      expect(unrelatedEvidence.coverage).toBe('complete')
      expect(unrelatedEvidence.discovery_exclusions).toEqual({
        policy: 'artifact_path_only',
        total: 2,
        relevant: 0,
        reasons: {
          secret_config: 1,
          unreadable_path: 1,
        },
        relevant_reasons: {},
      })

      const variantEvidence = buildMadarResponseEvidence({
        graphPath,
        question: 'Where is the credential loaded?',
        coveredWorkflowOwners: ['src/bootstrap.ts'],
        coverage: {
          required_evidence: ['primary'],
          semantic_required: [],
          semantic_optional: [],
          entries: [
            { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          ],
          semantic_entries: [],
          missing_required: [],
          missing_semantic: [],
          available_relationships: 1,
          selected_relationships: 1,
        },
      })

      expect(variantEvidence.pack_confidence).toBe('medium')
      expect(variantEvidence.coverage).toBe('partial')
      expect(variantEvidence.agent_directive).toBe('verify_one_targeted_file')
      expect(variantEvidence.discovery_exclusions).toMatchObject({
        total: 2,
        relevant: 1,
        relevant_reasons: { secret_config: 1 },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
    expect(evidence.evidence_strength).toMatchObject({
      level: 'moderate',
      reasons: expect.arrayContaining(['graph_scope_alignment_unverified']),
    })
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
    expect(evidence.evidence_strength.level).toBe('moderate')
    expect(evidence.answerability).toMatchObject({
      state: 'ready_with_caveat',
      caveats: expect.arrayContaining(['runtime_answer_contract_reported_medium_strength']),
    })
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

  it('uses the recorded source root when a graph artifact lives outside its worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-external-graph-evidence-'))
    const sourceRoot = join(root, 'linked-worktree', 'backend')
    const graphPath = join(root, 'git-artifacts', 'worktree', 'out', 'graph.json')
    try {
      mkdirSync(dirname(graphPath), { recursive: true })
      writeCanonicalGraphFixture(graphPath, { root_path: sourceRoot })

      const evidence = buildMadarResponseEvidence({
        graphPath,
        coveredWorkflowOwners: ['backend/src/runtime.ts'],
        executionSlice: {
          status: 'complete',
          confidence: 'high',
          confidence_reasons: [],
          steps: [],
          phase_coverage: {
            expected: [],
            observed: [],
            missing: [],
          },
        },
      })

      expect(evidence.confidence_reasons).toContain(
        'scope quality: graph scope is aligned with the backend runtime evidence',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
