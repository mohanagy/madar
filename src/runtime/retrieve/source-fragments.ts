import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import ts from 'typescript'
import { createSourceCompilerHost } from './source-compiler-host.js'

import type { SourceLineRange } from '../../shared/source-location.js'
import {
  readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationKind, sourceQueryLiterals,
  sourceQueryRequestsClauseLocations, sourceRequestProse, sourceSyntaxTree, type EvidenceLineRange,
} from './source-evidence.js'

const MAX_FILES = 64
const MAX_OWNERS = 1024
const MAX_NODES = 150_000
const MAX_CLAUSES = 8
const MAX_STATEMENTS = 4096
const MAX_WITNESSES = 16
const MAX_CHARS = 12_000
const NOISE = new Set('a an the to of in on at by for from with and or any also that which using use source javascript typescript code function functions method methods find locate show explain trace restrict only file files include including ordinary'.split(' '))

export interface SourceFragmentOwner {
  id: string
  label: string
  sourceFile: string
  range: SourceLineRange
  fileNodeLike?: boolean
}
export interface SourceFragment {
  sourceHash: string
  range: SourceLineRange
  retained: EvidenceLineRange[]
}
export interface SourceFragmentSelection {
  /** Exact existing owners, ordered before optional lexical evidence. */
  ownerIds: string[]
  bindingIds: string[]
  fragments: Map<string, SourceFragment>
}
interface Clause {
  text: string
  terms: Set<string>
  pairs: Set<string>
  literals: string[]
  role?: 'construction' | 'decision'
}
interface Owner extends SourceFragmentOwner { lines: string[]; source: ts.SourceFile; kind: string; declaration: ts.Node }
interface Statement {
  node: ts.Statement
  owner: Owner
  terms: Set<string>
  pairs: Set<string>
  literals: Set<string>
  construction: boolean
  decision: boolean
}

function words(text: string): string[] {
  return text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z_$][a-z\d_$]*/g) ?? []
}
function terms(text: string): Set<string> { return new Set(words(text).filter(word => word.length > 2 && !NOISE.has(word))) }
function hash(lines: readonly string[]): string { return createHash('sha256').update(lines.join('\n')).digest('hex') }
function rangeOf(node: ts.Node, source: ts.SourceFile): SourceLineRange {
  return { start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end: source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1 }
}
function contains(outer: SourceLineRange, inner: SourceLineRange): boolean { return outer.start <= inner.start && outer.end >= inner.end }

/** Keep complete raw requests rather than the short terms used by advisory coverage. */
function clausesFor(question: string): Clause[] | undefined {
  if (question.length > 8192) return undefined
  const prose = sourceRequestProse(question).replace(/(?:\.\/)?[\w@-]+(?:[./\\][\w@*-]+)+/g, value => ' '.repeat(value.length))
  const boundaries = [...prose.matchAll(/[.;]\s*|,\s*(?=(?:how|why|where|when|whether)\b)|\band\s+(?=(?:any|also|how|why|where|when|whether|find|locate|show|explain|trace)\b)/gi)]
  if (boundaries.length > MAX_CLAUSES) return undefined
  const result: Clause[] = []
  let start = 0
  let preceding: Clause | undefined
  for (const boundary of [...boundaries, { index: question.length, 0: '' }]) {
    const end = boundary.index!
    const text = question.slice(start, end).trim()
    const currentTerms = terms(text)
    if (currentTerms.size) {
      // A coordinated request can omit its subject: "... context.Item, and any
      // selection ...". Preserve that preceding entity evidence, not its verbs.
      const rawWords = words(text)
      const pairs = new Set(rawWords.slice(1).map((word, index) => `${rawWords[index]}\0${word}`))
      if (/^any\b/i.test(text) && preceding) for (const pair of preceding.pairs) pairs.add(pair)
      const role = /\b(?:selection|select|selects|choos\w*|skip\w*|guard\w*|decision|filter\w*)\b/i.test(text) ? 'decision'
        : /\b(?:construct\w*|instantiat\w*|creat\w*|new)\b/i.test(text) ? 'construction' : undefined
      const clause: Clause = { text, terms: currentTerms, pairs, literals: sourceQueryLiterals(text), ...(role ? { role } : {}) }
      if (/^any\b/i.test(text) && preceding) {
        for (const term of preceding.terms) if (!/^(?:construct\w*|creat\w*|instantiat\w*)$/.test(term)) clause.terms.add(term)
      }
      result.push(clause)
      preceding = clause
    }
    start = end + boundary[0].length
  }
  return result.length >= 2 && result.length <= MAX_CLAUSES ? result : undefined
}

