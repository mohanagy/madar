import ts from 'typescript'
import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { sourceSyntaxTree } from './source-evidence.js'
import type { SourceLineRange } from '../../shared/source-location.js'

interface RequestedHelper { name: string; start: number; end: number }
export interface RequestedHelperOwner { id: string; label: string; range: SourceLineRange }

/** A narrow request grammar; prose and quoted values are not identifier lists. */
export function sourceRequestedHelpers(question: string): RequestedHelper[] {
  if (question.length > 16_384) return []
  // Preserve offsets while refusing new admission from quoted examples/data.
  const text = question.replace(/([`"'])(?:\\.|(?!\1)[\s\S])*?\1/g, match => ' '.repeat(match.length))
  const found = new Map<string, RequestedHelper>()
  const add = (name: string, start: number): void => {
    if (/^[a-z][a-z0-9]*$/.test(name) && name.length <= 64 && !found.has(name)) {
      found.set(name, { name, start, end: start + name.length })
    }
  }
  // A helper role directly attached to an imperative is explicit even when
  // its spelling is an ordinary lowercase word.
  for (const match of text.matchAll(/\b(?:find|locate|inspect|show)\s+(?:the\s+)?([a-z][a-z0-9]*)\s+helper\b/gi)) {
    const before = text.slice(0, match.index)
    if (!/(?:^|[.!?;]\s*|\bAlso\s+|\b(?:in|within)\s+[^\s]+\s*)$/i.test(before)) continue
    add(match[1]!, match.index + match[0].indexOf(match[1]!))
  }
  for (const command of text.matchAll(/\b(?:include|find|inspect|locate)\s+/gi)) {
    const before = text.slice(0, command.index)
    if (!/(?:^|[.!?;]\s*|\bAlso\s+|\b(?:in|within)\s+[^\s]+\s*)$/i.test(before)) continue
    const clause = text.slice(command.index).split(/(?<![A-Za-z0-9_$])[.!?;]|[.!?;](?=\s|$)/, 1)[0] ?? ''
    if (/\b(?:as|for)\s+(?:(?:example|sample|input|output|literal|test)\s+)*(?:data|values?|examples?|samples?|literals?)\b/i.test(clause)) continue
    const items: RequestedHelper[] = []
    let at = command.index + command[0].length
    let commas = 0
    let typed = false
    while (items.length < 32) {
      const item = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s+(constructor|function|method|helper))?/.exec(text.slice(at))
      if (!item) break
      const name = item[1]!, end = at + item[0].length
      const after = text.slice(end)
      const comma = /^\s*,\s*/.exec(after)
      const and = /^\s+and\s+/.exec(after)
      const terminal = /^\s*(?:[.!?;]|$)/.test(after)
      // A free noun phrase does not become the next list item. A trailing
      // broader obligation ("and relevant error handling") stays untouched.
      if (!comma && !and && !terminal) break
      items.push({ name, start: at, end: at + name.length })
      typed ||= !!item[2] || /[_$#.]|[a-z][A-Z]|^[A-Z]/.test(name)
      if (comma) { commas += 1; at = end + comma[0].length; continue }
      if (and) { at = end + and[0].length; continue }
      break
    }
    // Commas establish list syntax. A source/helper context or an already
    // code-shaped item distinguishes this from an ordinary data enumeration.
    const context = text.slice(Math.max(0, command.index - 512), at)
    if (commas && items.length >= 2 && (typed || /\b(?:helpers?|functions?|methods?|symbols?|implementations?|constructors?)\b/i.test(context))) {
      for (const item of items) add(item.name, item.start)
    }
  }
  return found.size <= 32 ? [...found.values()] : []
}

/** Admit existing owners only after a complete current-source uniqueness census. */
export function selectRequestedHelperOwners(
  question: string,
  owners: readonly RequestedHelperOwner[],
  lines: readonly string[],
  sourceFile: string,
): string[] {
  const requested = new Set(sourceRequestedHelpers(question).map(item => item.name))
  if (!requested.size) return []
  const source = sourceSyntaxTree(lines, sourceFile)
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return []
  type Identity = { node: ts.Node; start: number; nameLine: number; end: number; callable: boolean }
  const identities = new Map<string, Map<number, Identity>>()
  const callableRanges = new Map<string, Map<ts.Node, boolean>>()
  const recordCallable = (node: ts.Node, start: number, end: number, body: boolean): void => {
    const key = `${start}:${end}`
    const entries = callableRanges.get(key) ?? new Map<ts.Node, boolean>()
    entries.set(node, body)
    callableRanges.set(key, entries)
  }
  let visited = 0
  const record = (name: string, node: ts.Node, nameNode: ts.Node, callable: boolean): void => {
    if (!requested.has(name)) return
    const offset = node.getStart(source)
    const entries = identities.get(name) ?? new Map<number, Identity>()
    entries.set(offset, { node, start: source.getLineAndCharacterOfPosition(offset).line + 1,
      nameLine: source.getLineAndCharacterOfPosition(nameNode.getStart(source)).line + 1,
      end: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1, callable })
    identities.set(name, entries)
  }
  const visit = (node: ts.Node): void => {
    if (++visited > 100_000) return
    const occurrence = sourceFunctionOccurrence(node, source)
    if (occurrence) {
      record(occurrence.name, node, node, false)
      recordCallable(node, occurrence.start, occurrence.end, true)
    }
    const callable = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    const value = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.initializer : undefined
    if (callable || value) recordCallable(node,
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      source.getLineAndCharacterOfPosition(node.getEnd()).line + 1, !!(callable ? node.body : value?.body))
    const named = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isVariableDeclaration(node)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
      || ts.isPropertyDeclaration(node)) && node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
      ? node.name : undefined
    if (named) {
      const callable = ts.isFunctionDeclaration(node) ? !!node.body
        : ts.isVariableDeclaration(node) && !!node.initializer
          && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) && !!node.initializer.body
      record(named.text, node, named, callable)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (visited > 100_000) return []
  const selected: string[] = []
  for (const name of requested) {
    const declarations = identities.get(name)
    if (declarations?.size !== 1) continue
    const declaration = declarations.values().next().value!
    if (!declaration.callable) continue
    const indexed = owners.filter(owner => owner.label.replace(/\(\)$/, '') === name)
    if (indexed.length !== 1) continue
    const owner = indexed[0]!, range = owner.range
    if (range.start < declaration.start || range.start > declaration.nameLine
      || (range.start !== range.end && range.end !== declaration.end)) continue
    // The public owner identity is a line range, not only a name. Different
    // callables on one line and no-body overloads must not share its authority.
    const resolvedEnd = range.start === range.end ? declaration.end : range.end
    const rangeOwners = callableRanges.get(`${range.start}:${resolvedEnd}`)
    if (rangeOwners?.size === 1 && rangeOwners.get(declaration.node) === true) selected.push(owner.id)
  }
  return selected
}
