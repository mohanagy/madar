import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { analyzePrImpact, compactPrImpactResult, type PrImpactResult } from '../../src/runtime/pr-impact.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-ts-pr-impact-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })

  const authLines = Array.from({ length: 40 }, (_, index) => `// auth filler ${index + 1}`)
  authLines[9] = 'export function authenticateUser(token: string) {'
  authLines[10] = '  const parsed = token.trim()'
  authLines[11] = '  const status = "ok"'
  authLines[12] = '  return parsed.length > 0 ? status : "fail"'
  authLines[13] = '}'
  authLines[29] = 'export function AuthGuard(input: string) {'
  authLines[30] = '  return input === "admin"'
  authLines[31] = '}'

  const apiLines = Array.from({ length: 16 }, (_, index) => `// api filler ${index + 1}`)
  apiLines[4] = 'export function ApiHandler(token: string) {'
  apiLines[5] = '  return authenticateUser(token)'
  apiLines[6] = '}'

  writeFileSync(join(root, 'src', 'auth.ts'), `${authLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'src', 'api.ts'), `${apiLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')
  writeFileSync(join(root, 'tests', 'api.test.ts'), 'describe("api", () => {})\n', 'utf8')

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'graphify@example.com'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Graphify Test'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root, stdio: 'pipe' })

  return root
}

function createNestedRepoWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-ts-pr-impact-workspace-'))
  const backendRoot = join(root, 'backend')
  mkdirSync(join(backendRoot, 'src'), { recursive: true })
  mkdirSync(join(backendRoot, 'tests'), { recursive: true })

  const authLines = Array.from({ length: 16 }, (_, index) => `// auth filler ${index + 1}`)
  authLines[4] = 'export function authenticateUser(token: string) {'
  authLines[5] = '  const parsed = token.trim()'
  authLines[6] = '  const status = "ok"'
  authLines[7] = '  return parsed.length > 0 ? status : "fail"'
  authLines[8] = '}'

  const apiLines = Array.from({ length: 10 }, (_, index) => `// api filler ${index + 1}`)
  apiLines[2] = 'export function ApiHandler(token: string) {'
  apiLines[3] = '  return authenticateUser(token)'
  apiLines[4] = '}'

  writeFileSync(join(backendRoot, 'src', 'auth.ts'), `${authLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(backendRoot, 'src', 'api.ts'), `${apiLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(backendRoot, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')

  execFileSync('git', ['init', '-b', 'main'], { cwd: backendRoot, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'graphify@example.com'], { cwd: backendRoot, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Graphify Test'], { cwd: backendRoot, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: backendRoot, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: backendRoot, stdio: 'pipe' })

  return root
}

function updateFile(root: string, relativePath: string, mutate: (content: string) => string): void {
  const filePath = join(root, relativePath)
  writeFileSync(filePath, mutate(readFileSync(filePath, 'utf8')), 'utf8')
}

function buildGraph(root: string): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = root
  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'API Layer',
  }

  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: join(root, 'src', 'auth.ts'),
    source_location: 'L10-L14',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('auth_guard', {
    label: 'AuthGuard',
    source_file: join(root, 'src', 'auth.ts'),
    source_location: 'L30-L32',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('api_handler', {
    label: 'ApiHandler',
    source_file: join(root, 'src', 'api.ts'),
    source_location: 'L5-L7',
    node_kind: 'function',
    file_type: 'code',
    community: 1,
  })

  graph.addEdge('api_handler', 'auth_user', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'api.ts'),
  })

  return graph
}

function buildNestedRepoGraph(root: string): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = root
  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'API Layer',
  }

  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: join(root, 'backend', 'src', 'auth.ts'),
    source_location: 'L5-L9',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('api_handler', {
    label: 'ApiHandler',
    source_file: join(root, 'backend', 'src', 'api.ts'),
    source_location: 'L3-L5',
    node_kind: 'function',
    file_type: 'code',
    community: 1,
  })

  graph.addEdge('api_handler', 'auth_user', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'backend', 'src', 'api.ts'),
  })

  return graph
}

function buildFallbackGraph(root: string): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = root

  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: join(root, 'src', 'auth.ts'),
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  return graph
}

