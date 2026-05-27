import { KnowledgeGraph } from '../contracts/graph.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableRef,
} from '../contracts/context-pack.js'
import type { ContextPackTaskKind } from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { godNodes, workspaceBridges } from '../pipeline/analyze.js'
import { communitiesFromGraph } from './serve.js'
import { analyzeImpact } from './impact.js'
import { featureMap, type FeatureMapOptions } from './feature-map.js'
import { retrieveContext } from './retrieve.js'
import { relativizeSourceFile } from '../shared/source-path.js'

export interface RiskMapOptions extends FeatureMapOptions {
  taskKind?: ContextPackTaskKind
  taskIntent?: TaskIntentKind
}

export type RiskSeverity = 'high' | 'medium' | 'low'

export interface RiskMapRisk {
  label: string
  severity: RiskSeverity
  reason: string
  affected_files: string[]
  affected_communities: string[]
}

export interface RiskMapHotspot {
  label: string
  type: 'bridge' | 'god_node'
  why: string
}

export interface RiskMapResult {
  question: string
  token_count: number
  summary: string
  top_risks: RiskMapRisk[]
  structural_hotspots: RiskMapHotspot[]
  starter_files: ReturnType<typeof featureMap>['relevant_files']
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
  missing_context?: ContextPackEvidenceClass[]
}

interface RiskCandidate {
  label: string
  nodeId?: string
  matchScore: number
}

export interface RiskSummaryCandidate {
  label: string
  totalAffected: number
  affectedFiles: readonly string[]
  affectedCommunities: readonly string[]
  hotspotKinds: readonly string[]
  dependentCount: number
}

interface RankedRiskDetails extends RiskMapRisk {
  score: number
  hotspot_count: number
  dependent_count: number
}

function storedCommunityLabels(graph: KnowledgeGraph): Record<number, string> {
  const raw = graph.graph.community_labels
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => [Number(key), typeof value === 'string' ? value : ''] as const)
      .filter(([id, label]) => Number.isFinite(id) && label.length > 0),
  )
}

export function scoreRisk(
  totalAffected: number,
  affectedCommunityCount: number,
  hotspotCount: number,
  dependentCount: number,
): number {
  return totalAffected * 2 + affectedCommunityCount + hotspotCount * 6 + dependentCount * 2
}

export function severityForRisk(score: number, affectedCommunities: number): RiskSeverity {
  if (score >= 6 || affectedCommunities >= 2) {
    return 'high'
  }
  if (score >= 3) {
    return 'medium'
  }
  return 'low'
}

export function summarizeRisk(
  label: string,
  affectedFiles: readonly string[],
  affectedCommunities: readonly string[],
  hotspotKinds: readonly string[],
): string {
  const filePart = `${affectedFiles.length} file${affectedFiles.length === 1 ? '' : 's'}`
  const communityPart = `${affectedCommunities.length} communit${affectedCommunities.length === 1 ? 'y' : 'ies'}`
  const hotspotPart = hotspotKinds.length > 0 ? ` Includes ${hotspotKinds.join(' and ')} hotspot exposure.` : ''
  return `${label} propagates into ${filePart} across ${communityPart}.${hotspotPart}`
}

export function buildRankedRisk(candidate: RiskSummaryCandidate): RankedRiskDetails {
  const hotspotCount = candidate.hotspotKinds.length
  const score = scoreRisk(
    candidate.totalAffected,
    candidate.affectedCommunities.length,
    hotspotCount,
    candidate.dependentCount,
  )

  return {
    label: candidate.label,
    severity: severityForRisk(score, candidate.affectedCommunities.length),
    reason: summarizeRisk(candidate.label, candidate.affectedFiles, candidate.affectedCommunities, candidate.hotspotKinds),
    affected_files: [...candidate.affectedFiles],
    affected_communities: [...candidate.affectedCommunities],
    score,
    hotspot_count: hotspotCount,
    dependent_count: candidate.dependentCount,
  }
}

export function compareRankedRisks(left: RankedRiskDetails, right: RankedRiskDetails): number {
  return right.score - left.score
    || right.hotspot_count - left.hotspot_count
    || right.dependent_count - left.dependent_count
    || left.label.localeCompare(right.label)
}

