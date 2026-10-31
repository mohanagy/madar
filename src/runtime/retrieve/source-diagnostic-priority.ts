import ts from 'typescript'
import { createHash } from 'node:crypto'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { retrievalEvidencePrompt } from '../retrieval-gate.js'
import { querySourceEvidenceClauses } from './conceptual-fallback.js'
import { sourceQuerySymbols } from './source-query-symbols.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceQueryLiterals, sourceRequestProse, sourceSyntaxTree, sourceDiagnosticAdmissionsKey, sourceDiagnosticAlternativesKey, sourceDiagnosticClauseEvidence, type SourceBodyMatch } from './source-evidence.js'
import { sourceDiagnosticMethodFragment, type DiagnosticFragmentClause } from './source-diagnostic-fragments.js'
import type { SourceFragment } from './source-fragments.js'

interface Candidate {
  id: string; label: string; sourceFile: string; sourceLocation: string | null
  sourceDomain: string
}
type Executable = ts.MethodDeclaration | ts.FunctionDeclaration
interface Owner { candidate: Candidate; declaration: Executable; lines: string[]; reads: Set<string>; writes: Set<string> }
export type SourceDiagnosticClauseMatches = readonly ReadonlyMap<string, SourceBodyMatch>[] & {
  [sourceDiagnosticAdmissionsKey]?: readonly string[]
  [sourceDiagnosticAlternativesKey]?: readonly (readonly string[])[]
}
export const sourceDiagnosticContextsKey = Symbol('sourceDiagnosticContexts')
export const sourceDiagnosticDecisionsKey = Symbol('sourceDiagnosticDecisions')
export const sourceDiagnosticFragmentsKey = Symbol('sourceDiagnosticFragments')
type DiagnosticQueries = string[] & { [sourceDiagnosticContextsKey]?: readonly string[] }
type DiagnosticSeeds = string[] & {
  [sourceDiagnosticDecisionsKey]?: readonly string[]
  [sourceDiagnosticFragmentsKey]?: ReadonlyMap<string, SourceFragment>
}

/** Keep bounded nominees and clause alternatives inside the 32-owner budget. */
export function sourceDiagnosticCandidatePool<T extends { id: string }>(candidates: readonly T[], nominated: readonly string[] = [], alternatives: readonly (readonly string[])[] = []): T[] {
  const wanted = new Set([...nominated.slice(0, 3), ...alternatives.slice(0, 8).flatMap(ids => ids.slice(0, 3))])
  return [...candidates.filter(candidate => wanted.has(candidate.id)), ...candidates.filter(candidate => !wanted.has(candidate.id))].slice(0, 32)
}

