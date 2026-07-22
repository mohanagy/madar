import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ContextPackCommunityContext,
  ContextPackCoverage,
  ContextPackNode,
  ContextPackRelationship,
  ContextPackSchemaV1,
} from '../../src/contracts/context-pack.js'
import { createTestGraph } from '../helpers/knowledge-graph.js'
import { buildHandoffArtifactV1, runHandoffCommand } from '../../src/infrastructure/handoff-command.js'
import type { MadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'

interface TestPack {
  matched_nodes: ContextPackNode[]
  relationships: ContextPackRelationship[]
  community_context: ContextPackCommunityContext[]
}

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function emptyCoverage(): ContextPackCoverage {
  return {
    required_evidence: [],
    semantic_required: [],
    semantic_optional: [],
    entries: [],
    semantic_entries: [],
    missing_required: [],
    missing_semantic: [],
    available_relationships: 0,
    selected_relationships: 0,
  }
}

function sampleEvidence(root: string): MadarResponseEvidence {
  return {
    pack_confidence: 'high',
    evidence_strength: {
      level: 'strong',
      direct_selected_nodes: 1,
      supporting_selected_nodes: 1,
      selected_relationships: 1,
      available_relationships: 1,
      reasons: ['direct_evidence_with_relationship_support'],
    },
    coverage: 'complete',
    coverage_detail: {
      status: 'complete',
      required_obligations: [],
      covered_obligations: [],
      missing_obligations: [],
    },
    answerability: {
      state: 'ready',
      answer_scope: 'complete',
      caveats: [],
      missing_obligations: [],
      verification_targets: [],
      broad_search_fallback: 'not_needed',
    },
    missing_phases: [],
    covered_workflow_owners: ['src/auth/service.ts'],
    confidence_reasons: [`scope quality: runtime evidence is concentrated under src/auth/ while the graph is rooted at ${join(root, 'out', 'graph.json')}`],
    agent_directive: 'answer_from_pack',
    discovery_exclusions: {
      policy: 'artifact_path_only',
      total: 2,
      relevant: 1,
      reasons: {
        secret_config: 1,
      },
      relevant_reasons: {
        secret_config: 1,
      },
    },
  }
}

function createPackSchema(root: string): ContextPackSchemaV1<TestPack> {
  return {
    schema_version: 1,
    task: 'implement',
    task_intent: 'implement',
    prompt: 'Implement login session handoff',
    budget: 1800,
    graph_path: join(root, 'out', 'graph.json'),
    plan: {
      version: 1,
      task_kind: 'implement',
      prompt: 'Implement login session handoff',
      total_budget: 1800,
      scope: {
        seed_mode: 'focused',
        focus_paths: [join(root, 'src', 'auth', 'service.ts')],
        changed_paths: [],
      },
      evidence: {
        recipe_id: 'implement',
        required: ['primary', 'supporting'],
        preferred: ['structural'],
        semantic_required: ['implementation', 'tests'],
        semantic_optional: ['contracts'],
      },
      steps: [
        {
          id: 'seed',
          kind: 'retrieve',
          title: 'Find the session entrypoint',
          budget: 600,
          evidence: ['primary'],
          scope_mode: 'focused',
          scope_paths: [join(root, 'src', 'auth', 'service.ts')],
        },
      ],
    },
    workflow_centers: [
      {
        label: 'Auth flow',
        path: join(root, 'src', 'auth', 'service.ts'),
        reason: 'Login orchestration starts here.',
      },
    ],
    recommended_first_read: [
      {
        path: join(root, 'src', 'auth', 'service.ts'),
        label: 'AuthService.login',
        reason: `Read ${join(root, 'src', 'auth', 'service.ts')} first to follow the login path.`,
      },
    ],
    likely_edit_files: [
      {
        path: join(root, 'src', 'auth', 'service.ts'),
        score: 0.97,
        reason: `Session creation currently happens in ${join(root, 'src', 'auth', 'service.ts')}.`,
        matched_symbols: ['AuthService.login'],
      },
    ],
    likely_test_files: [
      {
        path: join(root, 'tests', 'auth.service.test.ts'),
        score: 0.81,
        reason: 'Regression coverage already exists here.',
        matched_symbols: ['AuthService login'],
      },
    ],
    public_contracts: [
      {
        label: 'LoginRequest',
        source_file: join(root, 'src', 'contracts', 'auth.ts'),
        line_number: 12,
        kind: 'contract',
        why: `The request contract lives in ${join(root, 'src', 'contracts', 'auth.ts')}.`,
      },
    ],
    retrieval_pipeline: {
      phases: [
        { phase: 'seed', summary: 'Anchor the auth entrypoint and tests.' },
      ],
    },
    risk_boundaries: [
      {
        label: 'Session persistence',
        severity: 'high',
        reason: `Writes fan out into ${join(root, 'src', 'session', 'store.ts')}.`,
        affected_files: [
          join(root, 'src', 'session', 'store.ts'),
          '/tmp/external/private.ts',
        ],
        affected_communities: ['auth-runtime'],
      },
    ],
    validation_commands: [
      'OPENAI_API_KEY=super-secret npm run test:run -- tests/unit/auth.service.test.ts',
      'OPENAI_API_KEY="super-secret" npm run build',
      'curl -H "Authorization: Bearer abc123" https://user:pass@example.com/login?token=abc123',
    ],
    negative_guidance: [
      `Do not edit generated files under ${join(root, 'dist')}.`,
    ],
    confidence_score: 0.92,
    why_explanation: [
      `Start in ${join(root, 'src', 'auth', 'service.ts')} because the planner and workflow center agree on it.`,
    ],
    pack: {
      matched_nodes: [
        {
          label: 'AuthService.login',
          source_file: join(root, 'src', 'auth', 'service.ts'),
          line_number: 33,
          snippet: 'const sessionToken = await issueSessionToken(user)',
          evidence_class: 'primary',
          file_type: 'code',
        },
        {
          label: 'ExternalSecretReader',
          source_file: '/opt/private/secret-reader.ts',
          line_number: 7,
          snippet: 'const leaked = readFileSync("/opt/private/token.txt", "utf8")',
          evidence_class: 'supporting',
          file_type: 'code',
        },
      ],
      relationships: [
        {
          from: 'AuthService.login',
          to: 'SessionStore.createSession',
          relation: 'calls',
        },
      ],
      community_context: [
        {
          id: 1,
          label: 'Auth runtime',
          node_count: 6,
        },
      ],
    },
    evidence: sampleEvidence(root),
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
        task: 'implement',
        task_intent: 'implement',
        budget: 1800,
      },
      directive: {
        pack_confidence: 'high',
        evidence_strength: 'strong',
        coverage: 'complete',
        answerability: 'ready',
        agent_directive: 'answer_from_pack',
        missing_phases: [],
        missing_obligation_count: 0,
        verification_target_count: 0,
        recovery_attempts: 0,
        recovery_improved: false,
      },
      follow_up: {
        expandable_handle_count: 1,
        expandable_evidence_classes: ['primary'],
        expansion_task_kinds: ['implement'],
        preview_item_count: 1,
        focus_file_count: 1,
        focus_range_count: 1,
      },
    },
    claims: [
      {
        evidence_class: 'primary',
        text: `The login path starts in ${join(root, 'src', 'auth', 'service.ts')}.`,
        node_labels: ['AuthService.login'],
      },
    ],
    expandable: [
      {
        kind: 'nodes',
        handle_id: 'auth-flow',
        evidence_class: 'primary',
        count: 1,
        preview: [
          {
            label: 'AuthService.login',
            source_file: join(root, 'src', 'auth', 'service.ts'),
          },
        ],
        follow_up: {
          kind: 'context_pack',
          task_kind: 'implement',
          evidence_class: 'primary',
          focus_files: [join(root, 'src', 'auth', 'service.ts')],
          focus_ranges: [
            {
              source_file: join(root, 'src', 'auth', 'service.ts'),
              start_line: 30,
              end_line: 48,
            },
          ],
        },
      },
    ],
    coverage: emptyCoverage(),
    missing_context: [],
    missing_semantic: [],
    retrieval_gate: {
      level: 4,
      skipped_retrieval: false,
      reason: 'manual override',
      intent: 'implement',
      signals: {
        has_pr_diff: false,
        has_stack_trace: false,
        mentioned_paths: [join(root, 'src', 'auth', 'service.ts')],
        mentioned_symbols: ['AuthService.login'],
        excluded_path_hints: [join(root, 'tests', 'auth.service.test.ts')],
      },
    },
  }
}

