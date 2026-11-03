import ts from 'typescript'

export interface SourceExecutableVisitBudget { visited: number; maxNodes: number; exhausted: boolean }
export interface SourceExecutableWitness { start: number; end: number; families: readonly string[] }
export interface SourceExecutableEvidence {
  completeOwner: boolean
  nameFamilies: readonly string[]
  witnesses: readonly SourceExecutableWitness[]
}

/** Lexical evidence only, from an already parsed owner. No type or call authority. */
export function sourceExecutableWitnesses(
  declaration: ts.FunctionDeclaration | ts.MethodDeclaration,
  source: ts.SourceFile,
  budget: SourceExecutableVisitBudget,
  families: (text: string) => readonly string[],
  ownsLine: (line: number) => boolean,
): SourceExecutableEvidence | undefined {
  if (budget.exhausted || !declaration.body) return undefined
  const witnesses: SourceExecutableWitness[] = []
  let completeOwner = true
  const visit = (node: ts.Node): void => {
    if (budget.exhausted) return
    if (++budget.visited > budget.maxNodes) { budget.exhausted = true; return }
    if (ts.isExpressionWithTypeArguments(node)) {
      const heritage = ts.isHeritageClause(node.parent) ? node.parent : undefined
      if (!heritage || (heritage.token === ts.SyntaxKind.ExtendsKeyword
        && (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent)))) visit(node.expression)
      return
    }
    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    if (ts.isParameter(node)) {
      // Binding/type names do not execute; defaults and destructuring keys do.
      if (!ts.isIdentifier(node.name)) visit(node.name)
      if (node.initializer) visit(node.initializer)
      node.modifiers?.forEach(modifier => { if (ts.isDecorator(modifier)) visit(modifier) })
      return
    }
    if (ts.isBindingElement(node)) {
      if (ts.isObjectBindingPattern(node.parent)) {
        if (node.propertyName) visit(ts.isComputedPropertyName(node.propertyName) ? node.propertyName.expression : node.propertyName)
        else if (ts.isIdentifier(node.name) && !node.dotDotDotToken) visit(node.name)
      }
      if (!ts.isIdentifier(node.name)) visit(node.name)
      if (node.initializer) visit(node.initializer)
      return
    }
    if (ts.isFunctionLike(node)) {
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression)
      node.parameters.forEach(visit)
      if ('body' in node && node.body) visit(node.body as ts.Node)
      if (ts.canHaveDecorators(node)) ts.getDecorators(node)?.forEach(visit)
      return
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
      || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)
      || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(source), end = node.getEnd()
      const first = source.getLineAndCharacterOfPosition(start).line + 1
      const last = source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1
      const matched = families(node.text)
      if (matched.length) {
        let owned = true
        for (let line = first; line <= last; line++) owned &&= ownsLine(line)
        if (owned) witnesses.push({ start, end, families: matched })
        else completeOwner = false
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  if (budget.exhausted) return undefined
  return {
    completeOwner,
    nameFamilies: declaration.name && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))
      ? families(declaration.name.text) : [],
    witnesses,
  }
}
