import ts from 'typescript'
import type { ContextPackNodeCandidate } from './context-pack.js'
import { buildExpandableRefs } from './context-pack.js'
import type { SourceFlowCatalog } from './retrieve/source-dependencies.js'
import { sourceQuerySymbols } from './retrieve/source-query-symbols.js'
import { sourceQueryLiterals } from './retrieve/source-evidence.js'
import { extractPromptExclusions, retrievalEvidencePrompt } from './retrieval-gate.js'

export type FlowRange = { start_line: number; end_line: number }
const contains = (outer: FlowRange, inner: FlowRange): boolean => outer.start_line <= inner.start_line && outer.end_line >= inner.end_line
const overlaps = (a: FlowRange, b: FlowRange): boolean => a.start_line <= b.end_line && b.start_line <= a.end_line
export const flowRange = (node: ts.Node, source: ts.SourceFile): FlowRange => ({
  start_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  end_line: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
})

/** Exact code-shaped request operands, including APIs separated by a slash. */
export function sourceFlowQueryNames(prompt: string): Set<string> {
  const positive = extractPromptExclusions(prompt).positivePrompt
  const names = sourceQuerySymbols(positive).map(symbol => symbol.name.split('.').at(-1)!)
  for (const pair of positive.matchAll(/(?<![\w$./\\])([A-Za-z_$][\w$]*)\/([A-Za-z_$][\w$]*)(?![\w$./\\])/g)) {
    names.push(pair[1]!, pair[2]!)
  }
  return new Set(names.filter(name => name.length > 1))
}