function executableName(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isTypeNode(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false
  if ('name' in parent && parent.name === node) return ts.isPropertyAccessExpression(parent)
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false
  return true
}
function propertyWords(node: ts.PropertyAccessExpression): string[] {
  const result: string[] = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) { result.unshift(...words(current.name.text)); current = current.expression }
  if (ts.isIdentifier(current)) result.unshift(...words(current.text))
  else return []
  return result
}
function controlExpression(node: ts.Statement): ts.Node | undefined {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)) return node.expression
  if (ts.isForStatement(node)) return node.condition
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return node.expression
  return undefined
}
function isAtom(node: ts.Node): node is ts.Statement {
  return ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isReturnStatement(node)
    || ts.isThrowStatement(node) || ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
    || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isSwitchStatement(node)
}
function statementEvidence(node: ts.Statement, owner: Owner, tick: () => boolean): Statement | undefined {
  const result: Statement = { node, owner, terms: new Set(), pairs: new Set(), literals: new Set(), construction: false, decision: !!controlExpression(node) }
  const visit = (child: ts.Node): void => {
    if (!tick() || ts.isTypeNode(child) || ts.isFunctionLike(child) || ts.isClassLike(child)) return
    if (ts.isIdentifier(child) && executableName(child)) for (const term of words(child.text)) result.terms.add(term)
    if (ts.isPropertyAccessExpression(child)) {
      const chain = propertyWords(child)
      for (let index = 1; index < chain.length; index++) result.pairs.add(`${chain[index - 1]}\0${chain[index]}`)
    }
    if (ts.isStringLiteralLike(child)) result.literals.add(child.text)
    if (ts.isNewExpression(child)) result.construction = true
    ts.forEachChild(child, visit)
  }
  visit(controlExpression(node) ?? node)
  return result.terms.size || result.literals.size ? result : undefined
}

function immutableDeclaration(identifier: ts.Identifier, checker: ts.TypeChecker, writes: ReadonlySet<ts.Symbol>): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(identifier)
  if (!symbol || writes.has(symbol)) return undefined
  const declarations = symbol.declarations ?? []
  if (declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0]!)) return undefined
  const declaration = declarations[0]!
  return ts.isIdentifier(declaration.name) && declaration.initializer
    && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
    && declaration.parent.declarations.length === 1 ? declaration : undefined
}
function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) if (ts.isStatement(current)) return current
  return undefined
}

/** Add exact lexical shells; a callback shell is not a claim that it executes. */
function fragmentLines(statement: ts.Statement, owner: Owner): Set<number> | undefined {
  const result = new Set<number>()
  const add = (start: number, end: number): boolean => {
    if (start < owner.range.start || end > owner.range.end || end < start) return false
    for (let line = start; line <= end; line++) result.add(line)
    return true
  }
  const selected = rangeOf(statement, owner.source)
  if (!contains(owner.range, selected) || selected.end - selected.start > 80 || !add(selected.start, selected.end)) return undefined
  // A file has no lexical shell. Top-level bindings retain only their complete
  // declaration, with the rest represented by the file owner's omissions.
  if (owner.kind === 'source_file') return statement.parent === owner.source ? result : undefined
  let child: ts.Node = statement
  let steps = 0
  for (let parent = child.parent; parent && parent !== owner.declaration.parent; child = parent, parent = parent.parent) {
    if (++steps > 128) return undefined
    const range = rangeOf(parent, owner.source)
    if (!contains(owner.range, range)) return undefined
    if (ts.isBlock(parent)) {
      add(range.start, range.start); add(range.end, range.end)
    } else if (ts.isFunctionLike(parent) && 'body' in parent && parent.body) {
      const body = rangeOf(parent.body, owner.source)
      add(range.start, body.start); add(body.end, range.end)
    } else if (ts.isIfStatement(parent)) {
      const body = rangeOf(parent.thenStatement, owner.source)
      add(range.start, body.start); add(body.end, body.end)
      if (parent.elseStatement) {
        const other = rangeOf(parent.elseStatement, owner.source)
        add(body.end, other.start); add(other.end, other.end)
      }
    } else if (ts.isIterationStatement(parent, false)) {
      const body = rangeOf(parent.statement, owner.source)
      add(range.start, body.start); add(body.end, range.end)
    } else if (ts.isTryStatement(parent) || ts.isCatchClause(parent) || ts.isSwitchStatement(parent)
      || ts.isCaseBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      // Complex branch shells are withheld until they can be represented exactly.
      return undefined
    } else {
      const nested = rangeOf(child, owner.source)
      add(range.start, nested.start); add(nested.end, range.end)
    }
    if (parent === owner.declaration) return result
  }
  return statement === owner.declaration ? result : undefined
}
function retainedRanges(selected: ReadonlySet<number>): EvidenceLineRange[] {
  const result: EvidenceLineRange[] = []
  for (const line of [...selected].sort((left, right) => left - right)) {
    const last = result.at(-1)
    if (last && last.end_line + 1 === line) last.end_line = line
    else result.push({ start_line: line, end_line: line })
  }
  return result
}

