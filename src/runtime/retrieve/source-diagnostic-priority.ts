import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { retrievalEvidencePrompt } from '../retrieval-gate.js'
import { querySourceEvidenceClauses } from './conceptual-fallback.js'
import { sourceQuerySymbols } from './source-query-symbols.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceQueryLiterals, sourceRequestProse, sourceSyntaxTree, type SourceBodyMatch } from './source-evidence.js'

interface Candidate {
  id: string; label: string; sourceFile: string; sourceLocation: string | null
  sourceDomain: string
}
type Executable = ts.MethodDeclaration | ts.FunctionDeclaration
interface Owner { candidate: Candidate; declaration: Executable; reads: Set<string>; writes: Set<string> }
export type SourceDiagnosticClauseMatches = readonly ReadonlyMap<string, SourceBodyMatch>[]

/** Only optional corroboration leaves the diagnostic implementation subject unambiguous. */
export function sourceDiagnosticQueries(question: string): string[] {
  if (question.length > 12_000) return []
  const positive = retrievalEvidencePrompt(question)
  if (sourceQueryLiterals(positive).length || sourceQuerySymbols(positive).some(occurrence => occurrence.explicit
    && (/[_$#.]|[a-z][A-Z]/.test(occurrence.name) || /^\s*\(/.test(positive.slice(occurrence.end))))) return []
  const prose = sourceRequestProse(positive).replace(/\b(?:tests?|specs?)\s+(?:if|when)\s+(?:useful|helpful|relevant|needed|available)\b/gi, '')
  if (/\b(?:tests?|testing|specs?|mocks?|fixtures?)\b/i.test(prose)) return []
  const clauses = querySourceEvidenceClauses(positive).slice(0, 8)
  const hints = new Set(sourceQueryLiterals(positive))
  // Adding clause queries must not change the original bounded file scan order.
  return clauses.length >= 2 && clauses.every(clause => sourceQueryLiterals(retrievalEvidencePrompt(clause))
    .every(literal => hints.has(literal))) ? clauses : []
}

/** Each clause competes independently within already admitted current owners.
 * A lexical win guides presentation; it never proves that a clause is answered. */
export function sourceDiagnosticSeeds(
  candidates: readonly Candidate[], clauses: SourceDiagnosticClauseMatches,
  allowedOwner: (file: string, label: string, text: string) => boolean,
  rootPath?: string, cache?: Map<string, string[] | null>,
): string[] {
  if (!rootPath || !candidates.length || candidates.length > 32 || clauses.length < 2 || clauses.length > 8) return []
  const files = new Map<string, { lines: string[]; source: ts.SourceFile; declarations: Executable[] }>()
  let bytes = 0, visited = 0, bounded = false
  const owners: Owner[] = []
  for (const candidate of candidates) {
    if (candidate.sourceDomain !== 'production') continue
    const file = sourcePathForEvidence(candidate.sourceFile, rootPath)
    const indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    if (!file || !indexed || !/\.[cm]?[jt]sx?$/i.test(file) || /\.d\.[cm]?ts$/i.test(file)) continue
    let loaded = files.get(file)
    if (!loaded) {
      if (files.size >= 32) return []
      const lines = readEvidenceLines(file, rootPath, cache)
      if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024) return []
      const source = sourceSyntaxTree(lines, file), declarations: Executable[] = []
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return []
      const visit = (node: ts.Node): void => {
        if (++visited > 100_000) { bounded = true; return }
        if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body && node.name && ts.isIdentifier(node.name)) declarations.push(node)
        if (!bounded) ts.forEachChild(node, visit)
      }
      visit(source)
      if (bounded) return []
      loaded = { lines, source, declarations }; files.set(file, loaded)
    }
    const range = resolveSourceSymbolRange(loaded.lines, indexed, candidate.label, file)
    const qualified = sourceDeclarationQualifiedName(loaded.lines, indexed, candidate.label, file)
    if (!range || !qualified || !allowedOwner(candidate.sourceFile, candidate.label, loaded.lines.slice(range.start - 1, range.end).join('\n'))
      || !allowedOwner(file, candidate.label, loaded.lines.slice(range.start - 1, range.end).join('\n'))) continue
    const name = candidate.label.replace(/\(\)$/, '').replace(/^\./, '')
    if (name.includes('.') && name !== qualified) continue
    const matches = loaded.declarations.filter(node => node.name!.getText(loaded!.source) === name.split('.').at(-1)
      && loaded!.source.getLineAndCharacterOfPosition(node.getStart(loaded!.source)).line + 1 === range.start
      && loaded!.source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1 === range.end)
    if (matches.length !== 1) continue
    const declaration = matches[0]!, reads = new Set<string>(), writes = new Set<string>()
    const inspect = (node: ts.Node, inArrow = false): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || (ts.isFunctionLike(node) && !ts.isArrowFunction(node))) return
      const nested = inArrow || ts.isArrowFunction(node)
      if (!nested) {
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
          && !(ts.isBinaryExpression(node.parent) && node.parent.left === node
            && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) reads.add(node.name.text)
      }
      // Arrow functions preserve the method's lexical receiver. Ordinary
      // functions/classes above cannot establish an instance-state writer.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) writes.add(node.left.name.text)
      if (!bounded) ts.forEachChild(node, child => inspect(child, nested))
    }
    inspect(declaration.body!)
    if (bounded) return []
    owners.push({ candidate, declaration, reads, writes })
  }
  if (new Set(owners.map(owner => owner.declaration)).size !== owners.length) return []
  const byId = new Map(owners.map(owner => [owner.candidate.id, owner]))
  const wins = new Map<string, { count: number; first: number }>()
  clauses.forEach((matches, index) => {
    // SourceBodySearch preserves its existing relevance/coverage ordering. The
    // match cannot introduce a new owner or change the full-question ranking.
    const id = [...matches.keys()].find(id => byId.has(id))
    if (!id) return
    const prior = wins.get(id)
    wins.set(id, { count: (prior?.count ?? 0) + 1, first: prior?.first ?? index })
  })
  const leaders = [...wins].sort((left, right) => right[1].count - left[1].count || left[1].first - right[1].first)
    .slice(0, 3).map(([id]) => byId.get(id)!)
  const selected = leaders.map(owner => owner.candidate.id)
  const leader = leaders[0]
  if (leader && ts.isMethodDeclaration(leader.declaration)
    && (ts.isClassDeclaration(leader.declaration.parent) || ts.isClassExpression(leader.declaration.parent))
    && !leader.declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
    const container = leader.declaration.parent
    const writers = owners.filter(owner => !selected.includes(owner.candidate.id) && ts.isMethodDeclaration(owner.declaration)
      && owner.declaration.parent === container
      && !owner.declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
      && [...owner.writes].some(field => leader.reads.has(field)))
    // Multiple same-name declarations or competing writers cannot establish a
    // unique initialization companion. Preserve ordinary order in that case.
    if (writers.length === 1 && container.members.filter(member => member.name?.getText() === writers[0]!.declaration.name!.getText()).length === 1) selected.splice(1, 0, writers[0]!.candidate.id)
  }
  return selected.slice(0, 3)
}
