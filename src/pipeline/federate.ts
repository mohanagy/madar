import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { rebindEvidenceOccurrence } from '../contracts/semantic-identity.js'
import { buildFromJson } from './build.js'
import { cluster, scoreAll } from './cluster.js'
import { buildCommunityLabels } from './community-naming.js'
import { generate as generateReport } from './report.js'
import { toJson } from './export.js'
import { isRecord } from '../shared/guards.js'
import { readGraphSourceRoot } from '../shared/graph-source-root.js'
import { validateGraphPath } from '../shared/security.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from './analyze.js'
import { loadGraph } from '../runtime/serve.js'
import { serializeGraphArtifactV2 } from '../contracts/graph-artifact.js'
import { activateGraphArtifactV2InDirectory } from '../infrastructure/graph-artifact-activation.js'

const MAX_GRAPH_BYTES = 100 * 1024 * 1024
const MAX_GRAPHS = 50

export interface FederateOptions {
  outputDir?: string | undefined
  directed?: boolean | undefined
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

/**
 * Loads one federation source.
 *
 * Federation predates artifact v2 and parsed the file as bare JSON, so after
 * the #705 cutover it could not read anything: the legacy path holds a
 * tombstone and the canonical artifact begins with a header. It now goes
 * through the shared loader, which resolves the request to the artifact that
 * actually holds the graph and understands both formats.
 *
 * The old size guard also read the entire file before comparing its length,
 * then read it a second time to parse. loadGraph stats first.
 *
 * loadGraph validates the path itself, so the raw path goes to it and the
 * resolved one comes from a single validation. Validating here as well ran
 * resolve, existsSync and realpathSync twice for each of up to MAX_GRAPHS
 * sources.
 */
function loadSourceGraph(graphPath: string): { graph: KnowledgeGraph; graphPath: string } {
  return { graphPath: validateGraphPath(graphPath), graph: loadGraph(graphPath) }
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

  const directed = options.directed === true
  const federatedGraph = new KnowledgeGraph({ directed })
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
        ...attributes,
        endpointIdentity: source.graph.nodeEndpointIdentity(nodeId),
        source_repo: repoName,
        original_id: nodeId,
      })
    }

    // Add all edges with repo prefix
    for (const { fact, attributes } of source.graph.factRecords()) {
      const prefixedSource = prefixNodeId(repoName, fact.source)
      const prefixedTarget = prefixNodeId(repoName, fact.target)
      const admission = federatedGraph.addEdge(prefixedSource, prefixedTarget, {
        ...attributes,
        source_repo: repoName,
      }, {
        discriminator: fact.discriminator,
        recordOccurrence: false,
      })
      if (admission.status !== 'stored') {
        throw new Error(`Federation could not admit relation ${fact.relation}`)
      }
      for (const occurrence of source.graph.occurrencesForFact(fact.id)) {
        federatedGraph.addOccurrence(rebindEvidenceOccurrence(occurrence, admission.factId))
      }
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
      files: { code: [], document: [], paper: [], image: [], audio: [], video: [] },
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

  // Federated output follows the same cutover contract as a generated
  // workspace: a canonical artifact plus a tombstone, published through the
  // same primitive rather than a second writer that could drift from it.
  // Writing v1 here would hand federation consumers a format the rest of
  // Madar no longer produces.
  const { artifactPath: graphPath } = activateGraphArtifactV2InDirectory(
    outputDir,
    serializeGraphArtifactV2({
      graph: federatedGraph,
      repositoryRevision: 'federated',
      generationMode: 'full',
      generatedAt: new Date().toISOString(),
      communityLabels,
      provenance: { schema_version: 2 },
    }),
  )
  writeFileSync(reportPath, report, 'utf8')

  return {
    graphPath,
    reportPath,
    repos: sources.map((s) => s.repoName),
    totalNodes: federatedGraph.numberOfNodes(),
    totalEdges: federatedGraph.numberOfFacts(),
    crossRepoEdges,
    communityCount: Object.keys(communities).length,
  }
}
