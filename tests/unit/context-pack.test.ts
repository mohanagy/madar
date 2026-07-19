import { describe, expect, it } from 'vitest'

import type { CompiledContextPack, ContextPackNode } from '../../src/contracts/context-pack.js'
import {
  classifyTaskContract,
  compactContextPack,
  compileContextPack,
  estimateContextPackEntryTokens,
  renderCompiledContextPackNodes,
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
    ...(typeof entry.source_file === 'string' ? { source_file: entry.source_file } : {}),
    ...(typeof entry.line_number === 'number' ? { line_number: entry.line_number } : {}),
    ...(typeof entry.file_type === 'string' ? { file_type: entry.file_type } : {}),
    ...(typeof entry.node_kind === 'string' ? { node_kind: entry.node_kind } : {}),
    ...(typeof entry.snippet === 'string' ? { snippet: entry.snippet } : {}),
    evidence_class: evidenceClass,
    estimate_tokens: () => tokenCost,
    build_entry: () => ({ ...entry, evidence_class: evidenceClass }),
  }
}

function renderedTokenCount(nodes: readonly ContextPackNode[]): number {
  return nodes.reduce(
    (total, node) => total + estimateContextPackEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
    0,
  )
}

describe('context-pack', () => {
  describe('classifyTaskContract', () => {
    it('classifies explain, implement, review, and impact task contracts with required evidence classes', () => {
      expect(classifyTaskContract('explain', { budget: 320, prompt: 'Explain auth flow' })).toEqual(expect.objectContaining({
        task_kind: 'explain',
        budget: 320,
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
      }))
      expect(classifyTaskContract('implement', { budget: 420, prompt: 'Implement auth session invalidation' })).toEqual(expect.objectContaining({
        task_kind: 'implement',
        budget: 420,
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
      }))
      expect(classifyTaskContract('review', { budget: 480, prompt: 'Review current changes' })).toEqual(expect.objectContaining({
        task_kind: 'review',
        budget: 480,
        required_evidence: ['change', 'supporting', 'impact'],
        semantic_required: ['changes', 'impact'],
      }))
      expect(classifyTaskContract('impact', { budget: 640, prompt: 'Analyze blast radius' })).toEqual(expect.objectContaining({
        task_kind: 'impact',
        budget: 640,
        required_evidence: ['primary', 'impact', 'structural'],
        semantic_required: ['implementation', 'impact', 'structure'],
      }))
    })

    it('attaches task-specific evidence recipes when a planned intent is provided', () => {
      expect(classifyTaskContract('review', {
        budget: 480,
        prompt: 'Audit the password reset flow for injection and auth bypass issues.',
        task_intent: 'security-review',
        has_change_evidence: true,
      })).toEqual(expect.objectContaining({
        task_kind: 'review',
        task_intent: 'security-review',
        evidence_recipe_id: 'security-review',
        required_evidence: ['change', 'impact', 'supporting'],
        preferred_evidence: ['change', 'impact', 'supporting', 'primary', 'structural'],
        semantic_required: ['changes', 'impact', 'configuration'],
        semantic_optional: ['tests', 'contracts'],
      }))
    })

    it('accepts implementation-oriented task intents on implement contracts', () => {
      expect(classifyTaskContract('implement', {
        budget: 480,
        prompt: 'Generate regression tests for token refresh and session expiry.',
        task_intent: 'test-generation',
      })).toEqual(expect.objectContaining({
        task_kind: 'implement',
        task_intent: 'test-generation',
        evidence_recipe_id: 'test-generation',
        required_evidence: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'tests', 'structure'],
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
      expect(pack.token_count).toBe(renderedTokenCount(pack.nodes))
      expect(pack.claims).toEqual([
        expect.objectContaining({ evidence_class: 'primary', node_labels: ['AuthService'] }),
        expect.objectContaining({ evidence_class: 'supporting', node_labels: ['SessionManager'] }),
      ])
      expect(pack.coverage).toEqual(expect.objectContaining({
        missing_required: ['structural'],
        missing_semantic: ['structure'],
        selected_relationships: 1,
      }))
      expect(pack.coverage.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidence_class: 'primary', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ evidence_class: 'supporting', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ evidence_class: 'structural', status: 'missing', selected_nodes: 0 }),
      ]))
      expect(pack.coverage.semantic_entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'implementation', status: 'covered', selected_nodes: 2 }),
        expect.objectContaining({ category: 'structure', status: 'missing', selected_nodes: 0 }),
      ]))
      expect(pack.expandable).toEqual([
        expect.objectContaining({
          kind: 'nodes',
          handle_id: expect.stringMatching(/^expand:explain:structural:/),
          evidence_class: 'structural',
          count: 1,
          preview: [
            {
              node_id: 'logger',
              label: 'Logger',
              source_file: 'src/logger.ts',
              line_range: {
                start_line: 3,
                end_line: 3,
              },
            },
          ],
          follow_up: {
            kind: 'context_pack',
            task_kind: 'explain',
            evidence_class: 'structural',
            focus_files: ['src/logger.ts'],
            focus_ranges: [
              {
                source_file: 'src/logger.ts',
                start_line: 3,
                end_line: 3,
              },
            ],
          },
        }),
      ])
      expect(pack.graph_signals).toEqual({
        god_nodes: [],
        bridge_nodes: ['SessionManager'],
      })
    })

    it('keeps the first review node when it alone exceeds budget', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('review', { budget: 5, prompt: 'Review current changes' }),
        nodes: [
          nodeCandidate({
            node_id: 'auth_service',
            label: 'authenticateUser',
            source_file: 'src/auth.ts',
            line_number: 10,
            file_type: 'code',
            snippet: 'return token.trim()',
            match_score: 10,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
          }, 'change', 8),
          nodeCandidate({
            node_id: 'api_handler',
            label: 'ApiHandler',
            source_file: 'src/api.ts',
            line_number: 20,
            file_type: 'code',
            snippet: 'return authenticateUser(token)',
            match_score: 6,
            relevance_band: 'related',
            community: 1,
            community_label: 'API',
          }, 'supporting', 3),
        ],
      })

      expect(pack.nodes.map((node) => node.label)).toEqual(['authenticateUser'])
      expect(pack.token_count).toBe(renderedTokenCount(pack.nodes))
      expect(pack.coverage.missing_required).toEqual(['supporting', 'impact'])
      expect(pack.coverage.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidence_class: 'change', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ evidence_class: 'supporting', status: 'missing', selected_nodes: 0 }),
      ]))
      expect(pack.expandable).toEqual([
        expect.objectContaining({
          kind: 'nodes',
          handle_id: expect.stringMatching(/^expand:review:supporting:/),
          evidence_class: 'supporting',
          count: 1,
          preview: [
            {
              node_id: 'api_handler',
              label: 'ApiHandler',
              source_file: 'src/api.ts',
              line_range: {
                start_line: 20,
                end_line: 20,
              },
            },
          ],
          follow_up: {
            kind: 'context_pack',
            task_kind: 'review',
            evidence_class: 'supporting',
            focus_files: ['src/api.ts'],
            focus_ranges: [
              {
                source_file: 'src/api.ts',
                start_line: 20,
                end_line: 20,
              },
            ],
          },
        }),
      ])
    })

    it('places router-output input provenance before generic evidence claims', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', {
          budget: 80,
          prompt: 'Explain how the public status JSON gets its page status.',
        }),
        nodes: [
          nodeCandidate({
            node_id: 'unresolved_incidents',
            label: 'unresolvedIncidents()',
            source_file: 'apps/status-page/src/content/status-json.ts',
            line_number: 50,
            file_type: 'code',
            snippet: [
              'type Page = NonNullable<RouterOutputs["statusPage"]["get"]>;',
              'function unresolvedIncidents(page: Page) {',
              '  return page.statusReports.filter((report) => !report.resolvedAt)',
              '}',
            ].join('\n'),
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Public status JSON',
          }, 'primary', 20),
        ],
      })

      expect(pack.claims).toEqual([
        {
          evidence_class: 'primary',
          text: 'input provenance: unresolvedIncidents() consumes data typed as the RouterOutputs["statusPage"]["get"] router output',
          node_labels: ['unresolvedIncidents()'],
        },
        expect.objectContaining({
          evidence_class: 'primary',
          text: 'primary evidence: unresolvedIncidents()',
        }),
      ])
    })

    it('makes a split public-status projection explicit and deduplicates file-level provenance', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', {
          budget: 160,
          prompt: 'Compare public status computation paths.',
        }),
        nodes: [
          nodeCandidate({
            node_id: 'unresolved_incidents',
            label: 'unresolvedIncidents()',
            source_file: 'apps/status-page/src/content/status-json.ts',
            line_number: 50,
            file_type: 'code',
            snippet: [
              'type Page = NonNullable<RouterOutputs["statusPage"]["get"]>;',
              'status: pageIndicator(page.status),',
              'return page.statusReports.filter((report) => report.status !== "resolved")',
            ].join('\n'),
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
          }, 'primary', 20),
          nodeCandidate({
            node_id: 'status_json',
            label: 'status-json.ts',
            source_file: 'apps/status-page/src/content/status-json.ts',
            line_number: 1,
            file_type: 'code',
            snippet: 'type Page = NonNullable<RouterOutputs["statusPage"]["get"]>;',
            match_score: 8,
            relevance_band: 'direct',
            community: 0,
          }, 'primary', 10),
          nodeCandidate({
            node_id: 'status_page_router',
            label: 'statusPage.ts',
            source_file: 'packages/api/src/router/statusPage.ts',
            line_number: 226,
            file_type: 'code',
            snippet: 'events.some((e) => e.type === "incident" && !e.to) && barType !== "manual" ? "error" : activeReportStatus(events)',
            match_score: 8,
            relevance_band: 'direct',
            community: 1,
          }, 'primary', 20),
        ],
      })

      expect(pack.claims.filter((claim) => claim.text.startsWith('input provenance:'))).toHaveLength(1)
      expect(pack.claims[0]).toEqual({
        evidence_class: 'primary',
        text: 'public payload divergence: when barType is not manual, an open incident event can make page.status "error" in packages/api/src/router/statusPage.ts; apps/status-page/src/content/status-json.ts builds unresolved incident entries only from page.statusReports, so an auto-created incident without a status report can yield an error indicator with an empty incidents list',
        node_labels: ['unresolvedIncidents()', 'statusPage.ts'],
      })
      expect(pack.claims[1]?.text).toBe(
        'input provenance: unresolvedIncidents() consumes data typed as the RouterOutputs["statusPage"]["get"] router output',
      )
    })

    it('states the public runtime router provenance separately from an alternate computation', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', {
          budget: 180,
          prompt: 'Identify inconsistent public status computation paths.',
        }),
        nodes: [
          nodeCandidate({
            node_id: 'public_status_route',
            label: 'GET()',
            source_file: 'apps/status-page/src/app/api/status/[[...path]]/route.ts',
            line_number: 34,
            file_type: 'code',
            snippet: 'const data = await queryClient.fetchQuery(trpc.statusPage.get.queryOptions({ slug })); const payload = toStatus(data, baseUrl)',
            match_score: 10,
            relevance_band: 'direct',
            community: 0,
          }, 'primary', 20),
          nodeCandidate({
            node_id: 'status_page_router',
            label: 'statusPage.ts',
            source_file: 'packages/api/src/router/statusPage.ts',
            line_number: 226,
            file_type: 'code',
            snippet: 'events.some((e) => e.type === "incident" && !e.to) && barType !== "manual"',
            match_score: 9,
            relevance_band: 'direct',
            community: 1,
          }, 'primary', 20),
          nodeCandidate({
            node_id: 'alternate_status',
            label: 'computeOverallStatus()',
            source_file: 'apps/server/src/routes/rpc/handlers/status-page/index.ts',
            line_number: 360,
            file_type: 'code',
            snippet: 'const overallStatus = hasActiveStatusReport ? DEGRADED : hasActiveMaintenance ? MAINTENANCE : OPERATIONAL',
            match_score: 8,
            relevance_band: 'direct',
            community: 2,
          }, 'primary', 20),
        ],
      })

      expect(pack.claims[0]).toEqual({
        evidence_class: 'primary',
        text: 'public runtime provenance: apps/status-page/src/app/api/status/[[...path]]/route.ts GET() fetches trpc.statusPage.get and passes that data to the public status-json serializers backed by packages/api/src/router/statusPage.ts; packages/api/src/router/statusPage.ts treats an open incident event as "error" outside manual mode, while apps/server/src/routes/rpc/handlers/status-page/index.ts computeOverallStatus() derives overall status from active status reports and maintenance',
        node_labels: ['GET()', 'statusPage.ts', 'computeOverallStatus()'],
      })
    })

    it('states the failed-check transport handoff across Go owners', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', {
          budget: 120,
          prompt: 'Trace a failed monitor check into the workflow.',
        }),
        nodes: [
          nodeCandidate({
            node_id: 'http_checker_handler',
            label: '.HTTPCheckerHandler()',
            source_file: 'apps/checker/handlers/checker.go',
            line_number: 47,
            file_type: 'code',
            snippet: 'checker.UpdateStatus(ctx, checker.UpdateData{ Status: "error", MonitorId: req.MonitorID })',
            match_score: 10,
            relevance_band: 'direct',
            community: 0,
          }, 'primary', 20),
          nodeCandidate({
            node_id: 'update_status',
            label: 'UpdateStatus()',
            source_file: 'apps/checker/checker/update.go',
            line_number: 29,
            file_type: 'code',
            snippet: 'client, err := cloudtasks.NewClient(ctx); _, err = client.CreateTask(ctx, req)',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
          }, 'primary', 20),
        ],
      })

      expect(pack.claims[0]).toEqual({
        evidence_class: 'primary',
        text: 'failure detection: apps/checker/handlers/checker.go .HTTPCheckerHandler() sends Status "error" to UpdateStatus',
        node_labels: ['.HTTPCheckerHandler()'],
      })
      expect(pack.claims[1]).toEqual({
        evidence_class: 'primary',
        text: 'cross-runtime handoff: apps/checker/checker/update.go UpdateStatus() enqueues the checker status update with Cloud Tasks',
        node_labels: ['UpdateStatus()'],
      })
    })

    it('keeps the same selected labels while task-aware rendering changes representation cost after selection', () => {
      const nodes = [
        nodeCandidate({
          node_id: 'auth_service',
          label: 'AuthService.login',
          source_file: 'src/auth/service.ts',
          line_number: 18,
          file_type: 'code',
          snippet: [
            'export class AuthService {',
            '  async login(input: LoginInput) {',
            '    return this.sessionStore.create(input.userId)',
            '  }',
            '}',
          ].join('\n'),
          match_score: 10,
          relevance_band: 'direct',
          community: 0,
          community_label: 'Auth',
        }, 'primary', 18),
        nodeCandidate({
          node_id: 'auth_controller',
          label: 'AuthController.callback',
          source_file: 'src/auth/controller.ts',
          line_number: 10,
          file_type: 'code',
          snippet: [
            'export class AuthController {',
            '  async callback(input: LoginInput) {',
            '    return this.authService.login(input)',
            '  }',
            '}',
          ].join('\n'),
          match_score: 8,
          relevance_band: 'related',
          community: 0,
          community_label: 'Auth',
        }, 'structural', 17),
      ] as const
      const relationships = [
        {
          from_id: 'auth_controller',
          from: 'AuthController.callback',
          to_id: 'auth_service',
          to: 'AuthService.login',
          relation: 'calls',
        },
      ] as const

      const explainPack = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 64, prompt: 'Explain the auth callback flow' }),
        nodes,
        relationships,
      })
      const reviewPack = compileContextPack({
        task_contract: classifyTaskContract('review', { budget: 64, prompt: 'Review the auth callback changes' }),
        nodes,
        relationships,
      })

      expect(explainPack.nodes.map((node) => node.label).sort()).toEqual(reviewPack.nodes.map((node) => node.label).sort())
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).toBe('detail')
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_reason).toBe('explain detail preserved')
      expect(reviewPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).toBe('signature')
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_controller')?.snippet).toContain('return this.authService.login(input)')
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_service')?.snippet).toContain('return this.sessionStore.create(input.userId)')
      expect(reviewPack.token_count).toBeLessThan(explainPack.token_count)
      expect(explainPack.token_count).toBe(renderedTokenCount(explainPack.nodes))
      expect(reviewPack.token_count).toBe(renderedTokenCount(reviewPack.nodes))
    })

    it('compresses selected explain nodes more aggressively when the token budget is tight', () => {
      const nodes = [
        nodeCandidate({
          node_id: 'auth_controller',
          label: 'AuthController.callback',
          source_file: 'src/auth/controller.ts',
          line_number: 12,
          file_type: 'code',
          snippet: [
            'export class AuthController {',
            '  async callback(input: LoginInput) {',
            '    const normalized = normalizeCallback(input)',
            '    const user = await this.authService.login(normalized)',
            '    return this.sessionStore.create(user.id)',
            '  }',
            '}',
          ].join('\n'),
          match_score: 10,
          relevance_band: 'direct',
          community: 0,
          community_label: 'Auth',
        }, 'primary', 8),
        nodeCandidate({
          node_id: 'auth_service',
          label: 'AuthService.login',
          source_file: 'src/auth/service.ts',
          line_number: 20,
          file_type: 'code',
          snippet: [
            'export class AuthService {',
            '  async login(input: LoginInput) {',
            '    await this.validator.validate(input)',
            '    const token = this.tokenService.sign(input.userId)',
            '    return this.sessionStore.create(token)',
            '  }',
            '}',
          ].join('\n'),
          match_score: 8,
          relevance_band: 'related',
          community: 0,
          community_label: 'Auth',
        }, 'supporting', 8),
      ]
      const relationships = [
        {
          from_id: 'auth_controller',
          from: 'AuthController.callback',
          to_id: 'auth_service',
          to: 'AuthService.login',
          relation: 'calls',
        },
      ] as const

      const generous = renderCompiledContextPackNodes(
        classifyTaskContract('explain', { budget: 256, prompt: 'Explain the auth callback flow' }),
        nodes.map((candidate) => candidate.build_entry()),
        relationships,
      )
      const constrained = renderCompiledContextPackNodes(
        classifyTaskContract('explain', { budget: 32, prompt: 'Explain the auth callback flow' }),
        nodes.map((candidate) => candidate.build_entry()),
        relationships,
      )

      expect(generous.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).toBe('detail')
      expect(constrained.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).not.toBe('detail')
      expect(constrained.token_count).toBeLessThan(generous.token_count)
    })

    it('does not materialize omitted entries when candidate metadata already covers previews and semantics', () => {
      let primaryBuilds = 0
      let omittedBuilds = 0

      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 10, prompt: 'Explain auth flow' }),
        nodes: [
          {
            label: 'AuthService',
            node_id: 'auth_service',
            source_file: 'src/auth.ts',
            line_number: 10,
            file_type: 'code',
            snippet: 'export function AuthService() {}',
            community: 0,
            evidence_class: 'primary',
            estimate_tokens: () => 10,
            build_entry: () => {
              primaryBuilds += 1
              return {
                node_id: 'auth_service',
                label: 'AuthService',
                source_file: 'src/auth.ts',
                line_number: 10,
                file_type: 'code',
                snippet: 'export function AuthService() {}',
                match_score: 10,
                relevance_band: 'direct',
                community: 0,
                community_label: 'Auth',
                evidence_class: 'primary',
              }
            },
          } as ContextPackNodeCandidate<ContextPackNode> & {
            source_file: string
            line_number: number
            file_type: string
          },
          {
            label: 'Logger',
            node_id: 'logger',
            source_file: 'src/logger.ts',
            line_number: 3,
            file_type: 'code',
            snippet: 'export const Logger = console',
            evidence_class: 'structural',
            expandable_ref: {
              node_id: 'logger',
              label: 'Logger',
              source_file: 'src/logger.ts',
              line_range: {
                start_line: 3,
                end_line: 3,
              },
            },
            estimate_tokens: () => 9,
            build_entry: () => {
              omittedBuilds += 1
              return {
                node_id: 'logger',
                label: 'Logger',
                source_file: 'src/logger.ts',
                line_number: 3,
                file_type: 'code',
                snippet: 'export const Logger = console',
                match_score: 2,
                relevance_band: 'peripheral',
                community: 1,
                community_label: 'Observability',
                evidence_class: 'structural',
              }
            },
          } as ContextPackNodeCandidate<ContextPackNode> & {
            source_file: string
            line_number: number
            file_type: string
          },
        ],
      })

      expect(pack.nodes.map((node) => node.label)).toEqual(['AuthService'])
      expect(pack.coverage.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          evidence_class: 'structural',
          available_nodes: 1,
          selected_nodes: 0,
          status: 'missing',
        }),
      ]))
      expect(pack.coverage.semantic_entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'implementation',
          available_nodes: 2,
          selected_nodes: 1,
        }),
        expect.objectContaining({
          category: 'structure',
          available_nodes: 1,
          selected_nodes: 0,
        }),
      ]))
      expect(pack.expandable).toEqual([
        expect.objectContaining({
          evidence_class: 'structural',
          preview: [
            expect.objectContaining({
              source_file: 'src/logger.ts',
              line_range: {
                start_line: 3,
                end_line: 3,
              },
            }),
          ],
        }),
      ])
      expect(primaryBuilds).toBe(1)
      expect(omittedBuilds).toBe(0)
    })

    it('materializes omitted entries when snippet text is required for semantic coverage classification', () => {
      let omittedBuilds = 0

      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', {
          budget: 12,
          prompt: 'Where does runtime configuration appear?',
        }),
        nodes: [
          nodeCandidate({
            node_id: 'service',
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 7,
            file_type: 'code',
            snippet: 'export function AuthService() {}',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
          }, 'primary', 6),
          {
            label: 'EnvAccess',
            node_id: 'env_access',
            source_file: 'src/auth.ts',
            line_number: 21,
            file_type: 'code',
            evidence_class: 'supporting',
            estimate_tokens: () => 20,
            build_entry: () => {
              omittedBuilds += 1
              return {
                node_id: 'env_access',
                label: 'EnvAccess',
                source_file: 'src/auth.ts',
                line_number: 21,
                file_type: 'code',
                snippet: 'const redirect = process.env.AUTH_REDIRECT_URL',
                match_score: 1,
                relevance_band: 'peripheral',
                evidence_class: 'supporting',
              }
            },
          } satisfies ContextPackNodeCandidate<ContextPackNode>,
        ],
      })

      expect(pack.coverage.semantic_entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'configuration',
          available_nodes: 1,
          selected_nodes: 0,
        }),
      ]))
      expect(omittedBuilds).toBe(1)
    })

    it('reorders selected review evidence based on the task-specific recipe preferences', () => {
      const nodes = [
        nodeCandidate({
          node_id: 'changed_handler',
          label: 'ChangedHandler',
          source_file: 'src/auth.ts',
          line_number: 10,
          file_type: 'code',
          snippet: 'export function ChangedHandler() {}',
          match_score: 10,
          relevance_band: 'direct',
          community: 0,
          community_label: 'Auth',
        }, 'change', 8),
        nodeCandidate({
          node_id: 'supporting_fixture',
          label: 'SupportingFixture',
          source_file: 'tests/auth.test.ts',
          line_number: 4,
          file_type: 'code',
          snippet: 'expect(refresh()).toBeTruthy()',
          match_score: 8,
          relevance_band: 'related',
          community: 1,
          community_label: 'Tests',
        }, 'supporting', 6),
        nodeCandidate({
          node_id: 'auth_bypass_path',
          label: 'AuthBypassPath',
          source_file: 'src/reset.ts',
          line_number: 18,
          file_type: 'code',
          snippet: 'if (token === "debug") return true',
          match_score: 7,
          relevance_band: 'related',
          community: 2,
          community_label: 'Security',
        }, 'impact', 6),
      ] as const

      const genericReviewPack = compileContextPack({
        task_contract: classifyTaskContract('review', {
          budget: 14,
          prompt: 'Review auth changes',
        }),
        nodes,
      })
      const securityReviewPack = compileContextPack({
        task_contract: classifyTaskContract('review', {
          budget: 14,
          prompt: 'Audit the password reset flow for injection and auth bypass issues.',
          task_intent: 'security-review',
          has_change_evidence: true,
        }),
        nodes,
      })

      expect(genericReviewPack.nodes.map((node) => node.label)).toEqual(['ChangedHandler', 'SupportingFixture'])
      expect(securityReviewPack.nodes.map((node) => node.label)).toEqual(['ChangedHandler', 'AuthBypassPath'])
      expect(securityReviewPack.coverage.required_evidence).toEqual(['change', 'impact', 'supporting'])
      expect(securityReviewPack.coverage.semantic_required).toEqual(['changes', 'impact', 'configuration'])
      expect(securityReviewPack.coverage.missing_semantic).toEqual(['configuration'])
      expect(securityReviewPack.coverage.semantic_entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'changes', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ category: 'impact', status: 'covered', selected_nodes: 1 }),
        expect.objectContaining({ category: 'tests', status: 'available', available_nodes: 1, selected_nodes: 0 }),
        expect.objectContaining({ category: 'configuration', status: 'missing', selected_nodes: 0 }),
      ]))
      expect(securityReviewPack.claims[1]).toEqual(expect.objectContaining({
        evidence_class: 'impact',
        node_labels: ['AuthBypassPath'],
      }))
    })

    it('builds stable expandable handle ids for the same omitted evidence set', () => {
      const first = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 10, prompt: 'Explain auth flow' }),
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
            node_id: 'session_policy',
            label: 'SessionPolicy',
            source_file: 'src/session-policy.ts',
            line_number: 24,
            file_type: 'code',
            snippet: 'export class SessionPolicy {}',
            match_score: 4,
            relevance_band: 'related',
            community: 1,
            community_label: 'Session',
          }, 'supporting', 8),
        ],
      })
      const second = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 10, prompt: 'Explain auth flow' }),
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
            node_id: 'session_policy',
            label: 'SessionPolicy',
            source_file: 'src/session-policy.ts',
            line_number: 24,
            file_type: 'code',
            snippet: 'export class SessionPolicy {}',
            match_score: 4,
            relevance_band: 'related',
            community: 1,
            community_label: 'Session',
          }, 'supporting', 8),
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
        ],
      })

      expect(first.expandable[0]?.handle_id).toBe(second.expandable[0]?.handle_id)
      expect(first.expandable[0]?.follow_up).toEqual({
        kind: 'context_pack',
        task_kind: 'explain',
        evidence_class: 'supporting',
        focus_files: ['src/session-policy.ts', 'src/session.ts'],
        focus_ranges: [
          {
            source_file: 'src/session-policy.ts',
            start_line: 24,
            end_line: 24,
          },
          {
            source_file: 'src/session.ts',
            start_line: 20,
            end_line: 20,
          },
        ],
      })
    })

    it('ignores non-finite expandable ranges and falls back to entry line numbers', () => {
      const pack = compileContextPack({
        task_contract: classifyTaskContract('explain', { budget: 10, prompt: 'Explain auth flow' }),
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
          {
            ...nodeCandidate({
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
            expandable_ref: {
              node_id: 'logger',
              label: 'Logger',
              source_file: 'src/logger.ts',
              line_range: {
                start_line: Number.NaN,
                end_line: Number.POSITIVE_INFINITY,
              },
            },
          },
        ],
      })

      expect(pack.expandable[0]?.preview[0]).toEqual({
        node_id: 'logger',
        label: 'Logger',
        source_file: 'src/logger.ts',
        line_range: {
          start_line: 3,
          end_line: 3,
        },
      })
      expect(pack.expandable[0]?.follow_up.focus_ranges).toEqual([
        {
          source_file: 'src/logger.ts',
          start_line: 3,
          end_line: 3,
        },
      ])
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
          semantic_required: ['implementation', 'structure'],
          semantic_optional: ['contracts', 'configuration', 'tests'],
          entries: [],
          semantic_entries: [],
          missing_required: ['structural'],
          missing_semantic: ['structure'],
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
          semantic_required: ['changes', 'impact'],
          semantic_optional: ['tests', 'configuration', 'contracts'],
          entries: [],
          semantic_entries: [],
          missing_required: ['impact'],
          missing_semantic: ['impact'],
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
