import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function createRepo(options: { reviewHeavy?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-stdio-pr-impact-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })

  const authLines = Array.from({ length: 40 }, (_, index) => `// auth filler ${index + 1}`)
  authLines[9] = 'export function authenticateUser(token: string) {'
  authLines[10] = '  const parsed = token.trim()'
  authLines[11] = '  const status = "ok"'
  authLines[12] = '  return parsed.length > 0 ? status : "fail"'
  authLines[13] = '}'

  const apiLines = Array.from({ length: 16 }, (_, index) => `// api filler ${index + 1}`)
  apiLines[4] = 'export function ApiHandler(token: string) {'
  apiLines[5] = '  return authenticateUser(token)'
  apiLines[6] = '}'

  writeFileSync(join(root, 'src', 'auth.ts'), `${authLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'src', 'api.ts'), `${apiLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')
  writeFileSync(join(root, 'tests', 'api.test.ts'), 'describe("api", () => {})\n', 'utf8')
  const reviewFixtureFiles = options.reviewHeavy ? [
    {
      id: 'review_session',
      label: 'resolveReviewerSession',
      relativePath: 'src/review-session.ts',
      sourceLocation: 'L1-L5',
      community: 2,
      lines: [
        'export function resolveReviewerSession(token: string) {',
        '  const normalized = token.trim()',
        '  const reviewable = normalized.startsWith("Bearer ")',
        '  return { reviewable, reviewer: reviewable ? "maintainer" : "guest" }',
        '}',
        '',
      ],
    },
    {
      id: 'audit_logger',
      label: 'appendAuthAudit',
      relativePath: 'src/audit-log.ts',
      sourceLocation: 'L1-L5',
      community: 3,
      lines: [
        'export function appendAuthAudit(actor: string, status: string) {',
        '  const event = `${actor}:${status}`',
        '  return event.toLowerCase()',
        '}',
        '',
      ],
    },
    {
      id: 'merge_queue_gate',
      label: 'MergeQueueGate',
      relativePath: 'src/merge-queue-gate.ts',
      sourceLocation: 'L1-L5',
      community: 4,
      lines: [
        'export function MergeQueueGate(token: string) {',
        '  const lane = token.includes("hotfix") ? "priority" : "default"',
        '  return `${lane}:queued`',
        '}',
        '',
      ],
    },
    {
      id: 'review_summary_digest',
      label: 'ReviewSummaryDigest',
      relativePath: 'src/review-summary-digest.ts',
      sourceLocation: 'L1-L5',
      community: 2,
      lines: [
        'export function ReviewSummaryDigest(prTitle: string) {',
        '  const heading = prTitle.trim()',
        '  return heading.length > 0 ? heading : "untitled-review"',
        '}',
        '',
      ],
    },
    {
      id: 'reviewer_roster_sync',
      label: 'ReviewerRosterSync',
      relativePath: 'src/reviewer-roster-sync.ts',
      sourceLocation: 'L1-L5',
      community: 2,
      lines: [
        'export function ReviewerRosterSync(team: string) {',
        '  const normalized = team.trim().toLowerCase()',
        '  return normalized.length > 0 ? normalized.split("-") : []',
        '}',
        '',
      ],
    },
    {
      id: 'risk_escalation_digest',
      label: 'RiskEscalationDigest',
      relativePath: 'src/risk-escalation-digest.ts',
      sourceLocation: 'L1-L5',
      community: 4,
      lines: [
        'export function RiskEscalationDigest(score: number) {',
        '  return score > 8 ? "page-security" : "queue-review"',
        '}',
        '',
      ],
    },
    {
      id: 'security_checklist_digest',
      label: 'SecurityChecklistDigest',
      relativePath: 'src/security-checklist-digest.ts',
      sourceLocation: 'L1-L5',
      community: 3,
      lines: [
        'export function SecurityChecklistDigest(items: string[]) {',
        '  return items.filter((item) => item.includes("review"))',
        '}',
        '',
      ],
    },
    {
      id: 'stale_reviewer_reminder',
      label: 'StaleReviewerReminder',
      relativePath: 'src/stale-reviewer-reminder.ts',
      sourceLocation: 'L1-L5',
      community: 2,
      lines: [
        'export function StaleReviewerReminder(hoursOpen: number) {',
        '  return hoursOpen > 24 ? "nudge" : "quiet"',
        '}',
        '',
      ],
    },
  ] as const : []
  for (const fixtureFile of reviewFixtureFiles) {
    writeFileSync(join(root, fixtureFile.relativePath), fixtureFile.lines.join('\n'), 'utf8')
  }
  writeCanonicalGraphFixture(
    join(root, 'out', 'graph.json'),
    {
      community_labels: {
        '0': 'Auth Layer',
        '1': 'API Layer',
        ...(options.reviewHeavy ? {
          '2': 'Review Ops',
          '3': 'Audit Trail',
          '4': 'Release Safety',
        } : {}),
      },
      nodes: [
        {
          id: 'auth_user',
          label: 'authenticateUser',
          source_file: join(root, 'src', 'auth.ts'),
          source_location: 'L10-L14',
          node_kind: 'function',
          file_type: 'code',
          community: 0,
        },
        {
          id: 'auth_guard',
          label: 'AuthGuard',
          source_file: join(root, 'src', 'auth.ts'),
          source_location: 'L30-L32',
          node_kind: 'function',
          file_type: 'code',
          community: 0,
        },
        {
          id: 'api_handler',
          label: 'ApiHandler',
          source_file: join(root, 'src', 'api.ts'),
          source_location: 'L5-L7',
          node_kind: 'function',
          file_type: 'code',
          community: 1,
        },
        ...reviewFixtureFiles.map((fixtureFile) => ({
          id: fixtureFile.id,
          label: fixtureFile.label,
          source_file: join(root, fixtureFile.relativePath),
          source_location: fixtureFile.sourceLocation,
          node_kind: 'function',
          file_type: 'code',
          community: fixtureFile.community,
        })),
      ],
      edges: [
        {
          source: 'api_handler',
          target: 'auth_user',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'api.ts'),
        },
        ...(!options.reviewHeavy ? [] : [
          {
            source: 'auth_user',
            target: 'review_session',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'auth.ts'),
          },
          {
            source: 'auth_user',
            target: 'audit_logger',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'auth.ts'),
          },
          {
            source: 'merge_queue_gate',
            target: 'api_handler',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'merge-queue-gate.ts'),
          },
          {
            source: 'merge_queue_gate',
            target: 'audit_logger',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'merge-queue-gate.ts'),
          },
          {
            source: 'review_summary_digest',
            target: 'api_handler',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'review-summary-digest.ts'),
          },
          {
            source: 'review_summary_digest',
            target: 'review_session',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'review-summary-digest.ts'),
          },
          {
            source: 'reviewer_roster_sync',
            target: 'review_session',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'reviewer-roster-sync.ts'),
          },
          {
            source: 'reviewer_roster_sync',
            target: 'audit_logger',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'reviewer-roster-sync.ts'),
          },
          {
            source: 'risk_escalation_digest',
            target: 'audit_logger',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'risk-escalation-digest.ts'),
          },
          {
            source: 'risk_escalation_digest',
            target: 'merge_queue_gate',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'risk-escalation-digest.ts'),
          },
          {
            source: 'security_checklist_digest',
            target: 'audit_logger',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'security-checklist-digest.ts'),
          },
          {
            source: 'stale_reviewer_reminder',
            target: 'review_session',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: join(root, 'src', 'stale-reviewer-reminder.ts'),
          },
        ]),
      ],
      hyperedges: [],
      root_path: root,
    },
  )

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'madar@example.com'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Madar Test'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root, stdio: 'pipe' })

  return root
}

