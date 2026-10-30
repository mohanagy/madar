import ts from 'typescript'

import type { SourceLineRange } from '../../shared/source-location.js'

/** Local source presentation only: a wrapper call or JSX attribute does not
 * prove callback execution. Unsupported shapes retain the original excerpt. */
export function selectedCallbackExcerptLines(
  source: ts.SourceFile, lines: readonly string[], owner: SourceLineRange,
  selected: ReadonlySet<number>, maxLines: number, maxChars: number,
): number[] | null {
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
  let visited = 0
  const step = (): void => { if (++visited > 20_000) throw new Error('Callback excerpt syntax bound exceeded') }
  const range = (node: ts.Node): SourceLineRange => ({
    start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
  })
  const intersects = (span: SourceLineRange): boolean => [...selected].some(line => line >= span.start && line <= span.end)
  const complete = (span: SourceLineRange): boolean => {
    for (let line = span.start; line <= span.end; line++) if (!selected.has(line)) return false
    return true
  }
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression
    return expression
  }
  try {
    const owners: Array<ts.FunctionDeclaration | ts.MethodDeclaration> = []
    const find = (node: ts.Node): void => {
      step()
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) {
        const span = range(node)
        if (span.start === owner.start && span.end === owner.end) owners.push(node)
      }
      ts.forEachChild(node, find)
    }
    find(source)
    if (owners.length !== 1) return null
    const fn = owners[0]!, body = fn.body!
    const additions = new Set<number>()
    const keep = (span: SourceLineRange): void => {
      if (span.start < owner.start || span.end > owner.end || span.end - span.start + 1 > maxLines) throw new Error('Callback excerpt exceeds its owner or line bound')
      for (let line = span.start; line <= span.end; line++) additions.add(line)
    }
    const oneLine = (position: number): void => {
      const line = source.getLineAndCharacterOfPosition(position).line + 1
      keep({ start: line, end: line })
    }
    for (const statement of body.statements) {
      step()
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
        || statement.declarationList.declarations.length !== 1) continue
      const declaration = statement.declarationList.declarations[0]!
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const initializer = unwrap(declaration.initializer)
      const values = ts.isCallExpression(initializer) ? initializer.arguments.map(unwrap) : [initializer]
      const callbacks = values.filter((value): value is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      if (callbacks.length !== 1 || !ts.isBlock(callbacks[0]!.body)) continue
      const callback = callbacks[0]!, callbackBody = callback.body as ts.Block
      const header = { start: range(statement).start, end: range(callbackBody).start }
      if (!complete(header)) continue
      const guards: ts.IfStatement[] = [], handlers = new Set<ts.TryStatement>()
      const inspect = (node: ts.Node): void => {
        step()
        if (node !== callbackBody && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return
        if (ts.isIfStatement(node)) {
          const span = range(node)
          const guard = { start: span.start, end: range(node.thenStatement).start }
          if (span.end - span.start < 16 && complete(guard) && intersects(span) && !complete(span)) {
            let current: ts.Node = node, supported = true
            const enclosing: ts.TryStatement[] = []
            while (current !== callbackBody) {
              const parent = current.parent
              if (ts.isTryStatement(parent) && parent.tryBlock === current) enclosing.push(parent)
              else if (!ts.isBlock(parent)) { supported = false; break }
              current = parent
            }
            if (supported) { guards.push(node); enclosing.forEach(value => handlers.add(value)) }
          }
        }
        ts.forEachChild(node, inspect)
      }
      inspect(callbackBody)
      if (!guards.length) continue
      const name = declaration.name.text
      let unsafe = false
      const mentions = (node: ts.Node): boolean => {
        step()
        return ts.isIdentifier(node) && node.text === name || ts.forEachChild(node, child => mentions(child) ? true : undefined) === true
      }
      const bindingSafe = (node: ts.Node): void => {
        step()
        if (node !== declaration && (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
          || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node))
          && node.name && mentions(node.name)) unsafe = true
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && mentions(node.left)
          || (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
            && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && mentions(node.operand)
          || ts.isDeleteExpression(node) && mentions(node.expression)
          || (ts.isForInStatement(node) || ts.isForOfStatement(node)) && mentions(node.initializer)) unsafe = true
        ts.forEachChild(node, bindingSafe)
      }
      bindingSafe(fn)
      if (unsafe) continue
      const references: Array<{ attribute: ts.JsxAttribute; statement: ts.ReturnStatement }> = []
      for (const returned of body.statements) {
        if (!ts.isReturnStatement(returned) || !returned.expression) continue
        const value = unwrap(returned.expression)
        if (!ts.isJsxElement(value) && !ts.isJsxSelfClosingElement(value) && !ts.isJsxFragment(value)) continue
        const inspectJsx = (node: ts.Node): void => {
          step()
          if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
          if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)
            && node.initializer.expression && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === name) {
            references.push({ attribute: node, statement: returned })
          }
          ts.forEachChild(node, inspectJsx)
        }
        inspectJsx(value)
      }
      if (!references.length || references.length > 8) continue
      if (references.some(({ attribute, statement: returned }) => {
        for (let parent: ts.Node | undefined = attribute.parent; parent && parent !== returned; parent = parent.parent) {
          step()
          if (!ts.isJsxAttributes(parent) && !ts.isJsxOpeningElement(parent) && !ts.isJsxSelfClosingElement(parent)
            && !ts.isJsxElement(parent) && !ts.isJsxFragment(parent) && !ts.isJsxExpression(parent)
            && !ts.isParenthesizedExpression(parent)) return true
        }
        return false
      })) continue
      const units: ts.Node[] = [...guards]
      for (const handler of handlers) {
        if (handler.catchClause) units.push(handler.catchClause)
        if (handler.finallyBlock) units.push(handler.finallyBlock)
      }
      const simple = (node: ts.Node): boolean => {
        step()
        if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return false
        return ts.forEachChild(node, child => simple(child) ? undefined : true) !== true
      }
      if (units.some(node => range(node).end - range(node).start >= 16 || !simple(node))) continue
      units.forEach(node => keep(range(node)))
      for (const handler of handlers) {
        keep({ start: range(handler).start, end: range(handler.tryBlock).start })
        // Include punctuation and keywords even when catch/finally starts on
        // a separate physical line from the preceding block's closing brace.
        keep({ start: range(handler.tryBlock).end, end: range(handler).end })
      }
      // Keep the callback and initializer closure, including trailing wrapper
      // arguments; a larger tail is outside this bounded lexical presentation.
      const closing = { start: range(callbackBody).end, end: range(statement).end }
      if (closing.end - closing.start >= 8) return null
      keep(closing)
      for (const { attribute, statement: returned } of references) {
        keep(range(attribute)); oneLine(returned.getStart(source)); oneLine(returned.getEnd() - 1)
        for (let parent: ts.Node | undefined = attribute.parent; parent && parent !== returned; parent = parent.parent) {
          step()
          if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
            oneLine(parent.getStart(source)); oneLine(parent.getEnd() - 1)
          } else if (ts.isJsxElement(parent)) {
            oneLine(parent.openingElement.getStart(source)); oneLine(parent.openingElement.getEnd() - 1)
            keep(range(parent.closingElement))
          }
          else if (ts.isJsxFragment(parent)) { keep(range(parent.openingFragment)); keep(range(parent.closingFragment)) }
          else if (ts.isJsxExpression(parent) || ts.isParenthesizedExpression(parent)) {
            oneLine(parent.getStart(source)); oneLine(parent.getEnd() - 1)
          }
        }
      }
    }
    const combined = new Set([...selected, ...additions])
    if (combined.size > maxLines || [...combined].reduce((total, line) => total + (lines[line - 1]?.length ?? maxChars) + 1, 0) > maxChars) return null
    return [...additions]
  } catch { return null }
}
