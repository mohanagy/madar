import ts from 'typescript'

import { readEvidenceLines, sourcePathForEvidence } from './retrieve/source-evidence.js'
import { extractPromptExclusions, retrievalSubjectPrompt, retrievalSymbolKeywordPrompt } from './retrieval-gate.js'

type SourceNode = Record<string, unknown>
interface Range { start_line: number; end_line: number }
export interface CompleteRequestedSymbol { node_index: number; snippet: string }

/** Deliberately narrower than discovery: prose and arbitrary error strings are not owners. */
export function requestedSourceSymbols(prompt: string): string[] {
  const subject = retrievalSubjectPrompt(extractPromptExclusions(prompt).positivePrompt)
    .replace(/(?:[A-Za-z0-9_$.-]+\/)+[A-Za-z0-9_$.-]+\.[cm]?[jt]sx?\b/g, ' ')
  const names = new Set<string>()
  const add = (name: string): void => {
    if (!/\.[cm]?[jt]sx?$/i.test(name)) names.add(name.replace(/\(\)$/, ''))
  }
  // The request noun must be prose; its quoted operand may still name an owner.
  const keywordSubject = retrievalSymbolKeywordPrompt(prompt)
    .replace(/(?:[A-Za-z0-9_$.-]+\/)+[A-Za-z0-9_$.-]+\.[cm]?[jt]sx?\b/g, ' ')
  for (const match of keywordSubject.matchAll(/\b(?:functions?|methods?|symbols?)\s+[`'"]?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) add(match[1]!)
  // Quoted data and error strings do not authorize the enclosing source body.
  const codeSubject = subject.replace(/(["'])[^\n]*?\1/g, ' ')
    .replace(/\b(?:where|which)\b[^?\n]*`[^`\n]+`[^?\n]*\b(?:thrown|logged|printed|reported|emitted)\b[^?\n]*/gi, ' ')
  for (const match of codeSubject.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) add(match[1]!)
  for (const match of codeSubject.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g)) {
    // An error-code location request must not grow the enclosing function.
    if (!/^[A-Z][A-Z0-9_]*$/.test(match[1]!)) add(match[1]!)
  }
  for (const match of codeSubject.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g)) {
    const name = match[0]
    if ((/[a-z][A-Z]|[a-z]_[a-z]|\./.test(name)) && !/^[A-Z][A-Z0-9_]*$/.test(name)) add(name)
  }
  // Do not silently complete a prefix of an unmarked list ("foo() and bar").
  // Ambiguous plain prose tails are conservative no-ops rather than guessed owners.
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const continuation = new RegExp('(?:^|[^A-Za-z0-9_$])' + escaped + '(?:\\(\\))?[`\'"]?\\s*(?:,\\s*(?:and\\s+)?|(?:and|or)\\s+)[`\'"]?([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)', 'g')
    for (const match of subject.matchAll(continuation)) {
      if (!names.has(match[1]!) && !/^(?:functions?|methods?|symbols?)$/.test(match[1]!)) return []
    }
  }
  return [...names]
}

function rangeOf(value: unknown): Range | null {
  if (!value || typeof value !== 'object') return null
  const range = value as Range
  return Number.isInteger(range.start_line) && Number.isInteger(range.end_line)
    && range.start_line > 0 && range.end_line >= range.start_line ? range : null
}

function excerptMatches(node: SourceNode, lines: readonly string[], range: Range): boolean {
  if (typeof node.snippet !== 'string' || node.snippet_unverified === true || node.snippet_source === 'derived') return false
  const omitted = node.snippet_omitted_ranges ?? []
  if (!Array.isArray(omitted)) return false
  const gaps: Range[] = []
  for (const value of omitted) {
    const gap = rangeOf(value)
    if (!gap || gap.start_line < range.start_line || gap.end_line > range.end_line
      || gap.start_line <= (gaps.at(-1)?.end_line ?? 0)) return false
    gaps.push(gap)
  }
  // A truncated representation without exact omitted ranges is not source proof.
  if (node.snippet_truncated === true && gaps.length === 0) return false
  const text: string[] = []
  let line = range.start_line
  for (const gap of gaps) {
    text.push(...lines.slice(line - 1, gap.start_line - 1), `[omitted lines ${gap.start_line}-${gap.end_line}]`)
    line = gap.end_line + 1
  }
  text.push(...lines.slice(line - 1, range.end_line))
  return text.join('\n') === node.snippet
}

/** Atomic candidate set: every positively requested symbol must have one exact source owner. */
export function completeRequestedSymbolCandidates(nodes: readonly SourceNode[], prompt: string, rootPath: string): CompleteRequestedSymbol[] {
  const requested = requestedSourceSymbols(prompt)
  if (requested.length === 0 || requested.length > 8) return []
  const cache = new Map<string, string[] | null>()
  const parsed = new Map<string, Array<{ name: string; qualified: string; range: Range }>>()
  const matches = new Map<string, Map<string, CompleteRequestedSymbol[]>>()
  for (const name of requested) matches.set(name, new Map())
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.snippet_scope !== 'symbol' || typeof node.source_file !== 'string' || typeof node.label !== 'string'
      || !/\.[cm]?[jt]sx?$/i.test(node.source_file)) continue
    const range = rangeOf(node.snippet_line_range)
    const path = sourcePathForEvidence(node.source_file, rootPath)
    if (!range || !path) continue
    const lines = readEvidenceLines(node.source_file, rootPath, cache)
    if (!lines || range.end_line > lines.length || !excerptMatches(node, lines, range)) continue
    if (!parsed.has(path)) {
      const source = ts.createSourceFile(path, lines.join('\n'), ts.ScriptTarget.Latest, true)
      if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) continue
      const declarations: Array<{ name: string; qualified: string; range: Range }> = []
      const visit = (declaration: ts.Node): void => {
        if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
          || (ts.isVariableDeclaration(declaration) && declaration.initializer
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))))
          && declaration.name && ts.isIdentifier(declaration.name)
          && (!ts.isFunctionLike(declaration) || !!declaration.body)) {
          const containers: string[] = []
          for (let parent = declaration.parent; parent; parent = parent.parent) {
            if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isModuleDeclaration(parent))
              && parent.name && ts.isIdentifier(parent.name)) containers.unshift(parent.name.text)
          }
          declarations.push({ name: declaration.name.text, qualified: [...containers, declaration.name.text].join('.'),
            range: { start_line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
              end_line: source.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1 } })
        }
        ts.forEachChild(declaration, visit)
      }
      visit(source)
      parsed.set(path, declarations)
    }
    const label = node.label.replace(/\(\)$/, '').replace(/^[.#:]+/, '')
    const declarations = parsed.get(path)!.filter(declaration => declaration.range.start_line === range.start_line
      && declaration.range.end_line === range.end_line
      && (label === declaration.name || label === declaration.qualified))
    if (declarations.length !== 1) continue
    const declaration = declarations[0]!
    for (const name of requested) {
      if (name !== declaration.name && name !== declaration.qualified) continue
      const identity = `${path}:${range.start_line}:${range.end_line}`
      const owners = matches.get(name)!
      const entries = owners.get(identity) ?? []
      entries.push({ node_index: nodeIndex, snippet: lines.slice(range.start_line - 1, range.end_line).join('\n') })
      owners.set(identity, entries)
    }
  }
  if ([...matches.values()].some(owners => owners.size !== 1)) return []
  return [...new Map([...matches.values()].flatMap(owners => [...owners.values()][0]!).map(candidate => [candidate.node_index, candidate])).values()]
}
