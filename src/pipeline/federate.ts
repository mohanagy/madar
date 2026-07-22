import { mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { loadGraphArtifact, writeGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { KnowledgeGraph, normalizeGraphPathIdentity } from '../domain/graph/directed-multigraph.js'
import { cluster, scoreAll } from './cluster.js'
import { buildCommunityLabels } from './community-naming.js'
import { generate as generateReport } from './report.js'
import { readGraphSourceRoot } from '../shared/graph-source-root.js'
import { validateGraphPath } from '../shared/security.js'
import { writeTextFileAtomically } from '../shared/atomic-file.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from './analyze.js'

const MAX_GRAPHS = 50

export interface FederateOptions {
  outputDir?: string | undefined
}

export interface FederateResult {
  graphPath: string
  reportPath: string
  repos: string[]
  totalNodes: number
  totalEdges: number
  crossRepoEdges: number
  communityCount: number
}

interface GraphSource {
  repoName: string
  graphPath: string
  graph: KnowledgeGraph
}
const portableAttributes = (attributes: Record<string, unknown>, root: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(attributes, (key, value) =>
    key === 'source_file' ? normalizeGraphPathIdentity(value, root) : value)) as Record<string, unknown>

function loadSourceGraph(graphPath: string): { graph: KnowledgeGraph; graphPath: string } {
  const safePath = validateGraphPath(graphPath)
  return { graphPath: safePath, graph: loadGraphArtifact(safePath) }
}

function inferRepoName(graphPath: string): string {
  return basename(readGraphSourceRoot(graphPath))
}

function prefixNodeId(repoName: string, nodeId: string): string {
  return `${repoName}::${nodeId}`
}

function findCrossRepoEdges(
  sources: GraphSource[],
  federatedGraph: KnowledgeGraph,
): number {
  // Find cross-repo connections by matching:
  // 1. Same label across repos (shared types/interfaces)
  // 2. Package imports referencing another repo

  const labelToNodes = new Map<string, Array<{ repoName: string; nodeId: string }>>()

  for (const source of sources) {
    for (const [nodeId, attributes] of source.graph.nodeEntries()) {
      const label = String(attributes.label ?? '').toLowerCase()
      if (!label || label.length < 3) {
        continue
      }

      const prefixed = prefixNodeId(source.repoName, nodeId)
      const existing = labelToNodes.get(label) ?? []
      existing.push({ repoName: source.repoName, nodeId: prefixed })
      labelToNodes.set(label, existing)
    }
  }

  let crossRepoEdges = 0

  for (const [, nodes] of labelToNodes) {
    // Only create edges between nodes from different repos
    const repos = new Set(nodes.map((n) => n.repoName))
    if (repos.size < 2) {
      continue
    }

    nodes.sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)

    // Connect all cross-repo nodes with the same label
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const nodeA = nodes[i]!
        const nodeB = nodes[j]!
        if (nodeA.repoName === nodeB.repoName) {
          continue
        }

        if (federatedGraph.hasNode(nodeA.nodeId) && federatedGraph.hasNode(nodeB.nodeId)) {
          federatedGraph.addEdge(nodeA.nodeId, nodeB.nodeId, {
            relation: 'shared_across_repos',
            confidence: 'INFERRED',
            source_file: '',
            weight: 0.5,
          })
          crossRepoEdges += 1
        }
      }
    }
  }

  return crossRepoEdges
}

export function federate(graphPaths: string[], options: FederateOptions = {}): FederateResult {
  if (graphPaths.length === 0) {
    throw new Error('At least one graph path is required')
  }

  if (graphPaths.length > MAX_GRAPHS) {
    throw new Error(`Too many graphs to federate (max ${MAX_GRAPHS})`)
  }

  const federatedGraph = new KnowledgeGraph()
  const sources: GraphSource[] = []

  // Load all graphs and merge into federated graph
  for (const graphPath of graphPaths) {
    const source = loadSourceGraph(graphPath)
    const repoName = inferRepoName(source.graphPath)
    sources.push({ repoName, graphPath: source.graphPath, graph: source.graph })

    // Add all nodes with repo prefix
    for (const [nodeId, attributes] of source.graph.nodeEntries()) {
      const prefixedId = prefixNodeId(repoName, nodeId)
      federatedGraph.addNode(prefixedId, {
        ...portableAttributes(attributes, source.graph.graph.root_path),
        source_repo: repoName,
        original_id: nodeId,
      })
    }

    // Add all edges with repo prefix
    for (const [sourceNode, target, attributes] of source.graph.edgeEntries()) {
      const prefixedSource = prefixNodeId(repoName, sourceNode)
      const prefixedTarget = prefixNodeId(repoName, target)
      federatedGraph.addEdge(prefixedSource, prefixedTarget, {
        ...portableAttributes(attributes, source.graph.graph.root_path),
        source_repo: repoName,
      })
    }
  }

  // Find and add cross-repo edges
  const crossRepoEdges = findCrossRepoEdges(sources, federatedGraph)

  // Cluster the federated graph
  const communities = cluster(federatedGraph)
  const cohesion = scoreAll(federatedGraph, communities)
  const communityLabels = buildCommunityLabels(federatedGraph, communities)

  // Output
  const outputDir = resolve(options.outputDir ?? 'out-federated')
  mkdirSync(outputDir, { recursive: true })
  const graphPath = join(outputDir, 'graph.json')
  const reportPath = join(outputDir, 'GRAPH_REPORT.md')

  const gods = godNodes(federatedGraph, 10)
  const surprises = surprisingConnections(federatedGraph, communities, 5)
  const anomalies = semanticAnomalies(federatedGraph, communities, communityLabels)
  const questions = suggestQuestions(federatedGraph, communities, communityLabels, 5)

  const report = generateReport(
    federatedGraph,
    communities,
    cohesion,
    communityLabels,
    gods,
    surprises,
    anomalies,
    {
      files: { code: [] },
      total_files: 0,
      total_words: 0,
      needs_graph: true,
      warning: null,
      skipped_sensitive: [],
      exclusions: [],
      madarignore_patterns: 0,
    },
    { input_tokens: 0, output_tokens: 0 },
    outputDir,
    questions,
  )

  Object.assign(federatedGraph.graph, { community_labels: communityLabels, semantic_anomalies: anomalies })
  for (const [communityId, nodeIds] of Object.entries(communities)) for (const nodeId of nodeIds) federatedGraph.replaceNodeAttributes(nodeId, { ...federatedGraph.nodeAttributes(nodeId), community: Number(communityId) })
  writeGraphArtifact(federatedGraph, graphPath)
  writeTextFileAtomically(reportPath, `${report}\n`)

  return {
    graphPath,
    reportPath,
    repos: sources.map((s) => s.repoName),
    totalNodes: federatedGraph.numberOfNodes(),
    totalEdges: federatedGraph.numberOfEdges(),
    crossRepoEdges,
    communityCount: Object.keys(communities).length,
  }
}
