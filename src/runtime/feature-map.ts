import { KnowledgeGraph } from '../contracts/graph.js'
import type { ContextPackClaim, ContextPackCoverage, ContextPackEvidenceClass, ContextPackExpandableRef } from '../contracts/context-pack.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import { relevantFiles, type RelevantFileEntry } from './relevant-files.js'
import { retrieveContext, type RetrieveMatchedNode } from './retrieve.js'

export interface FeatureMapOptions {
  question: string
  budget: number
  limit?: number
  community?: number
  fileType?: string
}

export interface FeatureMapCommunity {
  id: number
  label: string
  node_count: number
  top_symbols: string[]
  top_files: string[]
  direct_matches: number
  related_matches: number
}

export interface FeatureMapEntryPoint {
  label: string
  node_kind?: string
  source_file: string
  line_number: number
  relevance_band: 'direct' | 'related' | 'peripheral'
  why: string
}

export interface FeatureMapResult {
  question: string
  token_count: number
  summary: string
  communities: FeatureMapCommunity[]
  entry_points: FeatureMapEntryPoint[]
  relevant_files: RelevantFileEntry[]
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
  missing_context?: ContextPackEvidenceClass[]
}

interface CommunityAggregate {
  id: number
  label: string
  nodeCount: number
  topSymbols: string[]
  symbolSet: Set<string>
  topFiles: string[]
  fileSet: Set<string>
  directMatches: number
  relatedMatches: number
  score: number
}

function pushUnique(values: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) {
    return
  }
  seen.add(value)
  values.push(value)
}

function featureMapRootPath(graph: KnowledgeGraph): string {
  return typeof graph.graph.root_path === 'string' ? graph.graph.root_path.trim() : ''
}

function isEntryPointNode(node: RetrieveMatchedNode): boolean {
  const frameworkRole = node.framework_role ?? ''
  const nodeKind = node.node_kind ?? ''
  return (
    ['route', 'router', 'controller', 'page', 'layout', 'middleware'].includes(nodeKind) ||
    frameworkRole.includes('route') ||
    frameworkRole.includes('controller') ||
    frameworkRole.includes('page') ||
    frameworkRole.includes('layout') ||
    frameworkRole.includes('middleware')
  )
}

function whyForEntryPoint(node: RetrieveMatchedNode, communityLabel: string | null): string {
  const role = node.framework_role?.replaceAll('_', ' ') ?? node.node_kind ?? 'entry point'
  if (communityLabel) {
    return `Primary ${role} in ${communityLabel}.`
  }
  return `Primary ${role} match for this feature.`
}

function summaryForFeatureMap(communities: readonly FeatureMapCommunity[], files: readonly RelevantFileEntry[]): string {
  if (communities.length === 0 && files.length === 0) {
    return 'No feature-map matches found.'
  }

  const labels = communities.slice(0, 2).map((community) => community.label)
  const labelSummary =
    labels.length === 0 ? 'relevant graph areas' : labels.length === 1 ? labels[0]! : `${labels[0]} and ${labels[1]}`
  const firstFile = files[0]?.path
  return firstFile ? `Primary areas: ${labelSummary}. Start with ${firstFile}.` : `Primary areas: ${labelSummary}.`
}

export function featureMap(graph: KnowledgeGraph, options: FeatureMapOptions): FeatureMapResult {
  const rootPath = featureMapRootPath(graph)
  const retrieveResult = retrieveContext(graph, {
    question: options.question,
    budget: options.budget,
    ...(options.community !== undefined ? { community: options.community } : {}),
    ...(options.fileType ? { fileType: options.fileType } : {}),
  })
  const limit = options.limit ?? 5

  const relevant_files = relevantFiles(graph, {
    question: options.question,
    budget: options.budget,
    limit,
    ...(options.community !== undefined ? { community: options.community } : {}),
    ...(options.fileType ? { fileType: options.fileType } : {}),
  }).relevant_files

  const communityContext = new Map(retrieveResult.community_context.map((community) => [community.id, community] as const))
  const byCommunity = new Map<number, CommunityAggregate>()

  for (const node of retrieveResult.matched_nodes) {
    if (node.relevance_band === 'peripheral' || node.community === null) {
      continue
    }

    let entry = byCommunity.get(node.community)
    if (!entry) {
      const context = communityContext.get(node.community)
      entry = {
        id: node.community,
        label: node.community_label ?? context?.label ?? `Community ${node.community}`,
        nodeCount: context?.node_count ?? 0,
        topSymbols: [],
        symbolSet: new Set<string>(),
        topFiles: [],
        fileSet: new Set<string>(),
        directMatches: 0,
        relatedMatches: 0,
        score: 0,
      }
      byCommunity.set(node.community, entry)
    }

    entry.score += node.match_score
    pushUnique(entry.topSymbols, entry.symbolSet, node.label)
    pushUnique(entry.topFiles, entry.fileSet, relativizeSourceFile(node.source_file, rootPath))
    if (node.relevance_band === 'direct') {
      entry.directMatches += 1
    } else if (node.relevance_band === 'related') {
      entry.relatedMatches += 1
    }
  }

  const communities = [...byCommunity.values()]
    .sort((left, right) => right.directMatches - left.directMatches || right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      node_count: entry.nodeCount,
      top_symbols: entry.topSymbols.slice(0, 3),
      top_files: entry.topFiles.slice(0, 3),
      direct_matches: entry.directMatches,
      related_matches: entry.relatedMatches,
    }))

  const entry_points = retrieveResult.matched_nodes
    .filter((node) => node.relevance_band !== 'peripheral')
    .filter((node) => isEntryPointNode(node))
    .sort((left, right) => right.match_score - left.match_score || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((node) => ({
      label: node.label,
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      source_file: relativizeSourceFile(node.source_file, rootPath),
      line_number: node.line_number,
      relevance_band: node.relevance_band,
      why: whyForEntryPoint(node, node.community_label),
    }))

  return {
    question: options.question,
    token_count: retrieveResult.token_count,
    summary: summaryForFeatureMap(communities, relevant_files),
    communities,
    entry_points,
    relevant_files,
    claims: retrieveResult.claims ?? [],
    expandable: retrieveResult.expandable ?? [],
    ...(retrieveResult.coverage
      ? {
          coverage: retrieveResult.coverage,
          missing_context: retrieveResult.coverage.missing_required,
        }
      : {}),
  }
}