/** Runtime reads only. Names, writes, comments, strings and type syntax do not supply a facet. */
export function sourceFlowReadNames(node: ts.Node, source: ts.SourceFile, delivered?: readonly FlowRange[]): Set<string> | undefined {
  const names = new Set<string>(); let visited = 0, bounded = false
  const visit = (current: ts.Node): void => {
    if (++visited > 100_000) { bounded = true; return }
    if (ts.isTypeNode(current)) return
    if (!ts.isSourceFile(node) && current !== node && (ts.isFunctionLike(current) || ts.isClassLike(current))) return
    if (ts.isIdentifier(current)) {
      const parent = current.parent
      const named = parent && 'name' in parent && parent.name === current
        && !ts.isPropertyAccessExpression(parent) && !ts.isShorthandPropertyAssignment(parent)
      let value: ts.Node = current
      while (value.parent && (ts.isPropertyAccessExpression(value.parent) || ts.isElementAccessExpression(value.parent)
        || ts.isParenthesizedExpression(value.parent))) value = value.parent
      const write = value.parent && (ts.isBinaryExpression(value.parent) && value.parent.left === value
        && value.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && value.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        || (ts.isPrefixUnaryExpression(value.parent) || ts.isPostfixUnaryExpression(value.parent))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(value.parent.operator))
      const range = flowRange(current, source)
      if (!named && !write && (!delivered || delivered.some(part => contains(part, range)))) names.add(current.text)
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return bounded ? undefined : names
}

export function sourceFlowExpandable(catalog: SourceFlowCatalog, omitId?: string) {
  return buildExpandableRefs(catalog.task_contract, catalog.overflow.filter(owner => owner.node_id !== omitId).map(owner => ({
    node_id: owner.node_id, label: owner.label, source_file: owner.source_file, evidence_class: owner.evidence_class,
    expandable_ref: { node_id: owner.node_id, label: owner.label, source_file: owner.source_file, line_range: owner.range },
    estimate_tokens: () => 0,
    build_entry: () => { throw new Error('Flow recovery metadata must not materialize source') },
  } satisfies ContextPackNodeCandidate)))
}

/** Whole source units only; this policy makes no claim that deferred code is semantically redundant. */
export function sourceFlowDonorRanges(
  source: ts.SourceFile, owner: FlowRange, delivered: readonly FlowRange[], prompt: string,
  protectedRanges: readonly FlowRange[], partial: boolean,
): FlowRange[] {
  if (source.text.length > 256 * 1024 || owner.end_line - owner.start_line > 4096) return []
  const positive = extractPromptExclusions(prompt).positivePrompt
  const names = sourceFlowQueryNames(prompt)
  // Single-character slash APIs are protected too. This only narrows donation;
  // it does not turn those ambiguous prose tokens into target-admission evidence.
  for (const pair of positive.matchAll(/(?<![\w$./\\])([A-Za-z_$][\w$]*)\/([A-Za-z_$][\w$]*)(?![\w$./\\])/g)) {
    names.add(pair[1]!); names.add(pair[2]!)
  }
  const literals = new Set(sourceQueryLiterals(retrievalEvidencePrompt(prompt)))
  const words = (value: string): string => value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase().trim()
  const prose = ` ${words(positive)} `
  const linked = (node: ts.Node): boolean => {
    let found = false
    const visit = (part: ts.Node): void => {
      if (ts.isIdentifier(part)) {
        const phrase = words(part.text)
        if (names.has(part.text) || phrase.length > 1 && prose.includes(` ${phrase} `)) found = true
      } else if (ts.isStringLiteralLike(part) && (literals.has(part.text)
        || (ts.isPropertyAssignment(part.parent) || ts.isShorthandPropertyAssignment(part.parent))
          && part.parent.name === part && names.has(part.text))) found = true
      if (!found) ts.forEachChild(part, visit)
    }
    visit(node); return found
  }
  let visited = 0, bounded = false
  const functions: ts.FunctionLikeDeclaration[] = [], objects: ts.ObjectLiteralExpression[] = []
  const scan = (node: ts.Node): void => {
    if (++visited > 100_000) { bounded = true; return }
    const range = flowRange(node, source)
    if (!overlaps(owner, range)) return
    if (ts.isFunctionLike(node) && 'body' in node && node.body && range.start_line === owner.start_line && range.end_line === owner.end_line) functions.push(node as ts.FunctionLikeDeclaration)
    if (ts.isObjectLiteralExpression(node) && contains(owner, range)) objects.push(node)
    ts.forEachChild(node, scan)
  }
  scan(source)
  if (bounded || functions.length !== 1) return []
  const fn = functions[0]!, body = fn.body
  if (!body || !ts.isBlock(body)) return []
  const eligible = (node: ts.Node): boolean => {
    const range = flowRange(node, source)
    return delivered.some(part => contains(part, range)) && !protectedRanges.some(part => overlaps(part, range))
  }
  const assignment = (statement: ts.Statement): ts.BinaryExpression | undefined => {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined
    const expression = statement.expression, left = expression.left
    return expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && left.expression.kind === ts.SyntaxKind.ThisKeyword)
      ? expression : undefined
  }
  if (!partial && body.statements.length > 1 && body.statements.every(statement => !!assignment(statement))) {
    const statements = [...body.statements], first = statements.findIndex(linked)
    if (first < 0) return []
    // A line is the wire's smallest unit. Shared-line statements and indirect
    // receiver dependencies cannot be safely separated by this narrow policy.
    if (statements.some((statement, index) => statements.some((other, otherIndex) => otherIndex !== index
      && overlaps(flowRange(statement, source), flowRange(other, source))))) return []
    let unsupported = false
    for (const statement of statements) {
      const left = assignment(statement)!.left
      if (ts.isElementAccessExpression(left) && !ts.isIdentifier(left.argumentExpression)
        && !ts.isStringLiteralLike(left.argumentExpression) && !ts.isNumericLiteral(left.argumentExpression)) unsupported = true
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isFunctionLike(node) || ts.isClassLike(node)
          || ts.isCallExpression(node) || ts.isNewExpression(node)) unsupported = true
        ts.forEachChild(node, visit)
      }
      visit(assignment(statement)!.right)
    }
    if (unsupported) return []
    const keep = new Set(statements.filter((statement, index) => index <= first || linked(statement) || !eligible(statement)
      || ts.isElementAccessExpression(assignment(statement)!.left)))
    const deferred = statements.filter(statement => !keep.has(statement)).map(statement => flowRange(statement, source))
    return withTrivia(deferred)
  }
  if (!partial) return []
  const result: FlowRange[] = []
  for (const object of objects) {
    // Only a direct const object value in this owner; never a callback's local object.
    if (!ts.isVariableDeclaration(object.parent) || object.parent.initializer !== object || !ts.isIdentifier(object.parent.name)
      || !ts.isVariableDeclarationList(object.parent.parent) || !(object.parent.parent.flags & ts.NodeFlags.Const)
      || object.parent.parent.declarations.length !== 1 || !ts.isVariableStatement(object.parent.parent.parent)
      || object.parent.parent.parent.parent !== body) continue
    for (const property of object.properties) {
      if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
        || ts.isComputedPropertyName(property.name) || !eligible(property) || linked(property.name)) continue
      // A named API is protected as a complete spelling, not by generic component overlap.
      // Runtime reads from another requested facet inside a value also protect it.
      if (ts.isPropertyAssignment(property)) {
        let requestedRead = false
        const visit = (part: ts.Node): void => {
          if (ts.isIdentifier(part) && names.has(part.text) || ts.isStringLiteralLike(part) && literals.has(part.text)) requestedRead = true
          ts.forEachChild(part, visit)
        }
        visit(property.initializer)
        if (requestedRead) continue
      }
      const range = flowRange(property, source)
      // Avoid deleting another unit sharing a physical source line.
      if (object.properties.some(other => other !== property && overlaps(flowRange(other, source), range))) continue
      result.push(range)
    }
  }
  return withTrivia(result)

  function withTrivia(ranges: FlowRange[]): FlowRange[] {
    const sourceLines = source.text.split('\n'), sorted = [...ranges].sort((a, b) => a.start_line - b.start_line)
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!, current = sorted[index]!
      const gap = { start_line: previous.end_line + 1, end_line: current.start_line - 1 }
      if (gap.start_line > gap.end_line || !delivered.some(part => contains(part, gap))
        || protectedRanges.some(part => overlaps(part, gap))) continue
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard,
        sourceLines.slice(gap.start_line - 1, gap.end_line).join('\n'))
      let trivia = true
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (![ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia, ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token)) { trivia = false; break }
      }
      if (trivia) current.start_line = gap.start_line
    }
    return sorted
  }
}
