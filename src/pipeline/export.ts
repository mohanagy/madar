import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { validateUrl } from '../shared/security.js'
import { _nodeCommunityMap, type SemanticAnomaly, type WorkspaceBridge, workspaceBridges } from './analyze.js'
import type { Communities } from './cluster.js'
import { bridgePageFilename, buildOverviewBridgeSummaries, type OverviewBridgeSummary } from './export/overview-bridges.js'
import { buildCommunitySummaryData } from './export/community-summary.js'
import { buildOverviewSearchIndex, buildOverviewTopNodes, type OverviewSearchIndexEntry, type OverviewTopNode } from './export/overview-navigation.js'

const COMMUNITY_COLORS = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC']

const SVG_LAYOUT = {
  cellWidth: 360,
  cellHeight: 280,
  padding: 48,
  legendWidth: 240,
  communityBaseRadius: 42,
  communityRadiusIncrement: 8,
  communityRadiusCap: 92,
  nodeBaseRadius: 10,
  nodeRadiusScale: 16,
  nodeLabelOffset: 14,
  legendRowHeight: 24,
} as const

const FILE_TYPE_TAGS: Record<string, string> = {
  code: 'madar/code',
  document: 'madar/document',
  paper: 'madar/paper',
  image: 'madar/image',
}

const INLINE_SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

const HTML_MODE_THRESHOLDS = {
  maxInlineNodes: 1200,
  maxInlineEdges: 2400,
  maxInlineBytes: 2_500_000,
} as const

const COMMUNITY_PAGES_DIRNAME = 'graph-pages'

type HtmlExportMode = 'auto' | 'inline' | 'overview'

interface HtmlExportOptions {
  mode?: HtmlExportMode
  cohesionScores?: Record<number, number>
}

interface HtmlExportResult {
  mode: 'inline' | 'overview'
  communityPageCount: number
  reason: string
}

interface HtmlNodeRecord {
  id: string
  label: string
  title: string
  color: {
    background: string
    border: string
  }
  community: number
  community_name: string
  source_file: string
  source_location: string
  source_url: string
  safe_source_url: string
  document_title: string
  author: string
  contributor: string
  captured_at: string
  question: string
  arxiv_id: string
  file_type: string
  degree: number
  global_degree?: number
  connected_communities?: string[]
  confidence: string
}

interface HtmlEdgeRecord {
  from: string
  to: string
  label: string
  title: string
  confidence: string
  dashes: boolean
}

interface HtmlLegendEntry {
  cid: number
  color: string
  label: string
  count: number
}

interface HtmlStats {
  nodes: number
  edges: number
  communities: number
}

interface HtmlPayload {
  nodes: HtmlNodeRecord[]
  edges: HtmlEdgeRecord[]
  legend: HtmlLegendEntry[]
  stats: HtmlStats
}

interface InteractiveHtmlPageOptions {
  pageTitle?: string
  heading?: string
  lede?: string
  backLinkHref?: string
  backLinkLabel?: string
  degreeLabel?: string
  initialSelectedNodeId?: string | null
}

interface OverviewCommunitySummary {
  id: number
  label: string
  count: number
  cohesion: number | null
  href: string
  pageMode: 'interactive' | 'summary'
  topNodes: OverviewTopNode[]
}

