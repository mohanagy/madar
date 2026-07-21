import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import type { Communities } from './cluster.js'
import { communityDetailsMid } from './community-details.js'

const MAX_SNIPPET_LINES = 15
const MAX_SNIPPET_LINE_LENGTH = 200
const DOCS_DIR_NAME = 'docs'

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function readSnippet(sourceFile: string, lineNumber: number): string | null {
  if (!sourceFile || lineNumber <= 0) {
    return null
  }

  try {
    if (!existsSync(sourceFile)) {
      return null
    }

    const content = readFileSync(sourceFile, 'utf8')
    const lines = content.split(/\r?\n/)
    const halfWindow = Math.floor(MAX_SNIPPET_LINES / 2)
    const start = Math.max(0, lineNumber - 1 - halfWindow)
    const end = Math.min(lines.length, lineNumber - 1 + halfWindow + 1)

    return lines
      .slice(start, end)
      .map((line) => (line.length > MAX_SNIPPET_LINE_LENGTH ? `${line.slice(0, MAX_SNIPPET_LINE_LENGTH)}...` : line))
      .join('\n')
  } catch {
    return null
  }
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).label ?? nodeId)
}

function generateCommunityDoc(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  communityId: number,
): string {
  const nodeIds = communities[communityId] ?? []
  const label = communityLabels[communityId] ?? `Community ${communityId}`
  const details = communityDetailsMid(graph, communities, communityLabels, communityId)

  const lines: string[] = []
  lines.push(`# ${label}`)
  lines.push('')
  lines.push(`**Nodes:** ${nodeIds.length} | **Community ID:** ${communityId}`)

  if (details?.dominant_file) {
    lines.push(`**Primary file:** \`${details.dominant_file}\``)
  }

  lines.push('')

  // Key nodes
  if (details && details.key_nodes.length > 0) {
    lines.push('## Key Components')
    lines.push('')
    lines.push('| Name | Kind | Connections |')
    lines.push('|------|------|-------------|')
    for (const node of details.key_nodes) {
      lines.push(`| \`${node.label}\` | ${node.node_kind || 'unknown'} | ${node.degree} |`)
    }
    lines.push('')
  }

  // Entry points
  if (details && details.entry_points.length > 0) {
    lines.push('## Entry Points')
    lines.push('')
    lines.push('These nodes are called from outside this module:')
    lines.push('')
    for (const entry of details.entry_points) {
      lines.push(`- \`${entry.label}\` (${entry.in_degree} external connections)`)
    }
    lines.push('')
  }

  // Exit points
  if (details && details.exit_points.length > 0) {
    lines.push('## Dependencies')
    lines.push('')
    lines.push('This module depends on:')
    lines.push('')
    const seen = new Set<string>()
    for (const exit of details.exit_points) {
      const key = `${exit.label}→${exit.target_community}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      lines.push(`- \`${exit.label}\` → **${exit.target_community}**`)
    }
    lines.push('')
  }

  // Bridge nodes
  if (details && details.bridge_nodes.length > 0) {
    lines.push('## Bridge Nodes')
    lines.push('')
    lines.push('These nodes connect this module to multiple other modules:')
    lines.push('')
    for (const bridge of details.bridge_nodes) {
      lines.push(`- \`${bridge}\``)
    }
    lines.push('')
  }

  // Code snippets for top 3 nodes
  const topNodes = [...nodeIds]
    .sort((a, b) => graph.degree(b) - graph.degree(a))
    .slice(0, 3)

  const snippets: Array<{ label: string; file: string; snippet: string }> = []
  for (const nodeId of topNodes) {
    const attributes = graph.nodeAttributes(nodeId)
    const lineNumber = typeof attributes.line_number === 'number' ? attributes.line_number : 0
    const sourceFile = String(attributes.source_file ?? '')
    const snippet = readSnippet(sourceFile, lineNumber)
    if (snippet) {
      snippets.push({
        label: nodeLabel(graph, nodeId),
        file: sourceFile,
        snippet,
      })
    }
  }

  if (snippets.length > 0) {
    lines.push('## Code')
    lines.push('')
    for (const { label: snippetLabel, file, snippet } of snippets) {
      lines.push(`### \`${snippetLabel}\``)
      lines.push('')
      lines.push(`Source: \`${file}\``)
      lines.push('')
      lines.push('```')
      lines.push(snippet)
      lines.push('```')
      lines.push('')
    }
  }

  return lines.join('\n')
}

function generateIndexDoc(
  communities: Communities,
  communityLabels: Record<number, string>,
  slugs: Map<number, string>,
): string {
  const lines: string[] = []
  lines.push('# Module Documentation')
  lines.push('')
  lines.push('Auto-generated from the madar knowledge graph.')
  lines.push('')
  lines.push('| Module | Nodes | File |')
  lines.push('|--------|-------|------|')

  const sorted = Object.entries(communities)
    .map(([idRaw, nodeIds]) => ({ id: Number(idRaw), nodeIds }))
    .sort((a, b) => b.nodeIds.length - a.nodeIds.length)

  for (const { id, nodeIds } of sorted) {
    if (nodeIds.length <= 1) {
      continue
    }
    const label = communityLabels[id] ?? `Community ${id}`
    const slug = slugs.get(id) ?? `community-${id}`
    lines.push(`| [${label}](./${slug}.md) | ${nodeIds.length} | \`${slug}.md\` |`)
  }

  lines.push('')
  return lines.join('\n')
}

export function generateDocs(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  outputDir: string,
): { docsPath: string; fileCount: number } {
  const docsPath = join(outputDir, DOCS_DIR_NAME)
  mkdirSync(docsPath, { recursive: true })

  const slugs = new Map<number, string>()
  const usedSlugs = new Set<string>()
  let fileCount = 0

  for (const [communityIdRaw, nodeIds] of Object.entries(communities)) {
    const communityId = Number(communityIdRaw)
    if (nodeIds.length <= 1) {
      continue
    }

    const label = communityLabels[communityId] ?? `Community ${communityId}`
    let slug = slugify(label)
    if (usedSlugs.has(slug)) {
      slug = `${slug}-${communityId}`
    }
    usedSlugs.add(slug)
    slugs.set(communityId, slug)

    const doc = generateCommunityDoc(graph, communities, communityLabels, communityId)
    writeFileSync(join(docsPath, `${slug}.md`), doc, 'utf8')
    fileCount += 1
  }

  const index = generateIndexDoc(communities, communityLabels, slugs)
  writeFileSync(join(docsPath, 'index.md'), index, 'utf8')
  fileCount += 1

  return { docsPath, fileCount }
}
