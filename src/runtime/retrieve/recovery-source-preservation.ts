import type { KnowledgeGraph } from '../../contracts/graph.js'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import type { RetrieveMatchedNode, RetrieveResult } from '../retrieve.js'
import { evaluateQueryEvidenceCoverage } from './conceptual-fallback.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationKind, sourcePathForEvidence, sourceQueryLiterals } from './source-evidence.js'

export interface RecoverySourceEvidenceLoss {
  protected_spans: number
  lost_spans: number
}

interface VerifiedSpan {
  path: string
  start: number
  end: number
  lines: Map<number, string>
}

// Keep provenance across recovery stages even when retained source is rendered
// as a file excerpt or split into other node identities. Result metadata spreads
// preserve this array; weak keys do not retain completed requests.
const carriedSpans = new WeakMap<RetrieveResult['matched_nodes'], {
  graph: KnowledgeGraph
  question: string
  root: string | undefined
  spans: ReadonlyMap<string, VerifiedSpan>
}>()

/** Validate delivered text and omissions against source, independent of node IDs. */
function verifiedSpan(node: RetrieveMatchedNode, root: string, cache: Map<string, string[] | null>): VerifiedSpan | null {
  const range = node.snippet_line_range
  if (node.snippet_unverified || !node.snippet || !range
    || !Number.isInteger(range.start_line) || !Number.isInteger(range.end_line)
    || range.start_line < 1 || range.end_line < range.start_line) return null
  const path = sourcePathForEvidence(node.source_file, root)
  const source = path ? readEvidenceLines(node.source_file, root, cache) : null
  if (!path || !source || range.end_line > source.length) return null
  const omissions = [...(node.snippet_omitted_ranges ?? [])].sort((a, b) => a.start_line - b.start_line)
  const lines = new Map<number, string>()
  const text: string[] = []
  let next = range.start_line
  for (const omission of omissions) {
    if (!Number.isInteger(omission.start_line) || !Number.isInteger(omission.end_line)
      || omission.start_line < next || omission.end_line < omission.start_line || omission.end_line > range.end_line) return null
    for (; next < omission.start_line; next += 1) {
      const line = source[next - 1]!
      text.push(line)
      if (line.trim()) lines.set(next, line)
    }
    text.push(`[omitted lines ${omission.start_line}-${omission.end_line}]`)
    next = omission.end_line + 1
  }
  for (; next <= range.end_line; next += 1) {
    const line = source[next - 1]!
    text.push(line)
    if (line.trim()) lines.set(next, line)
  }
  return text.join('\n') === node.snippet && lines.size > 0
    ? { path, start: range.start_line, end: range.end_line, lines }
    : null
}

function carriesQueryEvidence(question: string, snippet: string): boolean {
  const literalMatch = sourceQueryLiterals(question).some(literal => {
    if (!/^[A-Za-z_$][\w$]*$/.test(literal)) return snippet.includes(literal)
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`).test(snippet)
  })
  // Deliberately exclude labels and paths: evidence must occur in delivered code.
  return literalMatch || evaluateQueryEvidenceCoverage(question, [{ label: '', source_file: '', snippet }]).covered > 0
}

/**
 * Recovery may improve ranking, but it must not discard verified executable
 * evidence already selected for this question. Work is bounded by the two
 * selected packs and the existing source read limits; no corpus search occurs.
 * This is source non-regression, not a claim that the original answer is complete.
 */
export function recoverySourceGuard(graph: KnowledgeGraph, initial: RetrieveResult, question: string, projectRoot?: string): (candidate: RetrieveResult) => RecoverySourceEvidenceLoss {
  const root = typeof graph.graph.root_path === 'string' ? graph.graph.root_path : projectRoot
  const cache = new Map<string, string[] | null>()
  const carried = carriedSpans.get(initial.matched_nodes)
  const protectedSpans = new Map(carried?.graph === graph && carried.question === question && carried.root === root ? carried.spans : undefined)
  if (root) {
    for (const node of initial.matched_nodes) {
      if (node.relevance_band !== 'direct' || node.file_type !== 'code' || node.snippet_scope !== 'symbol'
        || !node.node_id || !graph.hasNode(node.node_id)) continue
      const attributes = graph.nodeAttributes(node.node_id)
      const range = lineRangeFromSourceLocation(attributes.source_location)
      const lines = readEvidenceLines(node.source_file, root, cache)
      const label = String(attributes.label ?? node.label)
      if (!range || !lines || sourceDeclarationKind(lines, range, label, node.source_file) !== 'function') continue
      const owner = resolveSourceSymbolRange(lines, range, label, node.source_file)
      const span = verifiedSpan(node, root, cache)
      if (!span || !owner || span.start < owner.start || span.end > owner.end
        || sourcePathForEvidence(String(attributes.source_file ?? ''), root) !== span.path
        || !carriesQueryEvidence(question, node.snippet!)) continue
      protectedSpans.set(`${span.path}\u0000${span.start}\u0000${span.end}`, span)
    }
  }
  const provenance = { graph, question, root, spans: protectedSpans }
  carriedSpans.set(initial.matched_nodes, provenance)
  return candidate => {
    const retained = new Map<string, Map<number, string>>()
    if (root && protectedSpans.size > 0) {
      const protectedPaths = new Set([...protectedSpans.values()].map(span => span.path))
      for (const node of candidate.matched_nodes) {
        const path = sourcePathForEvidence(node.source_file, root)
        if (!path || !protectedPaths.has(path)) continue
        const span = verifiedSpan(node, root, cache)
        if (!span) continue
        const lines = retained.get(path) ?? new Map<number, string>()
        for (const [line, text] of span.lines) lines.set(line, text)
        retained.set(path, lines)
      }
    }
    const lost = [...protectedSpans.values()].filter(span => {
      const lines = retained.get(span.path)
      return [...span.lines].some(([line, text]) => lines?.get(line) !== text)
    })
    if (lost.length === 0) carriedSpans.set(candidate.matched_nodes, provenance)
    return { protected_spans: protectedSpans.size, lost_spans: lost.length }
  }
}