interface BridgeNodeMetadata {
  global_degree: number
  connected_communities: string[]
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function escapeXml(value: string): string {
  return escapeHtml(value)
}

function escapeCypher(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/([\\`*_[\]()!])/g, '\\$1')
}

function sanitizeTag(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^[_/]+|[_/]+$/g, '')
  return sanitized.length > 0 ? sanitized : 'madar/unknown'
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => INLINE_SCRIPT_ESCAPES[character] ?? character)
}

function confidenceScore(attributes: Record<string, unknown>): number {
  if (typeof attributes.confidence_score === 'number') {
    return attributes.confidence_score
  }

  const confidence = String(attributes.confidence ?? 'EXTRACTED')
  if (confidence === 'AMBIGUOUS') {
    return 0.2
  }
  if (confidence === 'INFERRED') {
    return 0.5
  }
  if (confidence === 'EXTRACTED') {
    return 1.0
  }
  return 1.0
}

function exportableEdgeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const {
    _src: _internalSource,
    _tgt: _internalTarget,
    confidence_score: _derivedConfidenceScore,
    weight,
    ...rest
  } = attributes

  return {
    ...rest,
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight !== 1 ? { weight } : {}),
  }
}

function safeName(label: string): string {
  const sanitized = label
    .replace(/[\\/*?:"<>|#^[\]]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return sanitized.length > 0 ? sanitized : 'unnamed'
}

function dominantConfidence(graph: KnowledgeGraph, nodeId: string): string {
  const counts = new Map<string, number>()
  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (source !== nodeId && target !== nodeId) {
      continue
    }
    const confidence = String(attributes.confidence ?? 'EXTRACTED')
    counts.set(confidence, (counts.get(confidence) ?? 0) + 1)
  }

  let winner = 'EXTRACTED'
  let winnerCount = -1
  for (const [confidence, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = confidence
      winnerCount = count
    }
  }

  return winner
}

type ConnectionDirection = 'incoming' | 'outgoing' | 'undirected'

interface NodeConnection {
  neighborId: string
  direction: ConnectionDirection
  attributes: Record<string, unknown>
}

function nodeConnections(graph: KnowledgeGraph, nodeId: string): NodeConnection[] {
  const directionForUndirected = 'undirected' as const
  const connections: NodeConnection[] = []

  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (source === nodeId) {
      connections.push({
        neighborId: target,
        direction: graph.isDirected() ? 'outgoing' : directionForUndirected,
        attributes,
      })
      continue
    }

    if (target === nodeId) {
      connections.push({
        neighborId: source,
        direction: graph.isDirected() ? 'incoming' : directionForUndirected,
        attributes,
      })
    }
  }

  return connections
}

function connectionPrefix(direction: ConnectionDirection): string {
  if (direction === 'incoming') {
    return '← '
  }
  if (direction === 'outgoing') {
    return '→ '
  }
  return ''
}

function communityColor(communityId: number): string {
  return COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? '#4E79A7'
}

function buildHtmlPayload(graph: KnowledgeGraph, communities: Communities, communityLabels: Record<number, string>): HtmlPayload {
  const nodeCommunity = _nodeCommunityMap(communities)
  return {
    nodes: graph.nodeEntries().map(([id, attributes]) => {
      const communityId = nodeCommunity[id] ?? 0
      const color = communityColor(communityId)
      const sourceUrl = String(attributes.source_url ?? '')
      const safeSourceUrl = (() => {
        if (!sourceUrl) {
          return ''
        }

        try {
          return validateUrl(sourceUrl)
        } catch {
          return ''
        }
      })()
      return {
        id,
        label: String(attributes.label ?? id),
        title: escapeHtml(String(attributes.label ?? id)),
        color: { background: color, border: color },
        community: communityId,
        community_name: communityLabels[communityId] ?? `Community ${communityId}`,
        source_file: String(attributes.source_file ?? ''),
        source_location: String(attributes.source_location ?? ''),
        source_url: sourceUrl,
        safe_source_url: safeSourceUrl,
        document_title: String(attributes.title ?? ''),
        author: String(attributes.author ?? attributes.paper_authors ?? ''),
        contributor: String(attributes.contributor ?? ''),
        captured_at: String(attributes.captured_at ?? attributes.date ?? ''),
        question: String(attributes.question ?? ''),
        arxiv_id: String(attributes.arxiv_id ?? ''),
        file_type: String(attributes.file_type ?? ''),
        degree: graph.degree(id),
        confidence: dominantConfidence(graph, id),
      }
    }),
    edges: graph.edgeEntries().map(([source, target, attributes]) => ({
      from: source,
      to: target,
      label: String(attributes.relation ?? ''),
      title: escapeHtml(`${String(attributes.relation ?? '')} [${String(attributes.confidence ?? 'EXTRACTED')}]`),
      confidence: String(attributes.confidence ?? 'EXTRACTED'),
      dashes: String(attributes.confidence ?? 'EXTRACTED') !== 'EXTRACTED',
    })),
    legend: Object.entries(communities)
      .map(([communityId, nodeIds]) => ({
        cid: Number(communityId),
        color: communityColor(Number(communityId)),
        label: communityLabels[Number(communityId)] ?? `Community ${communityId}`,
        count: nodeIds.length,
      }))
      .sort((left, right) => left.cid - right.cid),
    stats: {
      nodes: graph.numberOfNodes(),
      edges: graph.numberOfEdges(),
      communities: Object.keys(communities).length,
    },
  }
}

function buildBridgeMetadata(bridges: readonly WorkspaceBridge[]): Map<string, BridgeNodeMetadata> {
  return new Map(
    bridges.map((bridge) => [
      bridge.id,
      {
        global_degree: bridge.degree,
        connected_communities: bridge.connected_communities.map((community) => community.label),
      },
    ]),
  )
}

function enrichPayloadWithBridgeMetadata(payload: HtmlPayload, bridgeMetadata: ReadonlyMap<string, BridgeNodeMetadata>): HtmlPayload {
  return {
    ...payload,
    nodes: payload.nodes.map((node) => {
      const metadata = bridgeMetadata.get(node.id)
      if (!metadata) {
        return node
      }

      return {
        ...node,
        global_degree: metadata.global_degree,
        connected_communities: [...metadata.connected_communities],
      }
    }),
  }
}

export function toJson(
  graph: KnowledgeGraph,
  communities: Communities,
  outputPath: string,
  communityLabels: Record<number, string> = {},
  semanticAnomalies: SemanticAnomaly[] = [],
  extractorVersion?: number,
): void {
  const nodeCommunity = _nodeCommunityMap(communities)
  const data = {
    schema_version: graph.graph.schema_version === 2 ? 2 : 1,
    directed: graph.isDirected(),
    ...(typeof graph.graph.root_path === 'string' && graph.graph.root_path.length > 0 ? { root_path: graph.graph.root_path } : {}),
    ...(typeof extractorVersion === 'number' ? { extractor_version: extractorVersion } : {}),
    nodes: graph.nodeEntries().map(([id, attributes]) => ({
      id,
      ...attributes,
      community: nodeCommunity[id] ?? -1,
    })),
    links: graph.edgeEntries().map(([source, target, attributes]) => ({
      source,
      target,
      ...exportableEdgeAttributes(attributes),
    })),
    hyperedges: Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : [],
    community_labels: communityLabels,
    semantic_anomalies: semanticAnomalies,
  }

  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function subgraphFromNodes(graph: KnowledgeGraph, nodeIds: string[]): KnowledgeGraph {
  const selectedNodeIds = new Set(nodeIds)
  const subgraph = new KnowledgeGraph({ directed: graph.isDirected() })

  for (const nodeId of nodeIds) {
    if (!graph.hasNode(nodeId)) {
      continue
    }
    subgraph.addNode(nodeId, graph.nodeAttributes(nodeId))
  }

  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (selectedNodeIds.has(source) && selectedNodeIds.has(target)) {
      subgraph.addEdge(source, target, attributes)
    }
  }

  const hyperedges = (Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : []).filter((hyperedge) => {
    return Array.isArray((hyperedge as { nodes?: unknown[] }).nodes)
      ? (hyperedge as { nodes: unknown[] }).nodes.every((nodeId) => typeof nodeId === 'string' && selectedNodeIds.has(nodeId))
      : false
  })
  if (hyperedges.length > 0) {
    subgraph.graph.hyperedges = hyperedges
  }

  return subgraph
}

function filterCommunitiesForNodes(communities: Communities, nodeIds: ReadonlySet<string>): Communities {
  return Object.fromEntries(
    Object.entries(communities)
      .map(([communityId, members]) => [communityId, members.filter((nodeId) => nodeIds.has(nodeId))] as const)
      .filter(([, members]) => members.length > 0),
  )
}

function bridgeNeighborhoodNodeIds(graph: KnowledgeGraph, nodeId: string): string[] {
  if (!graph.hasNode(nodeId)) {
    return []
  }

  return [nodeId, ...graph.incidentNeighbors(nodeId)].filter((candidate, index, items) => items.indexOf(candidate) === index)
}

function resolveHtmlExportMode(payload: HtmlPayload, requestedMode: HtmlExportOptions['mode'] = 'auto'): HtmlExportResult {
  if (requestedMode === 'inline') {
    return { mode: 'inline', communityPageCount: 0, reason: 'forced inline mode' }
  }

  if (requestedMode === 'overview') {
    return { mode: 'overview', communityPageCount: payload.legend.length, reason: 'forced overview mode' }
  }

  const serializedBytes =
    Buffer.byteLength(JSON.stringify(payload.nodes), 'utf8') +
    Buffer.byteLength(JSON.stringify(payload.edges), 'utf8') +
    Buffer.byteLength(JSON.stringify(payload.legend), 'utf8')
  const shouldUseOverview =
    payload.nodes.length > HTML_MODE_THRESHOLDS.maxInlineNodes ||
    payload.edges.length > HTML_MODE_THRESHOLDS.maxInlineEdges ||
    serializedBytes > HTML_MODE_THRESHOLDS.maxInlineBytes

  return shouldUseOverview
    ? { mode: 'overview', communityPageCount: payload.legend.length, reason: 'graph exceeded inline HTML thresholds' }
    : { mode: 'inline', communityPageCount: 0, reason: 'graph fits inline HTML thresholds' }
}

function buildInteractiveHtml(payload: HtmlPayload, isDirected: boolean, options: InteractiveHtmlPageOptions = {}): string {
  const backLinkMarkup =
    typeof options.backLinkHref === 'string' && options.backLinkHref.length > 0
      ? `<p class="muted" style="margin-bottom:10px;"><a class="back-link" href="${escapeHtml(options.backLinkHref)}">${escapeHtml(options.backLinkLabel ?? '← Back')}</a></p>`
      : ''
  const degreeLabel = options.degreeLabel ?? 'Degree'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(options.pageTitle ?? 'madar')}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  :root {
    color-scheme: light;
    --panel-border: #d7dce5;
    --panel-bg: #fbfcfe;
    --text-muted: #5b6473;
    --accent: #2553d8;
  }

  * { box-sizing: border-box; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0;
    display: flex;
    height: 100vh;
    color: #111827;
    background: #eef2f7;
  }

  #graph {
    flex: 1;
    min-width: 0;
    background: linear-gradient(180deg, #f8fbff 0%, #eef2f7 100%);
  }

  #sidebar {
    width: 360px;
    border-left: 1px solid var(--panel-border);
    padding: 16px;
    overflow: auto;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(8px);
  }

  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.15rem; }
  h2 { font-size: 0.96rem; margin-bottom: 10px; }
  .lede { color: var(--text-muted); font-size: 0.9rem; line-height: 1.5; margin-top: 8px; }
  .panel {
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    background: var(--panel-bg);
    padding: 14px;
    margin-bottom: 14px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }

  .stat {
    border-radius: 10px;
    padding: 10px;
    background: white;
    border: 1px solid #e6ebf2;
  }

  .stat strong {
    display: block;
    font-size: 1rem;
    margin-top: 3px;
  }

  .muted { color: var(--text-muted); font-size: 0.85rem; }
  .back-link { color: var(--accent); text-decoration: none; }

  #search {
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    border: 1px solid #cdd6e3;
    background: white;
  }

  .toolbar {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  button {
    appearance: none;
    border: 1px solid #cbd5e1;
    background: white;
    color: #111827;
    border-radius: 10px;
    padding: 8px 10px;
    cursor: pointer;
    font: inherit;
  }

  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  button.small {
    font-size: 0.82rem;
    padding: 6px 8px;
  }

  .list, #legend, #matches {
    display: grid;
    gap: 8px;
  }

  .legend-button,
  .match-button,
  .neighbor-button {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }

  .legend-chip {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex: 0 0 auto;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr;
    gap: 8px 12px;
    font-size: 0.9rem;
  }

  .meta-grid dt { color: var(--text-muted); }
  .meta-grid dd { margin: 0; word-break: break-word; }
  .meta-grid a { color: var(--accent); word-break: break-all; }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .neighbor-meta,
  .match-meta {
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  code {
    background: #eef2ff;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
  }
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <section class="panel">
    ${backLinkMarkup}
    <h1>${escapeHtml(options.heading ?? 'madar')}</h1>
    <p class="lede">${escapeHtml(options.lede ?? 'Explore the generated graph, inspect node evidence, and hop through neighbors without leaving the HTML export.')}</p>
    <div class="stats" id="stats"></div>
  </section>

  <section class="panel">
    <h2>Search</h2>
    <input id="search" placeholder="Search nodes by label or file..." />
    <div id="matches" class="list"></div>
    <div class="toolbar">
      <button id="resetView" class="small">Reset view</button>
      <button id="clearSelection" class="small">Clear selection</button>
    </div>
  </section>

  <section class="panel">
    <h2>Selected node</h2>
    <p id="selectionEmpty" class="empty">Click a node in the graph, choose a search match, or follow a neighbor to inspect it here.</p>
    <div id="selectionDetails" hidden>
      <h3 id="selectedLabel"></h3>
      <p id="selectedSummary" class="lede"></p>
      <dl class="meta-grid">
        <dt>Source</dt><dd id="selectedSource"></dd>
        <dt id="selectedDocumentTitleLabel" hidden>Title</dt><dd id="selectedDocumentTitle" hidden></dd>
        <dt id="selectedSourceUrlLabel" hidden>Source URL</dt><dd id="selectedSourceUrl" hidden></dd>
        <dt id="selectedAuthorLabel" hidden>Author</dt><dd id="selectedAuthor" hidden></dd>
        <dt id="selectedContributorLabel" hidden>Contributor</dt><dd id="selectedContributor" hidden></dd>
        <dt id="selectedCapturedAtLabel" hidden>Captured</dt><dd id="selectedCapturedAt" hidden></dd>
        <dt id="selectedQuestionLabel" hidden>Question</dt><dd id="selectedQuestion" hidden></dd>
        <dt id="selectedArxivIdLabel" hidden>arXiv</dt><dd id="selectedArxivId" hidden></dd>
        <dt>Type</dt><dd id="selectedType"></dd>
        <dt>Community</dt><dd id="selectedCommunity"></dd>
        <dt>Confidence</dt><dd id="selectedConfidence"></dd>
        <dt>${escapeHtml(degreeLabel)}</dt><dd id="selectedDegree"></dd>
        <dt id="selectedGlobalDegreeLabel" hidden>Global degree</dt><dd id="selectedGlobalDegree" hidden></dd>
        <dt id="selectedConnectedCommunitiesLabel" hidden>Connected communities</dt><dd id="selectedConnectedCommunities" hidden></dd>
      </dl>
      <div class="toolbar">
        <button id="focusNeighborhood" class="primary small">Focus neighborhood</button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Neighbors</h2>
    <p id="neighborsEmpty" class="empty">Neighbor navigation appears here once a node is selected.</p>
    <div id="neighborList" class="list"></div>
  </section>

  <section class="panel">
    <h2>Communities</h2>
    <div id="legend"></div>
  </section>
</div>
<script>
const RAW_NODES = ${serializeForInlineScript(payload.nodes)};
const RAW_EDGES = ${serializeForInlineScript(payload.edges)};
const LEGEND = ${serializeForInlineScript(payload.legend)};
const STATS = ${serializeForInlineScript(payload.stats)};
const IS_DIRECTED = ${serializeForInlineScript(isDirected)};
const EDGE_ARROWS = ${serializeForInlineScript(isDirected ? { to: { enabled: true, scaleFactor: 0.45 } } : {})};
const PRIMARY_DEGREE_LABEL = ${serializeForInlineScript(degreeLabel)};
const INITIAL_SELECTED_NODE_ID = ${serializeForInlineScript(options.initialSelectedNodeId ?? null)};

const nodes = new vis.DataSet(RAW_NODES);
const edges = new vis.DataSet(RAW_EDGES.map((edge) => ({ ...edge, arrows: EDGE_ARROWS, dashes: edge.dashes })));
const nodeIndex = new Map(RAW_NODES.map((node) => [node.id, node]));
const nodesByCommunity = new Map();
RAW_NODES.forEach((node) => {
  const group = nodesByCommunity.get(node.community) || [];
  group.push(node.id);
  nodesByCommunity.set(node.community, group);
});

const edgesByNode = new Map();
RAW_EDGES.forEach((edge) => {
  const outgoing = edgesByNode.get(edge.from) || [];
  outgoing.push(edge);
  edgesByNode.set(edge.from, outgoing);

  const incoming = edgesByNode.get(edge.to) || [];
  incoming.push(edge);
  edgesByNode.set(edge.to, incoming);
});

let selectedNodeId = null;

const elements = {
  stats: document.getElementById('stats'),
  search: document.getElementById('search'),
  matches: document.getElementById('matches'),
  selectionEmpty: document.getElementById('selectionEmpty'),
  selectionDetails: document.getElementById('selectionDetails'),
  selectedLabel: document.getElementById('selectedLabel'),
  selectedSummary: document.getElementById('selectedSummary'),
  selectedSource: document.getElementById('selectedSource'),
  selectedDocumentTitleLabel: document.getElementById('selectedDocumentTitleLabel'),
  selectedDocumentTitle: document.getElementById('selectedDocumentTitle'),
  selectedSourceUrlLabel: document.getElementById('selectedSourceUrlLabel'),
  selectedSourceUrl: document.getElementById('selectedSourceUrl'),
  selectedAuthorLabel: document.getElementById('selectedAuthorLabel'),
  selectedAuthor: document.getElementById('selectedAuthor'),
  selectedContributorLabel: document.getElementById('selectedContributorLabel'),
  selectedContributor: document.getElementById('selectedContributor'),
  selectedCapturedAtLabel: document.getElementById('selectedCapturedAtLabel'),
  selectedCapturedAt: document.getElementById('selectedCapturedAt'),
  selectedQuestionLabel: document.getElementById('selectedQuestionLabel'),
  selectedQuestion: document.getElementById('selectedQuestion'),
  selectedArxivIdLabel: document.getElementById('selectedArxivIdLabel'),
  selectedArxivId: document.getElementById('selectedArxivId'),
  selectedType: document.getElementById('selectedType'),
  selectedCommunity: document.getElementById('selectedCommunity'),
  selectedConfidence: document.getElementById('selectedConfidence'),
  selectedDegree: document.getElementById('selectedDegree'),
  selectedGlobalDegreeLabel: document.getElementById('selectedGlobalDegreeLabel'),
  selectedGlobalDegree: document.getElementById('selectedGlobalDegree'),
  selectedConnectedCommunitiesLabel: document.getElementById('selectedConnectedCommunitiesLabel'),
  selectedConnectedCommunities: document.getElementById('selectedConnectedCommunities'),
  neighborList: document.getElementById('neighborList'),
  neighborsEmpty: document.getElementById('neighborsEmpty'),
  legend: document.getElementById('legend'),
  resetView: document.getElementById('resetView'),
  clearSelection: document.getElementById('clearSelection'),
  focusNeighborhood: document.getElementById('focusNeighborhood'),
};

const network = new vis.Network(
  document.getElementById('graph'),
  { nodes, edges },
  {
    autoResize: true,
    interaction: { hover: true, navigationButtons: true, keyboard: true },
    physics: { stabilization: { iterations: 300 }, barnesHut: { gravitationalConstant: -4200, springLength: 120 } },
    nodes: {
      borderWidth: 1.25,
      shape: 'dot',
      font: { size: 14, face: 'Inter, ui-sans-serif, system-ui, sans-serif' },
      scaling: { min: 12, max: 34 },
    },
    edges: {
      arrows: EDGE_ARROWS,
      font: { align: 'middle', size: 10 },
      color: { inherit: false, color: '#94a3b8', highlight: '#334155' },
      smooth: { type: 'dynamic' },
    },
  },
);
network.once('stabilizationIterationsDone', function() { network.setOptions({ physics: false }); });

function createMeta(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function setOptionalMeta(labelElement, valueElement, value, options = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  const hasValue = text.length > 0;
  labelElement.hidden = !hasValue;
  valueElement.hidden = !hasValue;
  valueElement.replaceChildren();

  if (!hasValue) {
    return;
  }

  if (options.link === true) {
    const link = document.createElement('a');
    link.href = text;
    link.textContent = text;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    valueElement.appendChild(link);
    return;
  }

  valueElement.textContent = text;
}

function getNeighborEntries(nodeId) {
  const relatedEdges = edgesByNode.get(nodeId) || [];
  const deduped = new Map();
  relatedEdges.forEach((edge) => {
    const isOutgoing = edge.from === nodeId;
    const otherId = isOutgoing ? edge.to : edge.from;
    if (!nodeIndex.has(otherId)) {
      return;
    }

    const key = otherId + '::' + edge.label + '::' + edge.confidence;
    if (deduped.has(key)) {
      return;
    }

    const other = nodeIndex.get(otherId);
    deduped.set(key, {
      id: otherId,
      label: other.label,
      relation: edge.label || 'related_to',
      confidence: edge.confidence || 'EXTRACTED',
      direction: IS_DIRECTED ? (isOutgoing ? 'outgoing' : 'incoming') : 'connected',
      community: other.community_name,
      degree: other.degree,
    });
  });

  return [...deduped.values()].sort((left, right) => {
    return right.degree - left.degree || left.label.localeCompare(right.label);
  });
}

function renderStats() {
  const items = [
    { label: 'Nodes', value: STATS.nodes },
    { label: 'Edges', value: STATS.edges },
    { label: 'Communities', value: STATS.communities },
  ];

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'stat';
    card.appendChild(createMeta(item.label, 'muted'));
    const value = document.createElement('strong');
    value.textContent = String(item.value);
    card.appendChild(value);
    elements.stats.appendChild(card);
  });
}

function renderSearchMatches(query) {
  elements.matches.replaceChildren();
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    elements.matches.appendChild(createMeta('Type to surface the best matching nodes.', 'empty'));
    return [];
  }

  const matches = RAW_NODES.filter((node) => {
    return node.label.toLowerCase().includes(trimmed) || node.source_file.toLowerCase().includes(trimmed);
  })
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))
    .slice(0, 8);

  if (matches.length === 0) {
    elements.matches.appendChild(createMeta('No matches yet. Try a file name, class, function, or concept.', 'empty'));
    return [];
  }

  matches.forEach((node) => {
    const button = document.createElement('button');
    button.className = 'match-button small';
    const left = document.createElement('span');
    left.textContent = node.label;
    const right = createMeta(node.community_name + ' · ' + PRIMARY_DEGREE_LABEL.toLowerCase() + ' ' + node.degree, 'match-meta');
    button.append(left, right);
    button.addEventListener('click', () => selectNodeById(node.id, { focus: true }));
    elements.matches.appendChild(button);
  });

  return matches;
}

function renderNeighbors(nodeId) {
  elements.neighborList.replaceChildren();
  if (!nodeId) {
    elements.neighborsEmpty.hidden = false;
    return;
  }

  const neighbors = getNeighborEntries(nodeId);
  if (neighbors.length === 0) {
    elements.neighborsEmpty.hidden = false;
    elements.neighborsEmpty.textContent = 'This node currently has no rendered neighbors in the exported graph.';
    return;
  }

  elements.neighborsEmpty.hidden = true;
  neighbors.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'neighbor-button small';
    const left = document.createElement('span');
    left.textContent = entry.label;
    const right = createMeta(entry.direction + ' · ' + entry.relation + ' [' + entry.confidence + ']', 'neighbor-meta');
    button.append(left, right);
    button.addEventListener('click', () => selectNodeById(entry.id, { focus: true }));
    elements.neighborList.appendChild(button);
  });
}

function updateHash(nodeId) {
  if (!nodeId) {
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  history.replaceState(null, '', '#' + encodeURIComponent(nodeId));
}

function renderSelection(nodeId) {
  if (!nodeId || !nodeIndex.has(nodeId)) {
    selectedNodeId = null;
    elements.selectionEmpty.hidden = false;
    elements.selectionDetails.hidden = true;
    elements.selectedLabel.textContent = '';
    elements.selectedSummary.textContent = '';
    elements.selectedSource.textContent = '';
    setOptionalMeta(elements.selectedDocumentTitleLabel, elements.selectedDocumentTitle, '');
    setOptionalMeta(elements.selectedSourceUrlLabel, elements.selectedSourceUrl, '');
    setOptionalMeta(elements.selectedAuthorLabel, elements.selectedAuthor, '');
    setOptionalMeta(elements.selectedContributorLabel, elements.selectedContributor, '');
    setOptionalMeta(elements.selectedCapturedAtLabel, elements.selectedCapturedAt, '');
    setOptionalMeta(elements.selectedQuestionLabel, elements.selectedQuestion, '');
    setOptionalMeta(elements.selectedArxivIdLabel, elements.selectedArxivId, '');
    elements.selectedType.textContent = '';
    elements.selectedCommunity.textContent = '';
    elements.selectedConfidence.textContent = '';
    elements.selectedDegree.textContent = '';
    renderNeighbors(null);
    return;
  }

  const node = nodeIndex.get(nodeId);
  selectedNodeId = nodeId;
  elements.selectionEmpty.hidden = true;
  elements.selectionDetails.hidden = false;
  elements.selectedLabel.textContent = node.label;
  elements.selectedSummary.textContent = node.document_title || node.question || 'Inspect evidence, jump to neighbors, or focus this local neighborhood.';
  elements.selectedSource.textContent = [node.source_file, node.source_location].filter(Boolean).join(': ') || 'Unknown source';
  setOptionalMeta(elements.selectedDocumentTitleLabel, elements.selectedDocumentTitle, node.document_title || '');
  setOptionalMeta(elements.selectedSourceUrlLabel, elements.selectedSourceUrl, node.safe_source_url || '', { link: Boolean(node.safe_source_url) });
  setOptionalMeta(elements.selectedAuthorLabel, elements.selectedAuthor, node.author || '');
  setOptionalMeta(elements.selectedContributorLabel, elements.selectedContributor, node.contributor || '');
  setOptionalMeta(elements.selectedCapturedAtLabel, elements.selectedCapturedAt, node.captured_at || '');
  setOptionalMeta(elements.selectedQuestionLabel, elements.selectedQuestion, node.question || '');
  setOptionalMeta(elements.selectedArxivIdLabel, elements.selectedArxivId, node.arxiv_id || '');
  elements.selectedType.textContent = node.file_type || 'unknown';
  elements.selectedCommunity.textContent = node.community_name;
  elements.selectedConfidence.textContent = node.confidence;
  elements.selectedDegree.textContent = String(node.degree);
  setOptionalMeta(
    elements.selectedGlobalDegreeLabel,
    elements.selectedGlobalDegree,
    typeof node.global_degree === 'number' ? String(node.global_degree) : '',
  );
  setOptionalMeta(
    elements.selectedConnectedCommunitiesLabel,
    elements.selectedConnectedCommunities,
    Array.isArray(node.connected_communities) && node.connected_communities.length > 0 ? node.connected_communities.join(', ') : '',
  );
  renderNeighbors(nodeId);
}

function selectNodeById(nodeId, options = { focus: true }) {
  if (!nodeIndex.has(nodeId)) {
    return;
  }

  network.selectNodes([nodeId]);
  renderSelection(nodeId);
  updateHash(nodeId);
  if (options.focus !== false) {
    network.focus(nodeId, { scale: 1.15, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  }
}

function focusNeighborhood() {
  if (!selectedNodeId) {
    return;
  }

  const nodeIds = [selectedNodeId, ...getNeighborEntries(selectedNodeId).map((entry) => entry.id)];
  network.selectNodes(nodeIds);
  network.fit({ nodes: nodeIds, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
}

function focusCommunity(communityId) {
  const nodeIds = nodesByCommunity.get(communityId) || [];
  if (nodeIds.length === 0) {
    return;
  }

  network.selectNodes(nodeIds);
  network.fit({ nodes: nodeIds, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
}

function clearSelection() {
  network.unselectAll();
  renderSelection(null);
  updateHash(null);
}

function renderLegend() {
  LEGEND.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  LEGEND.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'legend-button small';
    const left = document.createElement('span');
    const chip = document.createElement('span');
    chip.className = 'legend-chip';
    chip.style.background = entry.color;
    const label = document.createElement('span');
    label.textContent = entry.label;
    left.append(chip, document.createTextNode(' '), label);
    const right = createMeta(String(entry.count), 'neighbor-meta');
    button.append(left, right);
    button.addEventListener('click', () => focusCommunity(entry.cid));
    elements.legend.appendChild(button);
  });
}

renderStats();
renderLegend();
renderSearchMatches('');
renderSelection(null);

elements.search.addEventListener('input', (event) => {
  renderSearchMatches(event.target.value || '');
});

elements.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  const matches = renderSearchMatches(elements.search.value || '');
  if (matches.length > 0) {
    selectNodeById(matches[0].id, { focus: true });
  }
});

elements.resetView.addEventListener('click', () => {
  network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
});
elements.clearSelection.addEventListener('click', clearSelection);
elements.focusNeighborhood.addEventListener('click', focusNeighborhood);

network.on('selectNode', (event) => {
  const nodeId = event.nodes && event.nodes[0];
  if (nodeId) {
    selectNodeById(nodeId, { focus: false });
  }
});

network.on('deselectNode', () => {
  renderSelection(null);
  updateHash(null);
});

window.addEventListener('hashchange', () => {
  const hashId = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (hashId && nodeIndex.has(hashId)) {
    selectNodeById(hashId, { focus: true });
  }
});

const initialHash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
if (initialHash && nodeIndex.has(initialHash)) {
  selectNodeById(initialHash, { focus: true });
} else if (INITIAL_SELECTED_NODE_ID && nodeIndex.has(INITIAL_SELECTED_NODE_ID)) {
  selectNodeById(INITIAL_SELECTED_NODE_ID, { focus: false });
} else {
  network.fit({ animation: false });
}
</script>
</body>
</html>`
}

function buildCommunitySummaryHtml(payload: HtmlPayload, options: InteractiveHtmlPageOptions = {}): string {
  const backLinkMarkup =
    typeof options.backLinkHref === 'string' && options.backLinkHref.length > 0
      ? `<p class="muted" style="margin-bottom:10px;"><a class="back-link" href="${escapeHtml(options.backLinkHref)}">${escapeHtml(options.backLinkLabel ?? '← Back')}</a></p>`
      : ''
  const degreeLabel = options.degreeLabel ?? 'Degree'

  const { summaryNodes, topNodes, topFiles } = buildCommunitySummaryData(payload.nodes)

  const graphDataJson = serializeForInlineScript({
    nodes: payload.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      file_type: n.file_type,
      degree: n.degree,
      community: n.community,
      community_name: n.community_name,
    })),
    edges: payload.edges,
  })

