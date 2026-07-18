import { performance } from 'node:perf_hooks'

import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import type { RetrievalQualitySnapshot } from '../../src/contracts/retrieval-plan.js'
import {
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  contextPackFromRetrieveResult,
  retrieveContext,
  withRetrieveSnippetBudget,
} from '../../src/runtime/retrieve.js'
import {
  evaluateQueryEvidenceCoverage,
  finalizeConceptualFallbackPlan,
  planConceptualFallback,
  queryEvidenceObligations,
  underScopedDivergenceNodeIds,
  type ConceptualFallbackProposal,
} from '../../src/runtime/retrieve/conceptual-fallback.js'

function addNode(
  graph: KnowledgeGraph,
  id: string,
  label: string,
  sourceFile: string,
  attributes: Record<string, unknown> = {},
): void {
  graph.addNode(id, {
    label,
    source_file: sourceFile,
    source_location: 'L1-L3',
    file_type: 'code',
    node_kind: 'function',
    snippet: `export function ${id.replaceAll('-', '_')}() {}`,
    ...attributes,
  })
}

function lowQuality(): RetrievalQualitySnapshot {
  return {
    selected_nodes: 3,
    selected_files: 3,
    direct_matches: 3,
    explicit_anchors: 0,
    workflow_coherence: 0.333,
    missing_required_evidence: 0,
    missing_semantic_evidence: 0,
    token_count: 120,
  }
}

function conceptualWorkflowGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  addNode(graph, 'snapshot', 'TopologySnapshot.publish', '/src/map/topology-snapshot.ts')
  addNode(graph, 'observer', 'ChangeObserver.reconcileModifications', '/src/refresh/change-observer.ts')
  addNode(graph, 'coordinator', 'RefreshCoordinator.run', '/src/refresh/coordinator.ts')
  addNode(graph, 'distractor', 'CurrentTopologyFormatter', '/src/ui/current-topology-formatter.ts')
  graph.addEdge('coordinator', 'snapshot', { relation: 'coordinates' })
  graph.addEdge('coordinator', 'observer', { relation: 'coordinates' })
  return graph
}

