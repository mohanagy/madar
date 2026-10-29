import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isDiscoveryPathIgnored, loadMadarignorePatterns } from '../shared/source-discovery.js'
import { classifyRetrievalLevel, extractPromptExclusions, retrievalEvidencePrompt, retrievalSubjectPrompt } from './retrieval-gate.js'
import { tokenizeQuestion } from './retrieve/pipeline.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceBodyWords, sourceDeclarationKind, sourcePathForEvidence, sourceQueryIsLiteralLookup, sourceQueryLiterals } from './retrieve/source-evidence.js'
import { sourceQuerySymbols } from './retrieve/source-query-symbols.js'

type Node = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type Proof = { node: Node; path: string; range: Range; text: string; terms: Set<string>; literals: Set<string> }
// A lexical budget policy, not interpretation or removal of query conditions.
const PROSE_OPERATORS = new Set(['without', 'unless', 'until', 'before', 'after', 'during', 'within'])
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {}
function rangeOf(value: unknown): Range | null {
  const range = record(value)
  return Number.isSafeInteger(range.start_line) && Number.isSafeInteger(range.end_line)
    && Number(range.start_line) > 0 && Number(range.end_line) >= Number(range.start_line)
    ? range as Range : null
}

/** A source-checked relevance preference, never a redundancy or binding claim. */
function sourceBudgetPreference(
  prompt: string, rootPath: string, mode: 'container' | 'disconnected' | 'outside',
  ignoreProseOperators = false,
): (nodes: readonly Node[], relationships?: readonly Node[]) => string | undefined {
  // Refuse the optional policy before prompt normalization: a protected quote
  // may be beyond the bounded literal list or inside an exclusion directive.
  if (ignoreProseOperators && /['"`\u2018\u2019\u201c\u201d]/.test(prompt)) return () => undefined
  const subject = retrievalSubjectPrompt(extractPromptExclusions(prompt).positivePrompt)
  if (subject.length > 16_384) return () => undefined
  const paths = new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths.map(path => resolve(rootPath, path)))
  if (paths.size < 2 || paths.size > 8 || sourceQueryIsLiteralLookup(subject)) return () => undefined
  let realRoot: string, patterns: string[] = []
  try {
    realRoot = realpathSync(rootPath)
    const ignore = resolve(rootPath, '.madarignore')
    let exists = false
    try {
      lstatSync(ignore)
      exists = true
      const actual = realpathSync(ignore), local = relative(realRoot, actual), stat = statSync(actual)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !stat.isFile() || stat.size > 64 * 1024) return () => undefined
      patterns = loadMadarignorePatterns(rootPath)
      if (patterns.length > 1024) return () => undefined
    } catch (error) {
      if (exists || (error as NodeJS.ErrnoException).code !== 'ENOENT') return () => undefined
    }
  } catch { return () => undefined }
  // Older indexes can retain a bare member label. Protect every possible
  // same-leaf owner for a qualified request; this does not resolve its binding.
  const symbols = sourceQuerySymbols(subject)
  const names = new Set(symbols.flatMap(occurrence => [occurrence.name, occurrence.name.split('.').at(-1)!]))
  const symbolTerms = new Set(ignoreProseOperators ? symbols.flatMap(occurrence => sourceBodyWords(occurrence.name)) : [])
  const queryTerms = new Set(tokenizeQuestion(sourceBodyWords(subject).join(' ')).filter(term => term.length >= 3
    && (!ignoreProseOperators || !PROSE_OPERATORS.has(term) || symbolTerms.has(term))))
  const queryLiterals = sourceQueryLiterals(retrievalEvidencePrompt(prompt))
  const files = new Map<string, string[] | null>()
  let bytes = 0
  const proofCache = new WeakMap<Node, Proof | null>()
  const prove = (node: Node): Proof | null => {
    if (proofCache.has(node)) return proofCache.get(node)!
    const fail = (): null => { proofCache.set(node, null); return null }
    if (typeof node.node_id !== 'string' || typeof node.label !== 'string' || typeof node.source_file !== 'string'
      || typeof node.snippet !== 'string' || node.snippet_source === 'derived' || node.snippet_unverified === true
      || node.snippet_scope !== 'symbol') return fail()
    const range = rangeOf(node.snippet_line_range), logical = resolve(rootPath, node.source_file)
    if (!range || (mode !== 'outside' && !paths.has(logical)) || isDiscoveryPathIgnored(logical, rootPath, patterns)) return fail()
    const path = sourcePathForEvidence(logical, rootPath)
    if (!path || isDiscoveryPathIgnored(path, realRoot, patterns)) return fail()
    if (!files.has(path)) {
      if (files.size >= 8) return fail()
      const lines = readEvidenceLines(logical, rootPath)
      bytes += lines ? Buffer.byteLength(lines.join('\n')) : 0
      files.set(path, bytes <= 1024 * 1024 ? lines : null)
    }
    const lines = files.get(path)
    if (!lines || range.end_line > lines.length
      || sourceDeclarationKind(lines, { start: range.start_line, end: range.end_line }, node.label, path) !== 'function') return fail()
    const omitted = node.snippet_omitted_ranges ?? []
    if (!Array.isArray(omitted) || node.snippet_truncated === true && !omitted.length) return fail()
    const rendered: string[] = [], source: string[] = []
    let cursor = range.start_line
    for (const value of omitted) {
      const gap = rangeOf(value)
      if (!gap || gap.start_line < cursor || gap.end_line > range.end_line) return fail()
      const part = lines.slice(cursor - 1, gap.start_line - 1)
      rendered.push(...part, `[omitted lines ${gap.start_line}-${gap.end_line}]`); source.push(...part)
      cursor = gap.end_line + 1
    }
    const tail = lines.slice(cursor - 1, range.end_line)
    rendered.push(...tail); source.push(...tail)
    if (rendered.join('\n') !== node.snippet) return fail()
    const text = source.join('\n'), words = new Set(sourceBodyWords(text))
    const proof = { node, path, range, text,
      terms: new Set([...queryTerms].filter(term => words.has(term))),
      literals: new Set(queryLiterals.filter(literal => {
        if (!/^#?[A-Za-z_$][\w$]*$/.test(literal)) return text.includes(literal)
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`).test(text)
      })) }
    proofCache.set(node, proof)
    return proof
  }
  return (nodes, relationships) => {
    // The absence of a relationship receipt is not proof of disconnection.
    if (mode === 'outside' && !Array.isArray(relationships)) return undefined
    if (nodes.length > 128) return undefined
    const ids = new Set(nodes.map(node => node.node_id))
    if (ids.size !== nodes.length) return undefined
    const references = new Set(nodes.flatMap(node => typeof node.snippet_ref === 'string' ? [node.snippet_ref] : []))
    const proofs = nodes.flatMap(node => { const proof = prove(node); return proof ? [proof] : [] })
    const localSources = new Set(proofs.filter(proof => paths.has(resolve(rootPath, String(proof.node.source_file)))).map(proof => proof.path))
    if (mode === 'outside' && !localSources.size) return undefined
    // Re-evaluate uniqueness after every removal. A later tail eviction must
    // not leave the remaining container's query evidence unprotected.
    const eligible = proofs.filter(owner => {
      if (owner.node.snippet_ref || references.has(String(owner.node.node_id))) return false
      const name = String(owner.node.label).replace(/\(\)$/, '')
      if (names.has(name) || names.has(name.split('.').at(-1)!)) return false
      const others = proofs.filter(proof => proof !== owner)
      if ([...owner.terms].some(term => !others.some(proof => proof.terms.has(term)))
        || [...owner.literals].some(literal => !others.some(proof => proof.literals.has(literal)))) return false
      if (mode === 'outside') {
        if (localSources.has(owner.path) || owner.node.snippet_ref !== undefined
          || owner.node.source_expand_handle !== undefined
          || owner.node.snippet_truncated !== undefined && owner.node.snippet_truncated !== false
          || owner.node.snippet_omitted_ranges !== undefined && !Array.isArray(owner.node.snippet_omitted_ranges)
          || Array.isArray(owner.node.snippet_omitted_ranges) && owner.node.snippet_omitted_ranges.length > 0
          || !others.some(proof => proof.terms.size > 0 || proof.literals.size > 0)) return false
        const lines = files.get(owner.path)
        const complete = lines && resolveSourceSymbolRange(lines, { start: owner.range.start_line, end: owner.range.end_line }, String(owner.node.label), owner.path)
        if (!complete || complete.start !== owner.range.start_line || complete.end !== owner.range.end_line) return false
        return !relationships!.some(edge => edge.from_id === owner.node.node_id || edge.to_id === owner.node.node_id
          || edge.from === owner.node.label || edge.to === owner.node.label)
      }
      if (mode === 'disconnected') {
        if (owner.node.source_expand_handle || owner.node.snippet_truncated === true
          || Array.isArray(owner.node.snippet_omitted_ranges) && owner.node.snippet_omitted_ranges.length > 0
          || !others.some(proof => proof.path === owner.path)) return false
        // Preserve every represented relationship, including non-call edges and
        // legacy label endpoints. An absent edge is not proof of irrelevance.
        return !(relationships ?? []).some(edge => edge.from_id === owner.node.node_id || edge.to_id === owner.node.node_id
          || edge.from === owner.node.label || edge.to === owner.node.label)
      }
      return others.some(child => child.path === owner.path
        && child.range.start_line > owner.range.start_line && child.range.end_line < owner.range.end_line)
    })
    eligible.sort((left, right) => mode === 'container'
      ? (right.range.end_line - right.range.start_line) - (left.range.end_line - left.range.start_line)
      : (left.range.end_line - left.range.start_line) - (right.range.end_line - right.range.start_line))
    return eligible[0]?.node.node_id as string | undefined
  }
}

export function sourceContainerBudgetPreference(prompt: string, rootPath: string): (nodes: readonly Node[]) => string | undefined {
  return sourceBudgetPreference(prompt, rootPath, 'container')
}

/** Prefer complete disconnected source outside exact file hints only during necessary eviction. */
export function sourceOutsideFileBudgetPreference(
  prompt: string, rootPath: string, options: { ignoreProseOperators?: boolean } = {},
): (nodes: readonly Node[], relationships: readonly Node[]) => string | undefined {
  return sourceBudgetPreference(prompt, rootPath, 'outside', options.ignoreProseOperators === true)
}

/** Only used to make room for an already verified atomic callsite addition. */
export function sourceDisconnectedBudgetPreference(prompt: string, rootPath: string): (nodes: readonly Node[], relationships: readonly Node[]) => string | undefined {
  return sourceBudgetPreference(prompt, rootPath, 'disconnected')
}