/** Optional scoped selection: no new graph owners, edges, or semantic obligations. */
export function selectSourceFragments(
  inputOwners: readonly SourceFragmentOwner[], question: string, originalQuestion: string,
  explicitIds: ReadonlySet<string>, rootPath?: string, cache?: Map<string, string[] | null>,
): SourceFragmentSelection | undefined {
  if (!sourceQueryRequestsClauseLocations(question)) return undefined
  const clauses = clausesFor(question)
  if (!clauses || inputOwners.length > MAX_OWNERS) return undefined
  const files = new Map<string, { lines: string[]; source: ts.SourceFile }>()
  const owners: Owner[] = []
  let visits = 0
  let bounded = false
  const tick = (): boolean => { if (++visits > MAX_NODES) bounded = true; return !bounded }
  for (const owner of inputOwners) {
    let file = files.get(owner.sourceFile)
    if (!file) {
      if (files.size >= MAX_FILES) return undefined
      const lines = readEvidenceLines(owner.sourceFile, rootPath, cache)
      if (!lines) continue
      const source = sourceSyntaxTree(lines, owner.sourceFile)
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
      file = { lines, source }; files.set(owner.sourceFile, file)
    }
    const range = owner.fileNodeLike ? { start: 1, end: file.lines.length } : resolveSourceSymbolRange(file.lines, owner.range, owner.label, owner.sourceFile)
    const kind = owner.fileNodeLike ? 'source_file' : sourceDeclarationKind(file.lines, owner.range, owner.label, owner.sourceFile)
    if (!range || !kind || !['function', 'value', 'source_file'].includes(kind)) continue
    if (kind === 'source_file') { owners.push({ ...owner, range, ...file, kind, declaration: file.source }); continue }
    const matches: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      if (!tick()) return
      const current = rangeOf(node, file!.source)
      if (!contains(current, range)) return
      if (current.start === range.start && current.end === range.end
        && ((kind === 'function' && ts.isFunctionLike(node) && 'body' in node && node.body)
          || (kind === 'value' && (ts.isVariableStatement(node) || ts.isImportDeclaration(node))))) matches.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file.source)
    // Function-expression owners can include their assignment statement.
    let declaration = matches[0]
    if (!declaration && kind === 'function') {
      const find = (node: ts.Node): void => {
        if (!tick()) return
        const current = rangeOf(node, file!.source)
        if (!contains(current, range) && !contains(range, current)) return
        if (ts.isFunctionLike(node) && 'body' in node && node.body && contains(range, current)) matches.push(node)
        else ts.forEachChild(node, find)
      }
      find(file.source)
      if (matches.length === 1) declaration = matches[0]
    }
    if (matches.length !== 1 || !declaration) continue
    owners.push({ ...owner, range, ...file, kind, declaration })
  }
  if (bounded || !owners.length) return undefined
  const ownersFor = (node: ts.Node): Owner | undefined => {
    const range = rangeOf(node, node.getSourceFile())
    const possible = owners.filter(owner => owner.kind === 'function' && owner.source === node.getSourceFile() && contains(owner.range, range))
      .sort((left, right) => (left.range.end - left.range.start) - (right.range.end - right.range.start))
    if (!possible.length || (possible[1] && possible[0]!.range.start === possible[1].range.start && possible[0]!.range.end === possible[1].range.end)) return undefined
    const owner = possible[0]!
    let current: ts.Node | undefined = node
    for (; current && current !== owner.declaration; current = current.parent) {
      let bound = current
      while (bound.parent && (ts.isParenthesizedExpression(bound.parent) || ts.isAsExpression(bound.parent)
        || ts.isNonNullExpression(bound.parent) || ts.isSatisfiesExpression(bound.parent) || ts.isTypeAssertionExpression(bound.parent))) bound = bound.parent
      if (ts.isClassLike(current) || (ts.isFunctionLike(current) && (
        ('name' in current && current.name)
        || ts.isVariableDeclaration(bound.parent) || ts.isPropertyAssignment(bound.parent)
        || (ts.isBinaryExpression(bound.parent) && bound.parent.right === bound)
      ))) return undefined
    }
    return current === owner.declaration ? owner : undefined
  }
  const compiler = createSourceCompilerHost(new Map([...files].map(([path, file]) => [path, file.source])), '')
  if (!compiler) return undefined
  const program = ts.createProgram(compiler.rootNames, { allowJs: true, checkJs: false, noLib: true, noResolve: true }, compiler.host)
  const checker = program.getTypeChecker()
  const writes = new Set<ts.Symbol>()
  const statements: Statement[] = []
  const moduleExports = new Map<ts.SourceFile, ts.BinaryExpression[]>()
  const unsupportedModuleExports = new Set<ts.SourceFile>()
  for (const { source } of files.values()) {
    const visit = (node: ts.Node): void => {
      if (!tick()) return
      if (ts.isIdentifier(node) && ((ts.isBinaryExpression(node.parent) && node.parent.left === node
        && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
          && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken)))) {
        const symbol = checker.getSymbolAtLocation(node); if (symbol) writes.add(symbol)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isPropertyAccessExpression(node.left)
        && ts.isIdentifier(node.left.expression) && node.left.expression.text === 'module' && node.left.name.text === 'exports') {
        const assignments = moduleExports.get(source) ?? []; assignments.push(node); moduleExports.set(source, assignments)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isElementAccessExpression(node.left)
        && ts.isIdentifier(node.left.expression) && node.left.expression.text === 'module'
        && (!ts.isStringLiteral(node.left.argumentExpression) || node.left.argumentExpression.text === 'exports')) unsupportedModuleExports.add(source)
      if (isAtom(node)) {
        const owner = ownersFor(node)
        if (owner?.kind === 'function') {
          const evidence = statementEvidence(node, owner, tick)
          if (evidence && rangeOf(node, source).end - rangeOf(node, source).start <= 80) statements.push(evidence)
          if (statements.length > MAX_STATEMENTS) bounded = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (bounded) return undefined
  const chosen = new Map<string, Set<number>>()
  const chosenStatements = new Map<string, Set<ts.Statement>>()
  const ownerIds: string[] = []
  const bindingIds: string[] = []
  const addStatement = (node: ts.Statement, owner: Owner): boolean => {
    const selected = fragmentLines(node, owner)
    if (!selected) return false
    if (!chosen.has(owner.id)) { chosen.set(owner.id, new Set()); ownerIds.push(owner.id) }
    for (const line of selected) chosen.get(owner.id)!.add(line)
    const complete = chosenStatements.get(owner.id) ?? new Set<ts.Statement>()
    complete.add(node); chosenStatements.set(owner.id, complete)
    return true
  }
  const requestedPaths = [...originalQuestion.matchAll(/(?:\.\/)?[\w@-]+(?:[./\\][\w@-]+)+/g)]
    .map(match => match[0].replaceAll('\\', '/'))
  const withoutExtension = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/i, '')
  const moduleRequested = (specifier: string, from: string): ts.SourceFile | undefined => {
    if (!specifier.startsWith('.')) return undefined
    const target = resolve(dirname(resolve(rootPath ?? '.', from)), specifier)
    const sources = [...files.keys()].map(file => resolve(rootPath ?? '.', file))
    const matches = sources.filter(file => withoutExtension(file) === withoutExtension(target))
    if (matches.length !== 1) return undefined
    const requested = requestedPaths.some(path => path.includes('/')
      ? withoutExtension(resolve(rootPath ?? '.', path)) === withoutExtension(matches[0]!)
      : sources.filter(file => withoutExtension(basename(file)) === withoutExtension(path)).length === 1
        && withoutExtension(basename(matches[0]!)) === withoutExtension(path))
    return requested ? [...files.entries()].find(([file]) => resolve(rootPath ?? '.', file) === matches[0])?.[1].source : undefined
  }
  // ESM binding transport is deliberately outside this prototype. Do not
  // narrow a requested module connection while silently dropping its import.
  for (const { source } of files.values()) for (const statement of source.statements) {
    let specifier: string | undefined
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const typeOnly = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every(binding => binding.isTypeOnly))
      if (!typeOnly) specifier = statement.moduleSpecifier.text
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)) specifier = statement.moduleSpecifier.text
    else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)) specifier = statement.moduleReference.expression.text
    if (specifier && moduleRequested(specifier, compiler.nativePath(source))) return undefined
  }
  // Retain only existing, uniquely indexed module binding owners. A source read
  // proves a value connection; it does not claim plugin or callback invocation.
  for (const { source } of files.values()) for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue
    const declaration = statement.declarationList.declarations[0]!
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || immutableDeclaration(declaration.name, checker, writes) !== declaration) continue
    const initializer = declaration.initializer
    if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require'
      || initializer.arguments.length !== 1 || !ts.isStringLiteral(initializer.arguments[0]!)
      || checker.getSymbolAtLocation(initializer.expression)?.declarations?.length) continue
    const target = moduleRequested(initializer.arguments[0]!.text, compiler.nativePath(source))
    if (!target) continue
    const bindingRange = rangeOf(statement, source)
    const valueOwners = owners.filter(owner => owner.source === source && owner.kind === 'value'
      && owner.range.start === bindingRange.start && owner.range.end === bindingRange.end)
    if (valueOwners.length > 1) return undefined
    const fileOwners = owners.filter(owner => owner.source === source && owner.kind === 'source_file')
    const owner = valueOwners[0] ?? (fileOwners.length === 1 ? fileOwners[0] : undefined)
    if (!owner) return undefined
    if (owner.kind === 'source_file' && !addStatement(statement, owner)) return undefined
    bindingIds.push(owner.id)
    // A unique direct default export is the implementation value of this
    // relative module binding. This still says nothing about its invocation.
    const exported = moduleExports.get(target) ?? []
    const assignment = exported.length === 1 ? exported[0] : undefined
    const moduleDeclarations = assignment && ts.isPropertyAccessExpression(assignment.left)
      ? checker.getSymbolAtLocation(assignment.left.expression)?.declarations ?? [] : []
    // The JS checker represents builtin CommonJS module with an export=
    // symbol declared by this exact assignment. A lexical module declaration
    // is different source identity and remains an unresolved shadow.
    const builtinModule = moduleDeclarations.length === 0
      || (moduleDeclarations.length === 1 && moduleDeclarations[0] === assignment)
    if (assignment && !unsupportedModuleExports.has(target) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isExpressionStatement(assignment.parent) && assignment.parent.parent === target
      && ts.isPropertyAccessExpression(assignment.left) && ts.isIdentifier(assignment.left.expression)
      && builtinModule
      && (ts.isFunctionExpression(assignment.right) || ts.isArrowFunction(assignment.right))) {
      const targets = owners.filter(candidate => candidate.kind === 'function' && candidate.declaration === assignment.right)
      if (targets.length === 1 && !ownerIds.includes(targets[0]!.id)) ownerIds.push(targets[0]!.id)
    }
    const binding = checker.getSymbolAtLocation(declaration.name)
    for (const evidence of statements) {
      if (!ts.isExpressionStatement(evidence.node) || !ts.isBinaryExpression(evidence.node.expression)) continue
      const assignment = evidence.node.expression
      if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.right)
        || checker.getSymbolAtLocation(assignment.right) !== binding || !addStatement(evidence.node, evidence.owner)) continue
      if (ts.isPropertyAccessExpression(assignment.left) && ts.isIdentifier(assignment.left.expression)) {
        const receiver = immutableDeclaration(assignment.left.expression, checker, writes)
        const receiverStatement = receiver && enclosingStatement(receiver)
        if (receiverStatement && receiverStatement.getSourceFile() === evidence.owner.source
          && contains(evidence.owner.range, rangeOf(receiverStatement, evidence.owner.source))) addStatement(receiverStatement, evidence.owner)
      }
      if (ownerIds.length > MAX_WITNESSES) return undefined
    }
  }
  const frequency = new Map<string, number>()
  for (const evidence of statements) for (const term of evidence.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  for (const clause of clauses) {
    const ranked = statements.map(evidence => {
      const pairs = [...evidence.pairs].filter(pair => clause.pairs.has(pair)).length
      const exact = [...evidence.literals].filter(literal => clause.literals.includes(literal)).length
      const hits = [...evidence.terms].filter(term => clause.terms.has(term) && !NOISE.has(term))
      const role = clause.role === 'construction' ? evidence.construction : clause.role === 'decision' ? evidence.decision : false
      return { evidence, pairs, exact, hits, role, weight: hits.reduce((sum, term) => sum + 1 / Math.sqrt(frequency.get(term) ?? 1), 0) }
    }).filter(entry => entry.exact || entry.pairs || entry.hits.length >= 2)
      .sort((left, right) => right.exact - left.exact || right.pairs - left.pairs
        || Number(right.role) - Number(left.role) || right.weight - left.weight
        || Number(explicitIds.has(right.evidence.owner.id)) - Number(explicitIds.has(left.evidence.owner.id))
        || left.evidence.node.getStart() - right.evidence.node.getStart())
    let matched = false
    for (const entry of ranked) {
      if (addStatement(entry.evidence.node, entry.evidence.owner)) { matched = true; break }
    }
    // An unrepresented request keeps legacy selection; lexical matches are not
    // a reason to silently discard another independent clause.
    if (!matched) return undefined
    if (ownerIds.length > MAX_WITNESSES) return undefined
  }
  if (!ownerIds.length) return undefined
  const fragments = new Map<string, SourceFragment>()
  for (const [id, selected] of chosen) {
    const owner = owners.find(candidate => candidate.id === id)!
    const complete = [...chosenStatements.get(id) ?? []].sort((left, right) => left.getStart(owner.source) - right.getStart(owner.source))
    for (let index = 1; index < complete.length; index++) {
      const left = complete[index - 1]!, right = complete[index]!, parent = left.parent
      if (parent !== right.parent || (!ts.isBlock(parent) && !ts.isSourceFile(parent))) continue
      const siblings = parent.statements
      if (siblings.indexOf(right) !== siblings.indexOf(left) + 1) continue
      const first = rangeOf(left, owner.source).end + 1, last = rangeOf(right, owner.source).start - 1
      if (last < first || last - first >= 4) continue
      const trivia = owner.source.text.slice(left.getEnd(), right.getStart(owner.source))
      if (trivia.length > 512) continue
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, trivia)
      let token = scanner.scan(), triviaOnly = true
      while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (![ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia, ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token)) { triviaOnly = false; break }
        token = scanner.scan()
      }
      if (triviaOnly) for (let line = first; line <= last; line++) selected.add(line)
    }
    // Small implementations remain complete; excerpts serve large
    // owners where lexical best-line windows would erase independent clauses.
    if (owner.kind !== 'source_file' && owner.range.end - owner.range.start < 80) continue
    const size = [...selected].reduce((sum, line) => sum + (owner.lines[line - 1]?.length ?? 0) + 1, 0)
    if (size > MAX_CHARS) return undefined
    fragments.set(id, { sourceHash: hash(owner.lines), range: owner.range, retained: retainedRanges(selected) })
  }
  return { ownerIds, bindingIds, fragments }
}