describe('conceptual-query fallback planner', () => {
  it('does not turn answer-format directives into repository evidence obligations', () => {
    const obligations = queryEvidenceObligations(
      'Explain the failed monitor flow and note what the available evidence cannot prove.',
    )

    expect(obligations).toEqual([
      { index: 0, terms: ['@failure', 'monitor', 'flow'] },
    ])
  })

  it('keeps an enumerated computation scope together and preserves trailing divergence', () => {
    const obligations = queryEvidenceObligations(
      'Identify all files involved in status computation for monitors, incidents, and status pages, and any inconsistent status-computation logic across these paths.',
    )

    expect(obligations).toHaveLength(2)
    expect(obligations[0]?.terms).toEqual(expect.arrayContaining([
      'status',
      '@computation',
      'monitors',
      'incidents',
      'pages',
    ]))
    expect(obligations[1]?.terms).toContain('@divergence')
  })

  it('does not let a repeated citation checklist consume trailing flow obligations', () => {
    const obligations = queryEvidenceObligations(
      'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Cite exact files and symbols for: monitor check failure detection, incident creation logic, notification dispatch, and status-page status computation. Identify any inconsistent status-computation paths.',
    )

    expect(obligations).toHaveLength(5)
    expect(obligations[4]?.terms).toContain('@divergence')
    expect(obligations.filter((obligation) => obligation.terms.includes('@failure'))).toHaveLength(1)
  })

  it('does not let an agent-expanded end-to-end checklist repeat the flow phases', () => {
    const obligations = queryEvidenceObligations(
      'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify all files/symbols involved end-to-end: from the checker detecting failure, through incident creation, notification dispatch, and public status-page computation. Also identify any inconsistent or duplicate status-computation paths.',
    )

    expect(obligations).toHaveLength(5)
    expect(obligations[4]?.terms).toContain('@divergence')
    expect(obligations.filter((obligation) => obligation.terms.includes('@failure'))).toHaveLength(1)
  })

  it('does not let an include checklist displace a trailing divergence request', () => {
    const obligations = queryEvidenceObligations(
      'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Include the checker/probe result ingestion, incident creation logic, notification dispatch, and status-page status computation. Identify all files and symbols involved and any inconsistent status-computation paths between different parts of the codebase.',
    )

    expect(obligations).toHaveLength(5)
    expect(obligations[4]?.terms).toContain('@divergence')
    expect(obligations.filter((obligation) => obligation.terms.includes('@failure'))).toHaveLength(1)
    expect(obligations.flatMap((obligation) => obligation.terms)).not.toContain('probe')
  })

  it('does not let a from-through checklist create a second workflow', () => {
    const obligations = queryEvidenceObligations(
      'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify all files/symbols involved from failed check ingestion through incident creation, notification dispatch, and status-page status computation. Also identify any inconsistent status-computation paths across the codebase.',
    )

    expect(obligations).toHaveLength(5)
    expect(obligations[4]?.terms).toContain('@divergence')
    expect(obligations.filter((obligation) => obligation.terms.includes('@transition'))).toHaveLength(1)
  })

  it('preserves divergence text embedded in a repeated checklist sentence', () => {
    const obligations = queryEvidenceObligations(
      'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify every owner from failure detection through notification dispatch and compare inconsistent status computations.',
    )

    expect(obligations.at(-1)?.terms).toContain('@divergence')
    expect(obligations.filter((obligation) => obligation.terms.includes('@failure'))).toHaveLength(1)
  })

  it('treats a status assignment as grounded computation evidence', () => {
    const coverage = evaluateQueryEvidenceCoverage(
      'Identify status computation for monitors',
      [{
        label: 'statusPage.ts',
        source_file: '/packages/api/statusPage.ts',
        snippet: 'const status = monitors.some((monitor) => monitor.status === "error") ? "error" : "success"',
      }],
    )

    expect(coverage).toMatchObject({
      total: 1,
      covered: 1,
      missing_obligations: [],
    })
  })

  it('reports snippet-grounded obligation coverage rather than vocabulary-anchor coverage', () => {
    const question = 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify inconsistent status-computation paths.'
    const proposal = planConceptualFallback(new KnowledgeGraph({ directed: true }), {
      question,
      initialQuality: lowQuality(),
      selectedNodes: [],
      initialQueryEvidence: {
        total: 5,
        covered: 5,
        covered_obligations: [
          'query:obligation:1',
          'query:obligation:2',
          'query:obligation:3',
          'query:obligation:4',
          'query:obligation:5',
        ],
        missing_obligations: [],
      },
    })

    expect(proposal.plan.reasons).not.toContain('missing_query_obligations')
    expect(proposal.plan.query_obligations).toEqual({
      total: 5,
      initially_covered: 5,
      finally_covered: 5,
    })
  })

  it('does not replace one covered obligation with another at the same count', () => {
    const quality = lowQuality()
    const proposal: ConceptualFallbackProposal = {
      plan: {
        version: 1,
        status: 'kept_initial',
        reasons: ['missing_query_obligations'],
        initial: quality,
        final: quality,
        attempts: [{
          fallback: 'repository_vocabulary_v1',
          status: 'kept_initial',
          reasons: ['missing_query_obligations'],
          vocabulary_sources: [],
          expansion_terms: [],
          promoted_candidates: 1,
          promoted_communities: [],
          changed_result: false,
          added_selected_files: 0,
          removed_selected_files: 0,
        }],
        query_obligations: {
          total: 2,
          initially_covered: 2,
          finally_covered: 2,
        },
      },
      nodeBoosts: new Map([['recovered', 1]]),
      initialQueryEvidence: {
        total: 2,
        covered: 2,
        covered_obligations: ['query:obligation:1', 'query:obligation:2'],
        missing_obligations: [],
      },
      obligationMatches: new Map([['recovered', new Set([0, 1])]]),
      initialObligationCoverage: 1,
    }

    const finalized = finalizeConceptualFallbackPlan(
      proposal,
      quality,
      new Set(['/initial.ts']),
      new Set(['/recovered.ts']),
      new Set(['recovered']),
      {
        total: 2,
        covered: 2,
        covered_obligations: ['query:obligation:1', 'query:obligation:3'],
        missing_obligations: ['query:obligation:2'],
      },
    )

    expect(finalized.useRecovered).toBe(false)
    expect(finalized.plan.query_obligations?.finally_covered).toBe(2)
  })

  it('excludes generic computations from a repository-scoped divergence comparison', () => {
    const graph = new KnowledgeGraph({ directed: true })
    addNode(graph, 'page-status', 'computeOverallStatus()', '/apps/server/status-page/index.ts')
    addNode(graph, 'generic-status', 'computePhaseStatus()', '/packages/services/import/utils.ts')

    const excluded = underScopedDivergenceNodeIds(
      graph,
      'Identify status computation for monitors, incidents, and status pages, and any inconsistent status-computation logic across these paths.',
    )

    expect(excluded.has('generic-status')).toBe(true)
    expect(excluded.has('page-status')).toBe(false)
  })

  it('recovers a structurally coherent workflow center when lexical anchors are disconnected', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'How is topology kept current when modifications happen?',
      budget: 3000,
    })

    expect(result.retrieval_plan).toMatchObject({
      version: 1,
      status: 'recovered',
      reasons: expect.arrayContaining(['low_workflow_coherence']),
      selected_fallback: 'repository_vocabulary_v1',
      attempts: [expect.objectContaining({
        fallback: 'repository_vocabulary_v1',
        status: 'applied',
        changed_result: true,
      })],
    })
    expect(result.matched_nodes.map((node) => node.label)).toContain('RefreshCoordinator.run')
    expect(result.retrieval_plan?.final.workflow_coherence).toBeGreaterThan(result.retrieval_plan?.initial.workflow_coherence ?? 1)
  })

  it('does not broaden an unrelated-keyword query into arbitrary graph hubs', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'quasar marmalade zephyr',
      budget: 3000,
    })

    expect(result.matched_nodes).toEqual([])
    expect(result.retrieval_plan).toMatchObject({
      status: 'no_candidates',
      attempts: [expect.objectContaining({
        status: 'no_candidates',
        changed_result: false,
        promoted_candidates: 0,
      })],
    })
    expect(result.retrieval_plan).not.toHaveProperty('selected_fallback')
  })

  it('does not override explicit symbol anchors', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'Explain `CurrentTopologyFormatter`',
      budget: 3000,
    })

    expect(result.retrieval_plan).toMatchObject({
      status: 'not_needed',
      reasons: [],
      attempts: [],
    })
    expect(result.matched_nodes[0]?.label).toBe('CurrentTopologyFormatter')
  })

  it('leaves implementation-pack ranking to the dedicated task-context planner', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'Implement automatic topology refresh when modifications happen',
      budget: 3000,
      taskKind: 'implement',
    })

    expect(result.retrieval_plan).toMatchObject({
      status: 'not_needed',
      reasons: [],
      attempts: [],
    })
  })

  it('derives fallback terms from every supported repository-local vocabulary source', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.graph.community_labels = { 1: 'Refresh lifecycle' }
    addNode(graph, 'exported', 'TopologyPublisher', '/src/map/publisher.ts', { community: 1 })
    addNode(graph, 'module', 'run', '/src/reconciliation/change-observer.ts', { community: 1 })
    addNode(graph, 'docs', 'Automatic refresh protocol', '/docs/auto-refresh.md', {
      file_type: 'document',
      node_kind: 'document',
      community: 1,
    })
    addNode(graph, 'framework', 'handler', '/src/runtime/handler.ts', {
      community: 1,
      framework: 'worker-runtime',
      framework_role: 'watcher',
      framework_metadata: { runtime_boundary: 'change reconciliation' },
    })
    graph.addEdge('exported', 'module', { relation: 'coordinates' })
    graph.addEdge('module', 'docs', { relation: 'references' })
    graph.addEdge('docs', 'framework', { relation: 'describes' })

    const proposal = planConceptualFallback(graph, {
      question: 'Explain topology refresh reconciliation watcher lifecycle',
      initialQuality: lowQuality(),
      selectedNodes: [
        { nodeId: 'exported', sourceFile: '/src/map/publisher.ts', relevanceBand: 'direct', matchScore: 1 },
        { nodeId: 'module', sourceFile: '/src/reconciliation/change-observer.ts', relevanceBand: 'direct', matchScore: 1 },
        { nodeId: 'docs', sourceFile: '/docs/auto-refresh.md', relevanceBand: 'direct', matchScore: 1 },
      ],
    })

    expect(proposal.nodeBoosts.size).toBeGreaterThan(0)
    expect(proposal.plan.attempts[0]?.vocabulary_sources).toEqual(expect.arrayContaining([
      'path',
      'exported_symbol',
      'module_name',
      'graph_community',
      'document_heading',
      'framework_metadata',
    ]))
    expect(proposal.plan.attempts[0]?.expansion_terms.length).toBeGreaterThan(0)
  })

  it('reports semantic evidence gaps separately from required evidence gaps', () => {
    const proposal = planConceptualFallback(conceptualWorkflowGraph(), {
      question: 'How is topology kept current when modifications happen?',
      initialQuality: {
        ...lowQuality(),
        selected_nodes: 2,
        selected_files: 2,
        direct_matches: 2,
        workflow_coherence: 1,
        missing_semantic_evidence: 1,
      },
      selectedNodes: [],
    })

    expect(proposal.plan.reasons).toEqual(['missing_semantic_evidence'])
  })

  it('applies the lifecycle vocabulary to an unrelated search-index workflow', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.graph.community_labels = { 7: 'Order changes and search projection synchronization' }
    addNode(graph, 'orders', 'OrderChangeSubscriber', '/services/search/order-events.ts', { community: 7 })
    addNode(graph, 'sync', 'SearchProjectionSynchronizer', '/services/search/projection-sync.ts', { community: 7 })
    addNode(graph, 'publish', 'ProductListingPublisher', '/services/search/listing-publisher.ts', { community: 7 })
    addNode(graph, 'badge', 'SearchStatusBadge', '/ui/search-status-badge.ts', { community: 9 })
    graph.addEdge('sync', 'orders', { relation: 'consumes' })
    graph.addEdge('sync', 'publish', { relation: 'publishes' })

    const result = retrieveContext(graph, {
      question: 'How are product search listings kept current when orders change?',
      budget: 2000,
    })

    const labels = result.matched_nodes.map((node) => node.label)
    expect(labels).toEqual(expect.arrayContaining([
      'OrderChangeSubscriber',
      'SearchProjectionSynchronizer',
      'ProductListingPublisher',
    ]))
    expect(result.relationships.length).toBeGreaterThan(0)
    const distractorRank = labels.indexOf('SearchStatusBadge')
    expect(distractorRank === -1 || labels.indexOf('SearchProjectionSynchronizer') < distractorRank).toBe(true)
    expect(labels.filter((label) => label !== 'SearchStatusBadge').length / labels.length).toBeGreaterThanOrEqual(0.75)
  })

  it('reserves the cross-runtime caller that owns the first failure transition', () => {
    const graph = new KnowledgeGraph({ directed: true })
    addNode(graph, 'failure-log', 'FailedMonitorLog', '/packages/services/monitor/failure-log.ts')
    addNode(graph, 'status-update', 'UpdateStatus()', '/apps/checker/checker/update.go')
    addNode(graph, 'http-checker', '.HTTPCheckerHandler()', '/apps/checker/handlers/checker.go', {
      framework: 'gin',
      framework_role: 'gin_handler',
    })
    addNode(graph, 'incident', 'createIncident()', '/apps/workflows/checker/incident.ts')
    addNode(graph, 'notifications', 'triggerNotifications()', '/apps/workflows/checker/alerting.ts')
    addNode(graph, 'public-status', 'statusPage.ts', '/packages/api/router/statusPage.ts')
    addNode(graph, 'alternate-status', 'computeOverallStatus()', '/apps/server/status-page/index.ts')
    graph.addEdge('http-checker', 'status-update', { relation: 'calls' })
    graph.addEdge('status-update', 'incident', { relation: 'calls' })
    graph.addEdge('incident', 'notifications', { relation: 'calls' })
    graph.addEdge('public-status', 'incident', { relation: 'reads' })
    graph.addEdge('alternate-status', 'public-status', { relation: 'competes_with' })

    const proposal = planConceptualFallback(graph, {
      question: 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify inconsistent status-computation paths.',
      initialQuality: lowQuality(),
      selectedNodes: [],
    })

    expect(proposal.preferredObligationAnchors?.get(0)).toBe('http-checker')
    expect(proposal.nodeBoosts.get('http-checker')).toBeGreaterThanOrEqual(9)
    expect(proposal.nodeBoosts.get('status-update')).toBeGreaterThanOrEqual(9)
  })

  it('reserves workflow-local creation and delivery owners for natural wording', () => {
    const graph = new KnowledgeGraph({ directed: true })
    addNode(graph, 'http-checker', '.HTTPCheckerHandler()', '/apps/checker/handlers/checker.go')
    addNode(graph, 'status-update', 'UpdateStatus()', '/apps/checker/checker/update.go')
    addNode(graph, 'incident-owner', 'findOpenIncident()', '/apps/workflows/src/checker/index.ts')
    addNode(graph, 'delivery-owner', 'triggerNotifications()', '/apps/workflows/src/checker/alerting.ts')
    addNode(graph, 'public-status', 'statusPage.ts', '/packages/api/src/router/statusPage.ts')
    addNode(graph, 'overall-status', 'computeOverallStatus()', '/apps/server/src/routes/status-page/index.ts')
    addNode(graph, 'import-writer', 'createImportedIncident()', '/packages/services/src/import/phase-writers.ts')
    addNode(graph, 'test-delivery', 'sendTestNotification()', '/apps/server/src/routes/notification/test-providers.ts')
    graph.addEdge('http-checker', 'status-update', { relation: 'calls' })
    graph.addEdge('status-update', 'incident-owner', { relation: 'calls' })
    graph.addEdge('incident-owner', 'delivery-owner', { relation: 'calls' })
    graph.addEdge('public-status', 'incident-owner', { relation: 'reads' })
    graph.addEdge('overall-status', 'public-status', { relation: 'competes_with' })

    const proposal = planConceptualFallback(graph, {
      question: 'Explain the path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every overall-status computation. Read-only: do not modify files.',
      initialQuality: lowQuality(),
      selectedNodes: [],
    })

    expect(proposal.preferredObligationAnchors?.get(1)).toBe('incident-owner')
    expect(proposal.preferredObligationAnchors?.get(2)).toBe('delivery-owner')
    expect(proposal.nodeBoosts.get('incident-owner')).toBeGreaterThanOrEqual(14)
    expect(proposal.nodeBoosts.get('delivery-owner')).toBeGreaterThanOrEqual(14)
    expect(proposal.nodeBoosts.has('test-delivery')).toBe(false)
  })

  it('reserves the public HTTP boundary separately from status computation owners', () => {
    const graph = new KnowledgeGraph({ directed: true })
    addNode(graph, 'public-json-route', 'GET()', '/apps/status-page/src/app/api/status/[[...path]]/route.ts', {
      framework_role: 'next_route_handler',
    })
    addNode(graph, 'status-json', 'status-json.ts', '/apps/status-page/src/content/status-json.ts')
    addNode(graph, 'public-status', 'statusPage.ts', '/packages/api/src/router/statusPage.ts')
    addNode(graph, 'overall-status', 'computeOverallStatus()', '/apps/server/src/routes/status-page/index.ts')
    addNode(graph, 'failed-check', '.HTTPCheckerHandler()', '/apps/checker/handlers/checker.go')
    addNode(graph, 'incident-owner', 'createIncident()', '/apps/workflows/src/checker/incident.ts')
    addNode(graph, 'notification-owner', 'triggerNotifications()', '/apps/workflows/src/checker/alerting.ts')
    graph.addEdge('public-json-route', 'status-json', { relation: 'calls' })
    graph.addEdge('status-json', 'public-status', { relation: 'serializes' })
    graph.addEdge('overall-status', 'public-status', { relation: 'competes_with' })
    graph.addEdge('failed-check', 'incident-owner', { relation: 'calls' })
    graph.addEdge('incident-owner', 'notification-owner', { relation: 'calls' })
    graph.addEdge('incident-owner', 'public-status', { relation: 'affects' })

    const proposal = planConceptualFallback(graph, {
      question: 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status. Identify inconsistent status-computation paths.',
      initialQuality: lowQuality(),
      selectedNodes: [],
    })

    expect(proposal.nodeBoosts.get('public-json-route')).toBeGreaterThanOrEqual(9)
    expect(proposal.nodeBoosts.has('public-status')).toBe(true)
    expect(proposal.nodeBoosts.has('overall-status')).toBe(true)
  })

  it('caps every BFS neighbor read on a hub-heavy graph', () => {
    const graph = new KnowledgeGraph({ directed: true })
    addNode(graph, 'snapshot', 'TopologySnapshot', '/runtime/topology/snapshot.ts')
    addNode(graph, 'observer', 'ModificationObserver', '/runtime/topology/modification-observer.ts')
    addNode(graph, 'hub', 'TopologyRefreshCoordinator', '/runtime/topology/refresh-coordinator.ts')
    graph.addEdge('snapshot', 'hub', { relation: 'publishes' })
    for (let index = 0; index < 2_000; index += 1) {
      const id = `noise-${index}`
      addNode(graph, id, `UnrelatedBranch${index}`, `/runtime/noise/${index}.ts`)
      graph.addEdge('hub', id, { relation: 'routes' })
    }
    graph.addEdge('hub', 'observer', { relation: 'notifies' })
    const neighborSpy = vi.spyOn(graph, 'incidentNeighbors')
    const started = performance.now()

    planConceptualFallback(graph, {
      question: 'How is topology kept current when modifications happen?',
      initialQuality: lowQuality(),
      selectedNodes: [],
    })

    expect(performance.now() - started).toBeLessThan(500)
    expect(neighborSpy).toHaveBeenCalled()
    expect(neighborSpy.mock.calls.every(([, limit]) => limit === 32)).toBe(true)
    expect(neighborSpy.mock.results.every((entry) => (
      entry.type !== 'return' || (entry.value as string[]).length <= 32
    ))).toBe(true)
    neighborSpy.mockRestore()

    const retrieval = retrieveContext(graph, {
      question: 'How is topology kept current when modifications happen?',
      budget: 1_200,
    })
    expect(retrieval.retrieval_plan?.initial.workflow_coherence).toBe(1)
  })

  it('keeps retrieval-plan query coverage aligned with every snippet-shaped representation', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'How is topology kept current when modifications happen?',
      budget: 3000,
    })
    const stalePlanResult = {
      ...result,
      retrieval_plan: {
        version: 1 as const,
        status: 'kept_initial' as const,
        reasons: ['missing_query_obligations' as const],
        initial: {
          selected_nodes: result.matched_nodes.length,
          selected_files: result.matched_nodes.length,
          direct_matches: result.matched_nodes.length,
          explicit_anchors: 0,
          workflow_coherence: 1,
          missing_required_evidence: 0,
          missing_semantic_evidence: 0,
          token_count: result.token_count,
        },
        final: {
          selected_nodes: result.matched_nodes.length,
          selected_files: result.matched_nodes.length,
          direct_matches: result.matched_nodes.length,
          explicit_anchors: 0,
          workflow_coherence: 1,
          missing_required_evidence: 0,
          missing_semantic_evidence: 0,
          token_count: result.token_count,
        },
        attempts: [],
        query_obligations: {
          total: 99,
          initially_covered: 99,
          finally_covered: 99,
        },
      },
    }
    const shapedRepresentations = [
      withRetrieveSnippetBudget(stalePlanResult, { topNWithSnippet: 1, snippetBudget: 12 }),
      compactRetrieveResult(stalePlanResult, { topNWithSnippet: 1, snippetBudget: 12 }),
      compactRetrieveResultForStdio(stalePlanResult, { topNWithSnippet: 1, snippetBudget: 12, maxOutputTokens: 1 }),
    ]

    expect(contextPackFromRetrieveResult(stalePlanResult).retrieval_plan).toEqual(stalePlanResult.retrieval_plan)
    for (const representation of shapedRepresentations) {
      const coverage = evaluateQueryEvidenceCoverage(result.question, representation.matched_nodes)
      expect(representation.retrieval_plan?.query_obligations).toEqual(expect.objectContaining({
        total: coverage.total,
        finally_covered: coverage.covered,
      }))
    }
  })
})