export function riskMap(graph: KnowledgeGraph, options: RiskMapOptions): RiskMapResult {
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path.trim() : ''
  const feature = featureMap(graph, options)
  const retrieve = retrieveContext(graph, {
    question: options.question,
    budget: options.budget,
    ...(options.community !== undefined ? { community: options.community } : {}),
    ...(options.fileType ? { fileType: options.fileType } : {}),
    ...(options.taskKind ? { taskKind: options.taskKind } : {}),
    ...(options.taskIntent ? { taskIntent: options.taskIntent } : {}),
  })
  const communities = communitiesFromGraph(graph)
  const communityLabels = storedCommunityLabels(graph)
  const bridgeMap = new Map(workspaceBridges(graph, communities, communityLabels, 20).map((bridge) => [bridge.label, bridge] as const))
  const godSet = new Set(godNodes(graph, 20).map((node) => node.label))

  const preferredNodes = retrieve.matched_nodes.filter((node) => node.relevance_band === 'direct')
  const fallbackNodes = retrieve.matched_nodes.filter((node) => node.relevance_band === 'related')
  const candidateSource = preferredNodes.length > 0 ? preferredNodes : fallbackNodes
  const candidateEntries = [...candidateSource.reduce((entries, node) => {
    const key = node.node_id ?? node.label
    const existing = entries.get(key)
    if (!existing || node.match_score > existing.matchScore) {
      entries.set(key, {
        label: node.label,
        ...(node.node_id ? { nodeId: node.node_id } : {}),
        matchScore: node.match_score,
      })
    }
    return entries
  }, new Map<string, RiskCandidate>()).values()]

  const top_risks = candidateEntries
    .map((candidate) => {
      const impact = analyzeImpact(graph, communityLabels, { label: candidate.label, depth: 3 })
      const affectedFiles = impact.affected_files.map((file) => relativizeSourceFile(file, rootPath))
      const affectedCommunities = impact.affected_communities.map((community) => community.label)
      const hotspotKinds = [
        ...(bridgeMap.has(candidate.label) ? ['bridge'] : []),
        ...(godSet.has(candidate.label) ? ['god node'] : []),
      ]
      const dependentCount = candidate.nodeId ? graph.predecessors(candidate.nodeId).length : 0
      return buildRankedRisk({
        label: candidate.label,
        totalAffected: impact.total_affected,
        affectedFiles,
        affectedCommunities,
        hotspotKinds,
        dependentCount,
      })
    })
    .filter((risk) => risk.score > 0)
    .sort(compareRankedRisks)
    .slice(0, options.limit ?? 5)
    .map(({ score: _score, hotspot_count: _hotspotCount, dependent_count: _dependentCount, ...risk }) => risk)

  const structuralHotspotLabels = [...new Set(candidateEntries.map((candidate) => candidate.label))]
  const structural_hotspots = structuralHotspotLabels
    .flatMap((label) => {
      const hotspots: RiskMapHotspot[] = []
      if (bridgeMap.has(label)) {
        hotspots.push({
          label,
          type: 'bridge',
          why: `${label} connects multiple communities in the matched feature area.`,
        })
      }
      if (godSet.has(label)) {
        hotspots.push({
          label,
          type: 'god_node',
          why: `${label} has unusually high graph degree for this workspace.`,
        })
      }
      return hotspots
    })
    .slice(0, options.limit ?? 5)

  const topRisk = top_risks[0]
  const summary = topRisk
    ? `Highest risk: ${topRisk.label} with ${topRisk.affected_files.length} affected files across ${topRisk.affected_communities.length} communities.`
    : 'No high-signal change risks found for this feature area.'

  return {
    question: options.question,
    token_count: retrieve.token_count,
    summary,
    top_risks,
    structural_hotspots,
    starter_files: feature.relevant_files,
    claims: retrieve.claims ?? [],
    expandable: retrieve.expandable ?? [],
    ...(retrieve.coverage
      ? {
          coverage: retrieve.coverage,
          missing_context: retrieve.coverage.missing_required,
        }
      : {}),
  }
}