  const topNodesMarkup =
    topNodes.length === 0
      ? '<p class="empty">No node summary is available for this community.</p>'
      : `<div class="list">${topNodes
          .map(
            (node) => `<a class="list-link" href="#${escapeHtml(node.anchor_id)}">
  <strong>${escapeHtml(node.label)}</strong>
  <span class="muted">${escapeHtml(degreeLabel.toLowerCase())} ${node.degree} · ${escapeHtml(node.source_file || 'Unknown source')}</span>
</a>`,
          )
          .join('\n')}</div>`

  const topFilesMarkup =
    topFiles.length === 0
      ? '<p class="empty">No file summary is available for this community.</p>'
      : `<div class="list">${topFiles
          .map(
            ([sourceFile, count]) => `<div class="list-link static">
  <strong>${escapeHtml(sourceFile)}</strong>
  <span class="muted">${count} node${count === 1 ? '' : 's'}</span>
</div>`,
          )
          .join('\n')}</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(options.pageTitle ?? 'madar')}</title>
<style>
  :root {
    color-scheme: light;
    --panel-border: #d7dce5;
    --panel-bg: #fbfcfe;
    --text-muted: #5b6473;
    --accent: #2553d8;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111827;
    background: #eef2f7;
  }

  main {
    max-width: 1180px;
    margin: 0 auto;
    padding: 24px;
  }

  .panel {
    border: 1px solid var(--panel-border);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.94);
    padding: 18px;
    margin-bottom: 16px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
  }

  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.45rem; }
  h2 { font-size: 1rem; margin-bottom: 12px; }
  .lede { color: var(--text-muted); line-height: 1.55; margin-top: 8px; }
  .muted { color: var(--text-muted); font-size: 0.88rem; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    padding: 6px 10px;
    border-radius: 999px;
    background: #fff4db;
    color: #9a6700;
    font-size: 0.82rem;
    font-weight: 600;
  }
  .back-link { color: var(--accent); text-decoration: none; }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
  }
  .stat {
    border-radius: 12px;
    padding: 12px;
    background: white;
    border: 1px solid #e6ebf2;
  }
  .stat strong { display: block; margin-top: 4px; font-size: 1.1rem; }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
    gap: 16px;
    align-items: start;
  }
  #search {
    width: 100%;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 12px;
    border: 1px solid #cdd6e3;
    background: white;
  }
  .list {
    display: grid;
    gap: 10px;
  }
  .list-link {
    display: block;
    border: 1px solid #d7dce5;
    border-radius: 12px;
    padding: 12px 14px;
    background: white;
    color: inherit;
    text-decoration: none;
  }
  .list-link.static {
    cursor: default;
  }
  .list-link:hover {
    border-color: var(--accent);
  }
  #matches {
    display: grid;
    gap: 12px;
  }
  .match-link {
    display: block;
    border: 1px solid #d7dce5;
    border-radius: 14px;
    padding: 14px;
    background: white;
    color: inherit;
    text-decoration: none;
  }
  .match-link:hover {
    border-color: var(--accent);
  }
  .match-meta {
    color: var(--text-muted);
    font-size: 0.82rem;
    margin-top: 4px;
  }
  .selection-panel {
    display: grid;
    gap: 8px;
  }
  .meta-row {
    display: grid;
    grid-template-columns: minmax(92px, auto) 1fr;
    gap: 12px;
    align-items: start;
    font-size: 0.9rem;
  }
  .meta-row span:first-child {
    color: var(--text-muted);
  }
  .meta-row a {
    color: var(--accent);
    word-break: break-all;
  }
  code {
    background: #eef2ff;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
    word-break: break-word;
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.92rem;
    line-height: 1.5;
  }
</style>
</head>
<body>
<main>
  <section class="panel">
    ${backLinkMarkup}
    <div class="badge">Summary-only community mode</div>
    <h1>${escapeHtml(options.heading ?? 'madar')}</h1>
    <p class="lede">${escapeHtml(options.lede ?? 'This community is too large to render as one interactive graph without freezing the browser. Use the summaries and searchable node list below instead.')}</p>
    <div class="stats" id="stats">
      <div class="stat"><div class="muted">Nodes</div><strong>${payload.stats.nodes}</strong></div>
      <div class="stat"><div class="muted">Edges</div><strong>${payload.stats.edges}</strong></div>
      <div class="stat"><div class="muted">Communities</div><strong>${payload.stats.communities}</strong></div>
    </div>
    <button id="loadGraphBtn" onclick="loadInteractiveGraph()" style="
      margin-top:16px; padding:10px 18px; border-radius:10px;
      border:none; background:#2553d8; color:white;
      font-size:0.9rem; font-weight:600; cursor:pointer;">
      ⚡ Load interactive graph
    </button>
    <div id="visContainer" style="display:none;height:80vh;min-height:600px;border-radius:14px;overflow:hidden;margin-top:16px;"></div>
    <script id="graphData" type="application/json">${graphDataJson}</script>
  </section>

  <div class="split">
    <section class="panel">
      <h2>Search nodes by label or file</h2>
      <input id="search" placeholder="Filter this community by label or source file..." />
      <div id="matches" class="list"></div>
    </section>

    <section class="panel">
      <h2>Selected node</h2>
      <p id="selectionEmpty" class="empty">Pick a top node or search result to inspect it here without loading every node into the DOM.</p>
      <div id="selectionDetails" class="selection-panel" hidden>
        <h3 id="selectedLabel"></h3>
        <div class="meta-row"><span>Source</span><code id="selectedSource"></code></div>
        <div class="meta-row"><span>Type</span><span id="selectedType"></span></div>
        <div class="meta-row"><span>Confidence</span><span id="selectedConfidence"></span></div>
        <div class="meta-row"><span>${escapeHtml(degreeLabel)}</span><span id="selectedDegree"></span></div>
        <div id="selectedGlobalDegreeRow" class="meta-row" hidden><span>Global degree</span><span id="selectedGlobalDegree"></span></div>
        <div id="selectedConnectedCommunitiesRow" class="meta-row" hidden><span>Connected communities</span><span id="selectedConnectedCommunities"></span></div>
        <div id="selectedSourceUrlRow" class="meta-row" hidden><span>Source URL</span><a id="selectedSourceUrl" target="_blank" rel="noreferrer noopener"></a></div>
        <h4 style="margin-top:12px;">Related nodes</h4>
        <div id="selectedNeighbors" class="list"></div>
      </div>
    </section>

    <div>
      <section class="panel">
        <h2>Top connected nodes</h2>
        ${topNodesMarkup}
      </section>
      <section class="panel">
        <h2>Most represented files</h2>
        ${topFilesMarkup}
      </section>
    </div>
  </div>
</main>
<script>
const SUMMARY_NODES = ${serializeForInlineScript(summaryNodes)};
const SEARCH_RESULT_LIMIT = 50;
const PRIMARY_DEGREE_LABEL = ${serializeForInlineScript(degreeLabel)};
const searchInput = document.getElementById('search');
const matches = document.getElementById('matches');
const selectionEmpty = document.getElementById('selectionEmpty');
const selectionDetails = document.getElementById('selectionDetails');
const selectedLabel = document.getElementById('selectedLabel');
const selectedSource = document.getElementById('selectedSource');
const selectedType = document.getElementById('selectedType');
const selectedConfidence = document.getElementById('selectedConfidence');
const selectedDegree = document.getElementById('selectedDegree');
const selectedGlobalDegreeRow = document.getElementById('selectedGlobalDegreeRow');
const selectedGlobalDegree = document.getElementById('selectedGlobalDegree');
const selectedConnectedCommunitiesRow = document.getElementById('selectedConnectedCommunitiesRow');
const selectedConnectedCommunities = document.getElementById('selectedConnectedCommunities');
const selectedSourceUrlRow = document.getElementById('selectedSourceUrlRow');
const selectedSourceUrl = document.getElementById('selectedSourceUrl');
const nodesByAnchor = new Map(SUMMARY_NODES.map((node) => [node.anchor_id, node]));
const nodesById = new Map(SUMMARY_NODES.map((node) => [node.id, node]));
const selectedNeighbors = document.getElementById('selectedNeighbors');

function findNeighbors(nodeId) {
  try {
    var raw = document.getElementById('graphData');
    if (!raw) return [];
    var data = JSON.parse(raw.textContent || '{}');
    if (!data.edges) return [];
    var neighbors = [];
    var seen = {};
    data.edges.forEach(function(e) {
      var neighborId = null;
      var relation = e.label || 'related';
      if (e.from === nodeId) neighborId = e.to;
      else if (e.to === nodeId) neighborId = e.from;
      if (neighborId && !seen[neighborId]) {
        seen[neighborId] = true;
        var n = nodesById.get(neighborId);
        neighbors.push({ id: neighborId, label: n ? n.label : neighborId, relation: relation });
      }
    });
    return neighbors.slice(0, 10);
  } catch(ex) { return []; }
}

function renderSelection(anchorId) {
  const node = nodesByAnchor.get(anchorId);
  if (!node) {
    selectionEmpty.hidden = false;
    selectionDetails.hidden = true;
    selectedLabel.textContent = '';
    selectedSource.textContent = '';
    selectedType.textContent = '';
    selectedConfidence.textContent = '';
    selectedDegree.textContent = '';
    selectedGlobalDegreeRow.hidden = true;
    selectedGlobalDegree.textContent = '';
    selectedConnectedCommunitiesRow.hidden = true;
    selectedConnectedCommunities.textContent = '';
    selectedSourceUrlRow.hidden = true;
    selectedSourceUrl.textContent = '';
    selectedSourceUrl.removeAttribute('href');
    return;
  }

  selectionEmpty.hidden = true;
  selectionDetails.hidden = false;
  selectedLabel.textContent = node.label;
  selectedSource.textContent = [node.source_file, node.source_location].filter(Boolean).join(': ') || 'Unknown source';
  selectedType.textContent = node.file_type || 'unknown';
  selectedConfidence.textContent = node.confidence;
  selectedDegree.textContent = String(node.degree);
  if (typeof node.global_degree === 'number') {
    selectedGlobalDegreeRow.hidden = false;
    selectedGlobalDegree.textContent = String(node.global_degree);
  } else {
    selectedGlobalDegreeRow.hidden = true;
    selectedGlobalDegree.textContent = '';
  }
  if (Array.isArray(node.connected_communities) && node.connected_communities.length > 0) {
    selectedConnectedCommunitiesRow.hidden = false;
    selectedConnectedCommunities.textContent = node.connected_communities.join(', ');
  } else {
    selectedConnectedCommunitiesRow.hidden = true;
    selectedConnectedCommunities.textContent = '';
  }

  if (typeof node.safe_source_url === 'string' && node.safe_source_url.length > 0) {
    selectedSourceUrlRow.hidden = false;
    selectedSourceUrl.href = node.safe_source_url;
    selectedSourceUrl.textContent = node.safe_source_url;
  } else {
    selectedSourceUrlRow.hidden = true;
    selectedSourceUrl.textContent = '';
    selectedSourceUrl.removeAttribute('href');
  }

  selectedNeighbors.replaceChildren();
  var neighbors = findNeighbors(node.id);
  if (neighbors.length === 0) {
    var hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'No related nodes found.';
    selectedNeighbors.appendChild(hint);
  } else {
    neighbors.forEach(function(nb) {
      var nbNode = nodesById.get(nb.id);
      var link = document.createElement('a');
      link.className = 'match-link';
      link.href = nbNode ? '#' + nbNode.anchor_id : '#';
      var title = document.createElement('strong');
      title.textContent = nb.label;
      var meta = document.createElement('div');
      meta.className = 'match-meta';
      meta.textContent = nb.relation;
      link.append(title, meta);
      selectedNeighbors.appendChild(link);
    });
  }
}

function renderMatches(query) {
  matches.replaceChildren();
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'Type to search this community without rendering every node up front.';
    matches.appendChild(hint);
    return;
  }

  const filtered = SUMMARY_NODES.filter((node) => node.search_text.includes(trimmed)).slice(0, SEARCH_RESULT_LIMIT);
  if (filtered.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'No matches yet. Try a file name, symbol, or concept.';
    matches.appendChild(hint);
    return;
  }

  filtered.forEach((node) => {
    const link = document.createElement('a');
    link.className = 'match-link';
    link.href = '#' + node.anchor_id;

    const title = document.createElement('strong');
    title.textContent = node.label;

  const meta = document.createElement('div');
  meta.className = 'match-meta';
  meta.textContent = node.source_file + ' · ' + PRIMARY_DEGREE_LABEL.toLowerCase() + ' ' + node.degree;

    link.append(title, meta);
    matches.appendChild(link);
  });
}

function renderFromHash() {
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  renderSelection(hash);
}

searchInput.addEventListener('input', (event) => {
  renderMatches(event.target.value || '');
});

window.addEventListener('hashchange', renderFromHash);

renderMatches('');
renderFromHash();
</script>
<script>
function loadInteractiveGraph() {
  var data = JSON.parse(document.getElementById('graphData').textContent);
  var nodeCount = data.nodes.length;
  var msg = nodeCount > 300
    ? '⚠️ This community has ' + nodeCount + ' nodes. Loading the full interactive graph may slow or freeze your browser.\\n\\nContinue anyway?'
    : 'Load the full interactive graph for this community (' + nodeCount + ' nodes)?';
  if (!confirm(msg)) return;
  var btn = document.getElementById('loadGraphBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  var s = document.createElement('script');
  s.src = 'https://unpkg.com/vis-network/standalone/umd/vis-network.min.js';
  s.onload = function() {
    var container = document.getElementById('visContainer');
    container.style.display = 'block';
    btn.style.display = 'none';
    var net = new vis.Network(container, {
      nodes: new vis.DataSet(data.nodes.map(function(n) {
        return { id: n.id, label: n.label, title: n.file_type };
      })),
      edges: new vis.DataSet(data.edges.map(function(e) {
        return { from: e.from, to: e.to, label: e.label };
      }))
    }, { physics: { stabilization: { iterations: 300 } } });
    net.once('stabilizationIterationsDone', function() { net.setOptions({ physics: false }); });
  };
  s.onerror = function() {
    btn.disabled = false;
    btn.textContent = '⚡ Load interactive graph';
    alert('Failed to load vis-network from CDN. Check your internet connection and try again.');
  };
  document.head.appendChild(s);
}
</script>
</body>
</html>`
}

