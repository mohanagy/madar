import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import type { SourceSelectionProvenance } from './source-selection-provenance.js'

interface SourceCandidate { id: string; label: string; sourceFile: string; sourceLocation: string | null }
type MethodOwner = { candidate: SourceCandidate; method: ts.MethodDeclaration; file: string }

/** Presentation affinity only: this.member syntax does not prove runtime dispatch.
 * The result contains existing candidates; no call edge or coverage is created. */
export function sourceCoherenceGroup(
  independent: readonly SourceCandidate[], candidates: readonly SourceCandidate[],
  provenance: SourceSelectionProvenance | undefined, rootPath?: string,
  cache?: Map<string, string[] | null>,
): { methods: string[]; priority: string[] } | undefined {
  const files = new Map<string, { lines: string[]; methods: ts.MethodDeclaration[] } | null>()
  let bytes = 0, visited = 0, bounded = false
  const load = (file: string) => {
    if (files.has(file)) return files.get(file)
    if (files.size >= 32) { bounded = true; return null }
    const lines = readEvidenceLines(file, rootPath, cache)
    if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024) { bounded = true; return null }
    const source = sourceSyntaxTree(lines, file), methods: ts.MethodDeclaration[] = []
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
    const visit = (node: ts.Node): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name)
        && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) methods.push(node)
      if (!bounded) ts.forEachChild(node, visit)
    }
    visit(source)
    const value = bounded ? null : { lines, methods }
    files.set(file, value); return value
  }
  const owner = (candidate: SourceCandidate): MethodOwner | undefined => {
    const indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    const file = sourcePathForEvidence(candidate.sourceFile, rootPath)
    if (!indexed || !file) return undefined
    const loaded = load(file)
    if (!loaded) return undefined
    const range = resolveSourceSymbolRange(loaded.lines, indexed, candidate.label, file)
    if (!range) return undefined
    const name = candidate.label.replace(/\(\)$/, '').replace(/^\./, '')
    if (name.includes('.') && name !== sourceDeclarationQualifiedName(loaded.lines, indexed, candidate.label, file)) return undefined
    const matches = loaded.methods.filter(method => {
      const source = method.getSourceFile()
      return method.name.getText(source) === name.split('.').at(-1)
        && source.getLineAndCharacterOfPosition(method.getStart(source)).line + 1 === range.start
        && source.getLineAndCharacterOfPosition(method.getEnd() - 1).line + 1 === range.end
    })
    return matches.length === 1 ? { candidate, method: matches[0]!, file } : undefined
  }
  const leading = independent.slice(0, 2).flatMap(candidate => {
    const current = owner(candidate); return current ? [current] : []
  })
  if (bounded || leading.length !== 2 || leading[0]!.method.parent !== leading[1]!.method.parent
    || leading[0]!.method === leading[1]!.method) return undefined
  const container = leading[0]!.method.parent
  if (!ts.isClassDeclaration(container) && !ts.isClassExpression(container)) return undefined
  // Static this has a different receiver domain; unsupported shapes do not rank.
  const instance = (method: ts.MethodDeclaration): boolean => !method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
  if (!leading.every(value => instance(value.method))) return undefined
  const peers = candidates.flatMap(candidate => {
    if (sourcePathForEvidence(candidate.sourceFile, rootPath) !== leading[0]!.file) return []
    const current = owner(candidate)
    return current && current.method.parent === container && instance(current.method) ? [current] : []
  })
  if (bounded) return undefined
  const byName = new Map<string, MethodOwner>()
  for (const peer of peers) {
    const name = peer.method.name.getText()
    if (byName.has(name)) return undefined
    // Unadmitted overloads/other declarations with this name remain ambiguous.
    if (container.members.filter(member => member.name?.getText() === name).length !== 1) return undefined
    byName.set(name, peer)
  }
  const references = new Map<ts.MethodDeclaration, Set<string>>()
  for (const peer of peers) {
    const names = new Set<string>()
    const inspect = (node: ts.Node): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
      if (ts.isCallExpression(node) && !node.questionDotToken && ts.isPropertyAccessExpression(node.expression)
        && !node.expression.questionDotToken && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) names.add(node.expression.name.text)
      if (!bounded) ts.forEachChild(node, inspect)
    }
    // Header initializers share the owner; nested closures remain unsupported.
    for (const parameter of peer.method.parameters) inspect(parameter)
    inspect(peer.method.body!)
    references.set(peer.method, names)
  }
  if (bounded) return undefined
  const bridges = peers.filter(peer => !leading.some(value => value.method === peer.method)
    && leading.every(value => references.get(peer.method)!.has(value.method.name.getText())))
  if (!bridges.length) return undefined
  const selected = new Set<string>(), limit = 12
  const add = (id: string): void => { if (selected.size < limit) selected.add(id) }
  for (const value of [...leading, ...bridges]) add(value.candidate.id)
  for (const value of [...leading, ...bridges]) for (const name of references.get(value.method) ?? []) {
    const target = byName.get(name); if (target) add(target.candidate.id)
  }
  const methods = [...selected]
  const admitted = new Set(candidates.map(candidate => candidate.id))
  const unique = new Set(provenance?.owners.filter(value => value.status === 'unique').map(value => value.node_id))
  const roots = new Set(selected)
  for (const pair of provenance?.resolved_pairs ?? []) if (roots.has(pair.from_id)
    && pair.relation === 'calls' && admitted.has(pair.to_id) && unique.has(pair.to_id)) add(pair.to_id)
  return { methods, priority: [...selected] }
}

export function sourceCoherencePriority(...args: Parameters<typeof sourceCoherenceGroup>): string[] {
  return sourceCoherenceGroup(...args)?.priority ?? []
}