describe('stdio pr impact', () => {
  const repoRoots: string[] = []

  afterEach(() => {
    for (const root of repoRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes pr_impact budget and returns the review bundle through MCP', async () => {
    const root = createRepo()
    repoRoots.push(root)
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      readFileSync(join(root, 'src', 'auth.ts'), 'utf8').replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'),
      'utf8',
    )

    const graphPath = join(root, 'out', 'graph.json')
    const tools = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
    const tool = (tools?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools.find(
      (entry) => entry.name === 'pr_impact',
    )

    expect(tool?.inputSchema.properties.budget).toEqual(expect.objectContaining({ type: 'number' }))
    expect(tool?.inputSchema.properties.verbose).toEqual(expect.objectContaining({ type: 'boolean' }))
    // The `compact` flag was de-advertised in #82 to shrink cold-start
    // schema overhead. The runtime still tolerates it for backward compat
    // (the handler validates it on receipt) but it is no longer surfaced
    // in tools/list. The runtime tolerance is exercised below.
    expect(tool?.inputSchema.properties.compact).toBeUndefined()

    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'pr_impact',
        arguments: {
          budget: 240,
        },
      },
    }))
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)

    expect(payload.seed_nodes).toEqual([
      expect.objectContaining({
        label: 'authenticateUser',
        match_kind: 'line',
      }),
    ])
    expect(payload.review_bundle).toEqual(
      expect.objectContaining({
        budget: 240,
      }),
    )
    expect(payload.review_bundle.token_count).toBeLessThanOrEqual(240)
  })

  it('uses graph root_path for pr impact when the graph artifact lives outside the repository', async () => {
    const root = createRepo()
    const artifactRoot = mkdtempSync(join(tmpdir(), 'madar-stdio-external-artifact-'))
    repoRoots.push(root, artifactRoot)
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      readFileSync(join(root, 'src', 'auth.ts'), 'utf8').replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'),
      'utf8',
    )
    mkdirSync(join(artifactRoot, 'out'))
    const graphPath = join(artifactRoot, 'out', 'graph.json')
    copyFileSync(join(root, 'out', 'graph.json'), graphPath)

    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 3,
      method: 'tools/call',
      params: { name: 'pr_impact', arguments: { budget: 240 } },
    }))
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)

    expect(payload.seed_nodes).toEqual([
      expect.objectContaining({ label: 'authenticateUser', match_kind: 'line' }),
    ])
  })

  it('returns the compact pr_impact payload by default and the full payload for verbose or compact=false', async () => {
    const root = createRepo({ reviewHeavy: true })
    repoRoots.push(root)
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      readFileSync(join(root, 'src', 'auth.ts'), 'utf8').replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'),
      'utf8',
    )

    const graphPath = join(root, 'out', 'graph.json')
    const compactResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'pr_impact',
        arguments: {
          budget: 2_000,
        },
      },
    }))
    const verboseResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 4,
      method: 'tools/call',
      params: {
        name: 'pr_impact',
        arguments: {
          budget: 2_000,
          verbose: true,
        },
      },
    }))
    const fullResponse = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 5,
      method: 'tools/call',
      params: {
        name: 'pr_impact',
        arguments: {
          budget: 2_000,
          compact: false,
        },
      },
    }))

    const compactPayload = JSON.parse((compactResponse?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const verbosePayload = JSON.parse((verboseResponse?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const fullPayload = JSON.parse((fullResponse?.result as { content: Array<{ text: string }> }).content[0]!.text)
    const fullReviewBundleTokens = estimateQueryTokens(JSON.stringify(verbosePayload.review_bundle))
    const compactReviewBundleTokens = estimateQueryTokens(JSON.stringify(compactPayload.review_bundle))
    const fullPayloadTokens = estimateQueryTokens(JSON.stringify(fullPayload))
    const compactPayloadTokens = estimateQueryTokens(JSON.stringify(compactPayload))
    const reviewBundleReductionRatio = Number((fullReviewBundleTokens / compactReviewBundleTokens).toFixed(3))
    const payloadReductionRatio = Number((fullPayloadTokens / compactPayloadTokens).toFixed(3))

    expect(compactPayload).not.toHaveProperty('changed_nodes')
    expect(compactPayload).not.toHaveProperty('affected_files')
    expect(compactPayload.review_bundle).toEqual(expect.objectContaining({ budget: 2_000 }))
    expect(verbosePayload.review_bundle.nodes.map((node: { label: string }) => node.label)).toEqual(expect.arrayContaining([
      'ApiHandler',
      'appendAuthAudit',
      'resolveReviewerSession',
      'MergeQueueGate',
      'ReviewSummaryDigest',
    ]))
    expect(compactPayload.review_bundle.nodes.map((node: { label: string }) => node.label)).toEqual(expect.arrayContaining([
      'authenticateUser',
      'ApiHandler',
      'appendAuthAudit',
      'resolveReviewerSession',
    ]))
    expect(compactPayload.review_bundle.nodes.map((node: { label: string }) => node.label)).not.toEqual(
      expect.arrayContaining(['MergeQueueGate', 'ReviewSummaryDigest', 'ReviewerRosterSync', 'RiskEscalationDigest']),
    )
    expect(compactPayload.review_bundle.nodes.length).toBeLessThanOrEqual(verbosePayload.review_bundle.nodes.length)
    expect(compactPayload.review_bundle).toEqual(expect.objectContaining({ shared_file_type: 'code' }))
    expect(compactPayload.review_bundle.nodes.find((node: { label: string; snippet: string | null }) => node.label === 'ApiHandler')).toEqual(
      expect.objectContaining({ snippet: null }),
    )
    expect(compactPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'ApiHandler')).not.toHaveProperty('node_id')
    expect(compactPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'ApiHandler')).not.toHaveProperty('match_score')
    expect(compactPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'ApiHandler')).not.toHaveProperty('community_label')
    expect(compactPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'ApiHandler')).not.toHaveProperty('framework_boost')
    expect(compactPayload.review_bundle.nodes.find((node: { label: string }) => node.label === 'ApiHandler')).not.toHaveProperty('file_type')
    expect(compactPayload.review_bundle.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'ApiHandler',
          to: 'authenticateUser',
          relation: 'calls',
        }),
        expect.objectContaining({
          from: 'authenticateUser',
          to: 'appendAuthAudit',
          relation: 'calls',
        }),
        expect.objectContaining({
          from: 'authenticateUser',
          to: 'resolveReviewerSession',
          relation: 'calls',
        }),
      ]),
    )
    expect(compactPayload.review_bundle.relationships[0]).not.toHaveProperty('from_id')
    expect(compactPayload.review_bundle.relationships[0]).not.toHaveProperty('to_id')
    expect(verbosePayload.review_bundle.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'MergeQueueGate',
          to: 'appendAuthAudit',
          relation: 'calls',
        }),
        expect.objectContaining({
          from: 'ReviewSummaryDigest',
          to: 'resolveReviewerSession',
          relation: 'calls',
        }),
        expect.objectContaining({
          from: 'ReviewerRosterSync',
          to: 'appendAuthAudit',
          relation: 'calls',
        }),
        expect.objectContaining({
          from: 'RiskEscalationDigest',
          to: 'MergeQueueGate',
          relation: 'calls',
        }),
      ]),
    )
    expect(compactPayload.review_bundle.community_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Auth Layer' }),
        expect.objectContaining({ label: 'API Layer' }),
        expect.objectContaining({ label: 'Audit Trail' }),
        expect.objectContaining({ label: 'Review Ops' }),
      ]),
    )
    expect(compactPayload.review_context).toEqual(expect.objectContaining({
      supporting_paths: ['src/api.ts', 'src/audit-log.ts', 'src/review-session.ts'],
      test_paths: expect.arrayContaining(['tests/auth.test.ts', 'tests/api.test.ts']),
      hotspots: expect.arrayContaining([
        expect.objectContaining({
          label: 'authenticateUser',
          type: expect.stringMatching(/bridge|god_node/),
          why: expect.any(String),
        }),
      ]),
    }))
    expect(compactReviewBundleTokens).toBeLessThan(fullReviewBundleTokens)
    expect(compactReviewBundleTokens).toBeLessThan(452)
    expect(reviewBundleReductionRatio).toBeGreaterThan(3)
    expect(compactPayloadTokens).toBeLessThan(fullPayloadTokens)
    expect(payloadReductionRatio).toBeGreaterThan(2.4)
    expect(compactPayload.risk_summary.top_risks[0]).toEqual(
      expect.objectContaining({
        label: 'authenticateUser',
        severity: expect.stringMatching(/high|medium|low/),
        reason: expect.any(String),
      }),
    )

    expect(verbosePayload.changed_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'authenticateUser',
        }),
      ]),
    )
    expect(verbosePayload.affected_files).toEqual(expect.arrayContaining(['src/api.ts']))
    expect(verbosePayload.per_node_impact[0]).toEqual(
      expect.objectContaining({
        node: 'authenticateUser',
        direct_dependents: expect.any(Number),
        transitive_dependents: expect.any(Number),
      }),
    )
    expect(fullPayload).toEqual(verbosePayload)
    expect(fullPayload.changed_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'authenticateUser',
        }),
      ]),
    )
    expect(fullPayload.affected_files).toEqual(expect.arrayContaining(['src/api.ts']))
  })

  it('keeps the first pr_impact review node even when it alone exceeds the requested budget through MCP', async () => {
    const root = createRepo()
    repoRoots.push(root)
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      readFileSync(join(root, 'src', 'auth.ts'), 'utf8').replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'),
      'utf8',
    )

    const graphPath = join(root, 'out', 'graph.json')
    const response = await Promise.resolve(handleStdioRequest(graphPath, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'pr_impact',
        arguments: {
          budget: 1,
        },
      },
    }))
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)

    expect(payload.review_bundle.budget).toBe(1)
    expect(payload.review_bundle.token_count).toBeGreaterThan(1)
    expect(payload.review_bundle.shared_file_type).toBe('code')
    expect(payload.review_bundle.nodes).toHaveLength(1)
    expect(payload.review_bundle.nodes[0]).toEqual(expect.objectContaining({
      label: 'authenticateUser',
      relevance_band: 'direct',
    }))
    expect(payload.review_bundle.nodes[0]).not.toHaveProperty('evidence_class')
    expect(payload.review_bundle.relationships).toEqual([])
  })
})