function buildOverviewHtml(
  stats: HtmlStats,
  searchIndex: OverviewSearchIndexEntry[],
  communities: OverviewCommunitySummary[],
  bridges: OverviewBridgeSummary[],
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>madar overview</title>
<style>
  :root {
    color-scheme: light;
    --panel-border: #d7dce5;
    --panel-bg: #fbfcfe;
    --text-muted: #5b6473;
    --accent: #2553d8;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111827;
    background: #eef2f7;
  }

  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
  }

  .panel {
    border: 1px solid var(--panel-border);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.94);
    padding: 18px;
    margin-bottom: 16px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
  }

  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.45rem; }
  h2 { font-size: 1rem; margin-bottom: 12px; }
  .lede { color: var(--text-muted); line-height: 1.55; margin-top: 8px; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    padding: 6px 10px;
    border-radius: 999px;
    background: #e8efff;
    color: var(--accent);
    font-size: 0.82rem;
    font-weight: 600;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
  }
  .stat {
    border-radius: 12px;
    padding: 12px;
    background: white;
    border: 1px solid #e6ebf2;
  }
  .muted { color: var(--text-muted); font-size: 0.88rem; }
  .stat strong { display: block; margin-top: 4px; font-size: 1.1rem; }
  #search {
    width: 100%;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 12px;
    border: 1px solid #cdd6e3;
    background: white;
  }
  .list {
    display: grid;
    gap: 10px;
  }
  .community-card,
  .match-link,
  .bridge-card {
    display: block;
    border: 1px solid #d7dce5;
    border-radius: 12px;
    padding: 12px 14px;
    background: white;
    color: inherit;
    text-decoration: none;
  }
  .community-card:hover,
  .match-link:hover,
  .bridge-card:hover {
    border-color: var(--accent);
  }
  .community-meta,
  .match-meta,
  .bridge-meta {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin-top: 4px;
  }
  .top-nodes {
    margin-top: 8px;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.92rem;
    line-height: 1.5;
  }