/** Only optional corroboration leaves the diagnostic implementation subject unambiguous. */
export function sourceDiagnosticQueries(question: string): DiagnosticQueries {
  if (question.length > 12_000) return []
  const positive = retrievalEvidencePrompt(question)
  if (sourceQueryLiterals(positive).length || sourceQuerySymbols(positive).some(occurrence => occurrence.explicit
    && (/[_$#.]|[a-z][A-Z]/.test(occurrence.name) || /^\s*\(/.test(positive.slice(occurrence.end))
      || /\b(?:functions?|methods?|symbols?|class(?:es)?|types?|interfaces?|enums?|variables?|constants?|propert(?:y|ies)|namespaces?|identifiers?)\s+$/i.test(positive.slice(0, occurrence.start))
      || /^(?:please\s+)?(?:how\s+(?:does|do)|explain|find|locate|show|describe|change|update|fix|where\s+(?:is|are|can\s+I\s+find))\s+(?:the\s+)?(?:(?:implementation|source|definition)\s+of\s+)?$/i.test(positive.slice(0, occurrence.start).trimStart())
        && /^(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*(?:\(\))?)*\s*[:;.!?]/i.test(positive.slice(occurrence.end))))) return []
  const prose = sourceRequestProse(positive).replace(/\b(?:tests?|specs?)\s+(?:if|when)\s+(?:useful|helpful|relevant|needed|available)\b/gi, '')
  if (/\b(?:tests?|testing|specs?|mocks?|fixtures?)\b/i.test(prose)) return []
  // These complete framing clauses are not independent implementation requests.
  // Keep the original question and public obligations intact for all other uses.
  const locator = /^\s*(?:in|within)\s+(?:(?:the|this|our)\s+)?(?:[\w@.-]+\s+)?(?:source|repository|repo|codebase)\s*$/i
  const optionalEvidence = /^\s*(?:find|use|consult|include|inspect|read)\s+(?:(?:relevant|exact|supporting|related)\s+)?(?:(?:tests?|specs?|config(?:uration)?(?:\s+(?:files?|limits))?)(?:\s*(?:[\/,&]|and|or)\s*)?)+\s+(?:if|when)\s+(?:useful|helpful|relevant|needed|available)\s*$/i
  let subject = positive
  const authored = sourceRequestProse(positive)
  // A topic followed by an authored question supplies scope, not an extra vote.
  const heading = /^\s*(?:(?:in|within)\s+(?:(?:the|this|our)\s+)?(?:[\w@.-]+\s+)?(?:source|repository|repo|codebase)\s*,\s*)?(?:trace|explain|describe)\s+([^:;.!?\n#]+):\s*(?=(?:how|what|why|when|where|whether)\b)/i.exec(authored)
  if (heading) subject = positive.slice(heading[0].length)
  const clauses = querySourceEvidenceClauses(subject).filter(clause => {
    const text = sourceRequestProse(clause)
    return !locator.test(text) && !optionalEvidence.test(text)
  }).slice(0, 8)
  const hints = new Set(sourceQueryLiterals(positive))
  // Adding clause queries must not change the original bounded file scan order.
  if (clauses.length < 2 || !clauses.every(clause => sourceQueryLiterals(retrievalEvidencePrompt(clause))
    .every(literal => hints.has(literal)))) return []
  if (heading && !/[“”‘’]/.test(heading[1]!)) {
    const prose = sourceRequestProse(subject)
    // A later authored request ends this heading's relevance context. Source
    // data is masked, and transformed/nonlocatable clauses fail closed below.
    const reset = /(?:^|[.;!?\n]\s*|\b(?:and|also|then|next|separately)\s+)(?:(?:also|then|next|separately)\s+)*(?:trace|explain|describe|find|locate|show|inspect|analy[sz]e|change|update|fix|add|remove|implement)\b|(?:^|[.;!?\n]\s*)[^:;.!?\n#]+:\s*(?=(?:how|what|why|when|where|whether)\b)/i.exec(prose)
    const end = reset?.index ?? subject.length
    let cursor = 0, locatable = true
    const contexts = clauses.map(clause => {
      const position = locatable ? subject.indexOf(clause, cursor) : -1
      if (position < 0) { locatable = false; return '' }
      cursor = position + clause.length
      return cursor <= end ? heading[1]!.trim() : ''
    })
    if (contexts.some(Boolean)) Object.defineProperty(clauses, sourceDiagnosticContextsKey, { value: contexts })
  }
  return clauses
}

/** Each clause competes independently within already admitted current owners.
 * A lexical win guides presentation; it never proves that a clause is answered. */
export function sourceDiagnosticSeeds(
  candidates: readonly Candidate[], clauses: SourceDiagnosticClauseMatches,
  allowedOwner: (file: string, label: string, text: string) => boolean,
  rootPath?: string, cache?: Map<string, string[] | null>,
): DiagnosticSeeds {
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
    owners.push({ candidate, declaration, lines: loaded.lines, reads, writes })
  }
  if (new Set(owners.map(owner => owner.declaration)).size !== owners.length) return []
  const byId = new Map(owners.map(owner => [owner.candidate.id, owner]))
  const wins = new Map<string, { count: number; first: number }>()
  const alternatives = clauses[sourceDiagnosticAlternativesKey]
  const decisionsByClause: string[][] = []
  clauses.forEach((matches, index) => {
    // SourceBodySearch preserves its existing relevance/coverage ordering. The
    // match cannot introduce a new owner or change the full-question ranking.
    const ids = alternatives ? [...new Set(alternatives[index]?.slice(0, 3) ?? [])]
      .filter(id => byId.has(id) && (matches.get(id)?.score ?? 0) >= 1)
      : [...matches.keys()].filter(id => byId.has(id)).slice(0, 1)
    decisionsByClause.push(ids)
    for (const id of ids) {
      const prior = wins.get(id)
      wins.set(id, { count: (prior?.count ?? 0) + 1, first: prior?.first ?? index })
    }
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
  const result: DiagnosticSeeds = selected.slice(0, 3)
  if (alternatives) {
    const decisions = new Set<string>()
    const eligibleDecisions = new Set(decisionsByClause.flat())
    for (const id of clauses[sourceDiagnosticAdmissionsKey]?.slice(0, 3) ?? []) {
      if (byId.has(id) && eligibleDecisions.has(id)) decisions.add(id)
    }
    for (let round = 0; round < 3; round++) for (const ids of decisionsByClause) {
      const id = ids[round]
      if (id && decisions.size < 8) decisions.add(id)
    }
    Object.defineProperty(result, sourceDiagnosticDecisionsKey, { value: [...decisions] })
    // The sidecars describe complete executable primary-clause witnesses from
    // the existing bounded scan. Names and heading context alone cannot justify
    // hiding setup or another method. This changes representation, not identity.
    const fragments = new Map<string, SourceFragment>()
    const hashes = new Map<readonly string[], string>()
    const fragmentBudget = { visited, limit: 100_000 }
    for (const id of decisions) {
      const owner = byId.get(id)
      if (!owner || !ts.isFunctionDeclaration(owner.declaration)) continue
      const assigned = decisionsByClause.flatMap((ids, index) => ids.includes(id) ? [index] : [])
      const fragmentClauses: DiagnosticFragmentClause[] = []
      for (const index of assigned) {
        const evidence = sourceDiagnosticClauseEvidence(clauses[index]!)
        const current = evidence?.owners.get(id)
        const source = owner.declaration.getSourceFile()
        if (!evidence?.contextual || !current?.completeOwner || current.lines !== owner.lines
          || current.declarationStart !== owner.declaration.getStart(source)
          || current.declarationEnd !== owner.declaration.getEnd()) break
        const terms = new Set(evidence.terms), families = new Set<string>()
        const spans = current.witnesses.flatMap(witness => {
          const matched = witness.families.filter(family => terms.has(family))
          if (!matched.length) return []
          for (const family of matched) families.add(family)
          return [{ start: witness.start, end: witness.end,
            startLine: source.getLineAndCharacterOfPosition(witness.start).line + 1,
            endLine: source.getLineAndCharacterOfPosition(witness.end - 1).line + 1 }]
        })
        fragmentClauses.push({ families: [...families], spans })
      }
      if (!assigned.length || fragmentClauses.length !== assigned.length) continue
      let hash = hashes.get(owner.lines)
      if (!hash) { hash = createHash('sha256').update(owner.lines.join('\n')).digest('hex'); hashes.set(owner.lines, hash) }
      const fragment = sourceDiagnosticMethodFragment(owner.declaration, owner.lines, hash, fragmentClauses, fragmentBudget)
      if (fragment) fragments.set(id, fragment)
      if (fragmentBudget.visited > fragmentBudget.limit) break
    }
    if (fragments.size) Object.defineProperty(result, sourceDiagnosticFragmentsKey, { value: fragments })
  }
  return result
}
