import { createHash } from 'node:crypto'
import ts from 'typescript'
const {
  isArrowFunction: isArrow, isBinaryExpression: isBinary,
  isCallExpression: isCall, isFunctionExpression: isFunction,
  isIdentifier, isIfStatement: isIf, isNewExpression: isNew,
  isNumericLiteral: isNumeric, isParameter, isPropertyAccessExpression: isAccess,
  isPropertyDeclaration: isPropertyDecl, isTypeReferenceNode: isTypeReference,
  isVariableDeclaration: isVariable,
} = ts
const K = ts.SyntaxKind
import {
  decodeIndexBodyFactTable, encodeIndexBodyFactTable, INDEX_BODY_FACT_CONTROL_LIMIT,
  IndexBodyFactBoundsError, indexBodyFactId, indexChannelId,
} from '../../domain/index/model.js'
import type {
  IndexBodyFact, IndexCallFact, IndexChannelNode, IndexControlFrame,
  IndexDiagnostic, IndexEdge, IndexFactEvidence, IndexFactSource,
  IndexChannelTransport, IndexPersistenceOperation, IndexRange, IndexSymbol, IndexValue,
} from '../../domain/index/model.js'
export type CollectExecutionInput = {
  program: ts.Program; sourceFiles: readonly ts.SourceFile[]
  checker: ts.TypeChecker; pathToFileId: ReadonlyMap<string, string>
  symbols: IndexSymbol[]
  symbolsByFile: ReadonlyMap<string, readonly IndexSymbol[]>
}
export type CollectExecutionResult = {
  channels: readonly IndexChannelNode[]; edges: readonly IndexEdge[]
  diagnostics: readonly IndexDiagnostic[]
}
type Confidence = 'high' | 'medium' | 'low'
type OwnerSpan = { symbol: IndexSymbol; start: number; end: number }
type ImportBinding = { imported: string; module: string; namespace: boolean }
type CallSite = readonly [targetId: string, arguments: readonly IndexValue[], node: EffectWitness]
type QueueTransport = Extract<IndexChannelTransport, 'bull' | 'bullmq'>
type QueueOrigin = readonly [key: IndexValue, transport: QueueTransport]
type MapQueueEntry = readonly [key: ts.Expression, file: FileContext, queueKey: ts.Expression, transport: QueueTransport]
type EmitterScope = readonly [scope: string, transport: 'node-event-emitter' | 'nestjs-event-emitter']
type EffectWitness = ts.CallExpression | ts.NewExpression
type BullEffect = readonly [
  kind: 'bull-publish' | 'bull-consume', queue: IndexValue,
  endpoint: IndexValue, transport: QueueTransport, scope: undefined,
  witness: EffectWitness, confidence: Confidence, source: IndexFactSource]
type EventEffect = readonly [
  kind: 'event-publish' | 'event-consume', event: IndexValue,
  handler: IndexValue | undefined,
  transport: 'node-event-emitter' | 'nestjs-event-emitter', scope: string,
  witness: EffectWitness, confidence: Confidence, source: IndexFactSource]
type PersistenceEffect = readonly [
  kind: 'persistence', operation: IndexPersistenceOperation,
  resource: IndexValue | undefined, receiverType: string, scope: undefined,
  witness: EffectWitness, confidence: Confidence, source: IndexFactSource]
