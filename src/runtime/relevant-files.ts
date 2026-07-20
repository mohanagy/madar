import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import type { ContextPackClaim, ContextPackCoverage, ContextPackEvidenceClass, ContextPackExpandableRef } from '../contracts/context-pack.js'
import type { ContextPackTaskKind } from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import { retrieveContext } from './retrieve.js'

export interface RelevantFilesOptions {
  question: string
  budget: number
  limit?: number
  community?: number
  fileType?: string
  taskKind?: ContextPackTaskKind
  taskIntent?: TaskIntentKind
}

export interface RelevantFileEntry {
  path: string
  score: number
  why: string
  matched_symbols: string[]
  direct_matches: number
  related_matches: number
}

export interface RelevantFilesResult {
  question: string
  token_count: number
  relevant_files: RelevantFileEntry[]
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
  missing_context?: ContextPackEvidenceClass[]
}

interface FileAggregate {
  path: string
  score: number
  matchedSymbols: string[]
  matchedSymbolSet: Set<string>
  directSymbols: string[]
  relatedSymbols: string[]
  directMatches: number
  relatedMatches: number
}

function pushUnique(values: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) {
    return
  }
  seen.add(value)
  values.push(value)
}

function formatSymbolList(symbols: readonly string[]): string {
  if (symbols.length === 0) {
    return 'supporting symbols'
  }
  if (symbols.length === 1) {
    return symbols[0]!
  }
  if (symbols.length === 2) {
    return `${symbols[0]} and ${symbols[1]}`
  }
  return `${symbols[0]}, ${symbols[1]}, and ${symbols[2]}`
}

function whyForFile(entry: FileAggregate): string {
  const directSymbols = entry.directSymbols.slice(0, 3)
  const relatedSymbols = entry.relatedSymbols.slice(0, 2)

  if (directSymbols.length > 0 && relatedSymbols.length > 0) {
    return `Directly relevant via ${formatSymbolList(directSymbols)}. Also connected through ${formatSymbolList(relatedSymbols)}.`
  }
  if (directSymbols.length > 0) {
    return `Directly relevant via ${formatSymbolList(directSymbols)}.`
  }
  return `Supporting context via ${formatSymbolList(relatedSymbols)}.`
}

export function relevantFiles(graph: KnowledgeGraph, options: RelevantFilesOptions): RelevantFilesResult {
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path.trim() : ''
  const retrieveResult = retrieveContext(graph, {
    question: options.question,
    budget: options.budget,
    ...(options.community !== undefined ? { community: options.community } : {}),
    ...(options.fileType ? { fileType: options.fileType } : {}),
    ...(options.taskKind ? { taskKind: options.taskKind } : {}),
    ...(options.taskIntent ? { taskIntent: options.taskIntent } : {}),
  })

  const byPath = new Map<string, FileAggregate>()

  for (const node of retrieveResult.matched_nodes) {
    if (node.relevance_band === 'peripheral' || node.source_file.length === 0) {
      continue
    }

    let entry = byPath.get(node.source_file)
    if (!entry) {
      entry = {
        path: relativizeSourceFile(node.source_file, rootPath),
        score: 0,
        matchedSymbols: [],
        matchedSymbolSet: new Set<string>(),
        directSymbols: [],
        relatedSymbols: [],
        directMatches: 0,
        relatedMatches: 0,
      }
      byPath.set(node.source_file, entry)
    }

    entry.score += node.match_score
    pushUnique(entry.matchedSymbols, entry.matchedSymbolSet, node.label)
    if (node.relevance_band === 'direct') {
      entry.directMatches += 1
      if (!entry.directSymbols.includes(node.label)) {
        entry.directSymbols.push(node.label)
      }
      continue
    }

    entry.relatedMatches += 1
    if (!entry.relatedSymbols.includes(node.label)) {
      entry.relatedSymbols.push(node.label)
    }
  }

  const limit = options.limit ?? 8
  const relevant_files = [...byPath.values()]
    .sort((left, right) => {
      return (
        right.directMatches - left.directMatches ||
        right.score - left.score ||
        right.relatedMatches - left.relatedMatches ||
        left.path.localeCompare(right.path)
      )
    })
    .slice(0, limit)
    .map((entry) => ({
      path: entry.path,
      score: entry.score,
      why: whyForFile(entry),
      matched_symbols: entry.matchedSymbols,
      direct_matches: entry.directMatches,
      related_matches: entry.relatedMatches,
    }))

  return {
    question: options.question,
    token_count: retrieveResult.token_count,
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