function createDeletionOnlyRepo(): string {
  const root = createRepo()
  writeFileSync(
    join(root, 'src', 'deletion.ts'),
    [
      'export function target() {',
      '  return true',
      '}',
      'export function keep() {',
      '  return false',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Add deletion fixture'], { cwd: root, stdio: 'pipe' })
  writeFileSync(
    join(root, 'src', 'deletion.ts'),
    [
      'export function keep() {',
      '  return false',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  return root
}

function buildDeletionOnlyGraph(root: string): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = root
  graph.graph.community_labels = {
    0: 'Deletion Layer',
  }

  graph.addNode('keep_node', {
    label: 'keep',
    source_file: join(root, 'src', 'deletion.ts'),
    source_location: 'L1-L3',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })

  return graph
}

function buildSecondHopCapGraph(root: string): KnowledgeGraph {
  const graph = buildGraph(root)
  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'API Layer',
    2: 'Review Ops',
    3: 'Audit Trail',
    4: 'Release Safety',
  }

  const reviewFixtureFiles = [
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
  ] as const

  for (const fixtureFile of reviewFixtureFiles) {
    const filePath = join(root, fixtureFile.relativePath)
    writeFileSync(
      filePath,
      fixtureFile.lines.join('\n'),
      'utf8',
    )
    graph.addNode(fixtureFile.id, {
      label: fixtureFile.label,
      source_file: filePath,
      source_location: fixtureFile.sourceLocation,
      node_kind: 'function',
      file_type: 'code',
      community: fixtureFile.community,
    })
  }

  graph.addEdge('auth_user', 'review_session', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'auth.ts'),
  })
  graph.addEdge('auth_user', 'audit_logger', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'auth.ts'),
  })
  graph.addEdge('merge_queue_gate', 'api_handler', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'merge-queue-gate.ts'),
  })
  graph.addEdge('merge_queue_gate', 'audit_logger', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'merge-queue-gate.ts'),
  })
  graph.addEdge('review_summary_digest', 'api_handler', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'review-summary-digest.ts'),
  })
  graph.addEdge('review_summary_digest', 'review_session', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'review-summary-digest.ts'),
  })
  graph.addEdge('reviewer_roster_sync', 'review_session', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'reviewer-roster-sync.ts'),
  })
  graph.addEdge('reviewer_roster_sync', 'audit_logger', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'reviewer-roster-sync.ts'),
  })
  graph.addEdge('risk_escalation_digest', 'audit_logger', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'risk-escalation-digest.ts'),
  })
  graph.addEdge('risk_escalation_digest', 'merge_queue_gate', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'risk-escalation-digest.ts'),
  })
  graph.addEdge('security_checklist_digest', 'audit_logger', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'security-checklist-digest.ts'),
  })
  graph.addEdge('stale_reviewer_reminder', 'review_session', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: join(root, 'src', 'stale-reviewer-reminder.ts'),
  })

  return graph
}