type ExecutionEffect = BullEffect | EventEffect | PersistenceEffect
type FileContext = {
  sf: ts.SourceFile; fileId: string; imports: ReadonlyMap<string, ImportBinding>
  owners: readonly OwnerSpan[]
}
type CollectionState = {
  input: CollectExecutionInput; symbolsById: ReadonlyMap<string, IndexSymbol>
  facts: Map<string, IndexBodyFact[]>; overflow: Set<string>
  effects: Map<string, ExecutionEffect[]>; calls: Map<string, CallSite[]>
  callIds: Map<ts.Node, string>; channels: Map<string, IndexChannelNode>
  edges: IndexEdge[]; diagnostics: IndexDiagnostic[]; seenDiagnostics: Set<string>
  unstable: Set<ts.Symbol>
  mapQueues: Map<ts.Symbol, Array<MapQueueEntry | null>>
  emitters: Map<string, EmitterScope>; nestQueues: Map<string, Map<string, QueueOrigin>>
  files: Map<ts.SourceFile, FileContext>
}
// Internal helpers are abbreviated because their emitted names count against
// the protected npm ceiling; exported names and serialized fields stay explicit.
const VDEP = 5, VELE = 32
const SBYT = 512, TBYT = 256
const WHOP = 2
const FMAX = 8_192, EMAX = 8_192
const FSM = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises'])
const FSO = {
  readFile: 'file_read', readFileSync: 'file_read',
  opendir: 'file_read', readdir: 'file_read', appendFile: 'file_write',
  appendFileSync: 'file_write', copyFile: 'file_write', copyFileSync: 'file_write',
  rename: 'file_write', writeFile: 'file_write', writeFileSync: 'file_write',
  rm: 'delete', rmSync: 'delete', unlink: 'delete', unlinkSync: 'delete',
} as const satisfies Record<string, IndexPersistenceOperation>
const TOO = {
  find: 'read', findOne: 'read', findOneBy: 'read', findMany: 'read',
  findUnique: 'read', count: 'read', aggregate: 'read', insert: 'create',
  save: 'upsert', update: 'update',
  updateOne: 'update', updateMany: 'update', delete: 'delete',
  deleteOne: 'delete', deleteMany: 'delete', remove: 'delete', upsert: 'upsert',
  transaction: 'transaction',
} as const satisfies Record<string, IndexPersistenceOperation>
const PRO = {
  findUnique: 'read', findFirst: 'read', findMany: 'read', count: 'read',
  aggregate: 'read', groupBy: 'read', create: 'create', createMany: 'create',
  update: 'update', updateMany: 'update', delete: 'delete',
  deleteMany: 'delete', upsert: 'upsert', $transaction: 'transaction',
} as const satisfies Record<string, IndexPersistenceOperation>
const PMC = {
  all: 'all_or_first_rejection', allSettled: 'all_settled',
  any: 'first_fulfilled', race: 'first_settled',
} as const
const LFL = new Map<ts.SyntaxKind, readonly [ConditionKind, BranchArm]>([
  [K.AmpersandAmpersandToken, ['logical_and', 'truthy']],
  [K.BarBarToken, ['logical_or', 'falsy']],
  [K.QuestionQuestionToken, ['nullish', 'nullish']],
])
const AMU = new Map<string, MutationOperation>([
  ['push', 'append'], ['unshift', 'append'], ['pop', 'remove'],
  ['shift', 'remove'], ['splice', 'remove'],
])
const FORD: Readonly<Record<IndexBodyFact['kind'], number>> = {
  condition: 0, loop: 1, parallel: 2, call: 3, literal: 4,
  mutation: 5, persistence: 6, return: 7, throw: 8,
}
const AOP = new Set<ts.SyntaxKind>([
  K.EqualsToken, K.PlusEqualsToken,
  K.MinusEqualsToken, K.AsteriskEqualsToken,
  K.AsteriskAsteriskEqualsToken, K.SlashEqualsToken,
  K.PercentEqualsToken, K.LessThanLessThanEqualsToken,
  K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken,
  K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken,
  K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken,
  K.QuestionQuestionEqualsToken,
])
const AIM = new Set([
  'every', 'filter', 'find', 'findIndex', 'flatMap',
  'forEach', 'map', 'reduce', 'reduceRight', 'some',
])
const SLT = new Set([
  K.StringLiteral, K.NumericLiteral,
  K.BigIntLiteral, K.RegularExpressionLiteral,
  K.NoSubstitutionTemplateLiteral, K.TemplateHead,
  K.TemplateMiddle, K.TemplateTail,
])
const SNM = /(?:api[_-]?key|authorization|cookie|credential|database[_-]?url|dsn|jwt|passwd|password|private[_-]?key|secret|token)/i
const SVAL = /^(?:bearer\s+|gh[pousr]_|github_pat_|sk-(?:live|test|proj)-|xox[baprs]-|[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:[^@\s/]+@|eyJ[\w-]+\.[\w-]+\.[\w-]+$)/i
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
function bd(value: string, maxBytes = TBYT): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break
    result += character
  }
  return result
}
function st(node: ts.Node, sf: ts.SourceFile): string {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, node.getText(sf));
    const tokens: string[] = [];
    for (let token = scanner.scan(); token !== K.EndOfFileToken; token = scanner.scan()) {
        tokens.push(SLT.has(token) ? '<literal>' : scanner.getTokenText());
    }
    return bd(tokens.join(' '));
}
function ct(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
function co(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}
function ro(node: ts.Node, sf: ts.SourceFile): IndexRange {
  return rf(sf, node.getStart(sf, false), node.getEnd())
}
function rf(sf: ts.SourceFile, start: number, end: number): IndexRange {
  const startPosition = sf.getLineAndCharacterOfPosition(start)
  const endPosition = sf.getLineAndCharacterOfPosition(end)
  return {
    start: { line: startPosition.line + 1, column: startPosition.character + 1 },
    end: { line: endPosition.line + 1, column: endPosition.character + 1 },
  }
}
function stmt(node: ts.Node): ts.Node {
    let current: ts.Node = node;
    while (current.parent) {
        if (ts.isStatement(current)
            || isVariable(current)
            || isPropertyDecl(current)
            || isParameter(current)) {
            return current;
        }
        if (ts.isSourceFile(current.parent))
            return current;
        current = current.parent;
    }
    return current;
}
function ev(node: ts.Node, sf: ts.SourceFile, fileId: string, stmtNode: ts.Node = stmt(node), bounds?: {
    start: number;
    end: number;
}): IndexFactEvidence {
    const rawStatementStart = stmtNode.getStart(sf, false);
    const rawStatementEnd = stmtNode.getEnd();
    const statementStart = bounds
        ? Math.max(rawStatementStart, bounds.start)
        : rawStatementStart;
    const statementEnd = bounds
        ? Math.min(rawStatementEnd, bounds.end)
        : rawStatementEnd;
    return {
        file_id: fileId,
        range: ro(node, sf),
        statement_range: rf(sf, statementStart, statementEnd),
        excerpt_sha256: hash(sf.text.slice(statementStart, statementEnd)),
    };
}
function fo(kind: IndexBodyFact['kind'], node: ts.Node, suffix = 0): readonly number[] {
  const sf = node.getSourceFile()
  return [
    node.getStart(sf, false),
    FORD[kind],
    node.getEnd(),
    suffix,
  ]
}
function fb(ownerId: string, kind: IndexBodyFact['kind'], node: ts.Node, file: FileContext, control: readonly IndexControlFrame[], opts: {
    confidence?: Confidence;
    source?: IndexFactSource;
    statementNode?: ts.Node;
    orderSuffix?: number;
} = {}): Pick<IndexBodyFact, 'id' | 'owner_symbol_id' | 'order' | 'evidence' | 'control' | 'confidence' | 'source'> {
    const ownerBounds = file.owners.find((span) => span.symbol.id === ownerId);
    const order = fo(kind, node, opts.orderSuffix);
    const evidence = ev(node, file.sf, file.fileId, opts.statementNode, ownerBounds);
    return {
        id: indexBodyFactId(ownerId, kind, order, evidence.excerpt_sha256),
        owner_symbol_id: ownerId,
        order,
        evidence,
        control: [...control],
        confidence: opts.confidence ?? 'high',
        source: opts.source ?? 'typescript-syntactic',
    };
}
type ConditionKind = Extract<IndexBodyFact, { kind: 'condition' }>['condition_kind']
type BranchArm = Extract<IndexControlFrame, { kind: 'branch' }>['arm']
type MutationOperation = Extract<IndexBodyFact, { kind: 'mutation' }>['operation']
function ac(
  ownerId: string, conditionKind: ConditionKind, expr: ts.Expression,
  file: FileContext, ctx: CollectionState, control: readonly IndexControlFrame[],
  stmtNode: ts.Node,
): ReturnType<typeof fb> {
  const base = fb(ownerId, 'condition', expr, file, control, { statementNode: stmtNode })
  af(ctx, {
    ...base,
    kind: 'condition',
    condition_kind: conditionKind,
    test: rd(expr, file, ctx, { constants: true }),
  })
  return base
}
function br(control: readonly IndexControlFrame[], controllerFactId: string, arm: BranchArm): IndexControlFrame[] {
    return [...control, { kind: 'branch', controller_fact_id: controllerFactId, arm }];
}
function am(
  ownerId: string, operationNode: ts.Node, operation: MutationOperation,
  targetNode: ts.Node, file: FileContext, ctx: CollectionState,
  control: readonly IndexControlFrame[],
  value?: ts.Expression, orderSuffix = 0,
): void {
  const target = st(targetNode, file.sf)
  af(ctx, {
    ...fb(ownerId, 'mutation', operationNode, file, control, { orderSuffix }),
    kind: 'mutation',
    operation,
    target: bd(target),
    ...(value ? {
      value: rd(value, file, ctx, {
        constants: true,
        secret: SNM.test(target),
      }),
    } : {}),
  })
}
function ai(ownerId: string, node: ts.Node, file: FileContext, ctx: CollectionState, control: readonly IndexControlFrame[]): string {
    const base = fb(ownerId, 'loop', node, file, control, { orderSuffix: 1 });
    af(ctx, { ...base, kind: 'loop', loop_kind: 'array_iteration' });
    return base.id;
}
function af(ctx: CollectionState, fact: IndexBodyFact): void {
  if (ctx.overflow.has(fact.owner_symbol_id)) return
  const facts = ctx.facts.get(fact.owner_symbol_id)
  if (!facts) { ctx.facts.set(fact.owner_symbol_id, [fact]); return }
  if (facts.length >= FMAX) {
    ctx.overflow.add(fact.owner_symbol_id); return
  }
  facts.push(fact)
}
function ab<T>(
  ctx: CollectionState, map: Map<string, T[]>, key: string, value: T,
): void {
  const values = map.get(key)
  if (!values) { map.set(key, [value]); return }
  if (values.length >= EMAX) {
    ctx.overflow.add(key)
  } else {
    values.push(value)
  }
}
function ae(ctx: CollectionState, ownerId: string, fx: ExecutionEffect): void {
  ab(ctx, ctx.effects, ownerId, fx)
}
function al(ctx: CollectionState, ownerId: string, callSite: CallSite): void {
    ab(ctx, ctx.calls, ownerId, callSite);
}
function io(symbol: IndexSymbol): boolean {
  if (!['function', 'method', 'constant', 'variable'].includes(symbol.kind)) return false
  // Execution facts require an authenticated owner span. Framework-only
  // synthetic nodes without declaration/definition ranges remain topology
  // nodes and must not become evidence owners.
  if (!symbol.declaration_range) return false
  if (symbol.framework_metadata?.external_call === true) return false
  if (typeof symbol.framework_metadata?.storage_operation === 'string') return false
  return true
}
function oo(sf: ts.SourceFile, position: IndexRange['start']): number {
  return sf.getPositionOfLineAndCharacter(position.line - 1, position.column - 1)
}
function os(sf: ts.SourceFile, symbols: readonly IndexSymbol[]): OwnerSpan[] {
    return symbols
        .filter(io)
        .map((symbol) => ({
        symbol,
        start: oo(sf, symbol.range.start),
        end: oo(sf, symbol.range.end),
    }))
        .sort((left, right) => (left.end - left.start) - (right.end - right.start)
        || left.start - right.start
        || ct(left.symbol.id, right.symbol.id));
}
function ow(node: ts.Node, file: FileContext): IndexSymbol | null {
  const start = node.getStart(file.sf, false)
  const end = node.getEnd()
  return file.owners.find((span) => span.start <= start && span.end >= end)?.symbol ?? null
}
function im(sf: ts.SourceFile): ReadonlyMap<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const module = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) {
      bindings.set(clause.name.text, { imported: 'default', module, namespace: false })
    }
    const named = clause.namedBindings
    if (!named) continue
    if (ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, { imported: '*', module, namespace: true })
      continue
    }
    for (const element of named.elements) {
      bindings.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        module,
        namespace: false,
      })
    }
  }
  return bindings
}
function ib(expr: ts.Expression, file: FileContext): ImportBinding | null {
    if (isIdentifier(expr))
        return file.imports.get(expr.text) ?? null;
    if (isAccess(expr)
        && isIdentifier(expr.expression)) {
        const namespace = file.imports.get(expr.expression.text);
        if (namespace?.namespace) {
            return {
                imported: expr.name.text,
                module: namespace.module,
                namespace: false,
            };
        }
    }
    return null;
}
function ii(expr: ts.Expression, file: FileContext, modules: readonly string[], names: readonly string[]): boolean {
    const binding = ib(expr, file);
    return binding !== null
        && modules.includes(binding.module)
        && names.includes(binding.imported);
}
function fa(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return symbol
  }
}
function sy(node: ts.Node, ctx: CollectionState): ts.Symbol | undefined {
  const checker = ctx.input.checker
  return fa(checker.getSymbolAtLocation(node), checker)
}
function ds(node: ts.Node, file: FileContext, ctx: CollectionState): IndexSymbol | null {
    const sf = node.getSourceFile();
    const fileId = ctx.input.pathToFileId.get(sf.fileName);
    if (!fileId)
        return null;
    const spans = sf === file.sf
        ? file.owners
        : os(sf, ctx.input.symbolsByFile.get(fileId) ?? []);
    const start = node.getStart(sf, false);
    const end = node.getEnd();
    return spans.find((span) => span.start <= start && span.end >= end)?.symbol ?? null;
}
function ed(node: ts.Node, file: FileContext, ctx: CollectionState): IndexSymbol | null {
  const symbol = ds(node, file, ctx)
  if (!symbol) return null
  const sf = node.getSourceFile(), start = node.getStart(sf, false), end = node.getEnd()
  const spans = sf === file.sf ? file.owners
    : os(sf, ctx.input.symbolsByFile.get(ctx.input.pathToFileId.get(sf.fileName) ?? '') ?? [])
  return spans.some((span) =>
    span.symbol.id === symbol.id && span.start === start && span.end === end)
    ? symbol : null
}
function sb(decl: ts.Declaration, ctx: CollectionState): boolean {
  const name = (isVariable(decl) || isPropertyDecl(decl)) && isIdentifier(decl.name)
    ? decl.name : null
  const symbol = name ? sy(name, ctx) : undefined
  return !!symbol && !ctx.unstable.has(symbol)
}
function sfor(expr: ts.Expression, file: FileContext, ctx: CollectionState): IndexSymbol | null {
    const symbol = sy(isAccess(expr) ? expr.name : expr, ctx);
    const declarations = symbol?.declarations ?? [];
    for (const decl of declarations) {
        const indexed = ds(decl, file, ctx);
        if (indexed)
            return indexed;
    }
    return null;
}
function cs(call: ts.CallExpression | ts.NewExpression, file: FileContext, ctx: CollectionState): IndexSymbol | null {
    const signature = ctx.input.checker.getResolvedSignature(call);
    const decl = signature?.getDeclaration();
    if (decl && !decl.getSourceFile().isDeclarationFile) {
        const indexed = ds(decl, file, ctx);
        if (indexed)
            return indexed;
    }
    return sfor(call.expression, file, ctx);
}
function ca(node: ts.SignatureDeclaration, file: FileContext, ctx: CollectionState): IndexSymbol | null {
    if (isArrow(node) || isFunction(node)) {
        const parent = node.parent;
        if (isVariable(parent) && parent.initializer === node) {
            const stmt = parent.parent.parent;
            return ts.isVariableStatement(stmt)
                && ts.isSourceFile(stmt.parent)
                ? ds(parent, file, ctx)
                : null;
        }
        return isBinary(parent)
            ? ed(node, file, ctx)
            : null;
    }
    return ts.isFunctionDeclaration(node)
        || ts.isMethodDeclaration(node)
        || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
        ? ed(node, file, ctx)
        : null;
}
function pv(identifier: ts.Identifier, file: FileContext, ctx: CollectionState): IndexValue | null {
    const symbol = sy(identifier, ctx);
    for (const decl of symbol?.declarations ?? []) {
        if (!isParameter(decl))
            continue;
        const parent = decl.parent;
        if (!ts.isFunctionLike(parent))
            continue;
        const position = parent.parameters.indexOf(decl);
        if (position >= 0) {
            return ca(parent, file, ctx)
                ? { kind: 'parameter', position }
                : { kind: 'parameter', position, scope: 'iteration' };
        }
    }
    return null;
}
function red(value: string): IndexValue {
  return {
    kind: 'redacted',
    sha256: hash(value),
    byte_length: Buffer.byteLength(value, 'utf8'),
  }
}
function ls(value: string, secret = false): IndexValue {
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (secret || SVAL.test(value) || byteLength > SBYT) {
    return red(value)
  }
  return { kind: 'literal', value }
}
function uk(reason: 'dynamic' | 'ambiguous' | 'unsupported' = 'dynamic'): IndexValue {
  return { kind: 'unknown', reason }
}
function uw(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isParenthesizedExpression(current)
        || ts.isSatisfiesExpression(current)) {
        current = current.expression;
    }
    return current;
}
type ValueOptions = { constants?: boolean; secret?: boolean; depth?: number; seen?: ReadonlySet<ts.Node> }
function rd(
  expr: ts.Expression,
  file: FileContext,
  ctx: CollectionState,
  opts: ValueOptions = {},
): IndexValue {
  const depth = opts.depth ?? 0
  if (depth >= VDEP) return uk('unsupported')
  const seen = new Set(opts.seen ?? [])
  const node = uw(expr)
  if (seen.has(node)) return uk('ambiguous')
  seen.add(node)
  const nested = (value: ts.Expression, extra: Partial<ValueOptions> = {}): IndexValue =>
    rd(value, file, ctx, {
      ...opts,
      ...extra,
      depth: depth + 1,
      seen,
    })
  if (ts.isStringLiteralLike(node)) return ls(node.text, opts.secret)
  if (isNumeric(node)) {
    const value = Number(node.text)
    return Number.isFinite(value) && !Object.is(value, -0)
      ? { kind: 'literal', value }
      : uk('unsupported')
  }
  if (node.kind === K.TrueKeyword) return { kind: 'literal', value: true }
  if (node.kind === K.FalseKeyword) return { kind: 'literal', value: false }
  if (node.kind === K.NullKeyword) return { kind: 'literal', value: null }
  if (ts.isPrefixUnaryExpression(node) && isNumeric(node.operand)) {
    const value = Number(node.operand.text)
    const signed = node.operator === K.MinusToken ? -value : value
    if ((node.operator === K.MinusToken
        || node.operator === K.PlusToken)
      && Number.isFinite(signed) && !Object.is(signed, -0)) {
      return { kind: 'literal', value: signed }
    }
  }
  if (isIdentifier(node)) {
    const parameter = pv(node, file, ctx)
    if (parameter) return parameter
    const symbol = sy(node, ctx)
    const decl = symbol?.valueDeclaration
      ?? symbol?.declarations?.find((candidate) => isVariable(candidate))
    if (
      opts.constants
      && decl
      && isVariable(decl)
      && sb(decl, ctx)
      && decl.initializer
    ) {
      return nested(decl.initializer, {
        secret: opts.secret || SNM.test(node.text),
      })
    }
    const indexed = decl
      ? ds(decl, file, ctx)
      : sfor(node, file, ctx)
    return indexed ? { kind: 'symbol', symbol_id: indexed.id } : uk()
  }
  if (ts.isArrayLiteralExpression(node)) {
    if (node.elements.length > VELE) return uk('unsupported')
    const elements: IndexValue[] = []
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return uk('unsupported')
      elements.push(nested(element, { constants: true }))
    }
    return { kind: 'array', elements }
  }
  if (ts.isObjectLiteralExpression(node)) {
    if (node.properties.length > VELE) return uk('unsupported')
    const entries = new Map<string, IndexValue>()
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = pn(property.name)
        if (key === null || key.includes('\0')
          || Buffer.byteLength(key, 'utf8') > SBYT) {
          return uk('unsupported')
        }
        entries.set(
          key,
          nested(property.initializer, {
            constants: true,
            secret: SNM.test(key),
          }),
        )
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text
        if (Buffer.byteLength(key, 'utf8') > SBYT) {
          return uk('unsupported')
        }
        entries.set(
          key,
          nested(property.name, {
            constants: true,
            secret: SNM.test(key),
          }),
        )
      } else {
        return uk('unsupported')
      }
    }
    return {
      kind: 'object',
      entries: [...entries].map(([key, value]) => ({ key, value })),
    }
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return ls(node.text, opts.secret)
  if (ts.isTemplateExpression(node)) {
    if (1 + (2 * node.templateSpans.length) > VELE) {
      return uk('unsupported')
    }
    const parts: IndexValue[] = [ls(node.head.text, opts.secret)]
    for (const span of node.templateSpans) {
      parts.push(nested(span.expression, { constants: true }))
      parts.push(ls(span.literal.text, opts.secret))
    }
    return { kind: 'template', parts }
  }
  if (isCall(node) && isAccess(node.expression)) {
    const method = node.expression.name.text
    const receiver = node.expression.expression
    if (method === 'slice') {
      const value = nested(receiver, { constants: true })
      if (value.kind !== 'array') return uk()
      const start = ni(node.arguments[0], file, ctx)
      const end = ni(node.arguments[1], file, ctx)
      if (start === null || (node.arguments[1] && end === null)) return uk()
      return { kind: 'array', elements: value.elements.slice(start, end ?? undefined) }
    }
    if (method === 'map') {
      return nested(receiver, { constants: false })
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const collection = nested(node.expression, { constants: true })
    const index = node.argumentExpression
      ? ni(node.argumentExpression, file, ctx)
      : null
    if (collection.kind === 'array' && index !== null) {
      return collection.elements[index] ?? uk()
    }
  }
  const target = sfor(node, file, ctx)
  return target ? { kind: 'symbol', symbol_id: target.id } : uk()
}
function pn(name: ts.PropertyName): string | null {
  if (isIdentifier(name) || ts.isStringLiteralLike(name) || isNumeric(name)) {
    return name.text
  }
  return null
}
function ni(expr: ts.Expression | undefined, file: FileContext, ctx: CollectionState): number | null {
    if (!expr)
        return 0;
    const value = rd(expr, file, ctx, { constants: true });
    return value.kind === 'literal'
        && typeof value.value === 'number'
        && Number.isSafeInteger(value.value)
        ? value.value
        : null;
}
function ss(value: IndexValue): string | null {
  if (value.kind === 'literal' && typeof value.value === 'string') {
    return value.value.length > 0 && Buffer.byteLength(value.value, 'utf8') <= TBYT
      ? value.value
      : null
  }
  if (value.kind !== 'template') return null
  let result = ''
  for (const part of value.parts) {
    if (part.kind !== 'literal'
      || !['string', 'number', 'boolean'].includes(typeof part.value)) return null
    result += String(part.value)
  }
  return result.length > 0 && Buffer.byteLength(result, 'utf8') <= TBYT
    ? result
    : null
}
function si(value: IndexValue): string | null {
  return value.kind === 'symbol' ? value.symbol_id : null
}
function mv(value: IndexValue, depth: number, resolve?: (position: number) => IndexValue): IndexValue {
    if (value.kind === 'parameter' && value.scope !== 'iteration' && resolve) {
        return mv(resolve(value.position), depth);
    }
    if (value.kind === 'array') {
        if (depth >= VDEP && value.elements.length > 0)
            return uk('unsupported');
        return {
            kind: 'array',
            elements: value.elements.map((entry) => mv(entry, depth + 1, resolve)),
        };
    }
    if (value.kind === 'object') {
        if (depth >= VDEP && value.entries.length > 0)
            return uk('unsupported');
        return {
            kind: 'object',
            entries: value.entries.map((entry) => ({
                key: entry.key,
                value: mv(entry.value, depth + 1, resolve),
            })),
        };
    }
    if (value.kind === 'template') {
        if (depth >= VDEP && value.parts.length > 0)
            return uk('unsupported');
        return {
            kind: 'template',
            parts: value.parts.map((entry) => mv(entry, depth + 1, resolve)),
        };
    }
    return value;
}
function sub(value: IndexValue, args: readonly IndexValue[]): IndexValue {
  return mv(value, 0, (position) => args[position] ?? uk())
}
function ie(fx: ExecutionEffect, args: readonly IndexValue[], witness: EffectWitness): ExecutionEffect {
    switch (fx[0]) {
        case 'bull-publish':
        case 'bull-consume':
            return [
                fx[0], sub(fx[1], args), sub(fx[2], args),
                fx[3], undefined, witness, fx[6], 'wrapper-summary',
            ];
        case 'event-publish':
            return [
                fx[0], sub(fx[1], args), undefined, fx[3], fx[4],
                witness, fx[6], 'wrapper-summary',
            ];
        case 'event-consume':
            return [
                fx[0], sub(fx[1], args), sub(fx[2]!, args),
                fx[3], fx[4], witness, fx[6], 'wrapper-summary',
            ];
        case 'persistence':
            return [
                fx[0], fx[1], fx[2] ? sub(fx[2], args) : undefined,
                fx[3], undefined, witness, fx[6], 'wrapper-summary',
            ];
    }
}
function cn(call: ts.CallExpression | ts.NewExpression): string {
  const sf = call.getSourceFile()
  const text = st(call.expression, sf)
  return bd(isNew(call) ? `new ${text}` : text)
}
function th(call: ts.CallExpression | ts.NewExpression, ctx: CollectionState): boolean {
  try {
    const signature = ctx.input.checker.getResolvedSignature(call)
    const type = signature && ctx.input.checker.getReturnTypeOfSignature(signature)
    const then = type?.getProperty('then')
    return !!then
      && ctx.input.checker.getTypeOfSymbolAtLocation(then, call).getCallSignatures().length > 0
  } catch { return false }
}
function sch(call: ts.CallExpression | ts.NewExpression, ctx: CollectionState): IndexCallFact['scheduling'] {
    let current: ts.Node = call;
    while (ts.isParenthesizedExpression(current.parent)
        || ts.isAsExpression(current.parent)
        || ts.isNonNullExpression(current.parent)) {
        current = current.parent;
    }
    if (ts.isAwaitExpression(current.parent))
        return 'awaited';
    if ((ts.isVoidExpression(current.parent)
        || ts.isExpressionStatement(current.parent)) && th(call, ctx)) {
        return 'fire_and_forget';
    }
    return 'sync';
}
function iar(expr: ts.Expression, ctx: CollectionState): boolean {
  try {
    const type = ctx.input.checker.getTypeAtLocation(expr)
    return ctx.input.checker.isArrayType(type)
      || ctx.input.checker.isTupleType(type)
  } catch { return false }
}
function cf(
  call: ts.CallExpression | ts.NewExpression, sym: IndexSymbol,
  file: FileContext, ctx: CollectionState,
  control: readonly IndexControlFrame[],
): IndexCallFact {
  const target = cs(call, file, ctx)
  const args = (call.arguments ?? []).map((argument) => {
    const value = uw(argument)
    return isArrow(value) || isFunction(value)
      ? hv(value, file, ctx)
      : rd(value, file, ctx, {
          constants: true,
          secret: SNM.test(value.getText(file.sf)),
        })
  })
  const fact: IndexCallFact = {
    ...fb(sym.id, 'call', call, file, control, {
      confidence: target ? 'high' : 'medium',
      source: target ? 'typescript-semantic' : 'typescript-syntactic',
    }),
    kind: 'call',
    callee: cn(call),
    ...(target ? { target_symbol_id: target.id } : {}),
    arguments: args,
    scheduling: sch(call, ctx),
  }
  af(ctx, fact)
  ctx.callIds.set(call, fact.id)
  if (target) {
    al(ctx, sym.id, [target.id, fact.arguments, call])
  }
  return fact
}
function rty(expr: ts.Expression, ctx: CollectionState): string {
  try {
    return bd(
      ctx.input.checker.typeToString(
        ctx.input.checker.getTypeAtLocation(expr),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ).replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/gu, '<literal>'),
    )
  } catch {
    return ''
  }
}
function ti(expr: ts.Expression, file: FileContext, ctx: CollectionState): ImportBinding | null {
    const symbol = sy(expr, ctx);
    for (const decl of symbol?.declarations ?? []) {
        const typeNode = isParameter(decl)
            || isPropertyDecl(decl)
            || isVariable(decl)
            ? decl.type
            : undefined;
        if (!typeNode)
            continue;
        const root = isTypeReference(typeNode)
            ? (ts.isQualifiedName(typeNode.typeName) ? typeNode.typeName.left : typeNode.typeName)
            : null;
        if (root && isIdentifier(root)) {
            const binding = file.imports.get(root.text);
            if (binding)
                return binding;
        }
    }
    return null;
}
function bt(binding: ImportBinding | null): QueueTransport | null {
  if (!binding || !['bull', 'bullmq'].includes(binding.module)
    || !['Queue', 'default'].includes(binding.imported)) return null
  return binding.module as QueueTransport
}
function cx(sf: ts.SourceFile, ctx: CollectionState): FileContext | null {
    return ctx.files.get(sf) ?? null;
}
function xs(expr: ts.Expression, ctx: CollectionState): ts.Symbol | undefined {
  const node = uw(expr)
  return sy(isAccess(node) ? node.name : node, ctx)
}
function eq(left: ts.Expression, right: ts.Expression, ctx: CollectionState): boolean {
  const a = uw(left), b = uw(right)
  if (ts.isStringLiteralLike(a) && ts.isStringLiteralLike(b)) {
    return a.text === b.text
  }
  if (isIdentifier(a) && isIdentifier(b)) return sy(a, ctx) === sy(b, ctx)
  if (isAccess(a) && isAccess(b)) {
    return a.name.text === b.name.text
      && xs(a.name, ctx) === xs(b.name, ctx)
      && (a.expression.kind === K.ThisKeyword && b.expression.kind === K.ThisKeyword
        || eq(a.expression, b.expression, ctx))
  }
  return false
}
function qc(expr: ts.Expression, ctx: CollectionState, seen: ReadonlySet<ts.Node> = new Set()): readonly [ts.Expression, FileContext, QueueTransport] | null {
  const node = uw(expr)
  if (seen.has(node)) return null
  const next = new Set(seen).add(node)
  const file = cx(node.getSourceFile(), ctx)
  if (!file) return null
  if (isNew(node) && node.arguments?.[0]) {
    const transport = bt(ib(node.expression, file))
    return transport ? [node.arguments[0], file, transport] : null
  }
  if (!isIdentifier(node)) return null
  const decl = sy(node, ctx)?.valueDeclaration
  return decl && isVariable(decl) && sb(decl, ctx) && decl.initializer
    ? qc(decl.initializer, ctx, next) : null
}
function prep(ctx: CollectionState): void {
  const sets: Array<readonly [ts.Symbol, ts.Expression, ts.Expression]> = []
  const mark = (node: ts.Node): void => {
    if (isIdentifier(node)) {
      const symbol = sy(node, ctx)
      if (symbol) ctx.unstable.add(symbol)
    }
    ts.forEachChild(node, mark)
  }
  for (const sf of ctx.input.sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (isBinary(node) && AOP.has(node.operatorToken.kind)) {
        mark(node.left)
      } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [K.PlusPlusToken, K.MinusMinusToken].includes(node.operator)) {
        mark(node.operand)
      } else if (ts.isDeleteExpression(node)) {
        mark(node.expression)
      }
      if (isCall(node) && isAccess(node.expression)
        && node.expression.name.text === 'set'
        && node.arguments[0] && node.arguments[1]) {
        const symbol = xs(node.expression.expression, ctx)
        if (symbol) sets.push([symbol, node.arguments[0], node.arguments[1]])
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  for (const [symbol, key, value] of sets) {
    const entries = ctx.mapQueues.get(symbol) ?? []
    const queue = qc(value, ctx)
    const file = cx(key.getSourceFile(), ctx)
    entries.push(queue && file ? [key, file, queue[0], queue[2]] : null)
    ctx.mapQueues.set(symbol, entries)
  }
}
function sm(decl: ts.Declaration, ctx: CollectionState): boolean {
  try {
    const symbol = ctx.input.checker.getTypeAtLocation(decl).getSymbol()
    return symbol?.name === 'Map'
      && !!symbol.declarations?.some((item) =>
        /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(
          item.getSourceFile().fileName.replaceAll('\\', '/'),
        ))
  } catch { return false }
}
function mq(map: ts.Expression, key: ts.Expression, file: FileContext, ctx: CollectionState): QueueOrigin | null {
  const mapSymbol = xs(map, ctx)
  const decl = mapSymbol?.valueDeclaration
  if (!mapSymbol || !decl
    || !(isVariable(decl) || isPropertyDecl(decl))
    || !sb(decl, ctx) || !sm(decl, ctx)) return null
  const entries = ctx.mapQueues.get(mapSymbol) ?? []
  if (entries.length === 0 || entries.some((entry) => !entry)) return null
  const proven = entries as MapQueueEntry[]
  const lookup = ss(rd(key, file, ctx, { constants: true }))
  if (lookup) {
    const matches = proven.filter(([entryKey, entryFile]) =>
      ss(rd(entryKey, entryFile, ctx, { constants: true })) === lookup)
    if (matches.length) {
      const origins = matches.map(([, entryFile, queueKey, transport]) =>
        [rd(queueKey, entryFile, ctx, { constants: true }), transport] as const)
      const first = JSON.stringify(origins[0])
      return origins.every((origin) => JSON.stringify(origin) === first)
        ? origins[0]! : null
    }
  }
  const transport = proven[0]![3]
  return proven.every(([entryKey, , queueKey, entryTransport]) =>
    entryTransport === transport && eq(entryKey, queueKey, ctx))
    ? [rd(key, file, ctx, { constants: true }), transport] : null
}
function qo(expr: ts.Expression, sym: IndexSymbol, file: FileContext, ctx: CollectionState, seen: ReadonlySet<ts.Node> = new Set()): QueueOrigin | null {
    const node = uw(expr);
    if (seen.has(node))
        return null;
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (isNew(node) && node.arguments?.[0]) {
        const transport = bt(ib(node.expression, file));
        if (transport) {
            return [
                rd(node.arguments[0], file, ctx, { constants: true }),
                transport,
            ];
        }
    }
    if (isIdentifier(node)) {
        const symbol = sy(node, ctx);
        const decl = symbol?.valueDeclaration;
        if (decl
            && isVariable(decl)
            && sb(decl, ctx)
            && decl.initializer) {
            const declFile = cx(decl.getSourceFile(), ctx);
            return declFile
                ? qo(decl.initializer, sym, declFile, ctx, nextSeen)
                : null;
        }
    }
    if (isAccess(node)
        && node.expression.kind === K.ThisKeyword) {
        const className = sym.kind === 'method'
            ? sym.name.slice(0, sym.name.lastIndexOf('.'))
            : sym.name;
        const injected = ctx.nestQueues
            .get(`${sym.file_id}\0${className}`)?.get(node.name.text);
        if (injected)
            return injected;
        const symbol = sy(node.name, ctx);
        const decl = symbol?.valueDeclaration;
        if (decl && isPropertyDecl(decl)
            && sb(decl, ctx)
            && decl.initializer) {
            const declFile = cx(decl.getSourceFile(), ctx);
            if (declFile) {
                return qo(decl.initializer, sym, declFile, ctx, nextSeen);
            }
        }
    }
    if (isCall(node)
        && isAccess(node.expression)
        && node.expression.name.text === 'get'
        && node.arguments[0]) {
        return mq(
          node.expression.expression, node.arguments[0], file, ctx,
        )
    }
    return null;
}
function es(expr: ts.Expression, sym: IndexSymbol, file: FileContext, ctx: CollectionState, seen: ReadonlySet<ts.Node> = new Set()): EmitterScope | null {
    const node = uw(expr);
    if (seen.has(node))
        return null;
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (isIdentifier(node)) {
        const symbol = sy(node, ctx);
        const decl = symbol?.valueDeclaration;
        if (decl) {
            const declFile = cx(decl.getSourceFile(), ctx);
            const identity = declFile
                ? `${declFile.fileId}:${decl.getStart(declFile.sf, false)}`
                : null;
            const cached = identity ? ctx.emitters.get(identity) : undefined;
            if (cached)
                return cached;
            if (isVariable(decl)
                && sb(decl, ctx)
                && decl.initializer
                && isNew(uw(decl.initializer))) {
                const init = uw(decl.initializer) as ts.NewExpression;
                if (!declFile)
                    return null;
                const transport = et(init.expression, declFile);
                if (transport) {
                    const scope = identity!;
                    const value: EmitterScope = [scope, transport];
                    ctx.emitters.set(scope, value);
                    return value;
                }
            }
        }
    }
    if (isAccess(node)
        && node.expression.kind === K.ThisKeyword) {
        const binding = ti(node, file, ctx);
        const transport = binding?.module === '@nestjs/event-emitter'
            ? 'nestjs-event-emitter'
            : binding?.module === 'node:events'
                || binding?.module === 'events'
                ? 'node-event-emitter'
                : null;
        const decl = sy(node.name, ctx)?.valueDeclaration;
        const inferred = decl && isPropertyDecl(decl)
            && sb(decl, ctx)
            && decl.initializer
            && isNew(uw(decl.initializer))
            ? et((uw(decl.initializer) as ts.NewExpression).expression, cx(decl.getSourceFile(), ctx) ?? file)
            : null;
        if (transport || inferred) {
            const className = sym.kind === 'method'
                ? sym.name.slice(0, sym.name.lastIndexOf('.'))
                : sym.name;
            return [
                `${file.fileId}:${className}.${node.name.text}`,
                transport ?? inferred!,
            ];
        }
    }
    return null;
}
function et(expr: ts.Expression, file: FileContext): 'node-event-emitter' | 'nestjs-event-emitter' | null {
    if (ii(expr, file, ['node:events', 'events'], ['EventEmitter'])) {
        return 'node-event-emitter';
    }
    if (ii(expr, file, ['@nestjs/event-emitter'], ['EventEmitter2'])) {
        return 'nestjs-event-emitter';
    }
    return null;
}
function hv(expr: ts.Expression, file: FileContext, ctx: CollectionState): IndexValue {
    const node = uw(expr);
    if (isArrow(node) || isFunction(node)) {
        const targets = new Set<string>();
        const visit = (child: ts.Node): void => {
            if (child !== node && (isArrow(child) || isFunction(child)))
                return;
            if (isCall(child)) {
                const target = cs(child, file, ctx);
                if (target)
                    targets.add(target.id);
            }
            ts.forEachChild(child, visit);
        };
        visit(node.body);
        return targets.size === 1
            ? { kind: 'symbol', symbol_id: [...targets][0]! }
            : uk(targets.size > 1 ? 'ambiguous' : 'dynamic');
    }
    return rd(node, file, ctx, { constants: false });
}
type PersistenceSummary = readonly [operation: IndexPersistenceOperation, resource: IndexValue | undefined, receiverType: string]
function se(
  operation: IndexPersistenceOperation | null, receiverType: string,
  resource: ts.Expression | undefined, file: FileContext, ctx: CollectionState,
): PersistenceSummary | null {
  return operation ? [
    operation,
    resource ? rd(resource, file, ctx, { constants: true }) : undefined,
    receiverType,
  ] : null
}
function po(call: ts.CallExpression, file: FileContext, ctx: CollectionState): PersistenceSummary | null {
    const expr = call.expression;
    if (isIdentifier(expr)) {
        const binding = file.imports.get(expr.text);
        if (binding && FSM.has(binding.module)) {
            return se(fsop(binding.imported, call.arguments[1], file, ctx), `${binding.module}:${binding.imported}`, call.arguments[0], file, ctx);
        }
    }
    if (!isAccess(expr))
        return null;
    const method = expr.name.text;
    const receiver = expr.expression;
    const root = li(receiver);
    const namespace = root ? file.imports.get(root.text) : undefined;
    if (namespace?.namespace && FSM.has(namespace.module)) {
        const summary = se(fsop(method, call.arguments[1], file, ctx), `${namespace.module}:namespace`, call.arguments[0], file, ctx);
        if (summary)
            return summary;
    }
    const type = rty(receiver, ctx);
    const typeBinding = ti(receiver, file, ctx);
    if (typeBinding?.module === 'typeorm'
        && ['Repository', 'MongoRepository'].includes(typeBinding.imported)) {
        const summary = se(typeormOperation(method), type || `${typeBinding.module}:${typeBinding.imported}`, call.arguments[0], file, ctx);
        if (summary)
            return summary;
    }
    if (pd(receiver, ctx, '/node_modules/@prisma/client/', '/node_modules/.prisma/client/')) {
        const summary = se(prismaOperation(method), type || 'PrismaClient', call.arguments[0], file, ctx);
        if (summary)
            return summary;
    }
    if (method !== 'send'
        || !(typeBinding?.module === '@aws-sdk/client-s3'
            && typeBinding.imported === 'S3Client'
            || pd(receiver, ctx, '/node_modules/@aws-sdk/client-s3/')))
        return null;
    const command = call.arguments[0];
    if (command && isNew(uw(command))) {
        const constructor = uw(command) as ts.NewExpression;
        const binding = ib(constructor.expression, file);
        if (binding?.module === '@aws-sdk/client-s3') {
            const writes = ['PutObjectCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand'];
            const reads = ['GetObjectCommand', 'HeadObjectCommand'];
            return se(writes.includes(binding.imported) ? 'object_write'
                : reads.includes(binding.imported) ? 'object_read' : null, type, constructor.arguments?.[0], file, ctx);
        }
    }
    return null;
}
function li(expr: ts.Expression): ts.Identifier | null {
  let current = expr
  while (isAccess(current)) current = current.expression
  return isIdentifier(current) ? current : null
}
function pd(expr: ts.Expression, ctx: CollectionState, ...packagePaths: readonly string[]): boolean {
    const checker = ctx.input.checker;
    let current: ts.Expression = expr;
    while (true) {
        try {
            const type = checker.getTypeAtLocation(current);
            const symbols = [type.aliasSymbol, type.getSymbol()];
            if (symbols.some((symbol) => symbol?.declarations?.some((decl) => {
                const path = decl.getSourceFile().fileName.replaceAll('\\', '/');
                return packagePaths.some((packagePath) => path.includes(packagePath));
            }))) {
                return true;
            }
        }
        catch {
            return false;
        }
        if (!isAccess(current))
            return false;
        current = current.expression;
    }
}
function no(method: string, operations: Readonly<Record<string, IndexPersistenceOperation>>): IndexPersistenceOperation | null {
    return Object.hasOwn(operations, method) ? operations[method]! : null;
}
function fsop(
  method: string, flags: ts.Expression | undefined, file: FileContext, ctx: CollectionState,
): IndexPersistenceOperation | null {
  if (!['open', 'openSync'].includes(method)) return no(method, FSO)
  if (!flags) return null
  const value = ss(rd(flags, file, ctx, { constants: true }))
  if (!value) return null
  if (value.includes('+') || /^[aw]/u.test(value)) return 'file_write'
  return /^r(?:s|sr)?$/u.test(value) ? 'file_read' : null
}
const typeormOperation = (method: string): IndexPersistenceOperation | null =>
  no(method, TOO)
const prismaOperation = (method: string): IndexPersistenceOperation | null =>
  no(method, PRO)
function re(call: ts.CallExpression | ts.NewExpression, sym: IndexSymbol, file: FileContext, ctx: CollectionState): void {
    const proof = [call, 'high', 'framework'] as const;
    if (isNew(call)) {
        if (ii(call.expression, file, ['bullmq'], ['Worker'])
            && call.arguments?.[0]
            && call.arguments[1]) {
            ae(ctx, sym.id, [
                'bull-consume',
                rd(call.arguments[0], file, ctx, { constants: true }),
                hv(call.arguments[1], file, ctx),
                'bullmq', undefined, ...proof,
            ]);
        }
        return;
    }
    if (isAccess(call.expression)) {
        const method = call.expression.name.text;
        const receiver = call.expression.expression;
        if (method === 'add' && call.arguments[0]) {
            const queue = qo(receiver, sym, file, ctx);
            if (queue) {
                ae(ctx, sym.id, [
                    'bull-publish', queue[0],
                    rd(call.arguments[0], file, ctx, { constants: true }),
                    queue[1], undefined, ...proof,
                ]);
            }
        }
        const emitter = es(receiver, sym, file, ctx);
        if (emitter && method === 'emit' && call.arguments[0]) {
            ae(ctx, sym.id, [
                'event-publish',
                rd(call.arguments[0], file, ctx, { constants: true }),
                undefined, emitter[1], emitter[0], ...proof,
            ]);
        }
        else if (emitter
            && ['addListener', 'on', 'once', 'prependListener'].includes(method)
            && call.arguments[0]
            && call.arguments[1]) {
            ae(ctx, sym.id, [
                'event-consume',
                rd(call.arguments[0], file, ctx, { constants: true }),
                hv(call.arguments[1], file, ctx),
                emitter[1], emitter[0], ...proof,
            ]);
        }
    }
    const persistence = po(call, file, ctx);
    if (persistence) {
        ae(ctx, sym.id, ['persistence', ...persistence, undefined, ...proof]);
    }
}
function pc(call: ts.CallExpression, ctx: CollectionState): {
  combinator: 'all' | 'allSettled' | 'any' | 'race'
  completion: 'all_or_first_rejection' | 'all_settled' | 'first_fulfilled' | 'first_settled'
} | null {
    if (!isAccess(call.expression)
        || !isIdentifier(call.expression.expression)
        || call.expression.expression.text !== 'Promise') {
        return null;
    }
    const symbol = sy(call.expression.expression, ctx);
    if (!symbol?.declarations?.some((decl) => decl.getSourceFile().isDeclarationFile
        && /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(decl.getSourceFile().fileName.replaceAll('\\', '/'))))
        return null;
    const combinator = call.expression.name.text;
    return Object.hasOwn(PMC, combinator)
        ? {
            combinator: combinator as keyof typeof PMC,
            completion: PMC[combinator as keyof typeof PMC],
        }
        : null;
}
function pl(expr: ts.Expression | undefined): readonly ts.Expression[] | null {
    if (!expr) return null
    const node = uw(expr);
    if (!ts.isArrayLiteralExpression(node)
      || node.elements.length > VELE
      || node.elements.some((element) =>
        ts.isOmittedExpression(element) || ts.isSpreadElement(element))) return null
    return [...node.elements] as ts.Expression[]
}
function mi(expr: ts.Expression | undefined, file: FileContext, ctx: CollectionState): {
  call: ts.CallExpression; input: IndexValue; receiver: ts.Expression
} | null {
    if (!expr)
        return null;
    const node = uw(expr);
    if (!isCall(node)
        || !isAccess(node.expression)
        || node.expression.name.text !== 'map')
        return null;
    const input = rd(node.expression.expression, file, ctx, { constants: true });
    return input.kind === 'array'
        ? { call: node, input, receiver: node.expression.expression }
        : null;
}
function ex(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)
    || ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) return true
  if (ts.isBlock(stmt)) {
    const last = stmt.statements.at(-1)
    return last ? ex(last) : false
  }
  if (isIf(stmt) && stmt.elseStatement) {
    return ex(stmt.thenStatement) && ex(stmt.elseStatement)
  }
  return false
}
function gc(stmt: ts.IfStatement): BranchArm | 'unreachable' | null {
  const thenExits = ex(stmt.thenStatement)
  const elseExits = stmt.elseStatement
    ? ex(stmt.elseStatement)
    : false
  if (thenExits && elseExits) return 'unreachable'
  if (thenExits) return 'else'
  return elseExits ? 'then' : null
}
function tv(decl: ts.VariableDeclaration, sym: IndexSymbol, file: FileContext, ctx: CollectionState): IndexValue | null {
    if (!decl.initializer || decl.parent.parent.parent !== file.sf)
        return null;
    const value = rd(decl.initializer, file, ctx, {
        constants: true,
        secret: isIdentifier(decl.name) && SNM.test(decl.name.text),
    });
    if (value.kind === 'unknown' || value.kind === 'symbol' || value.kind === 'parameter')
        return null;
    if (value.kind === 'literal'
        && typeof value.value === 'string'
        && value.value.length === 0) {
        return null;
    }
    return sym.id === ds(decl, file, ctx)?.id ? value : null;
}
function collect(file: FileContext, ctx: CollectionState): void {
  const visit = (
    node: ts.Node,
    control: readonly IndexControlFrame[],
    executeCallable = false,
  ): void => {
    if (ts.isDecorator(node)) return
    const sym = ow(node, file)
    if (ts.isFunctionLike(node)
      && ca(node, file, ctx)?.id !== sym?.id
      && !executeCallable) return
    if (sym && control.length > INDEX_BODY_FACT_CONTROL_LIMIT) {
      ctx.overflow.add(sym.id)
      return
    }
    if (sym && ts.isBlock(node)) {
      let nextControl = control
      for (const stmt of node.statements) {
        visit(stmt, nextControl)
        if (!isIf(stmt)) {
          if (ex(stmt)) break
          continue
        }
        const continuation = gc(stmt)
        if (continuation === 'unreachable') break
        if (continuation) {
          const base = fb(
            sym.id,
            'condition',
            stmt.expression,
            file,
            nextControl,
            { statementNode: stmt },
          )
          nextControl = br(nextControl, base.id, continuation)
        }
      }
      return
    }
    if (sym && isVariable(node) && isIdentifier(node.name)) {
      const value = tv(node, sym, file, ctx)
      if (value) {
        af(ctx, {
          ...fb(sym.id, 'literal', node.initializer!, file, control, {
            statementNode: stmt(node),
          }),
          kind: 'literal',
          value,
          role: 'initializer',
        })
      }
    }
    if (sym && isIf(node)) {
      const continuation = gc(node)
      const base = ac(
        sym.id, continuation ? 'guard' : 'if',
        node.expression, file, ctx, control, node,
      )
      visit(node.expression, control)
      visit(node.thenStatement, br(control, base.id, 'then'))
      if (node.elseStatement) {
        visit(node.elseStatement, br(control, base.id, 'else'))
      }
      return
    }
    if (sym && ts.isSwitchStatement(node)) {
      const base = ac(
        sym.id, 'switch', node.expression, file, ctx, control, node,
      )
      visit(node.expression, control)
      for (const clause of node.caseBlock.clauses) {
        const arm = ts.isDefaultClause(clause)
          ? 'default' as const
          : `case:${hash(`${clause.expression.getText(file.sf)}:${clause.pos}`).slice(0, 16)}` as const
        if (ts.isCaseClause(clause)) visit(clause.expression, control)
        let armControl = br(control, base.id, arm)
        for (const stmt of clause.statements) {
          visit(stmt, armControl)
          if (!isIf(stmt)) {
            if (ex(stmt)) break
            continue
          }
          const continuation = gc(stmt)
          if (continuation === 'unreachable') break
          if (continuation) armControl = br(
            armControl, fb(
              sym.id, 'condition', stmt.expression, file, armControl,
              { statementNode: stmt },
            ).id, continuation,
          )
        }
      }
      return
    }
    if (sym && ts.isConditionalExpression(node)) {
      const base = ac(
        sym.id, 'ternary', node.condition, file, ctx, control, stmt(node),
      )
      visit(node.condition, control)
      visit(node.whenTrue, br(control, base.id, 'truthy'))
      visit(node.whenFalse, br(control, base.id, 'falsy'))
      return
    }
    const logical = isBinary(node) ? LFL.get(node.operatorToken.kind) : undefined
    if (sym && isBinary(node) && logical) {
      const base = ac(
        sym.id, logical[0], node.left, file, ctx, control, stmt(node),
      )
      visit(node.left, control)
      visit(node.right, br(control, base.id, logical[1]))
      return
    }
    const loop = ld(node)
    if (sym && loop) {
      const base = fb(sym.id, 'loop', node, file, control)
      const repeatedControl = [...control, {
        kind: 'loop' as const,
        controller_fact_id: base.id,
      }]
      af(ctx, {
        ...base,
        kind: 'loop',
        loop_kind: loop.kind,
        ...(loop.test
          ? { test: rd(loop.test, file, ctx, { constants: true }) }
          : {}),
      })
      for (const setup of loop.once) visit(setup, control)
      for (const repeated of loop.repeated) visit(repeated, repeatedControl)
      visit(loop.body, repeatedControl)
      return
    }
    if (sym && ts.isTryStatement(node)) {
      visit(node.tryBlock, [...control, { kind: 'exception', arm: 'try' }])
      if (node.catchClause) {
        visit(node.catchClause, [...control, { kind: 'exception', arm: 'catch' }])
      }
      if (node.finallyBlock) {
        visit(node.finallyBlock, [...control, { kind: 'exception', arm: 'finally' }])
      }
      return
    }
    if (sym && ts.isReturnStatement(node)) {
      af(ctx, {
        ...fb(sym.id, 'return', node, file, control),
        kind: 'return',
        ...(node.expression
          ? { value: rd(node.expression, file, ctx, { constants: true }) }
          : {}),
      })
      if (node.expression) visit(node.expression, control)
      return
    }
    if (sym && ts.isThrowStatement(node)) {
      af(ctx, {
        ...fb(sym.id, 'throw', node, file, control),
        kind: 'throw',
        value: rd(node.expression, file, ctx, { constants: true }),
      })
      visit(node.expression, control)
      return
    }
    if (sym && isBinary(node) && AOP.has(node.operatorToken.kind)) {
      am(sym.id, node, 'assign', node.left, file, ctx, control, node.right)
    } else if (
      sym
      && (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [K.PlusPlusToken, K.MinusMinusToken].includes(node.operator)
    ) {
      am(
        sym.id, node,
        node.operator === K.PlusPlusToken ? 'increment' : 'decrement',
        node.operand, file, ctx, control,
      )
    } else if (sym && ts.isDeleteExpression(node)) {
      am(sym.id, node, 'delete', node.expression, file, ctx, control)
    }
    if (sym && (isCall(node) || isNew(node))) {
      cf(node, sym, file, ctx, control)
      re(node, sym, file, ctx)
      if (isCall(node)) {
        const promise = pc(node, ctx)
        if (promise) {
          const mapped = mi(node.arguments[0], file, ctx)
          const lanes = mapped ? null : pl(node.arguments[0])
          const input = mapped?.input ?? (lanes
            ? rd(node.arguments[0]!, file, ctx, { constants: true })
            : null)
          if (!input || input.kind !== 'array'
            || (lanes && lanes.length !== input.elements.length)) {
            for (const argument of node.arguments) visit(argument, control)
            return
          }
          const base = fb(sym.id, 'parallel', node, file, control)
          const before = ctx.facts.get(sym.id)?.length ?? 0
          if (mapped) {
            cf(mapped.call, sym, file, ctx, control)
            re(mapped.call, sym, file, ctx)
            const loopId = ai(sym.id, mapped.call, file, ctx, control)
            visit(mapped.receiver, control)
            for (const argument of mapped.call.arguments) {
              const callback = uw(argument)
              const executes = isArrow(callback)
                || isFunction(callback)
              visit(
                argument,
                executes
                  ? [
                      ...control,
                      { kind: 'loop', controller_fact_id: loopId },
                      {
                        kind: 'parallel',
                        controller_fact_id: base.id,
                        lane: 'each',
                      },
                    ]
                  : control,
                executes,
              )
            }
          } else {
            for (const [lane, expr] of lanes!.entries()) {
              visit(expr, [...control, {
                kind: 'parallel',
                controller_fact_id: base.id,
                lane,
              }])
            }
          }
          const memberFactIds = (ctx.facts.get(sym.id) ?? [])
            .slice(before)
            .filter((fact) => fact.kind === 'call'
              && fact.control.some((frame) =>
                frame.kind === 'parallel'
                && frame.controller_fact_id === base.id))
            .map((fact) => fact.id)
          af(ctx, {
            ...base,
            kind: 'parallel',
            ...promise,
            lane_count: input.elements.length,
            input,
            member_fact_ids: memberFactIds,
          })
          return
        }
        if (
          isAccess(node.expression)
          && AIM.has(node.expression.name.text)
        ) {
          const input = rd(
            node.expression.expression,
            file,
            ctx,
            { constants: true },
          )
          visit(node.expression.expression, control)
          if (input.kind !== 'array') {
            for (const argument of node.arguments) visit(argument, control)
            return
          }
          const loopId = ai(sym.id, node, file, ctx, control)
          for (const argument of node.arguments) {
            const callback = uw(argument)
            visit(argument, [...control, {
              kind: 'loop',
              controller_fact_id: loopId,
            }], isArrow(callback) || isFunction(callback))
          }
          return
        }
        const arrayMutation = isAccess(node.expression)
          ? AMU.get(node.expression.name.text)
          : undefined
        if (arrayMutation && isAccess(node.expression)
          && iar(node.expression.expression, ctx)) {
          am(
            sym.id, node, arrayMutation, node.expression.expression, file, ctx,
            control, arrayMutation === 'append' ? node.arguments[0] : undefined, 1,
          )
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, control))
  }
  visit(file.sf, [])
}
function ld(node: ts.Node): {
  kind: 'for' | 'for_in' | 'for_of' | 'while' | 'do_while'; test?: ts.Expression
  once: readonly ts.Node[]; repeated: readonly ts.Node[]; body: ts.Statement
} | null {
  if (ts.isForStatement(node)) {
    const once: ts.Node[] = []
    const repeated: ts.Node[] = []
    if (node.initializer) once.push(node.initializer)
    if (node.condition) repeated.push(node.condition)
    if (node.incrementor) repeated.push(node.incrementor)
    return {
      kind: 'for',
      ...(node.condition ? { test: node.condition } : {}),
      once,
      repeated,
      body: node.statement,
    }
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return {
      kind: ts.isForInStatement(node) ? 'for_in' : 'for_of',
      test: node.expression,
      once: [node.expression],
      repeated: [node.initializer],
      body: node.statement,
    }
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return {
      kind: ts.isWhileStatement(node) ? 'while' : 'do_while',
      test: node.expression,
      once: [],
      repeated: [node.expression],
      body: node.statement,
    }
  }
  return null
}
function dc(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []
}
function bv(
  node: ts.Node, name: 'InjectQueue' | 'Processor' | 'Process',
  file: FileContext, ctx: CollectionState,
): { value: IndexValue; transport: QueueTransport } | null {
  let result: { value: IndexValue; transport: QueueTransport } | null = null
  for (const decorator of dc(node)) {
    if (!isCall(decorator.expression)) continue
    const call = decorator.expression
    if (!call.arguments[0]) continue
    const binding = ib(call.expression, file)
    if (binding?.imported === name
      && ['@nestjs/bull', '@nestjs/bullmq'].includes(binding.module)) {
      result = {
        value: rd(call.arguments[0], file, ctx, { constants: true }),
        transport: binding.module === '@nestjs/bull' ? 'bull' : 'bullmq',
      }
    }
  }
  return result
}
function cnest(file: FileContext, ctx: CollectionState): void {
  for (const stmt of file.sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue
    const classKey = `${file.fileId}\0${stmt.name.text}`
    const properties = ctx.nestQueues.get(classKey)
      ?? new Map<string, QueueOrigin>()
    for (const member of stmt.members) {
      if (!ts.isConstructorDeclaration(member)) continue
      for (const parameter of member.parameters) {
        if (!isIdentifier(parameter.name)) continue
        const queue = bv(parameter, 'InjectQueue', file, ctx)
        if (queue) {
          properties.set(parameter.name.text, [queue.value, queue.transport])
        }
      }
    }
    if (properties.size > 0) ctx.nestQueues.set(classKey, properties)
  }
}
function nc(file: FileContext, ctx: CollectionState): void {
  for (const stmt of file.sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue
    const queue = bv(stmt, 'Processor', file, ctx)
    if (!queue) continue
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !isIdentifier(member.name)) continue
      const symbol = ds(member, file, ctx)
      if (!symbol) continue
      const job = bv(member, 'Process', file, ctx)
      if (job?.transport === queue.transport) {
        const queueKey = ss(queue.value)
        const jobKey = ss(job.value)
        if (queueKey && jobKey) {
          const queueNode = ch(ctx, {
            channel_kind: 'queue',
            transport: queue.transport,
            key: queueKey,
          })
          const jobNode = ch(ctx, {
            channel_kind: 'job',
            transport: queue.transport,
            key: jobKey,
            parent_channel_id: queueNode.id,
          })
          ce(ctx, symbol.id, jobNode.id, symbol.id, 'consumed_by', member, file, 'framework-decorator')
          ce(ctx, symbol.id, jobNode.id, queueNode.id, 'routes_through', member, file, 'framework-decorator')
        }
      } else if (!job && member.name.text === 'process') {
        const queueKey = ss(queue.value)
        if (queueKey) {
          const queueNode = ch(ctx, {
            channel_kind: 'queue',
            transport: queue.transport,
            key: queueKey,
          })
          ce(ctx, symbol.id, queueNode.id, symbol.id, 'consumed_by', member, file, 'framework-decorator')
        }
      }
    }
  }
}
function ee(ownerId: string, ctx: CollectionState, depth: number, stack: ReadonlySet<string>): ExecutionEffect[] {
    const direct = [...(ctx.effects.get(ownerId) ?? [])];
    if (direct.length > EMAX) {
        ctx.overflow.add(ownerId);
        return [];
    }
    if (depth >= WHOP || stack.has(ownerId))
        return direct;
    const nextStack = new Set(stack);
    nextStack.add(ownerId);
    for (const call of ctx.calls.get(ownerId) ?? []) {
        if (nextStack.has(call[0]))
            continue;
        const nested = ee(call[0], ctx, depth + 1, nextStack);
        if (ctx.overflow.has(call[0])) {
            ctx.overflow.add(ownerId);
            return [];
        }
        for (const fx of nested) {
            if (direct.length >= EMAX) {
                ctx.overflow.add(ownerId);
                return [];
            }
            direct.push(ie(fx, call[1], call[2]));
        }
    }
    return de(direct);
}
function de(effects: readonly ExecutionEffect[]): ExecutionEffect[] {
  const values = new Map<string, ExecutionEffect>()
  for (const fx of effects) {
    const witness = fx[5]
    const key = JSON.stringify([
      ...fx.slice(0, 5),
      witness.getSourceFile().fileName,
      witness.getStart(witness.getSourceFile(), false),
      witness.getEnd(),
    ])
    if (!values.has(key)) values.set(key, fx)
  }
  return [...values.values()]
}
type ChannelDescriptor = Omit<IndexChannelNode, 'id' | 'node_kind'>
function ch(ctx: CollectionState, descriptor: ChannelDescriptor): IndexChannelNode {
  const id = indexChannelId(descriptor)
  const node: IndexChannelNode = {
    id,
    node_kind: 'channel',
    ...descriptor,
  }
  const prior = ctx.channels.get(id)
  if (prior && JSON.stringify(prior) !== JSON.stringify(node)) {
    throw new Error(`Conflicting execution channel identity ${id}`)
  }
  ctx.channels.set(id, node)
  return node
}
function ce(
  ctx: CollectionState, ownerId: string, from: string, to: string,
  kind: Extract<IndexEdge['kind'], 'publishes_to' | 'routes_through' | 'consumed_by'>,
  witness: ts.Node, file: FileContext, source: IndexEdge['source'],
  confidence: Confidence = 'high',
): void {
  const evidence = ev(witness, file.sf, file.fileId)
  ctx.edges.push({
    from,
    to,
    kind,
    confidence,
    source,
    evidence,
    metadata: { execution_owner_id: ownerId },
  })
}
function edgeS(source: IndexFactSource): IndexEdge['source'] {
  if (source === 'framework') return 'framework-decorator'
  return source
}
function fn(node: ts.Node, ctx: CollectionState, filesById: ReadonlyMap<string, FileContext>): FileContext | null {
    const fileId = ctx.input.pathToFileId.get(node.getSourceFile().fileName);
    return fileId ? filesById.get(fileId) ?? null : null;
}
function ur(ctx: CollectionState, ownerId: string, fx: ExecutionEffect, file: FileContext): void {
    const witness = fx[5];
    const id = `canonical-index.execution.unresolved.${hash([
        ownerId,
        fx[0],
        file.fileId,
        witness.getStart(file.sf, false),
        witness.getEnd(),
    ].join(':')).slice(0, 16)}`;
    if (ctx.seenDiagnostics.has(id))
        return;
    ctx.seenDiagnostics.add(id);
    ctx.diagnostics.push({
        id,
        level: 'info',
        message: `Dynamic or ambiguous ${fx[0]} identity; unresolved channel parts were omitted`,
        evidence: {
            file_id: file.fileId,
            range: ro(witness, file.sf),
        },
    });
}
function pe(ctx: CollectionState, filesById: ReadonlyMap<string, FileContext>): void {
  for (const sym of ctx.input.symbols.filter(io)) {
    if (ctx.overflow.has(sym.id)) continue
    for (const fx of ee(sym.id, ctx, 0, new Set())) {
      if (ctx.overflow.has(sym.id)) break
      const [kind, primary, endpoint, qualifier, scope, witness, confidence, source] = fx
      const file = fn(witness, ctx, filesById)
      if (!file) continue
      const emit = (
        fromId: string,
        toId: string,
        relation: 'publishes_to' | 'consumed_by' | 'routes_through',
      ): void => ce(
        ctx, sym.id, fromId, toId, relation, witness, file,
        edgeS(source), confidence,
      )
      if (kind === 'bull-publish') {
        const queueKey = ss(primary)
        const jobKey = ss(endpoint)
        if (!queueKey) {
          ur(ctx, sym.id, fx, file)
          continue
        }
        const queueNode = ch(ctx, {
          channel_kind: 'queue',
          transport: qualifier,
          key: queueKey,
        })
        if (!jobKey) {
          emit(sym.id, queueNode.id, 'publishes_to')
          ur(ctx, sym.id, fx, file)
          continue
        }
        const jobNode = ch(ctx, {
          channel_kind: 'job',
          transport: qualifier,
          key: jobKey,
          parent_channel_id: queueNode.id,
        })
        emit(sym.id, jobNode.id, 'publishes_to')
        emit(jobNode.id, queueNode.id, 'routes_through')
      } else if (kind === 'bull-consume') {
        const queueKey = ss(primary)
        const handlerId = si(endpoint)
        if (!queueKey || !handlerId || !ctx.symbolsById.has(handlerId)) {
          ur(ctx, sym.id, fx, file)
          continue
        }
        const queueNode = ch(ctx, {
          channel_kind: 'queue',
          transport: qualifier,
          key: queueKey,
        })
        emit(queueNode.id, handlerId, 'consumed_by')
      } else if (kind === 'event-publish' || kind === 'event-consume') {
        const eventKey = ss(primary)
        const handlerId = kind === 'event-consume' ? si(endpoint!) : null
        if (!eventKey || (kind === 'event-consume'
          && (!handlerId || !ctx.symbolsById.has(handlerId)))) {
          ur(ctx, sym.id, fx, file)
          continue
        }
        const eventNode = ch(ctx, {
          channel_kind: 'event',
          transport: qualifier,
          key: eventKey,
          scope,
        })
        if (kind === 'event-publish') {
          emit(sym.id, eventNode.id, 'publishes_to')
        } else {
          emit(eventNode.id, handlerId!, 'consumed_by')
        }
      } else {
        const persistence = fx as PersistenceEffect
        const operation = persistence[1]
        const resource = persistence[2]
        const receiverType = persistence[3]
        const callFactId = ctx.callIds.get(witness)
          ?? fi(sym.id, witness, ctx)
        if (!callFactId || !receiverType) continue
        const ownerFacts = ctx.facts.get(sym.id) ?? []
        const existing = ownerFacts.some((fact) =>
          fact.kind === 'persistence'
          && fact.call_fact_id === callFactId
          && fact.operation === operation)
        if (existing) continue
        const callControl = ownerFacts.find((fact) =>
          fact.id === callFactId)?.control ?? []
        af(ctx, {
          ...fb(
            sym.id,
            'persistence',
            witness,
            file,
            callControl,
            {
              confidence,
              source,
            },
          ),
          kind: 'persistence',
          operation,
          call_fact_id: callFactId,
          ...(resource ? { resource } : {}),
          receiver_type: receiverType,
        })
      }
    }
  }
}
function fi(ownerId: string, witness: ts.Node, ctx: CollectionState): string | null {
    const sf = witness.getSourceFile();
    const range = ro(witness, sf);
    return ctx.facts.get(ownerId)?.find((fact) => fact.kind === 'call'
        && fact.evidence.range.start.line === range.start.line
        && fact.evidence.range.start.column === range.start.column
        && fact.evidence.range.end.line === range.end.line
        && fact.evidence.range.end.column === range.end.column)?.id ?? null;
}
function at(ctx: CollectionState): void {
    for (const symbol of ctx.input.symbols) {
        if (ctx.overflow.has(symbol.id)) {
            ctx.diagnostics.push({
                id: `canonical-index.execution.owner-bound.${hash(symbol.id).slice(0, 16)}`,
                level: 'error',
                message: `Execution facts exceeded a per-owner safety bound for ${symbol.name}; body facts were omitted`,
                evidence: { file_id: symbol.file_id, range: symbol.range },
            });
            continue;
        }
        const facts = ctx.facts.get(symbol.id);
        if (!facts || facts.length === 0)
            continue;
        const byId = new Map<string, IndexBodyFact>();
        for (const fact of facts)
            byId.set(fact.id, fact);
        const sorted = [...byId.values()].sort((left, right) => co(left.order, right.order) || ct(left.id, right.id));
        try {
            const encoded = encodeIndexBodyFactTable(sorted);
            const normalized = decodeIndexBodyFactTable(encoded, symbol.id, symbol.file_id);
            if (!normalized)
                throw new Error('execution fact codec rejected its output');
            symbol.body_facts = normalized;
        }
        catch (error) {
            const bounded = error instanceof IndexBodyFactBoundsError;
            ctx.diagnostics.push({
                id: `canonical-index.execution.${bounded ? 'owner-bound' : 'invalid'}.${hash(symbol.id).slice(0, 16)}`,
                level: 'error',
                message: bounded
                    ? `Execution facts exceeded a per-owner safety bound for ${symbol.name}; body facts were omitted`
                    : `Invalid execution facts for ${symbol.name}; body facts were omitted`,
                evidence: { file_id: symbol.file_id, range: symbol.range },
            });
            delete symbol.body_facts;
        }
    }
}
function sort(edges: readonly IndexEdge[]): IndexEdge[] {
    const structuralRoutes = new Map<string, IndexEdge>();
    const retained: IndexEdge[] = [];
    for (const edge of edges) {
        if (edge.kind !== 'routes_through') {
            retained.push(edge);
            continue;
        }
        const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
        const existing = structuralRoutes.get(key);
        if (!existing
            || ct(JSON.stringify(edge), JSON.stringify(existing)) < 0) {
            structuralRoutes.set(key, edge);
        }
    }
    return [...retained, ...structuralRoutes.values()].sort((left, right) => ct(JSON.stringify(left), JSON.stringify(right)));
}
export function collectExecutionSemantics(input: CollectExecutionInput): CollectExecutionResult {
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]))
  const ctx: CollectionState = {
    input,
    symbolsById,
    facts: new Map(),
    overflow: new Set(),
    effects: new Map(),
    calls: new Map(),
    callIds: new Map(),
    channels: new Map(),
    edges: [],
    diagnostics: [],
    seenDiagnostics: new Set(),
    unstable: new Set(),
    mapQueues: new Map(),
    emitters: new Map(),
    nestQueues: new Map(),
    files: new Map(),
  }
  const filesById = new Map<string, FileContext>()
  for (const sf of input.sourceFiles) {
    const fileId = input.pathToFileId.get(sf.fileName)
    if (!fileId) continue
    const file: FileContext = {
      sf,
      fileId,
      imports: im(sf),
      owners: os(sf, input.symbolsByFile.get(fileId) ?? []),
    }
    filesById.set(fileId, file)
    ctx.files.set(sf, file)
  }
  prep(ctx)
  for (const file of filesById.values()) {
    cnest(file, ctx)
  }
  for (const file of filesById.values()) {
    collect(file, ctx)
    nc(file, ctx)
  }
  pe(ctx, filesById)
  at(ctx)
  return {
    channels: [...ctx.channels.values()].sort((left, right) =>
      ct(left.id, right.id)),
    edges: sort(ctx.edges),
    diagnostics: [...ctx.diagnostics].sort((left, right) =>
      ct(left.id, right.id)),
  }
}