</style>
</head>
<body>
<main>
  <section class="panel">
    <div class="badge">Overview-first large-graph mode</div>
    <h1>madar</h1>
    <p class="lede">This export is using an overview-first layout so large projects stay fast to open. Start from a named community, then drill into its self-contained page for interactive node inspection.</p>
    <div class="stats" id="stats"></div>
  </section>

  <section class="panel">
    <h2>Search nodes and files</h2>
    <input id="search" placeholder="Search labels, files, or communities..." />
    <div id="matches" class="list"></div>
  </section>

  <section class="panel">
    <h2>Workspace Bridges</h2>
    <p class="lede">Start with nodes that connect otherwise separate communities.</p>
    <div id="bridges" class="list"></div>
  </section>

  <section class="panel">
    <h2>Communities</h2>
    <p class="lede">Open a focused community page for interactive rendering, or a summary page when one community is still too large to draw safely.</p>
    <div id="communities" class="list"></div>
  </section>
</main>
<script>
const STATS = ${serializeForInlineScript(stats)};
const SEARCH_INDEX = ${serializeForInlineScript(searchIndex)};
const COMMUNITIES = ${serializeForInlineScript(communities)};
const BRIDGES = ${serializeForInlineScript(bridges)};

const elements = {
  stats: document.getElementById('stats'),
  search: document.getElementById('search'),
  matches: document.getElementById('matches'),
  communities: document.getElementById('communities'),
  bridges: document.getElementById('bridges'),
};

