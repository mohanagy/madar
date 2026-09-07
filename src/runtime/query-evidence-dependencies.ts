import { extname } from 'node:path'

import * as ts from 'typescript'

export interface RepresentedQueryEvidenceSource {
  startLine: number
  endLine: number
  text: string
}

export interface OwnerDeclarationEvidenceLine {
  lineNumber: number
  text: string
}

export interface OwnerDeclarationEvidence {
  startLine: number
  endLine: number
  lines: OwnerDeclarationEvidenceLine[]
}

export interface OwnerDeclarationCompletionInput {
  sourceFilePath: string
  sourceLines: readonly string[]
  ownerRange: { start: number; end: number }
  representedSource: readonly RepresentedQueryEvidenceSource[]
}

interface ParsedSourceSnapshot {
  sourceFilePath: string
  sourceText: string
  sourceFile: ts.SourceFile
}

interface ConstBinding {
  declaration: ts.VariableDeclaration
  statement: ts.VariableStatement
}

type FunctionOwner = (
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration
) & { body: ts.ConciseBody }

const parsedSourceSnapshots = new WeakMap<readonly string[], ParsedSourceSnapshot>()
const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

function scriptKindForPath(sourceFilePath: string): ts.ScriptKind | null {
  switch (extname(sourceFilePath).toLowerCase()) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    case '.jsx':
      return ts.ScriptKind.JSX
    default:
      return null
  }
}

function parsedSourceForSnapshot(
  sourceFilePath: string,
  sourceLines: readonly string[],
): ts.SourceFile | null {
  const extension = extname(sourceFilePath).toLowerCase()
  if (!JS_TS_EXTENSIONS.has(extension)) {
    return null
  }
  const scriptKind = scriptKindForPath(sourceFilePath)
  if (scriptKind === null) {
    return null
  }

  const sourceText = sourceLines.join('\n')
  const cached = parsedSourceSnapshots.get(sourceLines)
  if (
    cached
    && cached.sourceFilePath === sourceFilePath
    && cached.sourceText === sourceText
  ) {
    return cached.sourceFile
  }

  const sourceFile = ts.createSourceFile(
    sourceFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  parsedSourceSnapshots.set(sourceLines, { sourceFilePath, sourceText, sourceFile })
  return sourceFile
}

function lineRangeOf(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const finalPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1)
  const end = sourceFile.getLineAndCharacterOfPosition(finalPosition).line + 1
  return { start, end }
}

function functionOwnerWithBody(node: ts.Node): FunctionOwner | null {
  if (
    !ts.isFunctionDeclaration(node)
    && !ts.isFunctionExpression(node)
    && !ts.isArrowFunction(node)
    && !ts.isMethodDeclaration(node)
    && !ts.isGetAccessorDeclaration(node)
    && !ts.isSetAccessorDeclaration(node)
    && !ts.isConstructorDeclaration(node)
  ) {
    return null
  }
  return node.body ? node as FunctionOwner : null
}

function identifyingRangeOf(owner: FunctionOwner, sourceFile: ts.SourceFile): { start: number; end: number } {
  let wrapped: ts.Node = owner
  while (
    (ts.isParenthesizedExpression(wrapped.parent)
      || ts.isAsExpression(wrapped.parent)
      || ts.isSatisfiesExpression(wrapped.parent)
      || ts.isTypeAssertionExpression(wrapped.parent)
      || ts.isNonNullExpression(wrapped.parent))
    && wrapped.parent.expression === wrapped
  ) {
    wrapped = wrapped.parent
  }
  if (
    ts.isVariableDeclaration(wrapped.parent)
    && wrapped.parent.initializer === wrapped
    && ts.isVariableDeclarationList(wrapped.parent.parent)
    && ts.isVariableStatement(wrapped.parent.parent.parent)
  ) {
    return lineRangeOf(wrapped.parent.parent.parent, sourceFile)
  }
  return lineRangeOf(owner, sourceFile)
}

