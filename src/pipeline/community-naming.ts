import { isAbsolute, relative, sep } from 'node:path'

import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import type { Communities } from './cluster.js'

const GENERIC_PATH_SEGMENTS = new Set(['src', 'tests', 'test', 'dist', 'lib', 'out', 'worked'])
const GENERIC_FILE_BASES = new Set(['index', 'main', 'mod'])
const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'get', 'has', 'have', 'in', 'is', 'of', 'on', 'or', 'set', 'the', 'to', 'with'])
const ACRONYMS: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  css: 'CSS',
  csv: 'CSV',
  docx: 'DOCX',
  go: 'Go',
  graphml: 'GraphML',
  html: 'HTML',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  io: 'IO',
  json: 'JSON',
  jsx: 'JSX',
  md: 'Markdown',
  neo4j: 'Neo4j',
  pdf: 'PDF',
  svg: 'SVG',
  ts: 'TypeScript',
  tsx: 'TSX',
  ui: 'UI',
  url: 'URL',
  urls: 'URLs',
  wasm: 'WASM',
  xml: 'XML',
}

export interface CommunityNamingOptions {
  rootPath?: string
}

function normalizePath(sourceFile: string, rootPath?: string): string {
  if (!sourceFile) {
    return ''
  }

  const normalized = sourceFile.replaceAll('\\', '/')
  if (rootPath && isAbsolute(sourceFile)) {
    const relativePath = relative(rootPath, sourceFile).replaceAll(sep, '/')
    if (!relativePath.startsWith('..') && relativePath.length > 0) {
      return relativePath
    }
  }

  return normalized
}

function splitWords(value: string): string[] {
  return value
    .replace(/\(\)$/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

function titleCaseWord(word: string): string {
  const lowered = word.toLowerCase()
  if (Object.hasOwn(ACRONYMS, lowered)) {
    return ACRONYMS[lowered]!
  }
  return lowered.charAt(0).toUpperCase() + lowered.slice(1)
}

function humanize(value: string): string {
  const words = splitWords(value)
  if (words.length === 0) {
    return ''
  }
  return words.map((word) => titleCaseWord(word)).join(' ')
}

function countWinner(counter: Map<string, number>): string | null {
  let winner: string | null = null
  let winnerScore = -1

  for (const [candidate, score] of counter.entries()) {
    if (score > winnerScore || (score === winnerScore && candidate.localeCompare(winner ?? '') < 0)) {
      winner = candidate
      winnerScore = score
    }
  }

  return winner
}

function addCount(counter: Map<string, number>, candidate: string, increment = 1): void {
  const trimmed = candidate.trim()
  if (!trimmed) {
    return
  }
  counter.set(trimmed, (counter.get(trimmed) ?? 0) + increment)
}

function fileBaseName(sourceFile: string): string {
  const fileName = sourceFile.split('/').at(-1) ?? sourceFile
  const parts = fileName.split('.')
  if (parts.length <= 1) {
    return fileName
  }
  parts.pop()
  return parts.join('.')
}

function dominantDirectory(sourceFiles: string[]): string | null {
  const counts = new Map<string, number>()

  for (const sourceFile of sourceFiles) {
    const segments = sourceFile.split('/').filter(Boolean)
    const directories = segments.slice(0, -1)
    const candidate = directories.find((segment) => !GENERIC_PATH_SEGMENTS.has(segment.toLowerCase()) && !segment.startsWith('.')) ?? directories.at(-1)
    if (candidate) {
      addCount(counts, humanize(candidate))
    }
  }

  return countWinner(counts)
}

function dominantFileTheme(sourceFiles: string[]): string | null {
  const counts = new Map<string, number>()

  for (const sourceFile of sourceFiles) {
    const baseName = fileBaseName(sourceFile)
    if (!baseName || GENERIC_FILE_BASES.has(baseName.toLowerCase())) {
      continue
    }
    addCount(counts, humanize(baseName))
  }

  return countWinner(counts)
}

function dominantOperationTheme(labels: string[]): string | null {
  const counts = new Map<string, number>()

  for (const label of labels) {
    const words = splitWords(label)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))

    for (const word of words) {
      addCount(counts, titleCaseWord(word))
    }
  }

  return countWinner(counts)
}

function representativeNodeLabel(graph: KnowledgeGraph, nodeIds: string[]): string | null {
  const labels = nodeIds
    .map((nodeId) => ({
      label: humanize(String(graph.nodeAttributes(nodeId).label ?? nodeId)),
      degree: graph.degree(nodeId),
    }))
    .filter((entry) => entry.label.length > 0)
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))

  return labels[0]?.label ?? null
}

function joinThemes(directoryTheme: string | null, fileTheme: string | null, operationTheme: string | null, fallbackLabel: string | null): string | null {
  if (fileTheme && directoryTheme && fileTheme.toLowerCase() !== directoryTheme.toLowerCase()) {
    if (directoryTheme.toLowerCase() === 'tests') {
      return `${fileTheme} Tests`
    }
    return `${directoryTheme} ${fileTheme}`
  }

  if (fileTheme) {
    return fileTheme
  }

  if (directoryTheme && operationTheme && directoryTheme.toLowerCase() !== operationTheme.toLowerCase()) {
    return `${directoryTheme} ${operationTheme}`
  }

  if (fallbackLabel) {
    return fallbackLabel
  }

  return directoryTheme ?? operationTheme
}

export function buildCommunityLabels(graph: KnowledgeGraph, communities: Communities, options: CommunityNamingOptions = {}): Record<number, string> {
  const labels = new Map<number, string>()
  const seen = new Map<string, number>()

  for (const communityId of Object.keys(communities)
    .map(Number)
    .sort((left, right) => left - right)) {
    const nodeIds = communities[communityId] ?? []
    const sourceFiles = nodeIds
      .map((nodeId) => normalizePath(String(graph.nodeAttributes(nodeId).source_file ?? ''), options.rootPath))
      .filter((sourceFile) => sourceFile.length > 0)
    const nodeLabels = nodeIds.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId))
    const fallbackLabel = representativeNodeLabel(graph, nodeIds)

    let label =
      nodeIds.length === 1 ? fallbackLabel : joinThemes(dominantDirectory(sourceFiles), dominantFileTheme(sourceFiles), dominantOperationTheme(nodeLabels), fallbackLabel)

    if (!label || label.trim().length === 0) {
      label = `Community ${communityId}`
    }

    const duplicateCount = seen.get(label) ?? 0
    seen.set(label, duplicateCount + 1)

    if (duplicateCount === 0) {
      labels.set(communityId, label)
    } else {
      // Disambiguate using operation theme or representative node, not community ID
      const operationTheme = dominantOperationTheme(nodeLabels)
      const representative = representativeNodeLabel(graph, nodeIds)
      const disambiguator = operationTheme && operationTheme !== label ? operationTheme : representative && representative !== label ? representative : null
      let candidate = disambiguator ? `${label} — ${disambiguator}` : label
      // If the disambiguated name is also taken, append a counter
      const candidateCount = seen.get(candidate) ?? 0
      seen.set(candidate, candidateCount + 1)
      if (candidateCount > 0) {
        candidate = `${candidate} (${candidateCount + 1})`
      }
      labels.set(communityId, candidate)
    }
  }

  return Object.fromEntries(labels.entries())
}
