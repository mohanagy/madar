import { extname } from 'node:path'
import ts from 'typescript'

import { JS_TS_SOURCE_EXTENSIONS } from '../../shared/source-extensions.js'
import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { sourceDeclarationQualifiedName, sourceRequestProse, sourceSyntaxTree, type EvidenceLineRange } from './source-evidence.js'

const MAX_SYNTAX_NODES = 20_000
const MAX_ANCESTORS = 256
const MAX_EXCERPT_CHARS = 12_000
const JS_TS_EXTENSIONS = new Set<string>(JS_TS_SOURCE_EXTENSIONS)
type Range = EvidenceLineRange

function unwrap(value: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isNonNullExpression(value)) value = value.expression
  return value
}

function callable(node: ts.Node, source: ts.SourceFile): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node
  let value = ts.isVariableDeclaration(node) ? node.initializer
    : sourceFunctionOccurrence(node, source) ? ts.isBinaryExpression(node) ? node.right : ts.isFunctionExpression(node) ? node : undefined
      : undefined
  if (value) value = unwrap(value)
  return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined
}

function control(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isCaseBlock(node)
    || ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isTryStatement(node) || ts.isCatchClause(node)
    || ts.isWithStatement(node) || ts.isLabeledStatement(node)
}

/** A conservative positive request, preserving identifier spelling and excluding quoted code. */
export function sourceTypeRejectionQueryIdentifiers(question: string): ReadonlySet<string> | undefined {
  if (question.length > 8192) return undefined
  const prose = sourceRequestProse(question).replace(/(?:\.\/)?[\w@-]+(?:[./\\][\w@*-]+)+/g, value => ' '.repeat(value.length))
  if (!/\b(?:source|code|implementation)\b/i.test(prose)) return undefined
  const clauses = prose.split(/[.;,!?]/)
  if (clauses.length > 8) return undefined
  const names = new Set<string>()
  const noise = new Set('a an the for of in on and or to from with find locate show source code implementation final type types validate validates validating validation validations reject rejects rejected rejecting rejection rejections'.split(' '))
  for (const clause of clauses) {
    if (!/\btypes?[\s-]+(?:validat(?:e|es|ing|ion|ions)|reject(?:s|ed|ing|ion|ions)?)\b|\b(?:validat(?:e|es|ing|ion|ions)|reject(?:s|ed|ing|ion|ions)?)\b[^.;,!?]{0,80}\btypes?\b/i.test(clause)
      || /\b(?:no|not|never|without|avoid|skip|exclude|ignore|cannot|neither|nor|none|non|absent|absence|lack|lacks|lacked|lacking|missing)\b|\b(?:isn|aren|wasn|weren|don|doesn|didn|shouldn|mustn|can|couldn|won|wouldn|hasn|haven|hadn)['’]t\b/i.test(clause)) continue
    for (const match of clause.matchAll(/(?<![\w$#./\\])[A-Za-z_$][\w$]*(?![\w$#./\\])/g)) {
      if (!noise.has(match[0].toLowerCase())) names.add(match[0])
    }
  }
  return names.size && names.size <= 32 ? names : undefined
}

export interface SourceTypeRejectionUnit { branch: Range; retained: Range[] }

/** Exact local type guards; omitted earlier control flow is never asserted complete. */
export function sourceTypeRejectionUnits(
  lines: readonly string[], sourceFile: string, label: string, owner: Range, identifiers: ReadonlySet<string>,
): SourceTypeRejectionUnit[] | null {
  if (!identifiers.size || identifiers.size > 32 || !JS_TS_EXTENSIONS.has(extname(sourceFile).toLowerCase())
    || !sourceDeclarationQualifiedName(lines, { start: owner.start_line, end: owner.end_line }, label, sourceFile)) return null
  const source = sourceSyntaxTree(lines, sourceFile)
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
  const range = (node: ts.Node): Range => ({ start_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end_line: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1 })
  let visited = 0
  const step = (): void => { if (++visited > MAX_SYNTAX_NODES) throw new Error('Source syntax bound exceeded') }
  const owners = new Set<ts.FunctionLikeDeclaration>()
  try {
    const find = (node: ts.Node): void => {
      step(); const fn = callable(node, source), span = fn ? range(node) : null
      if (fn?.body && ts.isBlock(fn.body) && span?.start_line === owner.start_line && span.end_line === owner.end_line) owners.add(fn)
      ts.forEachChild(node, find)
    }
    find(source)
    if (owners.size !== 1) return null
    const fn = [...owners][0]!, body = fn.body
    if (!body || !ts.isBlock(body)) return null
    const result: SourceTypeRejectionUnit[] = []
    for (const statement of body.statements) {
      step()
      if (!ts.isIfStatement(statement) || statement.elseStatement) continue
      const thrown = ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1
        ? statement.thenStatement.statements[0] : statement.thenStatement
      if (!thrown || !ts.isThrowStatement(thrown)) continue
      const subjects = new Set<string>(), reads = new Set<string>()
      let unsupported = false
      const inspect = (node: ts.Node, condition: boolean): void => {
        step()
        if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) { unsupported = true; return }
        if (ts.isTypeNode(node)) return
        if (condition && ts.isTypeOfExpression(node)) {
          const value = unwrap(node.expression)
          if (ts.isIdentifier(value) && identifiers.has(value.text)) subjects.add(value.text)
        }
        if (!condition && ts.isIdentifier(node) && identifiers.has(node.text)) {
          const parent = node.parent
          let value: ts.Node = node
          while (value.parent && (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent)
            || ts.isNonNullExpression(value.parent))) value = value.parent
          const context = value.parent
          const written = ts.isBinaryExpression(context) && context.left === value
            && context.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && context.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            || (ts.isPrefixUnaryExpression(context) || ts.isPostfixUnaryExpression(context))
              && (context.operator === ts.SyntaxKind.PlusPlusToken || context.operator === ts.SyntaxKind.MinusMinusToken)
            || ts.isDeleteExpression(context)
          if (!written && !(ts.isPropertyAccessExpression(parent) && parent.name === node)
            && (!('name' in parent) || parent.name !== node || ts.isShorthandPropertyAssignment(parent))) reads.add(node.text)
        }
        ts.forEachChild(node, child => inspect(child, condition))
      }
      inspect(statement.expression, true); inspect(thrown.expression, false)
      if (unsupported || ![...subjects].some(name => reads.has(name))) continue
      const branch = range(statement), retained = [{ start_line: owner.start_line, end_line: range(body).start_line }, branch,
        { start_line: range(body).end_line, end_line: owner.end_line }]
      const kept = new Set<number>()
      for (const part of retained) for (let line = part.start_line; line <= part.end_line; line++) kept.add(line)
      if ([...kept].reduce((sum, line) => sum + (lines[line - 1]?.length ?? MAX_EXCERPT_CHARS) + 1, 0) > MAX_EXCERPT_CHARS) return null
      result.push({ branch, retained })
    }
    return result
  } catch { return null }
}

/** Complete only a uniquely bracketed interior, never a new branch or control path. */
export function sourceBracketedBranchRanges(
  lines: readonly string[], sourceFile: string, label: string, owner: Range, delivered: readonly Range[],
): Range[] | null {
  if (delivered.length > 4096 || !JS_TS_EXTENSIONS.has(extname(sourceFile).toLowerCase())
    || !sourceDeclarationQualifiedName(lines, { start: owner.start_line, end: owner.end_line }, label, sourceFile)) return null
  const source = sourceSyntaxTree(lines, sourceFile)
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
  let visited = 0
  const step = (): void => { if (++visited > MAX_SYNTAX_NODES) throw new Error('Source syntax bound exceeded') }
  const span = (node: ts.Node): Range => ({ start_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end_line: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1 })
  const visible = (range: Range): boolean => {
    for (let line = range.start_line; line <= range.end_line; line++) {
      if (!delivered.some(part => part.start_line <= line && part.end_line >= line)) return false
    }
    return true
  }
  const bracketed = (node: ts.IfStatement): boolean => ts.isBlock(node.thenStatement) && !node.elseStatement
    && visible({ start_line: span(node).start_line, end_line: span(node.thenStatement).start_line })
    && visible({ start_line: span(node.thenStatement).end_line, end_line: span(node.thenStatement).end_line })
  const owners = new Set<ts.FunctionLikeDeclaration>()
  try {
    const find = (node: ts.Node): void => {
      step(); const fn = callable(node, source), range = fn ? span(node) : null
      if (fn?.body && ts.isBlock(fn.body) && range?.start_line === owner.start_line && range.end_line === owner.end_line) owners.add(fn)
      ts.forEachChild(node, find)
    }
    find(source)
    if (owners.size !== 1) return null
    const body = [...owners][0]!.body
    if (!body || !ts.isBlock(body)) return null
    if (!visible({ start_line: owner.start_line, end_line: span(body).start_line })
      || !visible({ start_line: span(body).end_line, end_line: owner.end_line })) return []
    const supported = (node: ts.Node): boolean => {
      step()
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
        || control(node) && (!ts.isIfStatement(node) || !!node.elseStatement)
        || ts.isIfStatement(node) && !ts.isBlock(node.thenStatement)) return false
      return ts.forEachChild(node, child => supported(child) ? undefined : true) !== true
    }
    const ancestorsVisible = (node: ts.Node): boolean => {
      let current = node, count = 0
      while (current !== body) {
        if (++count > MAX_ANCESTORS) throw new Error('Source ancestor bound exceeded')
        const parent = current.parent
        if (ts.isBlock(parent)) {
          const range = span(parent)
          if (!visible({ start_line: range.start_line, end_line: range.start_line })
            || !visible({ start_line: range.end_line, end_line: range.end_line })) return false
        } else if (!ts.isIfStatement(parent) || parent.thenStatement !== current || !bracketed(parent)) return false
        current = parent
      }
      return true
    }
    const result: Range[] = []
    const visit = (node: ts.Node): void => {
      step()
      if (node !== body && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return
      if (ts.isIfStatement(node) && ts.isBlock(node.thenStatement) && bracketed(node)) {
        const block = node.thenStatement, terminal = block.statements.at(-1), range = span(node)
        if (range.end_line - range.start_line < 32 && terminal && (ts.isReturnStatement(terminal) || ts.isThrowStatement(terminal))
          && visible(span(terminal)) && ancestorsVisible(node) && supported(node)) {
          const missing: Range[] = []
          for (let line = range.start_line; line <= range.end_line; line++) if (!visible({ start_line: line, end_line: line })) {
            const prior = missing.at(-1)
            if (prior && prior.end_line + 1 === line) prior.end_line = line
            else missing.push({ start_line: line, end_line: line })
          }
          const gap = missing[0], statements = block.statements.filter(statement => {
            const part = span(statement)
            return gap && part.start_line <= gap.end_line && part.end_line >= gap.start_line
          })
          if (missing.length === 1 && gap && gap.start_line > span(block).start_line && gap.end_line < span(terminal).start_line
            && statements.length && statements.every(statement => span(statement).start_line >= gap.start_line && span(statement).end_line <= gap.end_line)) {
            const kept = new Set<number>()
            for (const part of [...delivered, range]) for (let line = part.start_line; line <= part.end_line; line++) kept.add(line)
            if ([...kept].reduce((sum, line) => sum + (lines[line - 1]?.length ?? MAX_EXCERPT_CHARS) + 1, 0) > MAX_EXCERPT_CHARS) throw new Error('Source excerpt bound exceeded')
            result.push(range)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return result
  } catch { return null }
}

/** Syntax only: existing guards and optional immediate branch exits, without dependency or query selection. */
export function sourceExcerptGuardRanges(
  lines: readonly string[], sourceFile: string, label: string, owner: Range, delivered: readonly Range[],
  options: { includeTerminalSiblings?: boolean } = {},
): Range[] | null {
  if (!JS_TS_EXTENSIONS.has(extname(sourceFile).toLowerCase()) || delivered.length > 4096
    || !sourceDeclarationQualifiedName(lines, { start: owner.start_line, end: owner.end_line }, label, sourceFile)) return null
  const source = sourceSyntaxTree(lines, sourceFile)
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
  let visited = 0
  const step = (): void => { if (++visited > MAX_SYNTAX_NODES) throw new Error('Source syntax bound exceeded') }
  const lineRange = (start: number, end: number): Range | null => {
    while (start < end && /\s/.test(source.text[start]!)) start++
    while (end > start && /\s/.test(source.text[end - 1]!)) end--
    return end > start ? { start_line: source.getLineAndCharacterOfPosition(start).line + 1,
      end_line: source.getLineAndCharacterOfPosition(end - 1).line + 1 } : null
  }
  const intersects = (range: Range): boolean => delivered.some(part => part.start_line <= range.end_line && part.end_line >= range.start_line)
  const candidates = new Set<ts.FunctionLikeDeclaration>()
  try {
    const findOwner = (node: ts.Node): void => {
      step()
      const fn = callable(node, source), range = fn ? lineRange(node.getStart(source), node.getEnd()) : null
      if (fn?.body && ts.isBlock(fn.body) && range?.start_line === owner.start_line && range.end_line === owner.end_line) candidates.add(fn)
      ts.forEachChild(node, findOwner)
    }
    findOwner(source)
    if (candidates.size !== 1) return null
    const fn = [...candidates][0]!, body = fn.body
    if (!body || !ts.isBlock(body)) return null
    const kept: Range[] = []
    const terminalCandidates = new Set<ts.ReturnStatement | ts.ThrowStatement>()
    const keep = (start: number, end: number, into = kept): void => {
      const range = lineRange(start, end)
      if (!range) return
      if (range.start_line < owner.start_line || range.end_line > owner.end_line) throw new Error('Source syntax escapes its owner')
      into.push(range)
    }
    const braces = (block: ts.Block, into = kept): void => {
      keep(block.getStart(source), block.getStart(source) + 1, into)
      keep(block.getEnd() - 1, block.getEnd(), into)
    }
    const shells = new Map<ts.Node, Range[]>()
    const shell = (node: ts.Node): Range[] => {
      const cached = shells.get(node)
      if (cached) return cached
      step()
      const ranges: Range[] = [], children: ts.Node[] = []
      ts.forEachChild(node, child => {
        if (ts.isStatement(child) || control(child)) children.push(child)
      })
      let position = node.getStart(source)
      for (const child of children) {
        keep(position, child.getStart(source), ranges)
        if (ts.isBlock(child)) braces(child, ranges)
        else if (control(child)) ranges.push(...shell(child))
        // An unrelated statement body is represented by the final renderer's
        // omission markers, including non-block branches and switch siblings.
        position = child.getEnd()
      }
      keep(position, node.getEnd(), ranges)
      shells.set(node, ranges)
      return ranges
    }
    const ancestors = (node: ts.Node): void => {
      let cursor = node, count = 0
      while (cursor !== body) {
        if (++count > MAX_ANCESTORS) throw new Error('Source ancestor bound exceeded')
        const parent = cursor.parent
        if (!parent || ts.isFunctionLike(parent)) throw new Error('Source syntax crosses a function boundary')
        if (ts.isBlock(parent)) braces(parent)
        else if (control(parent)) kept.push(...shell(parent))
        else throw new Error('Unsupported source statement ancestry')
        cursor = parent
      }
    }
    const hasFunction = (node: ts.Node): boolean => {
      step()
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return true
      return ts.forEachChild(node, hasFunction) ?? false
    }
    const visit = (node: ts.Node): void => {
      step()
      const range = lineRange(node.getStart(source), node.getEnd())
      if (!range || !intersects(range)) return
      if (node !== body && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
        throw new Error('Selected nested function syntax is unsupported')
      }
      if (ts.isBlock(node)) { for (const statement of node.statements) visit(statement); return }
      if (control(node)) {
        const ranges = shell(node)
        if (ranges.some(intersects)) { kept.push(...ranges); ancestors(node) }
        ts.forEachChild(node, child => { if (ts.isStatement(child) || control(child)) visit(child) })
        return
      }
      if (ts.isStatement(node)) {
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || hasFunction(node)) throw new Error('Unsupported selected declaration')
        keep(node.getStart(source), node.getEnd())
        ancestors(node)
        // Only an originally delivered executable statement can authorize its
        // immediate branch exit. Added guard shells never seed more source.
        if (options.includeTerminalSiblings === true
          && (ts.isExpressionStatement(node) || ts.isVariableStatement(node) || ts.isDebuggerStatement(node))) {
          const block = node.parent
          if (ts.isBlock(block) && ts.isIfStatement(block.parent)
            && (block.parent.thenStatement === block || block.parent.elseStatement === block)
            && block.statements.at(-2) === node) {
            const next = block.statements.at(-1)
            if (next && (ts.isReturnStatement(next) || ts.isThrowStatement(next))) terminalCandidates.add(next)
          }
        }
      }
    }
    visit(body)
    const union = new Set<number>()
    for (const range of [...delivered, ...kept]) for (let line = range.start_line; line <= range.end_line; line++) union.add(line)
    let chars = 0
    for (const line of union) {
      chars += (lines[line - 1]?.length ?? MAX_EXCERPT_CHARS) + 1
      if (chars > MAX_EXCERPT_CHARS) return null
    }
    if (options.includeTerminalSiblings !== true) return kept
    // Optional exits cannot invalidate the old guard result. Scan only after
    // it is finalized, using the remaining syntax allowance and source cap.
    const terminals: Range[] = []
    try {
      for (const terminal of terminalCandidates) {
        const range = lineRange(terminal.getStart(source), terminal.getEnd())
        if (!range) return kept
        let alreadyKept = true
        for (let line = range.start_line; line <= range.end_line; line++) if (!union.has(line)) { alreadyKept = false; break }
        if (alreadyKept) continue
        if (hasFunction(terminal)) return kept
        keep(terminal.getStart(source), terminal.getEnd(), terminals)
        for (let line = range.start_line; line <= range.end_line; line++) {
          if (union.has(line)) continue
          chars += (lines[line - 1]?.length ?? MAX_EXCERPT_CHARS) + 1
          if (chars > MAX_EXCERPT_CHARS) return kept
          union.add(line)
        }
      }
    } catch { return kept }
    return terminals.length ? [...kept, ...terminals] : kept
  } catch { return null }
}
