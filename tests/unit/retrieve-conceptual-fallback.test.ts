import { performance } from 'node:perf_hooks'

import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import type { RetrievalQualitySnapshot } from '../../src/contracts/retrieval-plan.js'
import {
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  contextPackFromRetrieveResult,
  retrieveContext,
} from '../../src/runtime/retrieve.js'
import { planConceptualFallback } from '../../src/runtime/retrieve/conceptual-fallback.js'

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

  it('surfaces the retrieval plan through full, compact, and stdio context representations', () => {
    const result = retrieveContext(conceptualWorkflowGraph(), {
      question: 'How is topology kept current when modifications happen?',
      budget: 3000,
    })

    expect(contextPackFromRetrieveResult(result).retrieval_plan).toEqual(result.retrieval_plan)
    expect(compactRetrieveResult(result).retrieval_plan).toEqual(result.retrieval_plan)
    expect(compactRetrieveResultForStdio(result).retrieval_plan).toEqual(result.retrieval_plan)
  })
})
