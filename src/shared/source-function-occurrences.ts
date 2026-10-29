import ts from 'typescript'

/** A syntactic source occurrence; this does not prove a runtime property binding. */
export interface SourceFunctionOccurrence {
  node: ts.Node
  name: string
  qualifiedName: string
  start: number
  end: number
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression
  return expression
}

function staticMember(expression: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(expression)) return [expression.text]
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)
    || expression.questionDotToken) return undefined
  const parent = staticMember(expression.expression)
  return parent ? [...parent, expression.name.text] : undefined
}

export function sourceFunctionOccurrence(node: ts.Node, source: ts.SourceFile): SourceFunctionOccurrence | undefined {
  let name: string | undefined
  let qualifiedName: string | undefined
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const value = unwrap(node.right)
    const member = staticMember(node.left)
    if (!member || member.length < 2 || !(ts.isFunctionExpression(value) || ts.isArrowFunction(value))) return undefined
    name = member.at(-1)!
    qualifiedName = member.join('.')
  } else if (ts.isFunctionExpression(node) && node.name) {
    let argument: ts.Node = node
    while (ts.isParenthesizedExpression(argument.parent) || ts.isAsExpression(argument.parent)
      || ts.isNonNullExpression(argument.parent)) argument = argument.parent
    if (!ts.isCallExpression(argument.parent) || !argument.parent.arguments.some(value => value === argument)) return undefined
    name = node.name.text
    qualifiedName = name
  } else return undefined
  return { node, name, qualifiedName,
    start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end: source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1 }
}
