import { KnowledgeGraph } from '../contracts/graph.js'
import {
  analysisEntityDegree,
  isAnalysisEntityNode,
  _nodeCommunityMap,
  graphStructureMetrics,
  workspaceBridges,
  type SemanticAnomaly,
} from './analyze.js'
import { cohesionScore, type Communities } from './cluster.js'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/([\\`*_[\]()!])/g, '\\$1')
}

function formatInlineCode(value: string): string {
  return `\`${escapeMarkdownInline(value)}\``
}

function formatConfidenceTag(confidence: string, confidenceScore?: number): string {
  if (confidence === 'INFERRED' && typeof confidenceScore === 'number') {
    return `INFERRED ${confidenceScore.toFixed(2)}`
  }
  return confidence
}

function formatAnomalyKind(kind: SemanticAnomaly['kind']): string {
  switch (kind) {
    case 'bridge_node':
      return 'Bridge node'
    case 'cross_boundary_edge':
      return 'Cross-boundary edge'
    case 'low_cohesion_community':
      return 'Low-cohesion community'
  }
}

export function generate(
  graph: KnowledgeGraph,
  communities: Communities,
  _cohesionScores: Record<number, number>,
  communityLabels: Record<number, string>,
  godNodeList: Array<{ id: string; label: string; edges: number }>,
  surpriseList: Array<{
    source: string
    target: string
    source_files: [string, string]
    confidence: string
    confidence_score?: number
    relation: string
    why?: string
    note?: string
  }>,
  semanticAnomalyList: SemanticAnomaly[],
  detectionResult: Record<string, unknown>,
  tokenCost: Record<string, unknown>,
  root: string,
  suggestedQuestions: Array<{ type: string; question: string | null; why: string }> = [],
): string {
  const confidences = graph.edgeEntries().map(([, , attributes]) => String(attributes.confidence ?? 'EXTRACTED'))
  const totalEdges = confidences.length || 1
  const extractedPercent = Math.round((confidences.filter((confidence) => confidence === 'EXTRACTED').length / totalEdges) * 100)
  const inferredPercent = Math.round((confidences.filter((confidence) => confidence === 'INFERRED').length / totalEdges) * 100)
  const ambiguousPercent = Math.round((confidences.filter((confidence) => confidence === 'AMBIGUOUS').length / totalEdges) * 100)
  const inferredEdges = graph.edgeEntries().filter(([, , attributes]) => String(attributes.confidence ?? 'EXTRACTED') === 'INFERRED')
  const inferredScores = inferredEdges.map(([, , attributes]) => attributes.confidence_score).filter((value): value is number => typeof value === 'number')
  const inferredAverage = inferredScores.length > 0 ? Math.round((inferredScores.reduce((sum, value) => sum + value, 0) / inferredScores.length) * 100) / 100 : null
  const structure = graphStructureMetrics(graph)
  const bridgeList = workspaceBridges(graph, communities, communityLabels)

  const today = new Date().toISOString().split('T')[0]
  const lines = [`# Graph Report - ${escapeMarkdownInline(root)}  (${today})`, '', '## Corpus Check']

  const warning = typeof detectionResult.warning === 'string' ? detectionResult.warning : null
  if (warning) {
    lines.push(`- ${warning}`)
  } else {
    const totalFiles = typeof detectionResult.total_files === 'number' ? detectionResult.total_files : 0
    const totalWords = typeof detectionResult.total_words === 'number' ? detectionResult.total_words : 0
    lines.push(`- ${totalFiles} files · ~${formatNumber(totalWords)} words`)
    lines.push('- Verdict: corpus is large enough that graph structure adds value.')
  }

  const indexing = detectionResult.indexing_completeness
  if (indexing && typeof indexing === 'object' && !Array.isArray(indexing)) {
    const summary = indexing as {
      state?: unknown
      counts?: Partial<Record<'indexed' | 'indexed_with_warnings' | 'skipped_by_policy' | 'unsupported' | 'failed', unknown>>
    }
    const state = summary.state === 'complete' || summary.state === 'partial' || summary.state === 'failed'
      ? summary.state
      : 'partial'
    const count = (name: keyof NonNullable<typeof summary.counts>): number => {
      const value = summary.counts?.[name]
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    lines.push(
      `- **Indexing completeness: ${state.toUpperCase()}** — ${count('indexed')} indexed, ${count('indexed_with_warnings')} with warnings, ${count('skipped_by_policy')} skipped by policy, ${count('unsupported')} unsupported, ${count('failed')} failed.`,
    )
  }

  lines.push('')
  lines.push('## Summary')
  lines.push(`- ${graph.numberOfNodes()} nodes · ${graph.numberOfEdges()} edges · ${Object.keys(communities).length} communities detected`)
  lines.push(
    `- Extraction: ${extractedPercent}% EXTRACTED · ${inferredPercent}% INFERRED · ${ambiguousPercent}% AMBIGUOUS` +
      (inferredAverage !== null ? ` · INFERRED: ${inferredEdges.length} edges (avg confidence: ${inferredAverage})` : ''),
  )
  lines.push(`- Token cost: ${formatNumber(Number(tokenCost.input ?? 0))} input · ${formatNumber(Number(tokenCost.output ?? 0))} output`)
  lines.push('')
  lines.push('## Structure Signals')
  lines.push(`- Entity graph basis: ${formatNumber(structure.total_nodes)} non-file, non-concept node(s)`)
  lines.push(`- Weakly connected components: ${formatNumber(structure.weakly_connected_components)}`)
  lines.push(`- Singleton components: ${formatNumber(structure.singleton_components)}`)
  lines.push(`- Isolated nodes: ${formatNumber(structure.isolated_nodes)}`)
  lines.push(
    `- Largest component: ${formatNumber(structure.largest_component_nodes)} node(s) (${Math.round(structure.largest_component_ratio * 100)}% of the entity graph basis)`,
  )
  lines.push(`- Low-cohesion communities: ${formatNumber(structure.low_cohesion_communities)}`)
  lines.push(
    structure.low_cohesion_communities > 0
      ? `- Largest low-cohesion community: ${formatNumber(structure.largest_low_cohesion_community_nodes)} node(s) (cohesion ${structure.largest_low_cohesion_community_score})`
      : '- Largest low-cohesion community: none on the entity graph basis',
  )
  lines.push('')
  lines.push('## Workspace Bridges')
  if (bridgeList.length === 0) {
    lines.push('- None detected - no entity nodes currently connect multiple communities.')
  } else {
    for (const [index, bridge] of bridgeList.entries()) {
      const connected = bridge.connected_communities.map((community) => formatInlineCode(community.label)).join(', ')
      const sourceFiles = bridge.source_files.map((sourceFile) => formatInlineCode(sourceFile)).join(', ')
      lines.push(
        `${index + 1}. ${formatInlineCode(bridge.label)} - connects ${connected}; home: ${formatInlineCode(bridge.community_label)}; degree ${bridge.degree}; score ${bridge.score}`,
      )
      lines.push(`  source files: ${sourceFiles || 'n/a'}`)
    }
  }
  lines.push('')
  lines.push('## God Nodes')
  for (const [index, node] of godNodeList.entries()) {
    lines.push(`${index + 1}. ${formatInlineCode(node.label)} - ${node.edges} edges`)
  }

  lines.push('')
  lines.push('## Surprising Connections')
  if (surpriseList.length === 0) {
    lines.push('- None detected - all connections are within the same source files.')
  } else {
    for (const surprise of surpriseList) {
      lines.push(
        `- ${formatInlineCode(surprise.source)} --${escapeMarkdownInline(surprise.relation)}--> ${formatInlineCode(surprise.target)}  [${formatConfidenceTag(surprise.confidence, surprise.confidence_score)}]`,
      )
      lines.push(
        `  ${escapeMarkdownInline(surprise.source_files[0])} → ${escapeMarkdownInline(surprise.source_files[1])}${surprise.why ? `  _${escapeMarkdownInline(surprise.why)}_` : ''}`,
      )
    }
  }

  lines.push('')
  lines.push('## Semantic Anomalies')
  if (semanticAnomalyList.length === 0) {
    lines.push('- None detected - the graph currently looks structurally well-behaved.')
  } else {
    for (const anomaly of semanticAnomalyList) {
      lines.push(`- **[${anomaly.severity}] ${formatAnomalyKind(anomaly.kind)}** - ${escapeMarkdownInline(anomaly.summary)}`)
      lines.push(`  _${escapeMarkdownInline(anomaly.why)}_`)
    }
  }

  const hyperedges = Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : []
  if (hyperedges.length > 0) {
    lines.push('')
    lines.push('## Hyperedges (group relationships)')
    for (const hyperedge of hyperedges) {
      const label = typeof hyperedge.label === 'string' ? hyperedge.label : typeof hyperedge.id === 'string' ? hyperedge.id : 'hyperedge'
      const nodeLabels = Array.isArray(hyperedge.nodes) ? hyperedge.nodes.map((nodeId: unknown) => escapeMarkdownInline(String(nodeId))).join(', ') : ''
      const confidence = typeof hyperedge.confidence === 'string' ? hyperedge.confidence : 'INFERRED'
      const confidenceScore = typeof hyperedge.confidence_score === 'number' ? hyperedge.confidence_score : undefined
      lines.push(`- **${escapeMarkdownInline(label)}** — ${nodeLabels} [${formatConfidenceTag(confidence, confidenceScore)}]`)
    }
  }

  lines.push('')
  lines.push('## Communities')
  const nodeCommunity = _nodeCommunityMap(communities)
  for (const [communityId, nodeIds] of Object.entries(communities)) {
    const label = escapeMarkdownInline(communityLabels[Number(communityId)] ?? `Community ${communityId}`)
    const realNodes = nodeIds.filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
    const score = realNodes.length > 0 ? cohesionScore(graph, realNodes) : null
    const display = realNodes.slice(0, 8).map((nodeId) => escapeMarkdownInline(String(graph.nodeAttributes(nodeId).label ?? nodeId)))
    const suffix = realNodes.length > 8 ? ` (+${realNodes.length - 8} more)` : ''
    lines.push('')
    lines.push(`### Community ${communityId} - "${label}"`)
    lines.push(`Cohesion (entity basis within full-graph community): ${score ?? 'n/a'}`)
    lines.push(`Nodes (${realNodes.length}): ${display.join(', ')}${suffix}`)
  }

  const ambiguousEdges = graph.edgeEntries().filter(([, , attributes]) => String(attributes.confidence ?? 'EXTRACTED') === 'AMBIGUOUS')
  if (ambiguousEdges.length > 0) {
    lines.push('')
    lines.push('## Ambiguous Edges')
    for (const [sourceNodeId, targetNodeId, attributes] of ambiguousEdges) {
      const directedSourceId = typeof attributes._src === 'string' && graph.hasNode(attributes._src) ? attributes._src : sourceNodeId
      const directedTargetId = typeof attributes._tgt === 'string' && graph.hasNode(attributes._tgt) ? attributes._tgt : targetNodeId
      lines.push(
        `- ${formatInlineCode(String(graph.nodeAttributes(directedSourceId).label ?? directedSourceId))} → ${formatInlineCode(String(graph.nodeAttributes(directedTargetId).label ?? directedTargetId))}  [AMBIGUOUS]`,
      )
      lines.push(`  ${escapeMarkdownInline(String(attributes.source_file ?? ''))} · relation: ${escapeMarkdownInline(String(attributes.relation ?? 'unknown'))}`)
    }
  }

  const isolated = graph.nodeIds().filter((nodeId) => analysisEntityDegree(graph, nodeId) <= 1 && isAnalysisEntityNode(graph, nodeId))
  const thinCommunities = Object.fromEntries(Object.entries(communities).filter(([, nodeIds]) => nodeIds.length < 3))
  const gapCount = isolated.length + Object.keys(thinCommunities).length
  if (gapCount > 0 || ambiguousPercent > 20) {
    lines.push('')
    lines.push('## Knowledge Gaps')
    if (isolated.length > 0) {
      const isolatedLabels = isolated.slice(0, 5).map((nodeId) => formatInlineCode(String(graph.nodeAttributes(nodeId).label ?? nodeId)))
      const suffix = isolated.length > 5 ? ` (+${isolated.length - 5} more)` : ''
      lines.push(`- **${isolated.length} weakly connected node(s):** ${isolatedLabels.join(', ')}${suffix}`)
      lines.push('  These have ≤1 connection - possible missing edges or undocumented components.')
    }
    for (const [communityId, nodeIds] of Object.entries(thinCommunities)) {
      const label = communityLabels[Number(communityId)] ?? `Community ${communityId}`
      const labels = nodeIds.map((nodeId) => formatInlineCode(String(graph.nodeAttributes(nodeId).label ?? nodeId)))
      lines.push(`- **Thin community ${formatInlineCode(label)}** (${nodeIds.length} nodes): ${labels.join(', ')}`)
      lines.push('  Too small to be a meaningful cluster - may be noise or needs more connections extracted.')
    }
    if (ambiguousPercent > 20) {
      lines.push(`- **High ambiguity: ${ambiguousPercent}% of edges are AMBIGUOUS.** Review the Ambiguous Edges section above.`)
    }
  }

  if (suggestedQuestions.length > 0) {
    lines.push('')
    lines.push('## Suggested Questions')
    const noSignal = suggestedQuestions.length === 1 && suggestedQuestions[0]?.type === 'no_signal'
    if (noSignal) {
      lines.push(`_${suggestedQuestions[0]?.why ?? ''}_`)
    } else {
      lines.push('_Questions this graph is uniquely positioned to answer:_')
      lines.push('')
      for (const suggestedQuestion of suggestedQuestions) {
        if (!suggestedQuestion.question) {
          continue
        }
        lines.push(`- **${escapeMarkdownInline(suggestedQuestion.question)}**`)
        lines.push(`  _${escapeMarkdownInline(suggestedQuestion.why)}_`)
      }
    }
  }

  return lines.join('\n')
}
