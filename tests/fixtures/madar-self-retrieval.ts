import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

interface FixtureNode {
  id: string
  label: string
  source: string
  community: number
  role?: string
}

const NODES: FixtureNode[] = [
  { id: 'generate_index', label: 'generateIndex', source: '/src/application/generate-index.ts', community: 0 },
  { id: 'source_catalog', label: 'buildSourceCatalog', source: '/src/adapters/filesystem/source-catalog.ts', community: 0 },
  { id: 'index_sources', label: 'buildCanonicalTypeScriptIndex', source: '/src/adapters/typescript/index.ts', community: 0 },
  { id: 'generation_bridge', label: 'buildAndPublishIndex', source: '/src/application/generate-index.ts', community: 0 },
  { id: 'build_state', label: 'attachBuildState', source: '/src/domain/index/build-state.ts', community: 0 },
  { id: 'publish_index', label: 'publishAcceptedIndex', source: '/src/adapters/filesystem/index-store.ts', community: 0 },
  { id: 'generation_distractor', label: 'GraphGenerationSummary', source: '/src/pipeline/report.ts', community: 9 },

  { id: 'watch_index', label: 'watchIndex', source: '/src/infrastructure/watch-index.ts', community: 1 },
  { id: 'watch_controller', label: 'startWatchIndex', source: '/src/infrastructure/watch-index.ts', community: 1, role: 'watcher' },
  { id: 'update_index', label: 'updateIndex', source: '/src/application/update-index.ts', community: 1 },
  { id: 'load_index', label: 'loadAcceptedIndex', source: '/src/adapters/filesystem/index-store.ts', community: 1 },
  { id: 'snapshot_compare', label: 'sourceSnapshotsEqual', source: '/src/domain/index/build-state.ts', community: 1 },
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
  ['generate_index', 'source_catalog', 'calls'],
  ['generate_index', 'index_sources', 'calls'],
  ['generate_index', 'generation_bridge', 'calls'],
  ['generation_bridge', 'build_state', 'calls'],
  ['generation_bridge', 'publish_index', 'calls'],
  ['watch_index', 'watch_controller', 'calls'],
  ['watch_controller', 'update_index', 'calls'],
  ['update_index', 'source_catalog', 'calls'],
  ['update_index', 'load_index', 'calls'],
  ['update_index', 'snapshot_compare', 'calls'],
  ['update_index', 'generation_bridge', 'calls'],
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
    0: 'Graph generation and canonical indexing',
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
      file_type: 'code',
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
