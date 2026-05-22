import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'

export interface WikiOptions {
  communityLabels?: Record<number, string>
  cohesion?: Record<number, number>
  godNodes?: Array<{ id: string; label: string; edges: number }>
}

const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const FORBIDDEN_FILENAME_CHARS = /[<>:"|?*\\/]/g

export function safeFilename(name: string): string {
  const sanitized = name.replace(FORBIDDEN_FILENAME_CHARS, '-').replaceAll(' ', '_').trim()
  const candidate = WINDOWS_RESERVED_NAME.test(sanitized) ? `_${sanitized}` : sanitized
  return candidate.slice(0, 200)
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

export function crossCommunityLinks(graph: KnowledgeGraph, nodes: string[], ownCommunityId: number, labels: Record<number, string>): Array<[string, number]> {
  const counts = new Map<string, number>()

  for (const nodeId of nodes) {
    for (const connection of nodeConnections(graph, nodeId)) {
      const neighborAttributes = graph.nodeAttributes(connection.neighborId)
      const community = neighborAttributes.community
      if (typeof community !== 'number' || community === ownCommunityId) {
        continue
      }
      const label = labels[community] ?? `Community ${community}`
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
}

export function communityArticle(graph: KnowledgeGraph, communityId: number, nodes: string[], label: string, labels: Record<number, string>, cohesion?: number): string {
  const topNodes = [...nodes].sort((left, right) => graph.degree(right) - graph.degree(left) || left.localeCompare(right)).slice(0, 25)
  const crossLinks = crossCommunityLinks(graph, nodes, communityId, labels)
  const confidenceCounts = new Map<string, number>()

  for (const nodeId of nodes) {
    for (const connection of nodeConnections(graph, nodeId)) {
      const confidence = String(connection.attributes.confidence ?? 'EXTRACTED')
      confidenceCounts.set(confidence, (confidenceCounts.get(confidence) ?? 0) + 1)
    }
  }

  const totalEdges = [...confidenceCounts.values()].reduce((sum, value) => sum + value, 0) || 1
  const sourceFiles = [...new Set(nodes.map((nodeId) => String(graph.nodeAttributes(nodeId).source_file ?? '')).filter((value) => value.length > 0))].sort()

  const lines = [
    `# ${label}`,
    '',
    `> ${[`${nodes.length} nodes`, cohesion !== undefined ? `cohesion ${cohesion.toFixed(2)}` : null].filter((value): value is string => value !== null).join(' · ')}`,
    '',
    '## Key Concepts',
    '',
  ]

  for (const nodeId of topNodes) {
    const attributes = graph.nodeAttributes(nodeId)
    const nodeLabel = String(attributes.label ?? nodeId)
    const sourceFile = String(attributes.source_file ?? '')
    lines.push(`- **${nodeLabel}** (${graph.degree(nodeId)} connections)${sourceFile ? ` — \`${sourceFile}\`` : ''}`)
  }

  const remaining = nodes.length - topNodes.length
  if (remaining > 0) {
    lines.push(`- *... and ${remaining} more nodes in this community*`)
  }

  lines.push('', '## Relationships', '')
  if (crossLinks.length > 0) {
    for (const [otherLabel, count] of crossLinks.slice(0, 12)) {
      lines.push(`- [[${otherLabel}]] (${count} shared connections)`)
    }
  } else {
    lines.push('- No strong cross-community connections detected')
  }

  lines.push('')
  if (sourceFiles.length > 0) {
    lines.push('## Source Files', '')
    for (const sourceFile of sourceFiles.slice(0, 20)) {
      lines.push(`- \`${sourceFile}\``)
    }
    lines.push('')
  }

  lines.push('## Audit Trail', '')
  for (const confidence of ['EXTRACTED', 'INFERRED', 'AMBIGUOUS']) {
    const count = confidenceCounts.get(confidence) ?? 0
    const percent = Math.round((count / totalEdges) * 100)
    lines.push(`- ${confidence}: ${count} (${percent}%)`)
  }

  lines.push('', '---', '', '*Part of the madar knowledge wiki. See [[index]] to navigate.*')
  return lines.join('\n')
}

export function godNodeArticle(graph: KnowledgeGraph, nodeId: string, labels: Record<number, string>): string {
  const attributes = graph.nodeAttributes(nodeId)
  const nodeLabel = String(attributes.label ?? nodeId)
  const sourceFile = String(attributes.source_file ?? '')
  const community = typeof attributes.community === 'number' ? attributes.community : null
  const communityName = community !== null ? (labels[community] ?? `Community ${community}`) : null
  const byRelation = new Map<string, string[]>()

  for (const connection of [...nodeConnections(graph, nodeId)].sort((left, right) => {
    return graph.degree(right.neighborId) - graph.degree(left.neighborId) || left.neighborId.localeCompare(right.neighborId)
  })) {
    const neighborAttributes = graph.nodeAttributes(connection.neighborId)
    const relation = String(connection.attributes.relation ?? 'related')
    const confidence = String(connection.attributes.confidence ?? '')
    const target = `${connectionPrefix(connection.direction)}[[${String(neighborAttributes.label ?? connection.neighborId)}]]${confidence ? ` \`${confidence}\`` : ''}`
    byRelation.set(relation, [...(byRelation.get(relation) ?? []), target])
  }

  const lines = [`# ${nodeLabel}`, '', `> God node · ${graph.degree(nodeId)} connections · \`${sourceFile}\``, '']

  if (communityName) {
    lines.push(`**Community:** [[${communityName}]]`, '')
  }

  lines.push('## Connections by Relation', '')
  for (const [relation, targets] of [...byRelation.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    lines.push(`### ${relation}`)
    for (const target of targets.slice(0, 20)) {
      lines.push(`- ${target}`)
    }
    lines.push('')
  }

  lines.push('---', '', '*Part of the madar knowledge wiki. See [[index]] to navigate.*')
  return lines.join('\n')
}

export function indexMd(
  communities: Record<number, string[]>,
  labels: Record<number, string>,
  godNodes: Array<{ id: string; label: string; edges: number }>,
  totalNodes: number,
  totalEdges: number,
): string {
  const lines = [
    '# Knowledge Graph Index',
    '',
    '> Auto-generated by madar. Start here — read community articles for context, then drill into god nodes for detail.',
    '',
    `**${totalNodes} nodes · ${totalEdges} edges · ${Object.keys(communities).length} communities**`,
    '',
    '---',
    '',
    '## Communities',
    '(sorted by size, largest first)',
    '',
  ]

  for (const [communityId, nodes] of Object.entries(communities).sort((left, right) => right[1].length - left[1].length || Number(left[0]) - Number(right[0]))) {
    const label = labels[Number(communityId)] ?? `Community ${communityId}`
    lines.push(`- [[${label}]] — ${nodes.length} nodes`)
  }

  lines.push('')
  if (godNodes.length > 0) {
    lines.push('## God Nodes', '(most connected concepts — the load-bearing abstractions)', '')
    for (const node of godNodes) {
      lines.push(`- [[${node.label}]] — ${node.edges} connections`)
    }
    lines.push('')
  }

  lines.push('---', '', '*Generated by [madar](https://github.com/safishamsi/madar)*')
  return lines.join('\n')
}

export function toWiki(graph: KnowledgeGraph, communities: Record<number, string[]>, outputDir: string, options: WikiOptions = {}): number {
  mkdirSync(outputDir, { recursive: true })

  const labels = options.communityLabels ?? Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Community ${communityId}`]))
  const cohesion = options.cohesion ?? {}
  const godNodes = options.godNodes ?? []
  let count = 0

  for (const [communityId, nodes] of Object.entries(communities)) {
    const numericCommunityId = Number(communityId)
    const label = labels[numericCommunityId] ?? `Community ${communityId}`
    const article = communityArticle(graph, numericCommunityId, nodes, label, labels, cohesion[numericCommunityId])
    writeFileSync(join(outputDir, `${safeFilename(label)}.md`), article, 'utf8')
    count += 1
  }

  for (const godNode of godNodes) {
    if (!graph.hasNode(godNode.id)) {
      continue
    }
    writeFileSync(join(outputDir, `${safeFilename(godNode.label)}.md`), godNodeArticle(graph, godNode.id, labels), 'utf8')
    count += 1
  }

  writeFileSync(join(outputDir, 'index.md'), indexMd(communities, labels, godNodes, graph.numberOfNodes(), graph.numberOfEdges()), 'utf8')
  return count
}