function renderStats() {
  [
    { label: 'Nodes', value: STATS.nodes },
    { label: 'Edges', value: STATS.edges },
    { label: 'Communities', value: STATS.communities },
  ].forEach((item) => {
    const card = document.createElement('div');
    card.className = 'stat';
    const label = document.createElement('div');
    label.className = 'muted';
    label.textContent = item.label;
    const value = document.createElement('strong');
    value.textContent = String(item.value);
    card.append(label, value);
    elements.stats.appendChild(card);
  });
}

function renderCommunities(query) {
  const trimmed = query.trim().toLowerCase();
  elements.communities.replaceChildren();

  const matches = COMMUNITIES.filter((community) => {
    if (!trimmed) {
      return true;
    }

    return (
      community.label.toLowerCase().includes(trimmed) ||
      community.topNodes.some((node) => node.label.toLowerCase().includes(trimmed))
    );
  });

  matches.forEach((community) => {
    const link = document.createElement('a');
    link.className = 'community-card';
    link.href = community.href;

    const title = document.createElement('strong');
    title.textContent = community.label;
    const meta = document.createElement('div');
    meta.className = 'community-meta';
    meta.textContent = community.count + ' node' + (community.count === 1 ? '' : 's') + (community.cohesion === null ? '' : ' · cohesion ' + community.cohesion);
    const topNodes = document.createElement('div');
    topNodes.className = 'top-nodes';
    topNodes.textContent = 'Top nodes: ' + (community.topNodes.map((node) => node.label).join(', ') || 'No node summary yet');

    const action = document.createElement('div');
    action.className = 'top-nodes';
    action.textContent = community.pageMode === 'summary' ? 'Open community summary →' : 'Open community →';

    link.append(title, meta, topNodes, action);
    elements.communities.appendChild(link);
  });
}

function renderMatches(query) {
  const trimmed = query.trim().toLowerCase();
  elements.matches.replaceChildren();
  if (!trimmed) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'Search results link directly into the relevant community page and node.';
    elements.matches.appendChild(hint);
    return;
  }

  const matches = SEARCH_INDEX.filter((entry) => {
    return (
      entry.label.toLowerCase().includes(trimmed) ||
      entry.source_file.toLowerCase().includes(trimmed) ||
      entry.community_name.toLowerCase().includes(trimmed)
    );
  }).slice(0, 12);

  if (matches.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'No matches yet. Try a file name, class, function, or community.';
    elements.matches.appendChild(hint);
    return;
  }

  matches.forEach((entry) => {
    const link = document.createElement('a');
    link.className = 'match-link';
    link.href = entry.href;

    const title = document.createElement('strong');
    title.textContent = entry.label;
    const meta = document.createElement('div');
    meta.className = 'match-meta';
    meta.textContent = entry.community_name + ' · ' + entry.source_file;

    link.append(title, meta);
    elements.matches.appendChild(link);
  });
}

function renderBridges() {
  elements.bridges.replaceChildren();
  if (BRIDGES.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = 'No bridge nodes detected across communities yet.';
    elements.bridges.appendChild(hint);
    return;
  }

  BRIDGES.forEach((bridge) => {
    const link = document.createElement('a');
    link.className = 'bridge-card';
    link.href = bridge.href;

    const title = document.createElement('strong');
    title.textContent = bridge.label;
    const meta = document.createElement('div');
    meta.className = 'bridge-meta';
    meta.textContent = bridge.connection_summary + ' · home ' + bridge.community_name + ' · degree ' + bridge.degree;
    const files = document.createElement('div');
    files.className = 'top-nodes';
    files.textContent = 'Source files: ' + (bridge.source_files.join(', ') || 'n/a');

    link.append(title, meta, files);
    elements.bridges.appendChild(link);
  });
}

renderStats();
renderCommunities('');
renderMatches('');
renderBridges();

