import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ContextPackCoverage, ContextPackExpandableRef } from '../../src/contracts/context-pack.js'
import { buildMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { buildRetrievalEvidencePlan } from '../../src/runtime/retrieve/pipeline.js'
import { createIndexingManifest } from '../../src/pipeline/indexing-outcomes.js'
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
      broad_search_fallback: 'allowed',
      verification_targets: [expect.objectContaining({
        handle_id: 'expand:explain:supporting:auth',
        basis: 'evidence_class',
        obligation_id: 'evidence:supporting',
        reason: 'retrieve candidates for missing evidence:supporting',
        focus_files: ['src/auth/store.ts'],
      })],
    })
    expect(evidence.pack_confidence).toBe('medium')
    expect(evidence.agent_directive).toBe('explore_with_caution')
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
    expect(evidence.answerability.advisory).toBe(true)
    expect(evidence.answerability.state).toBe('ready_with_caveat')
    expect(evidence.answerability.caveats).toContain('selected_evidence_without_complete_relationship_support')
    expect(evidence.answerability.broad_search_fallback).toBe('allowed')
    expect(evidence.pack_confidence).toBe('medium')
    expect(evidence.agent_directive).toBe('explore_with_caution')
  })

  it('returns insufficient with no answer scope when there is no usable evidence or verification target', () => {
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

  it('does not turn generic expansion categories or workflow owners into targets for unrelated gaps', () => {
    const coverage: ContextPackCoverage = {
      required_evidence: ['primary'], semantic_required: [], semantic_optional: [],
      entries: [{ evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' }],
      semantic_entries: [], missing_required: [], missing_semantic: [],
      available_relationships: 0, selected_relationships: 0,
    }
    const expandable: ContextPackExpandableRef[] = (['primary', 'supporting'] as const).map(evidence_class => ({
      kind: 'nodes', handle_id: `expand:explain:${evidence_class}:browse`, evidence_class, count: 1,
      preview: [{ node_id: evidence_class, label: 'Controller.run', source_file: 'src/controller.ts' }],
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class, focus_files: ['src/controller.ts'], focus_ranges: [] },
    }))
    const input = { coverage, expandable, coveredWorkflowOwners: ['src/controller.ts'] }
    const queryPlan = buildRetrievalEvidencePlan({
      ...input, question: 'How does the workflow persist?',
      matchedNodes: [{ label: 'Controller.run', source_file: 'src/controller.ts', snippet: 'return ready' }],
      selectedNodeCount: 1,
    })
    expect(queryPlan.query_evidence?.missing_obligations.length).toBeGreaterThan(0)
    const cases: Array<{
      name: string
      input: Parameters<typeof buildMadarResponseEvidence>[0]
      missing: string[]
      strength: 'moderate' | 'strong'
    }> = [
      { name: 'query', input: { ...input, evidencePlan: queryPlan }, missing: queryPlan.query_evidence!.missing_obligations, strength: 'moderate' },
      { name: 'indexing', input: { ...input, question: 'How does controller.vue work?', indexingManifest: createIndexingManifest({ outcomes: [
        { path: 'src/controller.vue', kind: 'file', status: 'unsupported', reason: 'unsupported_file_type', capability: null },
      ] }) }, missing: ['indexing:unsupported_file_type'], strength: 'moderate' },
      { name: 'semantic', input: { ...input, coverage: { ...coverage,
        semantic_required: ['tests'], missing_semantic: ['tests'],
        semantic_entries: [{ category: 'tests', label: 'tests', required: true, available_nodes: 0, selected_nodes: 0, status: 'missing' }],
        available_relationships: 1, selected_relationships: 1,
      } }, missing: ['semantic:tests'], strength: 'strong' },
      { name: 'impact', input: { ...input, impactTraversal: { status: 'depth_limited', depth: 1, node_limit: 500 } },
        missing: ['impact:depth_limited'], strength: 'moderate' },
    ]
    const original = structuredClone(input)
    for (const entry of cases) {
      const evidence = buildMadarResponseEvidence(entry.input)
      expect(evidence.coverage_detail.missing_obligations, entry.name).toEqual(entry.missing)
      expect(evidence.answerability, entry.name).toMatchObject({
        state: 'insufficient', answer_scope: 'partial', verification_targets: [], missing_obligations: entry.missing,
      })
      expect(evidence.evidence_strength.level, entry.name).toBe(entry.strength)
      expect(evidence.pack_confidence, entry.name).toBe('medium')
      expect(evidence.agent_directive, entry.name).toBe('explore_with_caution')
    }
    expect(input).toEqual(original)
  })

  it('keeps impact traversal limits separate from covered evidence classes', () => {
    const coverage: ContextPackCoverage = {
      required_evidence: ['primary'], semantic_required: [], semantic_optional: [],
      entries: [{ evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' }],
      semantic_entries: [], missing_required: [], missing_semantic: [],
      available_relationships: 1, selected_relationships: 1,
    }
    const input = { coverage, coveredWorkflowOwners: ['src/target.ts'] }
    const baseline = buildMadarResponseEvidence(input)
    expect(baseline.answerability.answer_scope).toBe('complete')
    expect(buildMadarResponseEvidence({
      ...input, impactTraversal: { status: 'complete', depth: 3, node_limit: 500 },
    })).toEqual(baseline)

    for (const status of ['depth_limited', 'node_limited'] as const) {
      const impactTraversal = { status, depth: 3, node_limit: 500 }
      const evidence = buildMadarResponseEvidence({ ...input, impactTraversal })
      expect(evidence.coverage).toBe('partial')
      expect(evidence.coverage_detail.covered_obligations).toContain('evidence:primary')
      expect(evidence.coverage_detail.missing_obligations).toEqual([`impact:${status}`])
      expect(evidence.answerability).toMatchObject({ answer_scope: 'partial', missing_obligations: [`impact:${status}`] })
      expect(evidence.evidence_strength.level).toBe('moderate')
      expect(evidence.pack_confidence).toBe('medium')
      expect(buildMadarResponseEvidence({ impactTraversal }).coverage).toBe('partial')
    }
    expect(coverage.missing_required).toEqual([])
    expect(coverage.entries[0]?.status).toBe('covered')
  })

  it('preserves PR traversal limits when a partial target row is omitted from the pack', () => {
    const coverage: ContextPackCoverage = {
      required_evidence: ['primary'], semantic_required: [], semantic_optional: [],
      entries: [{ evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' }],
      semantic_entries: [], missing_required: [], missing_semantic: [],
      available_relationships: 1, selected_relationships: 1,
    }
    const input = { coverage, coveredWorkflowOwners: ['src/target.ts'] }
    const baseline = buildMadarResponseEvidence(input)
    for (const [depthLimited, nodeLimited] of [[1, 0], [0, 1], [1, 1]] as const) {
      const impactTraversalSummary = {
        analyzed_targets: 13, partial_targets: depthLimited + nodeLimited,
        depth_limited_targets: depthLimited, node_limited_targets: nodeLimited,
      }
      const expectedMissing = [
        ...(depthLimited ? ['impact:depth_limited'] : []),
        ...(nodeLimited ? ['impact:node_limited'] : []),
      ]
      const evidence = buildMadarResponseEvidence({ ...input, impactTraversalSummary })
      expect(evidence.coverage).toBe('partial')
      expect(evidence.answerability).toMatchObject({ answer_scope: 'partial', missing_obligations: expectedMissing })
      expect(evidence.coverage_detail.covered_obligations).toContain('evidence:primary')
      expect(evidence.evidence_strength.level).toBe('moderate')
      expect(evidence.pack_confidence).toBe('medium')
    }
    expect(buildMadarResponseEvidence({ ...input, impactTraversalSummary: {
      analyzed_targets: 0, partial_targets: 0, depth_limited_targets: 0, node_limited_targets: 0,
    } })).toEqual(baseline)
    expect(buildMadarResponseEvidence({ ...input, impactTraversalSummary: undefined })).toEqual(baseline)
  })

  it('requires a matching class handle rather than workflow-owner metadata for an empty pack', () => {
    const input: Parameters<typeof buildMadarResponseEvidence>[0] = {
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
    }
    const evidence = buildMadarResponseEvidence(input)

    expect(evidence.evidence_strength.level).toBe('weak')
    expect(evidence.answerability).toMatchObject({
      state: 'insufficient',
      answer_scope: 'none',
      broad_search_fallback: 'allowed',
      missing_obligations: ['evidence:primary'],
      verification_targets: [],
    })
    expect(evidence.pack_confidence).toBe('low')
    expect(evidence.agent_directive).toBe('explore_with_caution')
    const withClassHandle = buildMadarResponseEvidence({ ...input, expandable: [{
      kind: 'nodes', handle_id: 'expand:explain:primary:auth', evidence_class: 'primary', count: 1,
      preview: [{ node_id: 'controller', label: 'Controller.run', source_file: 'src/auth/controller.ts' }],
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary',
        focus_files: ['src/auth/controller.ts'], focus_ranges: [] },
    }] })
    expect(withClassHandle.answerability).toMatchObject({
      state: 'verify_targets', answer_scope: 'none',
      caveats: ['no selected evidence; retrieve candidates for the missing evidence class'],
      verification_targets: [expect.objectContaining({
        handle_id: 'expand:explain:primary:auth', basis: 'evidence_class', obligation_id: 'evidence:primary',
        reason: 'retrieve candidates for missing evidence:primary',
      })],
    })
  })

  it('downgrades only relevant indexing uncertainty and exposes share-safe reason aggregates', () => {
    const indexingManifest = createIndexingManifest({
      outcomes: [
        {
          path: 'src/index.ts',
          kind: 'file',
          status: 'indexed',
          reason: 'indexed',
          capability: 'builtin:extract:typescript',
        },
        {
          path: 'src/auth/token-loader.ts',
          kind: 'file',
          status: 'failed',
          reason: 'extractor_error',
          capability: 'builtin:extract:typescript',
          diagnostics: [{ code: 'parser_failed', level: 'error', message: 'private parser detail' }],
        },
        {
          path: 'src/billing/legacy.vue',
          kind: 'file',
          status: 'unsupported',
          reason: 'unsupported_file_type',
          capability: null,
        },
      ],
    })
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

    const relevant = buildMadarResponseEvidence({
      indexingManifest,
      question: 'How does the auth token loader work?',
      coveredWorkflowOwners: ['src/auth/auth-service.ts'],
      coverage,
    })
    const unrelated = buildMadarResponseEvidence({
      indexingManifest,
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
      total_uncertain: 2,
      relevant_uncertain: 1,
      reasons: { extractor_error: 1, unsupported_file_type: 1 },
      relevant_reasons: { extractor_error: 1 },
    })
    expect(JSON.stringify(relevant)).not.toContain('token-loader.ts')
    expect(JSON.stringify(relevant)).not.toContain('private parser detail')
    expect(unrelated.pack_confidence).toBe('high')
    expect(unrelated.coverage).toBe('complete')
    expect(unrelated.indexing_completeness?.relevant_uncertain).toBe(0)
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
      writeFileSync(graphPath, JSON.stringify({
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
      }), 'utf8')

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
      expect(variantEvidence.agent_directive).toBe('explore_with_caution')
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
      writeFileSync(graphPath, JSON.stringify({ root_path: sourceRoot }), 'utf8')

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

    expect(evidence.agent_directive).toBe('explore_with_caution')
    expect(evidence.confidence_reasons).toContain(
      'answer containedness: the pack does not contain a complete runtime answer without raw reads',
    )
  })
})