export function renderSourceFragment(lines: readonly string[], range: SourceLineRange, fragment: SourceFragment, scope: 'symbol' | 'source_file' = 'symbol'): {
  snippet: string; lineNumber: number; scope: 'symbol' | 'source_file'; lineRange: EvidenceLineRange; omittedRanges: EvidenceLineRange[]
} | undefined {
  if (hash(lines) !== fragment.sourceHash || range.start !== fragment.range.start || range.end !== fragment.range.end) return undefined
  const omittedRanges: EvidenceLineRange[] = []
  const text: string[] = []
  let next = range.start
  for (const kept of fragment.retained) {
    if (kept.start_line < next || kept.end_line < kept.start_line || kept.end_line > range.end) return undefined
    if (next < kept.start_line) {
      omittedRanges.push({ start_line: next, end_line: kept.start_line - 1 })
      text.push(`[omitted lines ${next}-${kept.start_line - 1}]`)
    }
    text.push(...lines.slice(kept.start_line - 1, kept.end_line))
    next = kept.end_line + 1
  }
  if (next <= range.end) { omittedRanges.push({ start_line: next, end_line: range.end }); text.push(`[omitted lines ${next}-${range.end}]`) }
  return { snippet: text.join('\n'), lineNumber: range.start, scope, lineRange: { start_line: range.start, end_line: range.end }, omittedRanges }
}
