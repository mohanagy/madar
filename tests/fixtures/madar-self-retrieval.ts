import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

interface FixtureNode {
  id: string
  label: string
  source: string
  community: number
  role?: string
  fileType?: 'code' | 'document'
}

const NODES: FixtureNode[] = [
  { id: 'generate_command', label: 'runGenerateCommand', source: '/src/infrastructure/generate.ts', community: 0 },
  { id: 'detect_sources', label: 'detectProjectFiles', source: '/src/pipeline/detect.ts', community: 0 },
  { id: 'extract_sources', label: 'extractSourceFiles', source: '/src/pipeline/extract.ts', community: 0 },
  { id: 'generation_bridge', label: 'GenerationPipeline.run', source: '/src/infrastructure/generate.ts', community: 0 },
  { id: 'generation_distractor', label: 'GraphGenerationSummary', source: '/src/pipeline/report.ts', community: 9 },

  { id: 'watch_graph', label: 'GraphArtifact.publish', source: '/src/infrastructure/watch.ts', community: 1 },
  { id: 'watch_edits', label: 'EditObserver.detectChanges', source: '/src/infrastructure/watch.ts', community: 1 },
  { id: 'watch_reconcile', label: 'AutoRefreshCoordinator.reconcile', source: '/src/infrastructure/watch.ts', community: 1, role: 'watcher' },
  { id: 'watch_state', label: 'writeWatcherState', source: '/src/infrastructure/watcher-state.ts', community: 1 },
  { id: 'watch_distractor', label: 'GraphUpdateFormatter', source: '/src/pipeline/report.ts', community: 9 },

  { id: 'evidence_contract', label: 'MadarResponseEvidence', source: '/src/runtime/mcp-response-evidence.ts', community: 2 },
  { id: 'quality_signals', label: 'ContextPackQualitySignals', source: '/src/runtime/context-pack-diagnostics.ts', community: 2 },
  { id: 'confidence_decision', label: 'decideAgentDirective', source: '/src/runtime/mcp-response-evidence.ts', community: 2 },
  { id: 'evidence_bridge', label: 'assessMadarResponseEvidence', source: '/src/runtime/mcp-response-evidence.ts', community: 2 },
  { id: 'evidence_distractor', label: 'EvidenceQualityBadge', source: '/src/pipeline/report.ts', community: 9 },

  { id: 'install_profiles', label: 'INSTALL_PROFILES', source: '/src/infrastructure/install.ts', community: 3 },
  { id: 'mcp_profiles', label: 'MCP_TOOL_PROFILES', source: '/src/infrastructure/install.ts', community: 3 },
  { id: 'install_routing', label: 'buildInstallRoutingGuidance', source: '/src/infrastructure/install-routing-guidance.ts', community: 3 },
  { id: 'stdio_tools', label: 'availableMcpToolsForProfile', source: '/src/runtime/stdio/tools.ts', community: 3 },
  { id: 'profile_distractor', label: 'InstallProfileDocumentation', source: '/src/pipeline/report.ts', community: 9 },

  { id: 'impact_analysis', label: 'analyzeImpact', source: '/src/runtime/impact.ts', community: 4 },
  { id: 'dependency_walk', label: 'walkDependencyGraph', source: '/src/runtime/impact.ts', community: 4 },
  { id: 'direction_traversal', label: 'KnowledgeGraph.predecessors', source: '/src/domain/graph/directed-multigraph.ts', community: 4 },
  { id: 'impact_bridge', label: 'DirectionalImpactTraversal.run', source: '/src/runtime/impact.ts', community: 4 },
  { id: 'impact_distractor', label: 'ImpactDirectionLegend', source: '/src/pipeline/report.ts', community: 9 },
]

const EDGES: Array<[string, string, string]> = [
  ['generation_bridge', 'generate_command', 'coordinates'],
  ['generation_bridge', 'detect_sources', 'coordinates'],
  ['generation_bridge', 'extract_sources', 'coordinates'],
  ['watch_reconcile', 'watch_graph', 'coordinates'],
  ['watch_reconcile', 'watch_edits', 'coordinates'],
  ['watch_reconcile', 'watch_state', 'writes_state'],
  ['evidence_bridge', 'evidence_contract', 'coordinates'],
  ['evidence_bridge', 'quality_signals', 'coordinates'],
  ['evidence_bridge', 'confidence_decision', 'coordinates'],
  ['install_profiles', 'mcp_profiles', 'defines'],
  ['install_profiles', 'install_routing', 'configures'],
  ['install_routing', 'stdio_tools', 'controls'],
  ['impact_bridge', 'impact_analysis', 'coordinates'],
  ['impact_bridge', 'dependency_walk', 'coordinates'],
  ['impact_bridge', 'direction_traversal', 'coordinates'],
]

export function buildMadarSelfRetrievalFixture(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.graph.root_path = '/'
  graph.graph.community_labels = {
    0: 'Graph generation and source extraction',
    1: 'Automatic graph refresh while agents edit',
    2: 'Evidence quality and confidence decisions',
    3: 'Install profiles and MCP tool availability',
    4: 'Impact analysis and dependency direction',
    9: 'Presentation helpers',
  }
  for (const node of NODES) {
    graph.addNode(node.id, {
      label: node.label,
      source_file: node.source,
      source_location: 'L1-L4',
      file_type: node.fileType ?? 'code',
      node_kind: 'function',
      community: node.community,
      snippet: `export function ${node.id}() { return '${node.label}' }`,
      ...(node.role ? { framework_role: node.role } : {}),
    })
  }
  for (const [source, target, relation] of EDGES) {
    graph.addEdge(source, target, { relation })
  }
  return graph
}
