import ts from 'typescript'
import type { SourceFragment } from './source-fragments.js'

interface WitnessSpan { start: number; end: number; startLine: number; endLine: number }
export interface DiagnosticFragmentClause {
  families: readonly string[]
  spans: readonly WitnessSpan[]
}
interface VisitBudget { visited: number; limit: number }

/** A source excerpt of the factory, never a new callable owner or dispatch claim. */
export function sourceDiagnosticMethodFragment(
  declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
  lines: readonly string[], sourceHash: string, clauses: readonly DiagnosticFragmentClause[],
  budget: VisitBudget,
): SourceFragment | undefined {
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body || !declaration.name
    || !clauses.length || clauses.length > 8
    || clauses.some(clause => new Set(clause.families).size < 2 || !clause.spans.length)) return undefined
  const source = declaration.getSourceFile(), body = declaration.body
  const statement = body.statements.at(-1)
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression
    || !ts.isObjectLiteralExpression(statement.expression)) return undefined
  const object = statement.expression
  if (!object.properties.length || object.properties.length > 32) return undefined
  const methods: ts.MethodDeclaration[] = []
  const names = new Set<string>()
  for (const member of object.properties) {
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)
      || names.has(member.name.text)) return undefined
    names.add(member.name.text); methods.push(member)
  }
  // A different outer return makes this simple factory shape ambiguous. Nested
  // callable bodies have their own return statements and are not traversed here.
  let otherReturn = false
  const inspect = (node: ts.Node): void => {
    if (++budget.visited > budget.limit) return
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
    if (ts.isReturnStatement(node) && node !== statement) otherReturn = true
    if (!otherReturn && budget.visited <= budget.limit) ts.forEachChild(node, inspect)
  }
  inspect(body)
  if (otherReturn || budget.visited > budget.limit) return undefined
  const spans = clauses.flatMap(clause => clause.spans)
  const selected = methods.filter(method => spans.every(span => span.start >= method.body!.getStart(source)
    && span.end <= method.body!.getEnd() && span.end > span.start))
  if (selected.length !== 1) return undefined
  const method = selected[0]!
  const line = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1
  const start = line(declaration.getStart(source)), end = line(declaration.getEnd() - 1)
  const headerEnd = line(body.getStart(source)), returnStart = line(statement.getStart(source))
  const objectStart = line(object.getStart(source)), objectEnd = line(object.getEnd() - 1)
  const methodStart = line(method.getStart(source)), methodEnd = line(method.getEnd() - 1)
  // Same-line siblings or wrappers could expose a partial second method. Keep
  // this optional form to distinct lexical shells and one complete method.
  if (headerEnd >= returnStart || objectStart >= methodStart || methodEnd >= objectEnd || objectEnd >= end
    || methods.some(other => other !== method && line(other.getStart(source)) <= methodEnd
      && line(other.getEnd() - 1) >= methodStart)) return undefined
  const kept = new Set<number>()
  const shells: ReadonlyArray<readonly [number, number]> = [[start, headerEnd], [returnStart, objectStart], [methodStart, methodEnd], [objectEnd, end]]
  for (const [first, last] of shells) {
    if (last - first + 1 > 80) return undefined
    for (let current = first; current <= last; current++) kept.add(current)
  }
  if (kept.size > 80 || spans.some(span => {
    for (let current = span.startLine; current <= span.endLine; current++) if (!kept.has(current)) return true
    return false
  })) return undefined
  const retained: SourceFragment['retained'] = []
  let characters = 0
  for (const current of [...kept].sort((left, right) => left - right)) {
    const content = lines[current - 1]
    if (content === undefined || (characters += content.length + 1) > 12_000) return undefined
    const previous = retained.at(-1)
    if (previous && previous.end_line + 1 === current) previous.end_line = current
    else retained.push({ start_line: current, end_line: current })
  }
  if (kept.size >= end - start + 1) return undefined
  let next = start
  for (const range of retained) {
    if (next < range.start_line) characters += `[omitted lines ${next}-${range.start_line - 1}]\n`.length
    next = range.end_line + 1
  }
  if (next <= end) characters += `[omitted lines ${next}-${end}]\n`.length
  if (characters > 12_000) return undefined
  return { sourceHash, range: { start, end }, retained }
}