elements.search.addEventListener('input', (event) => {
  const value = event.target.value || '';
  renderMatches(value);
  renderCommunities(value);
});
</script>
</body>
</html>`
}

export function toCypher(graph: KnowledgeGraph, outputPath: string): void {
  const lines = ['// Neo4j Cypher import - generated by madar', '']

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = escapeCypher(String(attributes.label ?? nodeId))
    const fileTypeRaw = String(attributes.file_type ?? 'entity').replace(/[^A-Za-z0-9_]/g, '')
    const fileType = fileTypeRaw && /^[A-Za-z]/.test(fileTypeRaw) ? `${fileTypeRaw.charAt(0).toUpperCase()}${fileTypeRaw.slice(1)}` : 'Entity'
    lines.push(`MERGE (n:${fileType} {id: '${escapeCypher(nodeId)}', label: '${label}'});`)
  }

  lines.push('')
  for (const [source, target, attributes] of graph.edgeEntries()) {
    const relation =
      String(attributes.relation ?? 'RELATES_TO')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_') || 'RELATES_TO'
    const confidence = escapeCypher(String(attributes.confidence ?? 'EXTRACTED'))
    lines.push(`MATCH (a {id: '${escapeCypher(source)}'}), (b {id: '${escapeCypher(target)}'}) MERGE (a)-[:${relation} {confidence: '${confidence}'}]->(b);`)
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf8')
}

export function toGraphml(graph: KnowledgeGraph, communities: Communities, outputPath: string): void {
  const nodeCommunity = _nodeCommunityMap(communities)
  const edgeDefault = graph.isDirected() ? 'directed' : 'undirected'
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    `  <graph id="madar" edgedefault="${edgeDefault}">`,
  ]

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    lines.push(`    <node id="${escapeXml(nodeId)}">`)
    lines.push(`      <data key="label">${escapeXml(String(attributes.label ?? nodeId))}</data>`)
    lines.push(`      <data key="community">${nodeCommunity[nodeId] ?? -1}</data>`)
    lines.push(`      <data key="source_file">${escapeXml(String(attributes.source_file ?? ''))}</data>`)
    lines.push('    </node>')
  }

  let edgeIndex = 0
  for (const [source, target, attributes] of graph.edgeEntries()) {
    lines.push(`    <edge id="e${edgeIndex}" source="${escapeXml(source)}" target="${escapeXml(target)}">`)
    lines.push(`      <data key="relation">${escapeXml(String(attributes.relation ?? ''))}</data>`)
    lines.push(`      <data key="confidence">${escapeXml(String(attributes.confidence ?? 'EXTRACTED'))}</data>`)
    lines.push('    </edge>')
    edgeIndex += 1
  }

  lines.push('  </graph>')
  lines.push('</graphml>')
  writeFileSync(outputPath, lines.join('\n'), 'utf8')
}

/**
 * Export the graph as a static SVG with a deterministic, dependency-free layout.
 *
 * Communities are arranged in a grid and nodes are positioned on a circle inside
 * each community cell, which keeps output stable across runs for the same input.
 */
export function toSvg(graph: KnowledgeGraph, communities: Communities, outputPath: string, communityLabels: Record<number, string> = {}): void {
  const communityIds = Object.keys(communities)
    .map(Number)
    .sort((left, right) => left - right)
  const totalCommunities = Math.max(communityIds.length, 1)
  const columns = Math.max(1, Math.ceil(Math.sqrt(totalCommunities)))
  const rows = Math.max(1, Math.ceil(totalCommunities / columns))
  const width = SVG_LAYOUT.padding * 2 + columns * SVG_LAYOUT.cellWidth + SVG_LAYOUT.legendWidth
  const height = SVG_LAYOUT.padding * 2 + rows * SVG_LAYOUT.cellHeight
  const degreeByNode = new Map(graph.nodeIds().map((nodeId) => [nodeId, graph.degree(nodeId)]))
  const maxDegree = Math.max(...degreeByNode.values(), 1)
  const positions = new Map<string, { x: number; y: number }>()

  communityIds.forEach((communityId, index) => {
    const nodeIds = [...(communities[communityId] ?? [])].sort((left, right) => {
      return String(graph.nodeAttributes(left).label ?? left).localeCompare(String(graph.nodeAttributes(right).label ?? right))
    })
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = SVG_LAYOUT.padding + column * SVG_LAYOUT.cellWidth + SVG_LAYOUT.cellWidth / 2
    const centerY = SVG_LAYOUT.padding + row * SVG_LAYOUT.cellHeight + SVG_LAYOUT.cellHeight / 2

    if (nodeIds.length === 1) {
      positions.set(nodeIds[0]!, { x: centerX, y: centerY })
      return
    }

    const radius = Math.min(SVG_LAYOUT.communityRadiusCap, SVG_LAYOUT.communityBaseRadius + nodeIds.length * SVG_LAYOUT.communityRadiusIncrement)
    nodeIds.forEach((nodeId, nodeIndex) => {
      const angle = -Math.PI / 2 + (nodeIndex / nodeIds.length) * Math.PI * 2
      positions.set(nodeId, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      })
    })
  })

  const nodeElements = graph.nodeEntries().map(([nodeId, attributes]) => {
    const communityId = communityIds.find((id) => communities[id]?.includes(nodeId)) ?? 0
    const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0]
    const position = positions.get(nodeId) ?? { x: SVG_LAYOUT.padding + 40, y: SVG_LAYOUT.padding + 40 }
    const radius = SVG_LAYOUT.nodeBaseRadius + SVG_LAYOUT.nodeRadiusScale * ((degreeByNode.get(nodeId) ?? 0) / maxDegree)
    const label = escapeXml(String(attributes.label ?? nodeId))
    return [
      `  <circle cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${color}" fill-opacity="0.9" stroke="#ffffff" stroke-width="1.5" />`,
      `  <text x="${position.x.toFixed(2)}" y="${(position.y + radius + SVG_LAYOUT.nodeLabelOffset).toFixed(2)}" font-family="Inter, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#f8fafc">${label}</text>`,
    ].join('\n')
  })

  const edgeElements = graph.edgeEntries().map(([source, target, attributes]) => {
    const sourcePosition = positions.get(source)
    const targetPosition = positions.get(target)
    if (!sourcePosition || !targetPosition) {
      return ''
    }

    const confidence = String(attributes.confidence ?? 'EXTRACTED')
    const dashArray = confidence === 'EXTRACTED' ? '' : ' stroke-dasharray="6 4"'
    const opacity = confidence === 'EXTRACTED' ? '0.65' : '0.35'
    return `  <line x1="${sourcePosition.x.toFixed(2)}" y1="${sourcePosition.y.toFixed(2)}" x2="${targetPosition.x.toFixed(2)}" y2="${targetPosition.y.toFixed(2)}" stroke="#94a3b8" stroke-width="1.5" stroke-opacity="${opacity}"${dashArray} />`
  })

  const legendElements = communityIds.map((communityId, index) => {
    const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0]
    const label = escapeXml(communityLabels[communityId] ?? `Community ${communityId}`)
    const y = SVG_LAYOUT.padding + 28 + index * SVG_LAYOUT.legendRowHeight
    return [
      `  <circle cx="${width - SVG_LAYOUT.legendWidth + 20}" cy="${y}" r="6" fill="${color}" />`,
      `  <text x="${width - SVG_LAYOUT.legendWidth + 34}" y="${y + 4}" font-family="Inter, Arial, sans-serif" font-size="12" fill="#e2e8f0">${label} (${communities[communityId]?.length ?? 0})</text>`,
    ].join('\n')
  })

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="madar knowledge graph export">`,
    `  <rect width="${width}" height="${height}" fill="#111827" />`,
    '  <text x="48" y="32" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="600" fill="#f8fafc">madar</text>',
    '  <text x="48" y="54" font-family="Inter, Arial, sans-serif" font-size="12" fill="#94a3b8">Static SVG knowledge graph export</text>',
    ...edgeElements.filter((line) => line.length > 0),
    ...nodeElements,
    `  <text x="${width - SVG_LAYOUT.legendWidth + 12}" y="${SVG_LAYOUT.padding}" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="600" fill="#f8fafc">Communities</text>`,
    ...legendElements,
    '</svg>',
    '',
  ].join('\n')

  writeFileSync(outputPath, svg, 'utf8')
}

export function toHtml(
  graph: KnowledgeGraph,
  communities: Communities,
  outputPath: string,
  communityLabels: Record<number, string> = {},
  options: HtmlExportOptions = {},
): HtmlExportResult {
  const payload = buildHtmlPayload(graph, communities, communityLabels)
  const htmlResult = resolveHtmlExportMode(payload, options.mode ?? 'auto')
  const communityPagesDir = join(dirname(outputPath), COMMUNITY_PAGES_DIRNAME)
  const bridges = workspaceBridges(graph, communities, communityLabels)
  const bridgeMetadata = buildBridgeMetadata(bridges)

  if (htmlResult.mode === 'inline') {
    rmSync(communityPagesDir, { recursive: true, force: true })
    writeFileSync(outputPath, buildInteractiveHtml(payload, graph.isDirected()), 'utf8')
    return htmlResult
  }

  rmSync(communityPagesDir, { recursive: true, force: true })
  mkdirSync(communityPagesDir, { recursive: true })

  const communitySummaries: OverviewCommunitySummary[] = Object.entries(communities)
    .map(([communityIdRaw, nodeIds]) => {
      const communityId = Number(communityIdRaw)
      const pagePath = join(communityPagesDir, `community-${communityId}.html`)
      const communityName = communityLabels[communityId] ?? `Community ${communityId}`
      const subgraph = subgraphFromNodes(graph, nodeIds)
      const subgraphCommunities = { 0: [...nodeIds] }
      const subgraphLabels = { 0: communityName }
      const pagePayload = enrichPayloadWithBridgeMetadata(buildHtmlPayload(subgraph, subgraphCommunities, subgraphLabels), bridgeMetadata)
      const pageMode: OverviewCommunitySummary['pageMode'] =
        resolveHtmlExportMode(pagePayload, 'auto').mode === 'inline' ? 'interactive' : 'summary'

      writeFileSync(
        pagePath,
        pageMode === 'interactive'
          ? buildInteractiveHtml(pagePayload, graph.isDirected(), {
              pageTitle: `${communityName} · madar`,
              heading: communityName,
              lede: 'Focused community view. This page shows only nodes inside this community; cross-community connections are hidden.',
              backLinkHref: relative(dirname(pagePath), outputPath).replaceAll('\\', '/'),
              backLinkLabel: '← Back to overview',
              degreeLabel: 'Local degree',
            })
          : buildCommunitySummaryHtml(pagePayload, {
              pageTitle: `${communityName} · madar`,
              heading: communityName,
              lede: 'This community is too large to render as one interactive graph without freezing the browser. Use the searchable node list and summaries below instead. This page shows only nodes inside this community; cross-community connections are hidden.',
              backLinkHref: relative(dirname(pagePath), outputPath).replaceAll('\\', '/'),
              backLinkLabel: '← Back to overview',
              degreeLabel: 'Local degree',
            }),
        'utf8',
      )

      const topNodes = buildOverviewTopNodes(graph, nodeIds, communityId, pageMode, COMMUNITY_PAGES_DIRNAME)

      return {
        id: communityId,
        label: communityName,
        count: nodeIds.length,
        cohesion: options.cohesionScores?.[communityId] ?? null,
        href: `${COMMUNITY_PAGES_DIRNAME}/community-${communityId}.html`,
        pageMode,
        topNodes,
      }
    })
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))

  const communityPageModes = new Map(communitySummaries.map((community) => [community.id, community.pageMode]))
  const bridgeSummaries: OverviewBridgeSummary[] = buildOverviewBridgeSummaries(bridges, COMMUNITY_PAGES_DIRNAME)

  for (const bridge of bridges) {
    const neighborhoodNodeIds = bridgeNeighborhoodNodeIds(graph, bridge.id)
    if (neighborhoodNodeIds.length === 0) {
      continue
    }

    const neighborhoodNodeSet = new Set(neighborhoodNodeIds)
    const bridgePagePath = join(communityPagesDir, bridgePageFilename(bridge.id))
    const bridgePayload = enrichPayloadWithBridgeMetadata(
      buildHtmlPayload(
        subgraphFromNodes(graph, neighborhoodNodeIds),
        filterCommunitiesForNodes(communities, neighborhoodNodeSet),
        communityLabels,
      ),
      bridgeMetadata,
    )

    writeFileSync(
      bridgePagePath,
      buildInteractiveHtml(bridgePayload, graph.isDirected(), {
        pageTitle: `${bridge.label} · madar`,
        heading: bridge.label,
        lede: 'Bridge neighborhood view. This page shows the selected bridge node plus its immediate cross-community neighborhood.',
        backLinkHref: relative(dirname(bridgePagePath), outputPath).replaceAll('\\', '/'),
        backLinkLabel: '← Back to overview',
        degreeLabel: 'Local degree',
        initialSelectedNodeId: bridge.id,
      }),
      'utf8',
    )
  }

  const searchIndex = buildOverviewSearchIndex(payload.nodes, communityPageModes, COMMUNITY_PAGES_DIRNAME)

  writeFileSync(outputPath, buildOverviewHtml(payload.stats, searchIndex, communitySummaries, bridgeSummaries), 'utf8')
  return {
    ...htmlResult,
    communityPageCount: communitySummaries.length,
  }
}

export function toObsidian(
  graph: KnowledgeGraph,
  communities: Communities,
  outputDir: string,
  communityLabels: Record<number, string> = {},
  cohesionScores: Record<number, number> = {},
): number {
  mkdirSync(outputDir, { recursive: true })

  const nodeCommunity = _nodeCommunityMap(communities)
  const nodeFilename = new Map<string, string>()
  const seenNames = new Map<string, number>()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const base = safeName(String(attributes.label ?? nodeId))
    const count = seenNames.get(base) ?? 0
    nodeFilename.set(nodeId, count === 0 ? base : `${base}_${count}`)
    seenNames.set(base, count + 1)
  }

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = escapeMarkdownInline(String(attributes.label ?? nodeId))
    const communityId = nodeCommunity[nodeId] ?? -1
    const communityName = escapeMarkdownInline(communityLabels[communityId] ?? `Community ${communityId}`)
    const fileType = String(attributes.file_type ?? '')
    const fileTypeTag = sanitizeTag(FILE_TYPE_TAGS[fileType] ?? (fileType.length > 0 ? `madar/${fileType}` : 'madar/document'))
    const confidenceTag = sanitizeTag(`madar/${dominantConfidence(graph, nodeId)}`)
    const communityTag = sanitizeTag(`community/${communityName.replaceAll(' ', '_')}`)
    const tags = [fileTypeTag, confidenceTag, communityTag]
    const lines = [
      '---',
      `source_file: ${JSON.stringify(String(attributes.source_file ?? ''))}`,
      `type: ${JSON.stringify(fileType)}`,
      `community: ${JSON.stringify(communityName)}`,
    ]

    if (typeof attributes.source_location === 'string' && attributes.source_location.length > 0) {
      lines.push(`location: ${JSON.stringify(attributes.source_location)}`)
    }

    lines.push('tags:')
    for (const tag of tags) {
      lines.push(`  - ${tag}`)
    }

    lines.push('---', '', `# ${label}`, '')

    const connections = nodeConnections(graph, nodeId).sort((left, right) => {
      const leftLabel = String(graph.nodeAttributes(left.neighborId).label ?? left.neighborId)
      const rightLabel = String(graph.nodeAttributes(right.neighborId).label ?? right.neighborId)
      return leftLabel.localeCompare(rightLabel)
    })
    if (connections.length > 0) {
      lines.push('## Connections')
      for (const connection of connections) {
        const neighborId = connection.neighborId
        lines.push(
          `- ${connectionPrefix(connection.direction)}[[${nodeFilename.get(neighborId) ?? safeName(String(graph.nodeAttributes(neighborId).label ?? neighborId))}]] - \`${escapeMarkdownInline(String(connection.attributes.relation ?? ''))}\` [${escapeMarkdownInline(String(connection.attributes.confidence ?? 'EXTRACTED'))}]`,
        )
      }
      lines.push('')
    }

    lines.push(tags.map((tag) => `#${tag}`).join(' '))
    writeFileSync(join(outputDir, `${nodeFilename.get(nodeId) ?? safeName(label)}.md`), `${lines.join('\n')}\n`, 'utf8')
  }

  const interCommunityEdges: Record<number, Record<number, number>> = {}
  for (const communityId of Object.keys(communities).map(Number)) {
    interCommunityEdges[communityId] = {}
  }

  for (const [sourceNodeId, targetNodeId] of graph.edgeEntries()) {
    const sourceCommunity = nodeCommunity[sourceNodeId]
    const targetCommunity = nodeCommunity[targetNodeId]
    if (sourceCommunity === undefined || targetCommunity === undefined || sourceCommunity === targetCommunity) {
      continue
    }

    interCommunityEdges[sourceCommunity] ??= {}
    interCommunityEdges[targetCommunity] ??= {}
    interCommunityEdges[sourceCommunity]![targetCommunity] = (interCommunityEdges[sourceCommunity]![targetCommunity] ?? 0) + 1
    interCommunityEdges[targetCommunity]![sourceCommunity] = (interCommunityEdges[targetCommunity]![sourceCommunity] ?? 0) + 1
  }

  const communityReach = (nodeId: string): number => {
    const currentCommunity = nodeCommunity[nodeId]
    return new Set(
      nodeConnections(graph, nodeId)
        .map((connection) => nodeCommunity[connection.neighborId])
        .filter((neighborCommunityId): neighborCommunityId is number => neighborCommunityId !== undefined && neighborCommunityId !== currentCommunity),
    ).size
  }

  let communityNotesWritten = 0
  for (const [communityIdRaw, nodeIds] of Object.entries(communities).sort((left, right) => Number(left[0]) - Number(right[0]))) {
    const communityId = Number(communityIdRaw)
    const communityName = escapeMarkdownInline(communityLabels[communityId] ?? `Community ${communityId}`)
    const lines = ['---', 'type: community']
    if (cohesionScores[communityId] !== undefined) {
      lines.push(`cohesion: ${cohesionScores[communityId]}`)
    }
    lines.push(`members: ${nodeIds.length}`, '---', '', `# ${communityName}`, '')
    if (cohesionScores[communityId] !== undefined) {
      lines.push(`**Cohesion:** ${cohesionScores[communityId]}`)
    }
    lines.push(`**Members:** ${nodeIds.length} nodes`, '', '## Members')
    for (const nodeId of [...nodeIds].sort((left, right) =>
      String(graph.nodeAttributes(left).label ?? left).localeCompare(String(graph.nodeAttributes(right).label ?? right)),
    )) {
      const attributes = graph.nodeAttributes(nodeId)
      const entry = [`- [[${nodeFilename.get(nodeId) ?? safeName(String(attributes.label ?? nodeId))}]]`]
      if (typeof attributes.file_type === 'string' && attributes.file_type.length > 0) {
        entry.push(escapeMarkdownInline(String(attributes.file_type)))
      }
      if (typeof attributes.source_file === 'string' && attributes.source_file.length > 0) {
        entry.push(escapeMarkdownInline(String(attributes.source_file)))
      }
      lines.push(entry.join(' - '))
    }

    const crossCommunity = interCommunityEdges[communityId] ?? {}
    if (Object.keys(crossCommunity).length > 0) {
      lines.push('', '## Connections to other communities')
      for (const [otherCommunityIdRaw, edgeCount] of Object.entries(crossCommunity).sort((left, right) => Number(right[1]) - Number(left[1]))) {
        const otherCommunityId = Number(otherCommunityIdRaw)
        const otherCommunityName = communityLabels[otherCommunityId] ?? `Community ${otherCommunityId}`
        lines.push(`- ${edgeCount} edge${edgeCount === 1 ? '' : 's'} to [[_COMMUNITY_${safeName(otherCommunityName)}]]`)
      }
    }

    const bridgeNodes = [...nodeIds]
      .map((nodeId) => ({ nodeId, degree: graph.degree(nodeId), reach: communityReach(nodeId) }))
      .filter((entry) => entry.reach > 0)
      .sort((left, right) => right.reach - left.reach || right.degree - left.degree)
      .slice(0, 5)
    if (bridgeNodes.length > 0) {
      lines.push('', '## Top bridge nodes')
      for (const bridgeNode of bridgeNodes) {
        lines.push(
          `- [[${nodeFilename.get(bridgeNode.nodeId) ?? safeName(String(graph.nodeAttributes(bridgeNode.nodeId).label ?? bridgeNode.nodeId))}]] - degree ${bridgeNode.degree}, connects to ${bridgeNode.reach} ${bridgeNode.reach === 1 ? 'community' : 'communities'}`,
        )
      }
    }

    writeFileSync(join(outputDir, `_COMMUNITY_${safeName(communityName)}.md`), `${lines.join('\n')}\n`, 'utf8')
    communityNotesWritten += 1
  }

  mkdirSync(join(outputDir, '.obsidian'), { recursive: true })
  const colorGroups = Object.entries(communities)
    .map(([communityIdRaw]) => Number(communityIdRaw))
    .sort((left, right) => left - right)
    .map((communityId) => {
      const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? '#4E79A7'
      return {
        query: `tag:#community/${(communityLabels[communityId] ?? `Community ${communityId}`).replaceAll(' ', '_')}`,
        color: { a: 1, rgb: Number.parseInt(color.slice(1), 16) },
      }
    })
  writeFileSync(join(outputDir, '.obsidian', 'graph.json'), `${JSON.stringify({ colorGroups }, null, 2)}\n`, 'utf8')

  return graph.numberOfNodes() + communityNotesWritten
}
