import { describe, expect, it } from 'vitest'

import type { CompiledContextPack, ContextPackNode } from '../../src/contracts/context-pack.js'
import {
  classifyTaskContract,
  compactContextPack,
  compileContextPack,
  type ContextPackNodeCandidate,
} from '../../src/runtime/context-pack.js'

function nodeCandidate(
  entry: ContextPackNode,
  evidenceClass: 'primary' | 'supporting' | 'structural' | 'change' | 'impact',
  tokenCost: number,
): ContextPackNodeCandidate<ContextPackNode> {
  return {
    label: entry.label,
    ...(typeof entry.node_id === 'string' ? { node_id: entry.node_id } : {}),
    community: entry.community ?? null,
    evidence_class: evidenceClass,
    estimate_tokens: () => tokenCost,
    build_entry: () => ({ ...entry, evidence_class: evidenceClass }),
  }
}

describe('context-pack', () => {
  describe('classifyTaskContract', () => {
    it('classifies explain, review, and impact task contracts with required evidence classes', () => {
      expect(classifyTaskContract('explain', { budget: 320, prompt: 'Explain auth flow' })).toEqual(expect.objectContaining({
        task_kind: 'explain',
        budget: 320,
        required_evidence: ['primary', 'supporting', 'structural'],
      }))
      expect(classifyTaskContract('review', { budget: 480, prompt: 'Review current changes' })).toEqual(expect.objectContaining({
        task_kind: 'review',
        budget: 480,
        required_evidence: ['change', 'supporting', 'impact'],
      }))
      expect(classifyTaskContract('impact', { budget: 640, prompt: 'Analyze blast radius' })).toEqual(expect.objectContaining({
        task_kind: 'impact',
        budget: 640,
        required_evidence: ['primary', 'impact', 'structural'],
      }))
    })
  })

  describe('compileContextPack', () => {
    it('selects ranked evidence within budget and reports missing required coverage', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 19, prompt: 'Explain auth flow' }),
        nodes: [
          nodeCandidate({
            node_id: 'auth_service',
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 10,
            file_type: 'code',
            snippet: 'export function AuthService() {}',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
          }, 'primary', 10),
          nodeCandidate({
            node_id: 'session_manager',
            label: 'SessionManager',
            source_file: 'src/session.ts',
            line_number: 20,
            file_type: 'code',
            snippet: 'export class SessionManager {}',
            match_score: 5,
            relevance_band: 'related',
            community: 1,
            community_label: 'Session',
          }, 'supporting', 9),
          nodeCandidate({
            node_id: 'logger',
            label: 'Logger',
            source_file: 'src/logger.ts',
            line_number: 3,
            file_type: 'code',
            snippet: 'export const Logger = console',
            match_score: 2,
            relevance_band: 'peripheral',
            community: 2,
            community_label: 'Observability',
          }, 'structural', 9),
        ],
        relationships: [
          {
            from_id: 'auth_service',
            from: 'AuthService',
            to_id: 'session_manager',
            to: 'SessionManager',
            relation: 'calls',
          },
          {
            from_id: 'session_manager',
            from: 'SessionManager',
            to_id: 'logger',
            to: 'Logger',
            relation: 'uses',
          },
        ],
        community_context: [
          { id: 0, label: 'Auth', node_count: 3 },
          { id: 1, label: 'Session', node_count: 2 },
          { id: 2, label: 'Observability', node_count: 1 },
        ],
        graph_signals: {
          god_nodes: ['Logger'],
          bridge_nodes: ['SessionManager'],
        },
      })

      expect(pack.nodes.map((node) => node.label)).toEqual(['AuthService', 'SessionManager'])
      expect(pack.relationships).toEqual([
        {
          from_id: 'auth_service',
          from: 'AuthService',
          to_id: 'session_manager',
          to: 'SessionManager',
          relation: 'calls',
        },
      ])
      expect(pack.token_count).toBe(19)
      expect(pack.claims).toEqual([
        expect.objectContaining({ evidence_class: 'primary', node_labels: ['AuthService'] }),
        expect.objectContaining({ evidence_class: 'supporting', node_labels: ['SessionManager'] }),
      ])
      expect(pack.coverage).toEqual(expect.objectContaining({
        missing_required: ['structural'],
        selected_relationships: 1,
      }))
      expect(pack.coverage.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidence_class: 'primary', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ evidence_class: 'supporting', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ evidence_class: 'structural', status: 'missing', selected_nodes: 0 }),
      ]))
      expect(pack.expandable).toEqual([
        {
          kind: 'nodes',
          evidence_class: 'structural',
          count: 1,
          preview_labels: ['Logger'],
        },
      ])
      expect(pack.graph_signals).toEqual({
        god_nodes: [],
        bridge_nodes: ['SessionManager'],
      })
    })
  })

  describe('compactContextPack', () => {
    it('preserves retrieve compact semantics for hoisted file types and retained identities', () => {
      const pack: CompiledContextPack = {
        task_contract: classifyTaskContract('explain', { budget: 500, prompt: 'Where is auth defined?' }),
        token_count: 21,
        nodes: [
          {
            node_id: 'auth_service',
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 1,
            node_kind: 'function',
            file_type: 'code',
            snippet: null,
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
            framework_boost: 2,
            evidence_class: 'primary',
          },
          {
            node_id: 'session_manager',
            label: 'SessionManager',
            source_file: 'src/session.ts',
            line_number: 2,
            node_kind: 'class',
            file_type: 'code',
            snippet: null,
            match_score: 5,
            relevance_band: 'related',
            community: 0,
            community_label: 'Auth',
            framework_boost: 0,
            evidence_class: 'supporting',
          },
        ],
        relationships: [
          {
            from_id: 'auth_service',
            from: 'AuthService',
            to_id: 'session_manager',
            to: 'SessionManager',
            relation: 'calls',
          },
        ],
        community_context: [{ id: 0, label: 'Auth', node_count: 2 }],
        graph_signals: { god_nodes: [], bridge_nodes: ['SessionManager'] },
        claims: [],
        expandable: [],
        coverage: {
          required_evidence: ['primary', 'supporting', 'structural'],
          entries: [],
          missing_required: ['structural'],
          available_relationships: 1,
          selected_relationships: 1,
        },
      }

      const compact = compactContextPack(pack, { kind: 'retrieve' })

      expect(compact.shared_file_type).toBe('code')
      expect(compact.nodes[0]).toEqual(expect.objectContaining({
        node_id: 'auth_service',
        match_score: 9,
        evidence_class: 'primary',
      }))
      expect(compact.nodes[0]).not.toHaveProperty('file_type')
      expect(compact.nodes[0]).not.toHaveProperty('community_label')
      expect(compact.nodes[0]).not.toHaveProperty('framework_boost')
      expect(compact.relationships[0]).toHaveProperty('from_id', 'auth_service')
      expect(compact.relationships[0]).toHaveProperty('to_id', 'session_manager')
    })

    it('preserves pr-impact compact semantics for seed snippets and stripped support identities', () => {
      const pack: CompiledContextPack = {
        task_contract: classifyTaskContract('review', { budget: 500, prompt: 'Review current changes' }),
        token_count: 24,
        nodes: [
          {
            node_id: 'auth_service',
            label: 'authenticateUser',
            source_file: 'src/auth.ts',
            line_number: 10,
            file_type: '',
            snippet: 'return token.trim()',
            match_score: 10,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
            evidence_class: 'change',
          },
          {
            node_id: 'api_handler',
            label: 'ApiHandler',
            source_file: 'src/api.ts',
            line_number: 4,
            file_type: '',
            snippet: 'return authenticateUser(token)',
            match_score: 6,
            relevance_band: 'related',
            community: 1,
            community_label: 'API',
            evidence_class: 'supporting',
          },
        ],
        relationships: [
          {
            from_id: 'api_handler',
            from: 'ApiHandler',
            to_id: 'auth_service',
            to: 'authenticateUser',
            relation: 'calls',
          },
        ],
        community_context: [
          { id: 0, label: 'Auth', node_count: 2 },
          { id: 1, label: 'API', node_count: 1 },
        ],
        claims: [],
        expandable: [],
        coverage: {
          required_evidence: ['change', 'supporting', 'impact'],
          entries: [],
          missing_required: ['impact'],
          available_relationships: 1,
          selected_relationships: 1,
        },
      }

      const compact = compactContextPack(pack, {
        kind: 'review',
        seed_node_ids: ['auth_service'],
        seed_labels: ['authenticateUser'],
        max_supporting_nodes: 1,
      })

      expect(compact.shared_file_type).toBe('')
      expect(compact.nodes[0]).toEqual(expect.objectContaining({
        node_id: 'auth_service',
        match_score: 10,
        snippet: 'return token.trim()',
        evidence_class: 'change',
      }))
      expect(compact.nodes[1]).toEqual(expect.objectContaining({
        label: 'ApiHandler',
        snippet: null,
        evidence_class: 'supporting',
      }))
      expect(compact.nodes[1]).not.toHaveProperty('node_id')
      expect(compact.nodes[1]).not.toHaveProperty('match_score')
      expect(compact.nodes[0]).not.toHaveProperty('file_type')
      expect(compact.nodes[1]).not.toHaveProperty('file_type')
      expect(compact.relationships[0]).not.toHaveProperty('from_id')
      expect(compact.relationships[0]).not.toHaveProperty('to_id')
    })
  })
})