function uniquelyIdentifiedOwner(
  sourceFile: ts.SourceFile,
  ownerRange: { start: number; end: number },
): FunctionOwner | null {
  const owners: FunctionOwner[] = []
  const visit = (node: ts.Node): void => {
    const owner = functionOwnerWithBody(node)
    if (owner) {
      const range = identifyingRangeOf(owner, sourceFile)
      if (range.start === ownerRange.start && range.end === ownerRange.end) {
        owners.push(owner)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return owners.length === 1 ? owners[0]! : null
}

function normalizedSource(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function representedStatements(
  owner: FunctionOwner,
  representedSource: readonly RepresentedQueryEvidenceSource[],
  sourceFile: ts.SourceFile,
): ts.Statement[] {
  const representedByRange = new Map<string, Set<string>>()
  for (const represented of representedSource) {
    const key = `${represented.startLine}:${represented.endLine}`
    const texts = representedByRange.get(key) ?? new Set<string>()
    texts.add(normalizedSource(represented.text))
    representedByRange.set(key, texts)
  }

  const statements: ts.Statement[] = []
  const visit = (node: ts.Node): void => {
    if (node !== owner) {
      if (functionOwnerWithBody(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        return
      }
      if (ts.isStatement(node)) {
        const range = lineRangeOf(node, sourceFile)
        const texts = representedByRange.get(`${range.start}:${range.end}`)
        if (texts?.has(normalizedSource(node.getText(sourceFile)))) {
          statements.push(node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return statements
}

function isNestedFunctionOrClass(node: ts.Node): boolean {
  return functionOwnerWithBody(node) !== null
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
}

function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
    return true
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    || (ts.isLabeledStatement(parent) && parent.label === identifier)
    || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier)
  ) {
    return false
  }
  if ('name' in parent && (parent as ts.NamedDeclaration).name === identifier) {
    return false
  }
  return true
}

function collectValueReferences(
  root: ts.Node,
  rejectNestedFunctions: boolean,
): { identifiers: ts.Identifier[]; supported: boolean } {
  const identifiers: ts.Identifier[] = []
  let supported = true
  const visit = (node: ts.Node): void => {
    if (!supported) {
      return
    }
    if (node !== root && isNestedFunctionOrClass(node)) {
      supported = !rejectNestedFunctions
      return
    }
    if (ts.isTypeNode(node)) {
      return
    }
    if (
      ts.isYieldExpression(node)
      || (ts.isDeleteExpression(node))
      || (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
      || (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      )
    ) {
      supported = false
      return
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      identifiers.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return { identifiers, supported }
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text]
  }
  return name.elements.flatMap((element) => (
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  ))
}

function assignmentTargetNames(node: ts.Node): string[] {
  if (ts.isIdentifier(node)) {
    return [node.text]
  }
  if (ts.isParenthesizedExpression(node)) {
    return assignmentTargetNames(node.expression)
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => assignmentTargetNames(element))
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name.text]
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetNames(property.initializer)
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetNames(property.expression)
      }
      return []
    })
  }
  return []
}

function writtenBindingNames(owner: FunctionOwner): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      for (const name of assignmentTargetNames(node.left)) names.add(name)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      for (const name of assignmentTargetNames(node.operand)) names.add(name)
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) {
        for (const name of assignmentTargetNames(node.initializer)) names.add(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return names
}

function functionScopedVarBindingNames(owner: FunctionOwner): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (node !== owner && isNestedFunctionOrClass(node)) {
      return
    }
    if (
      ts.isVariableDeclarationList(node)
      && (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        for (const name of bindingNames(declaration.name)) names.add(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return names
}

type LexicalScope =
  | ts.Block
  | ts.CaseBlock
  | ts.CatchClause
  | ts.ForStatement
  | ts.ForInStatement
  | ts.ForOfStatement

function lexicalScopeChain(node: ts.Node, owner: FunctionOwner): LexicalScope[] | null {
  const scopes: LexicalScope[] = []
  let current: ts.Node | undefined = node.parent
  while (current && current !== owner) {
    if (
      ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isCatchClause(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
    ) {
      scopes.push(current)
    }
    if (isNestedFunctionOrClass(current)) {
      return null
    }
    current = current.parent
  }
  return ts.isBlock(owner.body) && scopes.includes(owner.body) ? scopes : null
}

function hasBindingName(name: ts.BindingName, expected: string): boolean {
  return bindingNames(name).includes(expected)
}

function constBindingForReference(
  identifier: ts.Identifier,
  owner: FunctionOwner,
  writtenNames: ReadonlySet<string>,
  functionVarNames: ReadonlySet<string>,
): { binding: ConstBinding | null; invalidDependency: boolean } {
  const scopes = lexicalScopeChain(identifier, owner)
  if (!scopes || functionVarNames.has(identifier.text)) {
    return { binding: null, invalidDependency: false }
  }

  for (const scope of scopes) {
    if (scope === owner.body && owner.parameters.some((parameter) => hasBindingName(parameter.name, identifier.text))) {
      return { binding: null, invalidDependency: false }
    }
    if (
      ts.isCatchClause(scope)
      && scope.variableDeclaration
      && hasBindingName(scope.variableDeclaration.name, identifier.text)
    ) {
      return { binding: null, invalidDependency: false }
    }

    const declarations: Array<{
      declaration: ts.VariableDeclaration
      statement: ts.VariableStatement
      declarationKind: 'const' | 'mutable'
    }> = []
    let unsupportedBinding = false
    const statements = ts.isBlock(scope)
      ? scope.statements
      : ts.isCaseBlock(scope)
        ? scope.clauses.flatMap((clause) => [...clause.statements])
        : []
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        const blockScopedFlags = statement.declarationList.flags & ts.NodeFlags.BlockScoped
        const declarationKind = blockScopedFlags === ts.NodeFlags.Const
          ? 'const'
          : 'mutable'
        for (const declaration of statement.declarationList.declarations) {
          if (!hasBindingName(declaration.name, identifier.text)) {
            continue
          }
          declarations.push({ declaration, statement, declarationKind })
        }
      } else if (
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
          && statement.name?.text === identifier.text)
      ) {
        unsupportedBinding = true
      }
    }
    if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
      const initializer = scope.initializer
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        unsupportedBinding ||= initializer.declarations.some((declaration) => (
          hasBindingName(declaration.name, identifier.text)
        ))
      }
    }

    if (declarations.length === 0 && !unsupportedBinding) {
      continue
    }
    if (declarations.length !== 1 || unsupportedBinding) {
      return { binding: null, invalidDependency: true }
    }

    const candidate = declarations[0]!
    if (
      candidate.declarationKind !== 'const'
      || !ts.isIdentifier(candidate.declaration.name)
      || !candidate.declaration.initializer
      || writtenNames.has(identifier.text)
    ) {
      return { binding: null, invalidDependency: false }
    }
    if (candidate.declaration.getStart() >= identifier.getStart()) {
      return { binding: null, invalidDependency: true }
    }
    if (candidate.statement.declarationList.declarations.some((declaration) => (
      !ts.isIdentifier(declaration.name) || !declaration.initializer
    ))) {
      return { binding: null, invalidDependency: true }
    }
    return {
      binding: { declaration: candidate.declaration, statement: candidate.statement },
      invalidDependency: false,
    }
  }
  return { binding: null, invalidDependency: false }
}

function declarationClosure(
  owner: FunctionOwner,
  seedStatements: readonly ts.Statement[],
): ts.VariableStatement[] | null {
  const writtenNames = writtenBindingNames(owner)
  const functionVarNames = functionScopedVarBindingNames(owner)
  const statements = new Set<ts.VariableStatement>()
  const completed = new Set<ts.VariableDeclaration>()
  const visiting = new Set<ts.VariableDeclaration>()

  const completeBinding = (binding: ConstBinding): boolean => {
    if (completed.has(binding.declaration)) {
      return true
    }
    if (visiting.has(binding.declaration)) {
      return false
    }
    visiting.add(binding.declaration)
    const references = collectValueReferences(binding.declaration.initializer!, true)
    if (!references.supported) {
      return false
    }
    for (const reference of references.identifiers) {
      const resolved = constBindingForReference(reference, owner, writtenNames, functionVarNames)
      if (resolved.invalidDependency) {
        return false
      }
      if (resolved.binding && !completeBinding(resolved.binding)) {
        return false
      }
    }
    visiting.delete(binding.declaration)
    completed.add(binding.declaration)
    statements.add(binding.statement)
    return true
  }

  for (const statement of seedStatements) {
    const references = collectValueReferences(statement, false)
    for (const reference of references.identifiers) {
      const resolved = constBindingForReference(reference, owner, writtenNames, functionVarNames)
      if (resolved.invalidDependency) {
        continue
      }
      if (resolved.binding && !completeBinding(resolved.binding)) {
        return null
      }
    }
  }
  return [...statements]
}

/**
 * Returns a complete, source-local const-declaration closure for exact source
 * statements already represented in a query excerpt. It intentionally does
 * not perform type checking, value inference, repository traversal, or reads.
 */
export function ownerLocalDeclarationEvidence(
  input: OwnerDeclarationCompletionInput,
): OwnerDeclarationEvidence[] {
  try {
    const sourceFile = parsedSourceForSnapshot(input.sourceFilePath, input.sourceLines)
    if (!sourceFile) {
      return []
    }
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[]
    }).parseDiagnostics
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      return []
    }

    const owner = uniquelyIdentifiedOwner(sourceFile, input.ownerRange)
    if (!owner || !ts.isBlock(owner.body)) {
      return []
    }
    const seeds = representedStatements(owner, input.representedSource, sourceFile)
    if (seeds.length === 0) {
      return []
    }
    const closure = declarationClosure(owner, seeds)
    if (!closure || closure.length === 0) {
      return []
    }

    const representedRanges = input.representedSource.map((represented) => ({
      start: represented.startLine,
      end: represented.endLine,
    }))
    return closure
      .map((statement): OwnerDeclarationEvidence => {
        const range = lineRangeOf(statement, sourceFile)
        return {
          startLine: range.start,
          endLine: range.end,
          lines: input.sourceLines
            .slice(range.start - 1, range.end)
            .map((text, offset) => ({ lineNumber: range.start + offset, text })),
        }
      })
      .filter((declaration) => !representedRanges.some((range) => (
        range.start <= declaration.startLine && declaration.endLine <= range.end
      )))
      .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  } catch {
    return []
  }
}
