import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { readQueryEvidenceSnippet, retrieveContext } from '../../src/runtime/retrieve.js'
import { assessMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { buildRetrievalEvidencePlanFromResult } from '../../src/runtime/retrieve/pipeline.js'
import { evaluateQueryEvidenceCoverage } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import {
  buildCrossLayerMonitorFlowFixture,
  CROSS_LAYER_MONITOR_FLOW_FILES,
} from '../fixtures/cross-layer-monitor-flow.js'

const QUESTION = 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status in this repository. Cite the exact files and symbols involved, identify any inconsistent status-computation paths, and clearly state any remaining uncertainty.'
const NATURAL_QUESTION = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Cite the relevant files and symbols, compare every distinct overall-status computation you find, and state what the available evidence cannot prove. Read-only: do not modify files.'
const AGENT_SHORTENED_QUESTION = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every distinct overall-status computation.'

function writeCrossLayerGraphFixture(root: string): string {
  const graph = buildCrossLayerMonitorFlowFixture()
  const graphPath = join(root, 'graph.json')
  writeFileSync(graphPath, JSON.stringify({
    ...graph.graph,
    directed: graph.isDirected(),
    nodes: graph.nodeEntries().map(([id, attributes]) => ({ id, ...attributes })),
    edges: graph.edgeEntries().map(([source, target, attributes]) => ({ source, target, ...attributes })),
    hyperedges: [],
  }), 'utf8')
  return graphPath
}

describe('cross-layer flow retrieval', () => {
  it('covers every flow obligation without letting presentation vocabulary dominate', () => {
    const started = performance.now()
    const result = retrieveContext(buildCrossLayerMonitorFlowFixture(), {
      question: QUESTION,
      budget: 1_800,
      retrievalStrategy: 'slice-v1',
    })
    const elapsedMs = performance.now() - started
    const selectedFiles = new Set(result.matched_nodes.map((node) => node.source_file))
    const relevantSelected = [...selectedFiles].filter((file) => (
      CROSS_LAYER_MONITOR_FLOW_FILES.includes(file as typeof CROSS_LAYER_MONITOR_FLOW_FILES[number])
    ))
    const precision = relevantSelected.length / Math.max(selectedFiles.size, 1)
    const evidence = assessMadarResponseEvidence({
      evidencePlan: buildRetrievalEvidencePlanFromResult(result),
      question: QUESTION,
      recovery: result.recovery,
    })
    const snippetCoverage = evaluateQueryEvidenceCoverage(QUESTION, result.matched_nodes)

    expect(
      CROSS_LAYER_MONITOR_FLOW_FILES.every((file) => selectedFiles.has(file)),
      JSON.stringify({
        selected: [...selectedFiles],
        labels: result.matched_nodes.map((node) => node.label),
        relationships: result.relationships,
        retrievalPlan: result.retrieval_plan,
        recovery: result.recovery,
      }, null, 2),
    ).toBe(true)
    expect(precision).toBeGreaterThanOrEqual(0.7)
    expect(result.matched_nodes.map((node) => node.label)).not.toContain('computeEffectiveStatus')
    expect(result.relationships.length).toBeGreaterThanOrEqual(5)
    expect(result.retrieval_plan).toMatchObject({
      status: 'recovered',
      reasons: expect.arrayContaining(['missing_query_obligations']),
      query_obligations: {
        total: 5,
        finally_covered: 5,
      },
      attempts: [expect.objectContaining({
        status: 'applied',
        promoted_communities: expect.arrayContaining([1, 2, 3, 4, 5, 6]),
      })],
    })
    expect(result.retrieval_plan?.query_obligations?.initially_covered).toBeLessThan(
      result.retrieval_plan?.query_obligations?.finally_covered ?? 0,
    )
    expect(result.retrieval_plan?.query_obligations).toMatchObject({
      total: snippetCoverage.total,
      finally_covered: snippetCoverage.covered,
    })
    expect(evidence.answerability.state).toMatch(/^ready(?:_with_caveat)?$/)
    expect(evidence.answerability.broad_search_fallback).toBe('not_needed')
    expect(evidence.agent_directive).toBe('answer_from_pack')
    expect(result.token_count).toBeLessThanOrEqual(1_800)
    expect(elapsedMs).toBeLessThan(750)
  })

  it('returns an answer-ready workflow through one context_pack MCP call', async () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-cross-layer-mcp-'))
    const previousToolProfile = process.env.MADAR_TOOL_PROFILE
    try {
      process.env.MADAR_TOOL_PROFILE = 'strict'
      const response = await Promise.resolve(handleStdioRequest(writeCrossLayerGraphFixture(root), {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: QUESTION,
            task: 'explain',
          },
        },
      }))
      expect((response as { error?: unknown }).error, JSON.stringify(response, null, 2)).toBeUndefined()

      const payload = JSON.parse(
        (response?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as {
        pack?: {
          matched_nodes?: Array<{ label: string; source_file: string }>
          relationships?: unknown[]
        }
        claims?: Array<{ text: string; node_labels: string[] }>
        evidence?: {
          answerability?: { state?: string; broad_search_fallback?: string }
          agent_directive?: string
        }
      }
      const selectedFiles = new Set(payload.pack?.matched_nodes?.map((node) => node.source_file) ?? [])
      const relevantSelected = [...selectedFiles].filter((file) => (
        CROSS_LAYER_MONITOR_FLOW_FILES.includes(file as typeof CROSS_LAYER_MONITOR_FLOW_FILES[number])
      ))
      const uiSelected = [...selectedFiles].filter((file) => file.includes('/components/status/'))

      expect(
        CROSS_LAYER_MONITOR_FLOW_FILES.every((file) => selectedFiles.has(file)),
        JSON.stringify(payload, null, 2),
      ).toBe(true)
      expect(relevantSelected.length / Math.max(selectedFiles.size, 1)).toBeGreaterThanOrEqual(0.7)
      expect(uiSelected.length).toBeLessThanOrEqual(2)
      expect(payload.pack?.matched_nodes?.map((node) => node.source_file)).not.toContain(
        'packages/api/src/router/external-service/effective-status.ts',
      )
      expect(payload.pack?.matched_nodes?.map((node) => node.label)).toContain('computeOverallStatus')
      // #660-B. Was an assertion on one fixed claim string keyed on this
      // repository's wording. What is worth holding is that every claim cites
      // a node the pack actually carries -- source attribution, not prose.
      const packLabels = new Set(payload.pack?.matched_nodes?.map((node) => node.label) ?? [])
      expect((payload.claims?.length ?? 0)).toBeGreaterThan(0)
      for (const claim of payload.claims ?? []) {
        expect(claim.node_labels.length).toBeGreaterThan(0)
        for (const label of claim.node_labels) {
          expect(packLabels, `claim cites a node absent from the pack: ${claim.text}`).toContain(label)
        }
      }
      expect(
        payload.pack?.relationships?.length ?? 0,
        JSON.stringify(payload, null, 2),
      ).toBeGreaterThanOrEqual(5)
      expect(payload.evidence, JSON.stringify(payload, null, 2)).toMatchObject({
        answerability: {
          state: expect.stringMatching(/^ready(?:_with_caveat)?$/),
          broad_search_fallback: 'not_needed',
        },
        agent_directive: 'answer_from_pack',
      })
    } finally {
      if (previousToolProfile === undefined) {
        delete process.env.MADAR_TOOL_PROFILE
      } else {
        process.env.MADAR_TOOL_PROFILE = previousToolProfile
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps natural and agent-shortened incident-delivery prompts answer-ready', async () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-cross-layer-natural-'))
    const previousToolProfile = process.env.MADAR_TOOL_PROFILE
    try {
      process.env.MADAR_TOOL_PROFILE = 'strict'
      const graphPath = writeCrossLayerGraphFixture(root)
      for (const [index, prompt] of [NATURAL_QUESTION, AGENT_SHORTENED_QUESTION].entries()) {
        const response = await Promise.resolve(handleStdioRequest(graphPath, {
          id: index + 2,
          method: 'tools/call',
          params: {
            name: 'context_pack',
            arguments: {
              prompt,
              task: 'explain',
            },
          },
        }))
        expect((response as { error?: unknown }).error, JSON.stringify(response, null, 2)).toBeUndefined()

        const payload = JSON.parse(
          (response?.result as { content: Array<{ text: string }> }).content[0]!.text,
        ) as {
          pack?: { matched_nodes?: Array<{ source_file: string; snippet?: string }> }
          evidence?: {
            answerability?: { state?: string; broad_search_fallback?: string }
            agent_directive?: string
          }
        }
        const selectedFiles = new Set(payload.pack?.matched_nodes?.map((node) => node.source_file) ?? [])
        const snippets = payload.pack?.matched_nodes?.map((node) => node.snippet ?? '').join('\n') ?? ''

        expect(
          CROSS_LAYER_MONITOR_FLOW_FILES.every((file) => selectedFiles.has(file)),
          JSON.stringify(payload, null, 2),
        ).toBe(true)
        expect(snippets).toMatch(/insert\(incidentTable\)/)
        expect(snippets).toMatch(/sendAlert\(notification\)/)
        expect(payload.evidence, JSON.stringify(payload, null, 2)).toMatchObject({
          answerability: {
            state: expect.stringMatching(/^ready(?:_with_caveat)?$/),
            broad_search_fallback: 'not_needed',
          },
          agent_directive: 'answer_from_pack',
        })
      }
    } finally {
      if (previousToolProfile === undefined) {
        delete process.env.MADAR_TOOL_PROFILE
      } else {
        process.env.MADAR_TOOL_PROFILE = previousToolProfile
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects decisive file evidence when an anonymous workflow is hidden behind a small helper anchor', () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-query-snippet-'))
    const sourceFile = join(root, 'checker.ts')
    try {
      writeFileSync(sourceFile, [
        "import { incidentTable } from './schema'",
        "import { triggerNotifications } from './notifications'",
        '',
        'export function findOpenIncident() {',
        '  return database.query.incidentTable.findFirst()',
        '}',
        '',
        "app.post('/updateStatus', async (context) => {",
        '  if (context.status === "error") {',
        '    await database.insert(incidentTable).values({ monitorId: context.monitorId })',
        '    await triggerNotifications({ notifType: "alert" })',
        '  }',
        '})',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 4, {
        question: QUESTION,
        label: 'findOpenIncident',
        sourceLocation: 'L4-L6',
      })

      expect(evidence).toMatchObject({ scope: 'source_file' })
      expect(evidence?.snippet).toContain('incidentTable')
      expect(evidence?.snippet).toContain('triggerNotifications')
      expect(evidence?.snippet).not.toContain('import')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // #660-B. Two tests were removed here. Their only subjects were
  // `incidentStatusOwnerFragment` and `QUERY_EVIDENCE_INPUT_PROVENANCE_PATTERN`,
  // which recognised one qualification repository's exact source lines. Both
  // are gone from production, so a test asserting they fire would assert a
  // behaviour that no longer exists rather than a property worth holding.

  it('keeps the public route fetch beside the status JSON serializer dispatch', () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-public-status-route-'))
    const sourceFile = join(root, 'route.ts')
    try {
      writeFileSync(sourceFile, [
        'export async function GET(request: NextRequest) {',
        '  const queryClient = getQueryClient()',
        '  const data = await queryClient.fetchQuery(',
        '    trpc.statusPage.get.queryOptions({ slug: row.slug }),',
        '  )',
        '  const payload = endpoint === "status"',
        '    ? toStatus(data, baseUrl)',
        '    : toSummary(data, baseUrl)',
        '  return Response.json(payload)',
        '}',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 1, {
        question: QUESTION,
        label: 'GET()',
        sourceLocation: 'L1-L10',
      })

      expect(evidence?.snippet).toContain('trpc.statusPage.get.queryOptions')
      expect(evidence?.snippet).toContain('toStatus(data, baseUrl)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the failed-check discriminant inside a structured cross-runtime handoff', () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-query-handoff-'))
    const sourceFile = join(root, 'checker.go')
    try {
      writeFileSync(sourceFile, [
        'package handlers',
        '',
        'func HTTPCheckerHandler(req Request, res Response) {',
        '  if res.Degraded {',
        '    checker.UpdateStatus(ctx, checker.UpdateData{',
        '      MonitorId: req.MonitorID,',
        '      Status: "degraded",',
        '    })',
        '  }',
        '  if !res.Successful {',
        '    checker.UpdateStatus(ctx, checker.UpdateData{',
        '      MonitorId: req.MonitorID,',
        '      Status: "error",',
        '      StatusCode: res.Status,',
        '    })',
        '  }',
        '}',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 3, {
        question: QUESTION,
        label: '.HTTPCheckerHandler()',
        sourceLocation: 'L3',
      })

      expect(evidence).toMatchObject({ scope: 'source_file' })
      expect(evidence?.snippet).toContain('UpdateStatus')
      expect(evidence?.snippet).toContain('Status: "error"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // #660-B. The subject is the generic provider-handoff shape: a transport is
  // constructed, then a delivery call is made on it. Every identifier here is
  // deliberately unrelated to any qualification target, so passing proves the
  // fragment extractor follows the code shape rather than remembered names.
  it('keeps the concrete transport provider beside a delivery handoff', () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-query-provider-'))
    const sourceFile = join(root, 'sync.go')
    try {
      writeFileSync(sourceFile, [
        'package ledger',
        '',
        'func SyncRecord(ctx context.Context, payload RecordPayload) error {',
        '  url := "https://workflows.example/syncRecord"',
        '  queueClient, err := messaging.NewQueueClient(ctx, option.WithAuthCredentials(creds))',
        '  if err != nil { return err }',
        '  req := &messagingpb.DispatchRequest{Parent: queuePath}',
        '  _, err = queueClient.Dispatch(ctx, req)',
        '  return err',
        '}',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 3, {
        question: QUESTION,
        label: 'SyncRecord()',
        sourceLocation: 'L3',
      })

      expect(evidence?.snippet).toContain('messaging.NewQueueClient')
      expect(evidence?.snippet).toContain('queueClient.Dispatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps both sides of a public status JSON divergence in one snippet', () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-query-divergence-'))
    const sourceFile = join(root, 'status-json.ts')
    try {
      writeFileSync(sourceFile, [
        'export function toStatus(page: Page) {',
        '  return { status: pageIndicator(page.status) }',
        '}',
        '',
        'export function unresolvedIncidents(page: Page) {',
        '  return page.statusReports.filter((report) => report.status !== "resolved")',
        '}',
      ].join('\n'), 'utf8')

      const evidence = readQueryEvidenceSnippet(sourceFile, 1, {
        question: QUESTION,
        label: 'status-json.ts',
        sourceLocation: 'L1',
        fileNodeLike: true,
      })

      expect(evidence?.snippet).toContain('pageIndicator(page.status)')
      expect(evidence?.snippet).toContain('page.statusReports')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