describe('pr impact', () => {
  const repoRoots: string[] = []

  afterEach(() => {
    for (const root of repoRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('narrows review seeds to changed line overlaps and returns a budgeted review bundle', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildGraph(root), root, { budget: 240 })

    expect(result.changed_files).toEqual(['src/auth.ts'])
    expect(result.changed_ranges).toEqual([
      {
        source_file: 'src/auth.ts',
        line_ranges: [{ start: 12, end: 12 }],
      },
    ])
    expect(result.changed_nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['authenticateUser', 'AuthGuard']))
    expect(result.seed_nodes).toEqual([
      expect.objectContaining({
        label: 'authenticateUser',
        match_kind: 'line',
      }),
    ])
    expect(result.review_bundle.token_count).toBeLessThanOrEqual(240)
    expect(result.review_bundle.nodes[0]).toEqual(expect.objectContaining({ label: 'authenticateUser' }))
    expect(result.review_bundle.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['ApiHandler', 'authenticateUser']))
    expect(result.review_bundle.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'ApiHandler',
          to: 'authenticateUser',
          relation: 'calls',
        }),
      ]),
    )
  }, 15_000)

  it('collects changed files from nested git repos under the graph root', () => {
    const root = createNestedRepoWorkspace()
    repoRoots.push(root)
    updateFile(root, 'backend/src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildNestedRepoGraph(root), root, { budget: 240 })

    expect(result.changed_files).toEqual(['backend/src/auth.ts'])
    expect(result.seed_nodes).toEqual([
      expect.objectContaining({
        label: 'authenticateUser',
        match_kind: 'line',
      }),
    ])
  })

  it('keeps the first review node when it alone exceeds the review budget', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildGraph(root), root, { budget: 1 })

    expect(result.review_bundle.budget).toBe(1)
    expect(result.review_bundle.token_count).toBeGreaterThan(1)
    expect(result.review_bundle.nodes).toHaveLength(1)
    expect(result.review_bundle.nodes[0]).toEqual(expect.objectContaining({
      label: 'authenticateUser',
      evidence_class: 'change',
      relevance_band: 'direct',
    }))
    expect(result.review_bundle.relationships).toEqual([])
    expect(result.review_bundle.task_contract).toEqual(expect.objectContaining({
      task_kind: 'review',
      required_evidence: ['change', 'supporting', 'impact'],
    }))
    expect(result.review_bundle.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidence_class: 'change',
        node_labels: ['authenticateUser'],
      }),
    ]))
    expect(result.review_bundle.expandable).toEqual([
      expect.objectContaining({ kind: 'nodes', evidence_class: 'supporting' }),
    ])
    expect(result.review_bundle.coverage).toEqual(expect.objectContaining({
      missing_required: ['supporting', 'impact'],
    }))
  })

  it('falls back to file-level seeds when nodes do not have line metadata', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = "revoked"'))

    const result = analyzePrImpact(buildFallbackGraph(root), root)

    expect(result.seed_nodes).toEqual([
      expect.objectContaining({
        label: 'authenticateUser',
        match_kind: 'file',
      }),
    ])
  })

  it('falls back to file-level seeds for pure deletions without changed lines in the new file', () => {
    const root = createDeletionOnlyRepo()
    repoRoots.push(root)

    const result = analyzePrImpact(buildDeletionOnlyGraph(root), root)

    expect(result.changed_ranges).toEqual([
      {
        source_file: 'src/deletion.ts',
        line_ranges: [],
      },
    ])
    expect(result.seed_nodes).toEqual([
      expect.objectContaining({
        label: 'keep',
        match_kind: 'file',
      }),
    ])
  })

  it('hard caps the second-hop review candidate pool across distinct review roles', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildSecondHopCapGraph(root), root, { budget: 2_000 })

    expect(result.review_bundle.nodes.slice(0, 2).map((node) => node.label)).toEqual(['authenticateUser', 'ApiHandler'])
    expect(result.review_bundle.nodes.filter((node) => node.relevance_band === 'peripheral').map((node) => node.label)).toEqual([
      'MergeQueueGate',
      'ReviewSummaryDigest',
      'ReviewerRosterSync',
      'RiskEscalationDigest',
    ])
    expect(result.review_bundle.nodes.map((node) => node.label)).not.toEqual(
      expect.arrayContaining(['SecurityChecklistDigest', 'StaleReviewerReminder']),
    )
  })

  it('attaches review context-pack metadata and highlights omitted impact evidence', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildSecondHopCapGraph(root), root, { budget: 240 })

    expect(result.review_bundle.task_contract).toEqual(expect.objectContaining({
      task_kind: 'review',
      required_evidence: ['change', 'supporting', 'impact'],
    }))
    expect(result.review_bundle.nodes[0]).toEqual(expect.objectContaining({
      label: 'authenticateUser',
      evidence_class: 'change',
    }))
    expect(result.review_bundle.nodes[1]).toEqual(expect.objectContaining({
      label: 'ApiHandler',
      evidence_class: 'supporting',
    }))
    expect(result.review_bundle.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidence_class: 'change',
        node_labels: ['authenticateUser'],
      }),
    ]))
    expect(result.review_bundle.coverage).toEqual(expect.objectContaining({
      missing_required: ['impact'],
    }))
    expect(result.review_bundle.expandable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'nodes',
        evidence_class: 'impact',
      }),
    ]))
  })

  it('returns the compact pr_impact contract while omitting full-only fields', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const full = analyzePrImpact(buildGraph(root), root, { budget: 300 })
    const compact = compactPrImpactResult(full)
    const compactSupportNode = compact.review_bundle.nodes.find((node) => node.label === 'ApiHandler') as Record<string, unknown> | undefined
    const compactNodePayload = typeof compact.review_bundle.shared_file_type === 'string'
      ? {
          shared_file_type: compact.review_bundle.shared_file_type,
          nodes: compact.review_bundle.nodes,
        }
      : compact.review_bundle.nodes

    expect(compact).toEqual(expect.objectContaining({
      base_branch: full.base_branch,
      changed_files: full.changed_files,
      changed_ranges: full.changed_ranges,
      seed_nodes: full.seed_nodes,
      total_blast_radius: full.total_blast_radius,
      affected_communities: full.affected_communities,
      risk_summary: full.risk_summary,
    }))
    expect(compact.review_bundle).toEqual(expect.objectContaining({
      budget: full.review_bundle.budget,
    }))
    expect(compact.review_bundle.nodes[0]).toEqual(expect.objectContaining({
      label: 'authenticateUser',
      snippet: full.review_bundle.nodes[0]?.snippet ?? null,
    }))
    expect(compact.review_bundle).toHaveProperty('shared_file_type', 'code')
    expect(compactSupportNode).toEqual(expect.objectContaining({ snippet: null }))
    expect(compactSupportNode).not.toHaveProperty('node_id')
    expect(compactSupportNode).not.toHaveProperty('match_score')
    expect(compactSupportNode).not.toHaveProperty('community_label')
    expect(compactSupportNode).not.toHaveProperty('framework_boost')
    expect(compactSupportNode).not.toHaveProperty('file_type')
    expect(compact.review_bundle.relationships[0]).not.toHaveProperty('from_id')
    expect(compact.review_bundle.relationships[0]).not.toHaveProperty('to_id')
    expect(compact.review_bundle.token_count).toBe(estimateQueryTokens(JSON.stringify(compactNodePayload)))
    expect(estimateQueryTokens(JSON.stringify(compactNodePayload))).toBeLessThan(
      estimateQueryTokens(JSON.stringify(full.review_bundle.nodes)),
    )
    expect(compact.per_node_impact).toEqual(
      full.per_node_impact.slice(0, 5).map((impact) => ({
        node: impact.node,
        total_dependents: impact.direct_dependents + impact.transitive_dependents,
        affected_communities: impact.affected_communities,
      })),
    )
    expect(compact).not.toHaveProperty('changed_nodes')
    expect(compact).not.toHaveProperty('affected_files')
    expect(compact.per_node_impact[0]).not.toHaveProperty('direct_dependents')
    expect(compact.per_node_impact[0]).not.toHaveProperty('transitive_dependents')
    expect(estimateQueryTokens(JSON.stringify(compact))).toBeLessThan(
      estimateQueryTokens(JSON.stringify(full)),
    )
  })

  it('materially reduces the default review payload on a review-heavy fixture', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const full = analyzePrImpact(buildSecondHopCapGraph(root), root, { budget: 2_000 })
    const compact = compactPrImpactResult(full)
    const fullReviewBundleTokens = estimateQueryTokens(JSON.stringify(full.review_bundle))
    const compactReviewBundleTokens = estimateQueryTokens(JSON.stringify(compact.review_bundle))
    const fullPayloadTokens = estimateQueryTokens(JSON.stringify(full))
    const compactPayloadTokens = estimateQueryTokens(JSON.stringify(compact))
    const reviewBundleReductionRatio = Number((fullReviewBundleTokens / compactReviewBundleTokens).toFixed(3))
    const payloadReductionRatio = Number((fullPayloadTokens / compactPayloadTokens).toFixed(3))

    expect(full.review_bundle.nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'ApiHandler',
      'appendAuthAudit',
      'resolveReviewerSession',
      'MergeQueueGate',
      'ReviewSummaryDigest',
      'ReviewerRosterSync',
      'RiskEscalationDigest',
    ]))
    expect(compact.review_bundle.nodes[0]).toEqual(expect.objectContaining({ label: 'authenticateUser' }))
    expect(compact.review_bundle.nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'ApiHandler',
      'appendAuthAudit',
      'resolveReviewerSession',
    ]))
    expect(compact.review_bundle.nodes.map((node) => node.label)).not.toEqual(
      expect.arrayContaining(['MergeQueueGate', 'ReviewSummaryDigest', 'ReviewerRosterSync', 'RiskEscalationDigest']),
    )
    expect(compact.review_bundle).toHaveProperty('shared_file_type', 'code')
    expect(compact.review_bundle.nodes.find((node) => node.label === 'ApiHandler')).toEqual(expect.not.objectContaining({
      node_id: expect.any(String),
      match_score: expect.any(Number),
      community_label: expect.anything(),
      framework_boost: expect.any(Number),
      file_type: expect.any(String),
    }))
    expect(compact.review_bundle.nodes.find((node) => node.label === 'ApiHandler')).toEqual(expect.objectContaining({ snippet: null }))
    expect(compact.review_bundle.relationships).toEqual(
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
    expect(full.review_bundle.relationships).toEqual(
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
    expect(compact.review_bundle.relationships[0]).not.toHaveProperty('from_id')
    expect(compact.review_bundle.relationships[0]).not.toHaveProperty('to_id')
    expect(compact.review_bundle.community_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Auth Layer' }),
        expect.objectContaining({ label: 'API Layer' }),
        expect.objectContaining({ label: 'Audit Trail' }),
        expect.objectContaining({ label: 'Review Ops' }),
      ]),
    )
    expect(compact.review_context).toEqual(expect.objectContaining({
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
    expect(compact.review_bundle.token_count).toBeLessThan(full.review_bundle.token_count)
    expect(compactReviewBundleTokens).toBeLessThan(452)
    expect(reviewBundleReductionRatio).toBeGreaterThan(3)
    expect(compactPayloadTokens).toBeLessThan(780)
    expect(payloadReductionRatio).toBeGreaterThan(2.4)
  })

  it('ranks the top review risks with severity and concise reasons', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildGraph(root), root, { budget: 300 })

    expect(result.risk_summary.top_risks[0]).toEqual(
      expect.objectContaining({
        label: 'authenticateUser',
        severity: expect.stringMatching(/high|medium|low/),
        reason: expect.any(String),
      }),
    )
  })

  it('adds typed review context for supporting paths, likely tests, and hotspots', () => {
    const root = createRepo()
    repoRoots.push(root)
    updateFile(root, 'src/auth.ts', (content) => content.replace('  const status = "ok"', '  const status = token.startsWith("Bearer ") ? "ok" : "fail"'))

    const result = analyzePrImpact(buildSecondHopCapGraph(root), root, { budget: 2_000 })

    expect(result.review_context).toEqual(expect.objectContaining({
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
    expect(new Set(result.review_context.hotspots.map((hotspot) => hotspot.label)).size).toBe(result.review_context.hotspots.length)
  })

  it('preserves full per-node impact ordering in the compact view when totals tie', () => {
    const full: PrImpactResult = {
      base_branch: 'main',
      changed_files: ['src/auth.ts'],
      changed_ranges: [],
      changed_nodes: [],
      seed_nodes: [],
      per_node_impact: [
        {
          node: 'ZuluNode',
          direct_dependents: 2,
          transitive_dependents: 0,
          affected_communities: 1,
        },
        {
          node: 'AlphaNode',
          direct_dependents: 1,
          transitive_dependents: 1,
          affected_communities: 9,
        },
        {
          node: 'LaterNode',
          direct_dependents: 1,
          transitive_dependents: 0,
          affected_communities: 1,
        },
      ],
      total_blast_radius: 3,
      affected_files: [],
      affected_communities: [],
      review_context: {
        supporting_paths: [],
        test_paths: [],
        hotspots: [],
      },
      review_bundle: {
        budget: 100,
        token_count: 0,
        nodes: [],
        relationships: [],
        community_context: [],
      },
      risk_summary: {
        high_impact_nodes: [],
        cross_community_changes: 0,
        top_risks: [],
      },
    }

    expect(compactPrImpactResult(full).per_node_impact.map((impact) => impact.node)).toEqual([
      'ZuluNode',
      'AlphaNode',
      'LaterNode',
    ])
  })

  it('keeps empty-string file types on compact review nodes when file types are mixed', () => {
    const full: PrImpactResult = {
      base_branch: 'main',
      changed_files: ['src/auth.ts'],
      changed_ranges: [{ source_file: 'src/auth.ts', line_ranges: [{ start: 12, end: 12 }] }],
      changed_nodes: [],
      seed_nodes: [],
      per_node_impact: [],
      total_blast_radius: 0,
      affected_files: [],
      affected_communities: [],
      review_context: {
        supporting_paths: [],
        test_paths: [],
        hotspots: [],
      },
      review_bundle: {
        budget: 200,
        token_count: 10,
        nodes: [
          {
            label: 'authenticateUser',
            source_file: 'src/auth.ts',
            line_number: 12,
            file_type: '',
            snippet: 'const status = "ok"',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth Layer',
          },
          {
            label: 'ApiHandler',
            source_file: 'src/api.ts',
            line_number: 5,
            file_type: 'code',
            snippet: null,
            match_score: 4,
            relevance_band: 'related',
            community: 1,
            community_label: 'API Layer',
          },
        ],
        relationships: [],
        community_context: [],
      },
      risk_summary: {
        high_impact_nodes: [],
        cross_community_changes: 0,
        top_risks: [],
      },
    }

    const compact = compactPrImpactResult(full)

    expect(compact.review_bundle).not.toHaveProperty('shared_file_type')
    expect(compact.review_bundle.nodes[0]).toHaveProperty('file_type', '')
  })

  it('hoists empty-string file types when every compact review node shares them', () => {
    const full: PrImpactResult = {
      base_branch: 'main',
      changed_files: ['src/auth.ts'],
      changed_ranges: [{ source_file: 'src/auth.ts', line_ranges: [{ start: 12, end: 12 }] }],
      changed_nodes: [],
      seed_nodes: [],
      per_node_impact: [],
      total_blast_radius: 0,
      affected_files: [],
      affected_communities: [],
      review_context: {
        supporting_paths: [],
        test_paths: [],
        hotspots: [],
      },
      review_bundle: {
        budget: 200,
        token_count: 10,
        nodes: [
          {
            label: 'authenticateUser',
            source_file: 'src/auth.ts',
            line_number: 12,
            file_type: '',
            snippet: 'const status = "ok"',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth Layer',
          },
          {
            label: 'resolveReviewerSession',
            source_file: 'src/review-session.ts',
            line_number: 1,
            file_type: '',
            snippet: null,
            match_score: 4,
            relevance_band: 'related',
            community: 2,
            community_label: 'Review Ops',
          },
        ],
        relationships: [],
        community_context: [],
      },
      risk_summary: {
        high_impact_nodes: [],
        cross_community_changes: 0,
        top_risks: [],
      },
    }

    const compact = compactPrImpactResult(full)

    expect(compact.review_bundle).toHaveProperty('shared_file_type', '')
    expect(compact.review_bundle.nodes[0]).not.toHaveProperty('file_type')
    expect(compact.review_bundle.nodes[1]).not.toHaveProperty('file_type')
  })

  it('trims oversized outer payload arrays in compact review mode', () => {
    const full: PrImpactResult = {
      base_branch: 'main',
      changed_files: Array.from({ length: 30 }, (_, index) => `src/file-${index + 1}.ts`),
      changed_ranges: Array.from({ length: 30 }, (_, index) => ({
        source_file: `src/file-${index + 1}.ts`,
        line_ranges: [{ start: index + 1, end: index + 1 }],
      })),
      changed_nodes: [],
      seed_nodes: Array.from({ length: 30 }, (_, index) => ({
        node_id: `seed-${index + 1}`,
        label: `Seed${index + 1}`,
        source_file: `src/file-${index + 1}.ts`,
        node_kind: 'function',
        community: index,
        community_label: `Community ${index + 1}`,
        line_number: index + 1,
        source_location: `L${index + 1}-L${index + 1}`,
        match_kind: 'line',
      })),
      per_node_impact: [],
      total_blast_radius: 30,
      affected_files: [],
      affected_communities: Array.from({ length: 24 }, (_, index) => ({
        id: index,
        label: `Community ${index + 1}`,
        node_count: 100 - index,
      })),
      review_context: {
        supporting_paths: [],
        test_paths: [],
        hotspots: [],
      },
      review_bundle: {
        budget: 500,
        token_count: 25,
        nodes: [
          {
            node_id: 'seed-1',
            label: 'Seed1',
            source_file: 'src/file-1.ts',
            line_number: 1,
            file_type: 'code',
            snippet: 'return true',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Community 1',
          },
        ],
        relationships: [],
        community_context: [],
      },
      risk_summary: {
        high_impact_nodes: Array.from({ length: 24 }, (_, index) => `Risk${index + 1}`),
        cross_community_changes: 12,
        top_risks: [
          {
            label: 'Seed1',
            severity: 'high',
            reason: 'Wide review surface',
          },
        ],
      },
    }

    const compact = compactPrImpactResult(full)

    expect(compact.changed_files).toHaveLength(20)
    expect(compact.changed_ranges).toHaveLength(20)
    expect(compact.seed_nodes).toHaveLength(12)
    expect(compact.affected_communities).toHaveLength(12)
    expect(compact.risk_summary.high_impact_nodes).toHaveLength(12)
    expect(compact.changed_files[0]).toBe('src/file-1.ts')
    expect(compact.changed_ranges.map((entry) => entry.source_file)).toEqual(compact.changed_files)
    expect(estimateQueryTokens(JSON.stringify(compact))).toBeLessThan(estimateQueryTokens(JSON.stringify(full)))
  })
})
