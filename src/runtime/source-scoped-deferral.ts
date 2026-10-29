import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'

import type { ContextPackNode } from '../contracts/context-pack.js'
import { sourceFunctionOccurrence } from '../shared/source-function-occurrences.js'
import type { RetrieveResult } from './retrieve.js'
import { classifyRetrievalLevel, extractPromptExclusions, retrievalSubjectPrompt } from './retrieval-gate.js'
import { sourceSelectionProvenanceKey } from './retrieve/source-dependencies.js'
import { readEvidenceLines, sourceBodyWords, sourceDeclarationKind, sourceDeclarationQualifiedName, sourceQueryIsLiteralLookup, sourceQueryLiterals } from './retrieve/source-evidence.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './retrieve/source-modules.js'
import { tokenizeQuestion } from './retrieve/pipeline.js'

/** Protect visible query witnesses; this can only reduce a proposed deferral. */
export function protectSourceQueryWitnesses(
  question: string, nodes: readonly ContextPackNode[], retainedIds: ReadonlySet<string>, root: string,
  cache = new Map<string, string[] | null>(),
  sourceFiles?: ReadonlySet<string>,
): Set<string> {
  const protectedIds = new Set(retainedIds)
  const protectAll = (): Set<string> => new Set([...protectedIds, ...nodes.flatMap(node => node.node_id ? [node.node_id] : [])])
  if (question.length > 16_384 || nodes.length > 128) return protectAll()
  const positive = retrievalSubjectPrompt(extractPromptExclusions(question).positivePrompt)
  const terms = new Set(tokenizeQuestion(sourceBodyWords(positive).join(' ')).filter(term => term.length >= 3))
  const literals = sourceQueryLiterals(positive)
  // The shared literal parser is capped; unknown remaining evidence is retained.
  if (literals.length >= 8) return protectAll()
  const containsLiteral = (text: string, literal: string): boolean => {
    if (!/^#?[A-Za-z_$][\w$]*$/.test(literal)) return text.includes(literal)
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`).test(text)
  }
  const visibleText = new Map<string, string>()
  for (const node of nodes) {
    if (node.snippet_ref) protectedIds.add(node.snippet_ref)
    if (!node.node_id) continue
    if (sourceFiles && !sourceFiles.has(resolve(root, node.source_file))) {
      protectedIds.add(node.node_id); continue
    }
    const lines = readEvidenceLines(node.source_file, root, cache), range = node.snippet_line_range
    if (!lines || !range || !node.snippet || node.snippet_unverified || node.snippet_source === 'derived') {
      protectedIds.add(node.node_id); continue
    }
    const gaps = node.snippet_omitted_ranges ?? [], rendered: string[] = [], visible: string[] = []
    let cursor = range.start_line, valid = Number.isSafeInteger(cursor) && Number.isSafeInteger(range.end_line)
      && cursor >= 1 && range.end_line >= cursor && range.end_line <= lines.length
    for (const gap of gaps) {
      if (!Number.isSafeInteger(gap.start_line) || !Number.isSafeInteger(gap.end_line)
        || gap.start_line < cursor || gap.end_line < gap.start_line || gap.end_line > range.end_line) { valid = false; break }
      const part = lines.slice(cursor - 1, gap.start_line - 1)
      rendered.push(...part, `[omitted lines ${gap.start_line}-${gap.end_line}]`); visible.push(...part); cursor = gap.end_line + 1
    }
    const tail = lines.slice(cursor - 1, range.end_line); rendered.push(...tail); visible.push(...tail)
    if (!valid || rendered.join('\n') !== node.snippet) protectedIds.add(node.node_id)
    else visibleText.set(node.node_id, visible.join('\n'))
  }
  // Only permanently retained authenticated text can justify a deferral.
  // Two proposed deferrals must never justify removing each other's witness.
  const retainedWords = new Set<string>(), retainedLiterals = new Set<string>()
  for (const [id, text] of visibleText) if (protectedIds.has(id)) {
    for (const word of sourceBodyWords(text)) retainedWords.add(word)
    for (const literal of literals) if (containsLiteral(text, literal)) retainedLiterals.add(literal)
  }
  for (const [id, text] of visibleText) {
    if (protectedIds.has(id)) continue
    const words = new Set(sourceBodyWords(text))
    if ([...terms].some(term => words.has(term) && !retainedWords.has(term))
      || literals.some(literal => containsLiteral(text, literal) && !retainedLiterals.has(literal))) protectedIds.add(id)
  }
  return protectedIds
}

/** A partial-context preference, never proof that a deferred owner is irrelevant. */
export function scopedSourceDeferralCore(
  retrieval: RetrieveResult, nodes: readonly ContextPackNode[], root: string,
): { question: string; node_ids: string[]; selected_node_ids: string[] } | undefined {
  const question = retrieval.question, provenance = retrieval[sourceSelectionProvenanceKey]
  if (retrieval.selection_scope !== 'task_context' || retrieval.task_contract?.task_kind !== 'explain'
    || !provenance || question.length > 16_384 || !nodes.length || nodes.length > 128
    || /['"`\u2018\u2019\u201c\u201d]/.test(question)
    || retrieval.relationships.some(edge => !edge.from_id || !edge.to_id)) return undefined
  const positive = retrievalSubjectPrompt(extractPromptExclusions(question).positivePrompt)
  if (sourceQueryIsLiteralLookup(positive)
    || /\b(?:all|every|entire|complete|callers?|callees?|calls|called|dependencies|dependents?|invok\w*|trace|flow|workflow|impact|affected|compare|contrast|versus|across)\b/i.test(positive)) return undefined
  const location = /^\s*(?:in|within|under)\s+([`"']?)([^\s`"',;]+)\1/i.exec(positive)?.[2]
  // Dotted member names may also appear in mentioned_paths. Only supported
  // source-file extensions establish this policy's concrete JavaScript scope.
  const paths = classifyRetrievalLevel({ prompt: question }).signals.mentioned_paths.filter(path => /\.[cm]?[jt]sx?$/i.test(path))
  if (!location || !/\.[cm]?[jt]sx?$/i.test(location) || /\.d\.[cm]?tsx?$/i.test(location)
    || paths.length !== 1 || resolve(root, paths[0]!) !== resolve(root, location)) return undefined
  if (provenance.root_path !== resolve(root)
    || ['source_loading', 'program', 'identity', 'calls', 'mutation'].some(key =>
      provenance.scans[key as keyof typeof provenance.scans] !== 'complete')
    || !sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, root)) return undefined
  const scope = resolve(root, location), sources = provenance.sources
  if (!sources.length || sources.length > 32) return undefined
  const cache = new Map<string, string[] | null>()
  let bytes = 0
  for (const source of sources) {
    const lines = readEvidenceLines(source.source_file, root, cache)
    if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024
      || createHash('sha256').update(lines.join('\n')).digest('hex') !== source.source_sha256) return undefined
  }
  const ids = nodes.flatMap(node => node.node_id ? [node.node_id] : [])
  if (ids.length !== nodes.length || new Set(ids).size !== ids.length) return undefined
  const scopeLines = cache.get(scope)
  if (!scopeLines) return undefined
  const syntax = ts.createSourceFile(scope, scopeLines.join('\n'), ts.ScriptTarget.Latest, true)
  if ((syntax as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
  const declarations = new Map<string, Array<{ start: number; end: number; body: boolean }>>()
  let visited = 0, complete = true
  const scan = (node: ts.Node): void => {
    if (!complete) return
    if (++visited > 100_000) { complete = false; return }
    const occurrence = sourceFunctionOccurrence(node, syntax)
    const callable = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    const body = callable ? node.body
      : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.initializer.body : undefined
    const nameNode = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node) || ts.isVariableDeclaration(node) ? node.name : undefined
    const named = (callable || body) && nameNode && ts.isIdentifier(nameNode) ? nameNode.text : undefined
    const name = occurrence?.name ?? named
    if (name) {
      const ranges = declarations.get(name) ?? []
      ranges.push(occurrence ? { start: occurrence.start, end: occurrence.end, body: true }
        : { start: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1,
          end: syntax.getLineAndCharacterOfPosition(node.getEnd()).line + 1, body: !!body })
      declarations.set(name, ranges)
    }
    ts.forEachChild(node, scan)
  }
  scan(syntax)
  if (!complete) return undefined
  const owners = new Map(provenance.owners.map(owner => [owner.node_id, owner]))
  let protectedIds = new Set([...provenance.seed_ids, ...provenance.forward.known_reachable_ids,
    ...(provenance.seed_origins?.requested_member_ids ?? []), ...(provenance.seed_origins?.helper_request_ids ?? []),
    ...(provenance.seed_origins?.explicit_symbol_candidate_ids ?? []), ...(provenance.seed_origins?.named_file_member_ids ?? [])])
  // Conservative protection only: an exact spelling in prose does not admit a
  // new owner, but prevents us from deferring one already delivered. This also
  // protects lowercase names that the request grammar has not recognized.
  const names = new Set(positive.match(/[A-Za-z_$][\w$]*/g) ?? [])
  for (const node of nodes) {
    const id = node.node_id!, owner = owners.get(id), name = node.label.replace(/\(\)$/, '')
    if (names.has(name) || names.has(name.split('.').at(-1)!)) protectedIds.add(id)
    if (node.snippet_ref) protectedIds.add(node.snippet_ref)
    const range = node.snippet_line_range
    const lines = cache.get(scope)
    const concrete = declarations.get(name)
    if (protectedIds.has(id) || owner?.status !== 'unique' || resolve(root, node.source_file) !== scope
      || owner.source_file !== scope || !/^[A-Za-z_$][\w$]*$/.test(name)
      || node.snippet_source === 'derived' || node.snippet_unverified || node.source_expand_handle
      || node.snippet_ref || node.snippet_truncated || node.snippet_omitted_ranges?.length
      || node.snippet_scope !== 'symbol' || !range || !lines || range.start_line < 1 || range.end_line > lines.length
      || concrete?.length !== 1 || !concrete[0]!.body || concrete[0]!.start !== range.start_line || concrete[0]!.end !== range.end_line
      || owner.indexed_range.start !== range.start_line || owner.indexed_range.end !== range.end_line
      || sourceDeclarationKind(lines, { start: range.start_line, end: range.end_line }, node.label, scope) !== 'function'
      || sourceDeclarationQualifiedName(lines, { start: range.start_line, end: range.end_line }, node.label, scope) !== name
      || lines.slice(range.start_line - 1, range.end_line).join('\n') !== node.snippet) {
      protectedIds.add(id)
    }
  }
  protectedIds = protectSourceQueryWitnesses(question, nodes, protectedIds, root, cache,
    new Set(sources.map(source => resolve(root, source.source_file))))
  if (!ids.some(id => !protectedIds.has(id))) return undefined
  return { question, node_ids: ids.filter(id => protectedIds.has(id)), selected_node_ids: ids }
}