describe('handoff-command', () => {
  it('builds a share-safe handoff artifact by default without raw plan state or snippets', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-handoff-'))
    tempRoots.push(root)
    const artifact = buildHandoffArtifactV1(createPackSchema(root), {
      consumer: 'copilot',
      artifactRoot: join(root, 'out'),
      projectRoot: root,
    })

    expect(artifact).toMatchObject({
      schema_version: 1,
      artifact_kind: 'madar_handoff',
      consumer: 'copilot',
      share_safe: true,
      snippet_policy: 'omit',
      task: 'implement',
      task_intent: 'implement',
      prompt: 'Implement login session handoff',
      graph_path: '<artifact-root>/graph.json',
      workflow_centers: [
        expect.objectContaining({
          path: '<project-root>/src/auth/service.ts',
        }),
      ],
      recommended_first_read: [
        expect.objectContaining({
          path: '<project-root>/src/auth/service.ts',
        }),
      ],
      likely_edit_files: [
        expect.objectContaining({
          path: '<project-root>/src/auth/service.ts',
        }),
      ],
      likely_test_files: [
        expect.objectContaining({
          path: '<project-root>/tests/auth.service.test.ts',
        }),
      ],
      public_contracts: [
        expect.objectContaining({
          source_file: '<project-root>/src/contracts/auth.ts',
        }),
      ],
      risk_boundaries: [
        expect.objectContaining({
          affected_files: ['<project-root>/src/session/store.ts', 'private.ts'],
        }),
      ],
    })

    expect(artifact).not.toHaveProperty('plan')
    expect(artifact.evidence.discovery_exclusions).toEqual({
      policy: 'artifact_path_only',
      total: 2,
      relevant: 1,
      reasons: { secret_config: 1 },
      relevant_reasons: { secret_config: 1 },
    })
    expect(artifact.pack.matched_nodes[0]).not.toHaveProperty('snippet')
    expect(JSON.stringify(artifact)).not.toContain(root)
    expect(JSON.stringify(artifact)).not.toContain('/opt/private/secret-reader.ts')
    expect(JSON.stringify(artifact)).not.toContain('super-secret')
    expect(JSON.stringify(artifact)).not.toContain('abc123')
    expect(JSON.stringify(artifact)).not.toContain('user:pass')
  })

  it('marks snippet-inclusive handoffs as non-share-safe while still sanitizing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-handoff-'))
    tempRoots.push(root)
    const artifact = buildHandoffArtifactV1(createPackSchema(root), {
      consumer: 'generic',
      allowSnippets: true,
      artifactRoot: join(root, 'out'),
      projectRoot: root,
    })

    expect(artifact.share_safe).toBe(false)
    expect(artifact.snippet_policy).toBe('include')
    expect(artifact.pack.matched_nodes[0]?.snippet).toBe('const sessionToken = await issueSessionToken(user)')
    expect(artifact.pack.matched_nodes[0]?.source_file).toBe('<project-root>/src/auth/service.ts')
    expect(artifact.pack.matched_nodes[1]?.source_file).toBe('secret-reader.ts')
  })

  it('sanitizes exact answerability verification targets in share-safe handoffs', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-handoff-'))
    tempRoots.push(root)
    const schema = createPackSchema(root)
    schema.evidence.answerability = {
      state: 'verify_targets',
      answer_scope: 'partial',
      caveats: [],
      missing_obligations: ['evidence:supporting'],
      verification_targets: [{
        handle_id: 'auth-support',
        evidence_class: 'supporting',
        focus_files: [join(root, 'src', 'auth', 'store.ts')],
        focus_ranges: [{
          source_file: join(root, 'src', 'auth', 'store.ts'),
          start_line: 10,
          end_line: 20,
        }],
        reason: `verify ${join(root, 'src', 'auth', 'store.ts')}`,
      }],
      broad_search_fallback: 'targeted_only',
    }

    const artifact = buildHandoffArtifactV1(schema, {
      consumer: 'copilot',
      artifactRoot: join(root, 'out'),
      projectRoot: root,
    })

    expect(artifact.evidence.answerability.verification_targets).toEqual([
      expect.objectContaining({
        focus_files: ['<project-root>/src/auth/store.ts'],
        focus_ranges: [expect.objectContaining({
          source_file: '<project-root>/src/auth/store.ts',
        })],
        reason: 'verify <project-root>/src/auth/store.ts',
      }),
    ])
    expect(JSON.stringify(artifact)).not.toContain(root)
  })

  it('normalizes relative graph paths when building a handoff from the command entrypoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-handoff-'))
    tempRoots.push(root)
    const schema = {
      ...createPackSchema(root),
      graph_path: 'out/graph.json',
    } satisfies ContextPackSchemaV1<TestPack>
    const graph = createTestGraph({})
    graph.graph.root_path = root

    const output = await runHandoffCommand({
      prompt: schema.prompt,
      budget: schema.budget,
      task: schema.task,
      graphPath: 'out/graph.json',
      consumer: 'cursor',
    }, {
      loadGraph: () => graph,
      runContextPackCommand: async () => JSON.stringify(schema),
    })

    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      consumer: 'cursor',
      graph_path: '<artifact-root>/graph.json',
    }))
  })
})
