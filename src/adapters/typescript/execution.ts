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
type OwnerSpan = { s: IndexSymbol; a: number; b: number }
type ImportBinding = { i: string; m: string; n: boolean }
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
type Predicate = readonly [ts.SyntaxKind, IndexValue, IndexValue | undefined, boolean]
type FileContext = {
  sf: ts.SourceFile; id: string; im: ReadonlyMap<string, ImportBinding>
  os: readonly OwnerSpan[]; v: number; nv: number
}
type CollectionState = {
  i: CollectExecutionInput; y: ReadonlyMap<string, IndexSymbol>
  f: Map<string, IndexBodyFact[]>; o: Set<string>
  e: Map<string, ExecutionEffect[]>; c: Map<string, CallSite[]>
  ci: Map<ts.Node, string[]>; ch: Map<string, IndexChannelNode>
  g: IndexEdge[]; d: IndexDiagnostic[]; sd: Set<string>; u: Set<ts.Symbol>
  q: Map<string, BranchArm>; w: Map<string, ReadonlyMap<string, IndexBodyFact>>
  p: Map<string, readonly IndexValue[]>
  r: Map<string, Predicate>
  mq: Map<ts.Symbol, Array<MapQueueEntry | null>>
  em: Map<string, EmitterScope>; nq: Map<string, Map<string, QueueOrigin>>
  fs: Map<ts.SourceFile, FileContext>
}
// Internal helpers and local bindings are abbreviated because their emitted
// names count against the protected npm ceiling; public/schema names stay explicit.
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
const COP = new Set<ts.SyntaxKind>([
  K.EqualsEqualsToken, K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsToken, K.ExclamationEqualsEqualsToken,
  K.LessThanToken, K.LessThanEqualsToken,
  K.GreaterThanToken, K.GreaterThanEqualsToken,
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
function hash(a: string): string { return createHash('sha256').update(a, 'utf8').digest('hex') }
function bd(d: string, b = TBYT): string {
  if (Buffer.byteLength(d, 'utf8') <= b) return d
  let c = ''
  for (const a of d) {
    if (Buffer.byteLength(c + a, 'utf8') > b) break
    c += a
  }
  return c
}
function st(d: ts.Node, sf: ts.SourceFile): string {
  const a = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, d.getText(sf))
  const c: string[] = []
  for (let b = a.scan(); b !== K.EndOfFileToken; b = a.scan())
    c.push(SLT.has(b) ? '<literal>' : a.getTokenText())
  return bd(c.join(' '))
}
function ct(b: string, a: string): number { return b < a ? -1 : b > a ? 1 : 0 }
function co(d: readonly number[], c: readonly number[]): number {
  const e = Math.min(d.length, c.length)
  for (let b = 0; b < e; b += 1) {
    const a = (d[b] ?? 0) - (c[b] ?? 0)
    if (a !== 0) return a
  }
  return d.length - c.length
}
function ro(a: ts.Node, sf: ts.SourceFile): IndexRange { return rf(sf, a.getStart(sf, false), a.getEnd()) }
function rf(sf: ts.SourceFile, c: number, end: number): IndexRange {
  const a = sf.getLineAndCharacterOfPosition(c), b = sf.getLineAndCharacterOfPosition(end)
  return {
    start: { line: a.line + 1, column: a.character + 1 },
    end: { line: b.line + 1, column: b.character + 1 },
  }
}
function stmt(b: ts.Node): ts.Node {
  let a: ts.Node = b
  while (a.parent) {
    if (ts.isStatement(a) || isVariable(a)
      || isPropertyDecl(a) || isParameter(a)) return a
    if (ts.isSourceFile(a.parent)) return a
    a = a.parent
  }
  return a
}
function ev(
  g: ts.Node, sf: ts.SourceFile, f: string,
  d: ts.Node = stmt(g), c?: OwnerSpan,
): IndexFactEvidence {
  const a = d.getStart(sf, false), b = d.getEnd()
  const e = c ? Math.max(a, c.a) : a
  const end = c ? Math.min(b, c.b) : b
  return {
    file_id: f, range: ro(g, sf), statement_range: rf(sf, e, end),
    excerpt_sha256: hash(sf.text.slice(e, end)),
  }
}
function fo(c: IndexBodyFact['kind'], a: ts.Node, b = 0): readonly number[] {
  const sf = a.getSourceFile()
  return [a.getStart(sf, false), FORD[c], a.getEnd(), b]
}
function fb(a: string, g: IndexBodyFact['kind'], h: ts.Node, d: FileContext, z: readonly IndexControlFrame[], e: {
  c?: Confidence; s?: IndexFactSource; n?: ts.Node; o?: number
} = {}): Pick<IndexBodyFact, 'id' | 'owner_symbol_id' | 'order' | 'evidence' | 'control' | 'confidence' | 'source'> {
    const b = d.os.find((j) => j.s.id === a)
    const i = fo(g, h, (e.o ?? 0) + d.v * (EMAX + 1))
    const f = ev(h, d.sf, d.id, e.n, b)
    return {
        id: indexBodyFactId(a, g, i, f.excerpt_sha256),
        owner_symbol_id: a, order: i, evidence: f,
        control: [...z],
        confidence: e.c ?? 'high',
        source: e.s ?? 'typescript-syntactic',
    }
}
type ConditionKind = Extract<IndexBodyFact, { kind: 'condition' }>['condition_kind']
type BranchArm = Extract<IndexControlFrame, { kind: 'branch' }>['arm']
type MutationOperation = Extract<IndexBodyFact, { kind: 'mutation' }>['operation']
function ac(
  h: string, e: ConditionKind, i: ts.Expression,
  f: FileContext, ctx: CollectionState, z: readonly IndexControlFrame[],
  g: ts.Node,
): ReturnType<typeof fb> {
  const j = fb(h, 'condition', i, f, z, { n: g })
  let a = uw(i), d = false
  while (ts.isPrefixUnaryExpression(a)
    && a.operator === K.ExclamationToken) {
    d = !d
    a = uw(a.operand)
  }
  const b = isBinary(a) && COP.has(a.operatorToken.kind)
    ? a : null
  ctx.r.set(j.id, b
    ? [b.operatorToken.kind,
      rd(b.left, f, ctx, { c: true }),
      rd(b.right, f, ctx, { c: true }), d]
    : [K.Unknown, rd(a, f, ctx, { c: true }), undefined, d])
  af(ctx, {
    ...j,
    kind: 'condition',
    condition_kind: e,
    test: rd(i, f, ctx, { c: true }),
  })
  return j
}
function br(z: readonly IndexControlFrame[], a: string, arm: BranchArm): IndexControlFrame[] {
  return [...z, { kind: 'branch', controller_fact_id: a, arm }]
}
function am(
  g: string, b: ts.Node, k: MutationOperation,
  a: ts.Expression, e: FileContext, ctx: CollectionState,
  z: readonly IndexControlFrame[],
  h?: ts.Expression, d = 0,
): void {
  const j = st(a, e.sf), raw = a.getText(e.sf)
  const i = uw(a)
  const key = ts.isElementAccessExpression(i) && i.argumentExpression
    ? rd(i.argumentExpression, e, ctx, { c: true }) : null
  const f = SNM.test(raw) || key !== null
    && (key.kind !== 'literal' || typeof key.value === 'string' && SNM.test(key.value))
  af(ctx, {
    ...fb(g, 'mutation', b, e, z, { o: d }),
    kind: 'mutation',
    operation: k,
    target: f ? `redacted:${hash(raw).slice(0, 16)}` : bd(j),
    ...(h ? {
      value: rd(h, e, ctx, {
        c: true,
        s: f,
      }),
    } : {}),
  })
}
function ai(a: string, c: ts.Node, d: FileContext, ctx: CollectionState, z: readonly IndexControlFrame[]): string {
    const b = fb(a, 'loop', c, d, z, { o: 1 });
    af(ctx, { ...b, kind: 'loop', loop_kind: 'array_iteration' });
    return b.id;
}
function af(ctx: CollectionState, a: IndexBodyFact): void {
  if (ctx.o.has(a.owner_symbol_id)) return
  const b = ctx.f.get(a.owner_symbol_id)
  if (!b) { ctx.f.set(a.owner_symbol_id, [a]); return }
  if (b.length >= FMAX) {
    ctx.o.add(a.owner_symbol_id); return
  }
  b.push(a)
}
function ab<T>(
  ctx: CollectionState, map: Map<string, T[]>, key: string, b: T,
): void {
  const a = map.get(key)
  if (!a) { map.set(key, [b]); return }
  if (a.length >= EMAX) {
    ctx.o.add(key)
  } else {
    a.push(b)
  }
}
function ae(ctx: CollectionState, a: string, fx: ExecutionEffect): void { ab(ctx, ctx.e, a, fx) }
function al(ctx: CollectionState, b: string, a: CallSite): void { ab(ctx, ctx.c, b, a) }
function io(a: IndexSymbol): boolean {
  if (!['function', 'method', 'constant', 'variable'].includes(a.kind)) return false
  // Execution facts require an authenticated owner span. Framework-only
  // synthetic nodes without declaration/definition ranges remain topology
  // nodes and must not become evidence owners.
  if (!a.declaration_range) return false
  if (a.framework_metadata?.external_call === true) return false
  if (typeof a.framework_metadata?.storage_operation === 'string') return false
  return true
}
function oo(sf: ts.SourceFile, a: IndexRange['start']): number {
  return sf.getPositionOfLineAndCharacter(a.line - 1, a.column - 1)
}
function os(sf: ts.SourceFile, c: readonly IndexSymbol[]): OwnerSpan[] {
    return c
        .filter(io)
        .map((s) => ({
        s,
        a: oo(sf, s.range.start),
        b: oo(sf, s.range.end),
    }))
        .sort((l, r) => (l.b - l.a) - (r.b - r.a)
        || l.a - r.a
        || ct(l.s.id, r.s.id));
}
function ow(c: ts.Node, d: FileContext): IndexSymbol | null {
  const f = c.getStart(d.sf, false)
  const end = c.getEnd()
  return d.os.find((e) => e.a <= f && e.b >= end)?.s ?? null
}
function im(sf: ts.SourceFile): ReadonlyMap<string, ImportBinding> {
  const a = new Map<string, ImportBinding>()
  for (const e of sf.statements) {
    if (!ts.isImportDeclaration(e) || !ts.isStringLiteral(e.moduleSpecifier)) continue
    const m = e.moduleSpecifier.text
    const b = e.importClause
    if (!b) continue
    if (b.name) {
      a.set(b.name.text, { i: 'default', m, n: false })
    }
    const d = b.namedBindings
    if (!d) continue
    if (ts.isNamespaceImport(d)) {
      a.set(d.name.text, { i: '*', m, n: true })
      continue
    }
    for (const c of d.elements) {
      a.set(c.name.text, {
        i: c.propertyName?.text ?? c.name.text,
        m,
        n: false,
      })
    }
  }
  return a
}
function ib(a: ts.Expression, b: FileContext): ImportBinding | null {
  if (isIdentifier(a)) return b.im.get(a.text) ?? null
  if (isAccess(a) && isIdentifier(a.expression)) {
    const ns = b.im.get(a.expression.text)
    if (ns?.n) {
      return { i: a.name.text, m: ns.m, n: false }
    }
  }
  return null
}
function ii(d: ts.Expression, e: FileContext, b: readonly string[], c: readonly string[]): boolean {
  const a = ib(d, e)
  return a !== null && b.includes(a.m) && c.includes(a.i)
}
function fa(a: ts.Symbol | undefined, b: ts.TypeChecker): ts.Symbol | undefined {
  if (!a || (a.flags & ts.SymbolFlags.Alias) === 0) return a
  try {
    return b.getAliasedSymbol(a)
  } catch {
    return a
  }
}
function sy(a: ts.Node, ctx: CollectionState): ts.Symbol | undefined {
  return fa(ctx.i.checker.getSymbolAtLocation(a), ctx.i.checker)
}
function ds(d: ts.Node, e: FileContext, ctx: CollectionState): IndexSymbol | null {
  const sf = d.getSourceFile(), c = ctx.i.pathToFileId.get(sf.fileName)
  if (!c) return null
  const g = sf === e.sf ? e.os
    : os(sf, ctx.i.symbolsByFile.get(c) ?? [])
  const h = d.getStart(sf, false), end = d.getEnd()
  return g.find((f) => f.a <= h && f.b >= end)?.s ?? null
}
function ed(d: ts.Node, e: FileContext, ctx: CollectionState): IndexSymbol | null {
  const c = ds(d, e, ctx)
  if (!c) return null
  const sf = d.getSourceFile(), g = d.getStart(sf, false), end = d.getEnd()
  const h = sf === e.sf ? e.os
    : os(sf, ctx.i.symbolsByFile.get(ctx.i.pathToFileId.get(sf.fileName) ?? '') ?? [])
  return h.some((f) =>
    f.s.id === c.id && f.a === g && f.b === end)
    ? c : null
}
function sb(a: ts.Declaration, ctx: CollectionState): boolean {
  const c = (isVariable(a) || isPropertyDecl(a)) && isIdentifier(a.name)
    ? a.name : null
  const b = c ? sy(c, ctx) : undefined
  return !!b && !ctx.u.has(b)
}
function sfor(b: ts.Expression, d: FileContext, ctx: CollectionState): IndexSymbol | null {
  const c = sy(isAccess(b) ? b.name : b, ctx)
  for (const e of c?.declarations ?? []) {
    const a = ds(e, d, ctx)
    if (a) return a
  }
  return null
}
function us(b: ts.Node, ctx: CollectionState): boolean {
  const a = isIdentifier(b) ? sy(b, ctx) : undefined
  return !!a && ctx.u.has(a)
    || ts.forEachChild(b, (c) => us(c, ctx)) === true
}
function cs(b: ts.CallExpression | ts.NewExpression, d: FileContext, ctx: CollectionState): IndexSymbol | null {
    if (us(uw(b.expression), ctx)) return null
    const c = ctx.i.checker.getResolvedSignature(b)?.getDeclaration()
    if (c && !c.getSourceFile().isDeclarationFile) {
        const a = ds(c, d, ctx)
        if (a) return a
    }
    return sfor(b.expression, d, ctx)
}
function ca(a: ts.SignatureDeclaration, c: FileContext, ctx: CollectionState): IndexSymbol | null {
  if (isArrow(a) || isFunction(a)) {
    const b = a.parent
    if (isVariable(b) && b.initializer === a) { const d = b.parent.parent
      return ts.isVariableStatement(d) && ts.isSourceFile(d.parent) ? ds(b, c, ctx) : null }
    return isBinary(b) ? ed(a, c, ctx) : null
  }
  return ts.isFunctionDeclaration(a) || ts.isMethodDeclaration(a) || ts.isConstructorDeclaration(a) || ts.isGetAccessorDeclaration(a) || ts.isSetAccessorDeclaration(a) ? ed(a, c, ctx) : null
}
function pv(a: ts.Identifier, d: FileContext, ctx: CollectionState): IndexValue | null {
  for (const b of sy(a, ctx)?.declarations ?? []) {
    if (!isParameter(b) || !ts.isFunctionLike(b.parent)) continue
    const c = b.parent.parameters.indexOf(b)
    if (c >= 0) {
      return ca(b.parent, d, ctx)
        ? { kind: 'parameter', position: c }
        : { kind: 'parameter', position: c, scope: 'iteration' }
    }
  }
  return null
}
function red(a: string): IndexValue {
  return { kind: 'redacted', sha256: hash(a), byte_length: Buffer.byteLength(a, 'utf8') }
}
function ls(b: string, c = false): IndexValue {
  const a = Buffer.byteLength(b, 'utf8')
  if (c || SVAL.test(b) || a > SBYT) {
    return red(b)
  }
  return { kind: 'literal', value: b }
}
function uk(a: 'dynamic' | 'ambiguous' | 'unsupported' = 'dynamic'): IndexValue {
  return { kind: 'unknown', reason: a }
}
function uw(b: ts.Expression): ts.Expression {
    let a = b
    while (ts.isAsExpression(a)
        || ts.isTypeAssertionExpression(a) || ts.isNonNullExpression(a)
        || ts.isParenthesizedExpression(a)
        || ts.isSatisfiesExpression(a)) {
        a = a.expression
    }
    return a
}
type ValueOptions = { c?: boolean; s?: boolean; d?: number; n?: ReadonlySet<ts.Node> }
function rd(
  L: ts.Expression, g: FileContext, ctx: CollectionState,
  f: ValueOptions = {},
): IndexValue {
  const d = f.d ?? 0
  if (d >= VDEP) return uk('unsupported')
  const z = new Set(f.n ?? [])
  const a = uw(L)
  if (z.has(a)) return uk('ambiguous')
  z.add(a)
  const b = (I: ts.Expression, J: Partial<ValueOptions> = {}): IndexValue =>
    rd(I, g, ctx, { ...f, ...J, d: d + 1, n: z })
  if (ts.isStringLiteralLike(a)) return ls(a.text, f.s)
  if (isNumeric(a)) {
    const A = Number(a.text)
    return Number.isFinite(A) && !Object.is(A, -0)
      ? { kind: 'literal', value: A }
      : uk('unsupported')
  }
  if (a.kind === K.TrueKeyword) return { kind: 'literal', value: true }
  if (a.kind === K.FalseKeyword) return { kind: 'literal', value: false }
  if (a.kind === K.NullKeyword) return { kind: 'literal', value: null }
  if (ts.isPrefixUnaryExpression(a) && isNumeric(a.operand)) {
    const B = Number(a.operand.text)
    const q = a.operator === K.MinusToken ? -B : B
    if ((a.operator === K.MinusToken
        || a.operator === K.PlusToken)
      && Number.isFinite(q) && !Object.is(q, -0)) {
      return { kind: 'literal', value: q }
    }
  }
  if (ts.isPrefixUnaryExpression(a) && a.operator === K.ExclamationToken) {
    const C = b(a.operand, { c: true })
    if (C.kind === 'literal') return { kind: 'literal', value: !Boolean(C.value) }
  }
  if (isIdentifier(a)) {
    const j = pv(a, g, ctx)
    if (j) return j
    const u = sy(a, ctx)
    const k = u?.valueDeclaration
      ?? u?.declarations?.find((t) => isVariable(t))
    if (
      f.c
      && k
      && isVariable(k)
      && sb(k, ctx)
      && k.initializer
    ) {
      return b(k.initializer, {
        s: f.s || SNM.test(a.text),
      })
    }
    const r = k
      ? ds(k, g, ctx)
      : sfor(a, g, ctx)
    return r ? { kind: 'symbol', symbol_id: r.id } : uk()
  }
  if (ts.isArrayLiteralExpression(a)) {
    if (a.elements.length > VELE) return uk('unsupported')
    const y: IndexValue[] = []
    for (const l of a.elements) {
      if (ts.isSpreadElement(l) || ts.isOmittedExpression(l)) return uk('unsupported')
      y.push(b(l, { c: true }))
    }
    return { kind: 'array', elements: y }
  }
  if (ts.isObjectLiteralExpression(a)) {
    if (a.properties.length > VELE) return uk('unsupported')
    const m = new Map<string, IndexValue>()
    for (const e of a.properties) {
      if (ts.isPropertyAssignment(e)) {
        const key = pn(e.name)
        if (key === null || key.includes('\0')
          || Buffer.byteLength(key, 'utf8') > SBYT) {
          return uk('unsupported')
        }
        m.set(
          key,
          b(e.initializer, {
            c: true,
            s: f.s || SNM.test(key),
          }),
        )
      } else if (ts.isShorthandPropertyAssignment(e)) {
        const key = e.name.text
        if (Buffer.byteLength(key, 'utf8') > SBYT) {
          return uk('unsupported')
        }
        m.set(
          key,
          b(e.name, {
            c: true,
            s: f.s || SNM.test(key),
          }),
        )
      } else {
        return uk('unsupported')
      }
    }
    return {
      kind: 'object',
      entries: [...m].map(([key, value]) => ({ key, value })),
    }
  }
  if (ts.isNoSubstitutionTemplateLiteral(a)) return ls(a.text, f.s)
  if (ts.isTemplateExpression(a)) {
    if (1 + (2 * a.templateSpans.length) > VELE) {
      return uk('unsupported')
    }
    const D: IndexValue[] = [ls(a.head.text, f.s)]
    for (const H of a.templateSpans) {
      D.push(b(H.expression, { c: true }))
      D.push(ls(H.literal.text, f.s))
    }
    return { kind: 'template', parts: D }
  }
  if (isCall(a) && isAccess(a.expression)) {
    const v = a.expression.name.text
    const p = a.expression.expression
    if (v === 'slice') {
      const E = b(p, { c: true })
      if (E.kind !== 'array') return uk()
      const F = ni(a.arguments[0], g, ctx)
      const end = ni(a.arguments[1], g, ctx)
      if (F === null || (a.arguments[1] && end === null)) return uk()
      return { kind: 'array', elements: E.elements.slice(F, end ?? undefined) }
    }
    if (v === 'map') {
      return b(p, { c: false })
    }
  }
  if (isAccess(a) || ts.isElementAccessExpression(a)) {
    const w = sy(a, ctx)?.declarations?.find(ts.isEnumMember)
    const o = w ? ctx.i.checker.getConstantValue(w)
      : ctx.i.checker.getConstantValue(a)
    if (typeof o === 'string') return ls(o, f.s)
    if (typeof o === 'number' && Number.isFinite(o) && !Object.is(o, -0))
      return { kind: 'literal', value: o }
  }
  if (ts.isElementAccessExpression(a)) {
    const h = b(a.expression, { c: true })
    const G = a.argumentExpression
      ? ni(a.argumentExpression, g, ctx)
      : null
    if (h.kind === 'array' && G !== null) {
      return h.elements[G] ?? uk()
    }
  }
  const x = sfor(a, g, ctx)
  return x ? { kind: 'symbol', symbol_id: x.id } : uk()
}
function pn(a: ts.PropertyName): string | null {
  if (isIdentifier(a) || ts.isStringLiteralLike(a) || isNumeric(a)) {
    return a.text
  }
  return null
}
function ni(b: ts.Expression | undefined, d: FileContext, ctx: CollectionState): number | null {
  if (!b) return 0
  const a = rd(b, d, ctx, { c: true })
  return a.kind === 'literal' && typeof a.value === 'number'
    && Number.isSafeInteger(a.value) ? a.value : null
}
function ss(a: IndexValue): string | null {
  if (a.kind === 'literal' && typeof a.value === 'string') {
    return a.value.length > 0 && Buffer.byteLength(a.value, 'utf8') <= TBYT
      ? a.value
      : null
  }
  if (a.kind !== 'template') return null
  let b = ''
  for (const c of a.parts) {
    if (c.kind !== 'literal'
      || !['string', 'number', 'boolean'].includes(typeof c.value)) return null
    b += String(c.value)
  }
  return b.length > 0 && Buffer.byteLength(b, 'utf8') <= TBYT
    ? b
    : null
}
function si(a: IndexValue): string | null {
  return a.kind === 'symbol' ? a.symbol_id : null
}
function mv(a: IndexValue, d: number, b?: (g: number) => IndexValue): IndexValue {
  if (a.kind === 'parameter' && a.scope !== 'iteration' && b) return mv(b(a.position), d)
  if (a.kind === 'array') {
    if (d >= VDEP && a.elements.length > 0) return uk('unsupported'); return {
      kind: 'array', elements: a.elements.map((e) => mv(e, d + 1, b)) }
  }
  if (a.kind === 'object') {
    if (d >= VDEP && a.entries.length > 0) return uk('unsupported'); return {
      kind: 'object', entries: a.entries.map((c) => ({ key: c.key, value: mv(c.value, d + 1, b) })) }
  }
  if (a.kind === 'template') {
    if (d >= VDEP && a.parts.length > 0) return uk('unsupported'); return {
      kind: 'template', parts: a.parts.map((f) => mv(f, d + 1, b)) }
  }
  return a
}
function sub(b: IndexValue, c: readonly IndexValue[]): IndexValue {
  return mv(b, 0, (a) => c[a] ?? uk())
}
function ie(fx: ExecutionEffect, b: readonly IndexValue[], a: EffectWitness): ExecutionEffect {
  switch (fx[0]) {
    case 'bull-publish':
    case 'bull-consume': return [fx[0], sub(fx[1], b), sub(fx[2], b), fx[3], undefined, a, fx[6], 'wrapper-summary']
    case 'event-publish': return [fx[0], sub(fx[1], b), undefined, fx[3], fx[4], a, fx[6], 'wrapper-summary']
    case 'event-consume': return [fx[0], sub(fx[1], b), sub(fx[2]!, b), fx[3], fx[4], a, fx[6], 'wrapper-summary']
    case 'persistence': return [fx[0], fx[1], fx[2] ? sub(fx[2], b) : undefined, fx[3], undefined, a, fx[6], 'wrapper-summary']
  }
}
function cn(a: ts.CallExpression | ts.NewExpression): string {
  const sf = a.getSourceFile()
  const b = st(a.expression, sf)
  return bd(isNew(a) ? `new ${b}` : b)
}
function th(b: ts.CallExpression | ts.NewExpression, ctx: CollectionState): boolean {
  try {
    const a = ctx.i.checker.getResolvedSignature(b)
    const d = a && ctx.i.checker.getReturnTypeOfSignature(a)
    const c = d?.getProperty('then')
    return !!c
      && ctx.i.checker.getTypeOfSymbolAtLocation(c, b).getCallSignatures().length > 0
  } catch { return false }
}
function sch(b: ts.CallExpression | ts.NewExpression, ctx: CollectionState): IndexCallFact['scheduling'] {
    let a: ts.Node = b
    while (ts.isParenthesizedExpression(a.parent)
        || ts.isAsExpression(a.parent)
        || ts.isNonNullExpression(a.parent)) {
        a = a.parent
    }
    if (ts.isAwaitExpression(a.parent)) return 'awaited'
    if ((ts.isVoidExpression(a.parent)
        || ts.isExpressionStatement(a.parent)) && th(b, ctx))
      return 'fire_and_forget'
    return 'sync'
}
function iar(b: ts.Expression, ctx: CollectionState): boolean {
  try {
    const a = ctx.i.checker.getTypeAtLocation(b)
    return ctx.i.checker.isArrayType(a)
      || ctx.i.checker.isTupleType(a)
  } catch { return false }
}
function cf(
  b: ts.CallExpression | ts.NewExpression, sym: IndexSymbol,
  e: FileContext, ctx: CollectionState,
  z: readonly IndexControlFrame[],
): IndexCallFact {
  const a = cs(b, e, ctx)
  const h = (b.arguments ?? []).map((g) => {
    const d = uw(g)
    return isArrow(d) || isFunction(d)
      ? hv(d, e, ctx)
      : rd(d, e, ctx, {
          c: true,
          s: SNM.test(d.getText(e.sf)),
        })
  })
  const f: IndexCallFact = {
    ...fb(sym.id, 'call', b, e, z, {
      c: a ? 'high' : 'medium',
      s: a ? 'typescript-semantic' : 'typescript-syntactic',
    }),
    kind: 'call',
    callee: cn(b),
    ...(a ? { target_symbol_id: a.id } : {}),
    arguments: h,
    scheduling: sch(b, ctx),
  }
  af(ctx, f)
  const ids = ctx.ci.get(b)
  if (ids) ids.push(f.id); else ctx.ci.set(b, [f.id])
  if (a && !ids) {
    al(ctx, sym.id, [a.id, f.arguments, b])
  }
  return f
}
function rty(a: ts.Expression, ctx: CollectionState): string {
  try {
    return bd(
      ctx.i.checker.typeToString(
        ctx.i.checker.getTypeAtLocation(a),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ).replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/gu, '<literal>'),
    )
  } catch {
    return ''
  }
}
function ti(e: ts.Expression, f: FileContext, ctx: CollectionState): ImportBinding | null {
    for (const c of sy(e, ctx)?.declarations ?? []) {
        const a = isParameter(c)
          || isPropertyDecl(c) || isVariable(c) ? c.type : undefined
        if (!a) continue
        const d = isTypeReference(a)
          ? (ts.isQualifiedName(a.typeName)
            ? a.typeName.left : a.typeName) : null
        if (d && isIdentifier(d)) {
            const b = f.im.get(d.text)
            if (b) return b
        }
    }
    return null
}
function bt(a: ImportBinding | null): QueueTransport | null {
  if (!a || !['bull', 'bullmq'].includes(a.m)
    || !['Queue', 'default'].includes(a.i)) return null
  return a.m as QueueTransport
}
function cx(sf: ts.SourceFile, ctx: CollectionState): FileContext | null {
    return ctx.fs.get(sf) ?? null;
}
function xs(b: ts.Expression, ctx: CollectionState): ts.Symbol | undefined {
  const a = uw(b)
  return sy(isAccess(a) ? a.name : a, ctx)
}
function eq(d: ts.Expression, c: ts.Expression, ctx: CollectionState): boolean {
  const a = uw(d), b = uw(c)
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
function qc(f: ts.Expression, ctx: CollectionState, e: ReadonlySet<ts.Node> = new Set()): readonly [ts.Expression, FileContext, QueueTransport] | null {
  const a = uw(f)
  if (e.has(a)) return null
  const g = new Set(e).add(a)
  const d = cx(a.getSourceFile(), ctx)
  if (!d) return null
  if (isNew(a) && a.arguments?.[0]) {
    const b = bt(ib(a.expression, d))
    return b ? [a.arguments[0], d, b] : null
  }
  if (!isIdentifier(a)) return null
  const c = sy(a, ctx)?.valueDeclaration
  return c && isVariable(c) && sb(c, ctx) && c.initializer
    ? qc(c.initializer, ctx, g) : null
}
function xe(a: ts.Statement, b: FileContext, ctx: CollectionState): boolean {
  if (ts.isBlock(a)) return a.statements.some((f) => xe(f, b, ctx))
  if (isIf(a)) {
    const e = rd(a.expression, b, ctx, { c: true })
    if (e.kind === 'literal') {
      const d = Boolean(e.value) ? a.thenStatement : a.elseStatement
      return !!d && xe(d, b, ctx)
    }}
  return ex(a, b, ctx)
}
function rr(
  b: ts.Statement, j: ts.MethodDeclaration | ts.ConstructorDeclaration,
  e: FileContext, ctx: CollectionState,
): boolean {
  let d: ts.Node = b, a = b.parent
  while (a !== j) {
    if (ts.isBlock(a)) {
      const f = a.statements.indexOf(d as ts.Statement)
      if (f >= 0 && a.statements.slice(0, f)
        .some((l) => xe(l, e, ctx))) return false
    } else if (isIf(a)) {
      const g = rd(a.expression, e, ctx, { c: true })
      if (g.kind !== 'literal'
        || Boolean(g.value) !== (d === a.thenStatement)) return false
    } else if ((ts.isWhileStatement(a) || ts.isForStatement(a))
        && a.statement === d) {
      const k = ts.isWhileStatement(a) ? a.expression : a.condition
      const h = k ? rd(k, e, ctx, { c: true }) : null
      if (h?.kind === 'literal' && !Boolean(h.value)) return false
    } else if (ts.isForOfStatement(a) && a.statement === d) {
      const i = rd(a.expression, e, ctx, { c: true })
      if (i.kind !== 'array' || i.elements.length === 0) return false
    }
    d = a
    a = a.parent
  }
  return true
}
function xr(j: ts.CallExpression, f: FileContext, ctx: CollectionState): boolean {
  const b = stmt(j)
  if (!ts.isExpressionStatement(b)) return false
  if (ts.isSourceFile(b.parent)) return true
  if (ts.isBlock(b.parent)
    && ts.isConstructorDeclaration(b.parent.parent)) return rr(
      b, b.parent.parent, f, ctx)
  let a: ts.Node = b.parent
  while (!ts.isSourceFile(a) && !ts.isMethodDeclaration(a)) {
    if (ts.isFunctionLike(a)) return false
    a = a.parent
  }
  if (!ts.isMethodDeclaration(a)
    || !isIdentifier(a.name) || a.name.text !== 'onModuleInit'
    || !ts.isClassLike(a.parent)) return false
  const h = dc(a.parent).some((c) => {
    const k = isCall(c.expression)
      ? c.expression.expression : c.expression
    const d = ib(k, f)
    return d?.m === '@nestjs/common'
      && ['Controller', 'Injectable', 'Module'].includes(d.i)
  })
  return h && rr(b, a, f, ctx)
    && a.parent.heritageClauses?.some((g) =>
      g.token === K.ImplementsKeyword && g.types.some((l) => {
        const e = ib(l.expression, f)
        return e?.m === '@nestjs/common' && e.i === 'OnModuleInit'
      })) === true
}
function prep(ctx: CollectionState): void {
  const s: Array<readonly [ts.Symbol, ts.Expression, ts.Expression]> = []
  const t = new Set<ts.Symbol>()
  const add = (d: ts.Symbol): void => {
    if (t.has(d)) return
    t.add(d); ctx.u.add(d)
    const k = d.valueDeclaration
    const b = k && ts.isBindingElement(k)
      && isVariable(k.parent.parent) ? k.parent.parent : k
    const f = b && isVariable(b) && b.initializer
      ? uw(b.initializer) : null
    if (f && (isIdentifier(f) || isAccess(f)
      || ts.isElementAccessExpression(f)
      || ts.isObjectLiteralExpression(f)
      || ts.isArrayLiteralExpression(f))) g(f)
  }
  const g = (l: ts.Node): void => {
    if (ts.isShorthandPropertyAssignment(l)) {
      const h = ctx.i.checker.getShorthandAssignmentValueSymbol(l)
      if (h) add(fa(h, ctx.i.checker) ?? h)
    }
    if (isIdentifier(l)) {
      const o = sy(l, ctx)
      if (o) add(o)
    }
    ts.forEachChild(l, g)
  }
  const j = (q: ts.Node): void =>
    g(ts.isElementAccessExpression(q) ? q.expression : q)
  for (const sf of ctx.i.sourceFiles) {
    const r = (a: ts.Node): void => {
      if (isBinary(a) && AOP.has(a.operatorToken.kind)) {
        j(a.left); const c = uw(a.right)
        if (a.operatorToken.kind === K.EqualsToken
          && (isIdentifier(c) || isAccess(c)
            || ts.isElementAccessExpression(c)
            || ts.isObjectLiteralExpression(c)
            || ts.isArrayLiteralExpression(c))) g(c)
      } else if ((ts.isPrefixUnaryExpression(a) || ts.isPostfixUnaryExpression(a))
        && [K.PlusPlusToken, K.MinusMinusToken].includes(a.operator))
        j(a.operand)
      else if (ts.isDeleteExpression(a)) j(a.expression)
      if (isCall(a) && isAccess(a.expression)) {
        const e = a.expression.name.text
        if (['assign', 'defineProperty', 'defineProperties'].includes(e)
          && isIdentifier(a.expression.expression)
          && a.expression.expression.text === 'Object'
          && sy(a.expression.expression, ctx)?.declarations?.some((v) =>
            v.getSourceFile().isDeclarationFile
            && /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(
              v.getSourceFile().fileName.replaceAll('\\', '/')))
          && a.arguments[0]) g(a.arguments[0])
        if (AMU.has(e)
          || ['clear', 'delete', 'copyWithin', 'fill', 'reverse', 'sort'].includes(e)) {
          g(a.expression.expression)
        } else if (e === 'set' && a.arguments[0] && a.arguments[1]
          && xr(a, cx(a.getSourceFile(), ctx)!, ctx)) {
          const p = xs(a.expression.expression, ctx)
          if (p) s.push([p, a.arguments[0], a.arguments[1]])
        }
      }
      ts.forEachChild(a, r)
    }
    r(sf)
  }
  for (const [symbol, key, value] of s) {
    const m = ctx.mq.get(symbol) ?? []
    const n = qc(value, ctx)
    const w = cx(key.getSourceFile(), ctx)
    m.push(n && w ? [key, w, n[0], n[2]] : null)
    ctx.mq.set(symbol, m)
  }
}
function sm(b: ts.Declaration, ctx: CollectionState): boolean {
  try {
    const a = ctx.i.checker.getTypeAtLocation(b).getSymbol()
    return a?.name === 'Map'
      && !!a.declarations?.some((c) =>
        /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(
          c.getSourceFile().fileName.replaceAll('\\', '/'),
        ))
  } catch { return false }
}
function mq(map: ts.Expression, key: ts.Expression, k: FileContext, ctx: CollectionState): QueueOrigin | null {
  const a = xs(map, ctx)
  const g = a?.valueDeclaration
  if (!a || !g
    || !(isVariable(g) || isPropertyDecl(g))
    || !sb(g, ctx) || !sm(g, ctx)) return null
  const b = ctx.mq.get(a) ?? []
  if (b.length === 0 || b.some((l) => !l)) return null
  const f = b as MapQueueEntry[]
  const i = ss(rd(key, k, ctx, { c: true }))
  if (i) {
    const h = f.filter(([entryKey, entryFile]) =>
      ss(rd(entryKey, entryFile, ctx, { c: true })) === i)
    if (h.length) {
      const d = h.map(([, entryFile, queueKey, transport]) =>
        [rd(queueKey, entryFile, ctx, { c: true }), transport] as const)
      const m = JSON.stringify(d[0])
      return d.every((j) => JSON.stringify(j) === m)
        ? d[0]! : null
    }
  }
  const e = f[0]![3]
  return f.every(([entryKey, , queueKey, entryTransport]) =>
    entryTransport === e && eq(entryKey, queueKey, ctx))
    ? [rd(key, k, ctx, { c: true }), e] : null
}
function qo(n: ts.Expression, sym: IndexSymbol, l: FileContext, ctx: CollectionState, m: ReadonlySet<ts.Node> = new Set()): QueueOrigin | null {
  const a = uw(n); if (m.has(a)) return null
  const d = new Set(m).add(a)
  if (isNew(a) && a.arguments?.[0]) {
    const b = bt(ib(a.expression, l)); if (b) return [rd(a.arguments[0], l, ctx, { c: true }), b]
  }
  if (isIdentifier(a)) {
    const e = sy(a, ctx)?.valueDeclaration
    if (e && isVariable(e) && sb(e, ctx) && e.initializer) {
      const f = cx(e.getSourceFile(), ctx); return f ? qo(e.initializer, sym, f, ctx, d) : null
    }
  }
  if (isAccess(a) && a.expression.kind === K.ThisKeyword) {
    const j = sy(a.name, ctx), k = sym.kind === 'method' ? sym.name.slice(0, sym.name.lastIndexOf('.')) : sym.name
    const g = ctx.nq.get(`${sym.file_id}\0${k}`)?.get(a.name.text)
    if (g && j && !ctx.u.has(j)) return g
    const h = j?.valueDeclaration
    if (h && isPropertyDecl(h) && sb(h, ctx) && h.initializer) {
      const i = cx(h.getSourceFile(), ctx); if (i) return qo(h.initializer, sym, i, ctx, d)
    }
  }
  if (isCall(a) && isAccess(a.expression) && a.expression.name.text === 'get' && a.arguments[0])
    return mq(a.expression.expression, a.arguments[0], l, ctx)
  return null
}
function es(j: ts.Expression, sym: IndexSymbol, l: FileContext, ctx: CollectionState, g: ReadonlySet<ts.Node> = new Set()): EmitterScope | null {
  const e = uw(j); if (g.has(e)) return null
  g = new Set(g).add(e)
  if (isIdentifier(e)) {
    const c = sy(e, ctx)?.valueDeclaration
    if (c) {
      const a = cx(c.getSourceFile(), ctx), b = a ? `${a.id}:${c.getStart(a.sf, false)}` : null
      const f = b ? ctx.em.get(b) : undefined
      if (f) return f
      if (isVariable(c) && sb(c, ctx) && c.initializer && isNew(uw(c.initializer))) {
        const k = uw(c.initializer) as ts.NewExpression; if (!a) return null
        const d = et(k.expression, a)
        if (d) {
          const h = b!, i: EmitterScope = [h, d]; ctx.em.set(h, i); return i
        }
      }
    }
  }
  return null
}
function et(a: ts.Expression, b: FileContext): 'node-event-emitter' | 'nestjs-event-emitter' | null {
    if (ii(a, b, ['node:events', 'events'], ['EventEmitter'])) return 'node-event-emitter'
    return ii(a, b, ['@nestjs/event-emitter'], ['EventEmitter2'])
      ? 'nestjs-event-emitter' : null
}
function hv(h: ts.Expression, g: FileContext, ctx: CollectionState): IndexValue {
  const d = uw(h)
  if (isArrow(d) || isFunction(d)) {
    const a = new Set<string>()
    const f = (b: ts.Node): void => {
      if (b !== d && (isArrow(b) || isFunction(b))) return
      if (isCall(b)) { const e = cs(b, g, ctx); if (e) a.add(e.id) }
      ts.forEachChild(b, f)
    }
    f(d.body)
    return a.size === 1 ? { kind: 'symbol', symbol_id: [...a][0]! }
      : uk(a.size > 1 ? 'ambiguous' : 'dynamic')
  }
  return rd(d, g, ctx, { c: false })
}
type PersistenceSummary = readonly [operation: IndexPersistenceOperation, resource: IndexValue | undefined, receiverType: string]
function se(
  a: IndexPersistenceOperation | null, b: string,
  d: ts.Expression | undefined, e: FileContext, ctx: CollectionState,
): PersistenceSummary | null {
  return a ? [
    a,
    d ? rd(d, e, ctx, { c: true }) : undefined,
    b,
  ] : null
}
function po(f: ts.CallExpression, c: FileContext, ctx: CollectionState): PersistenceSummary | null {
  const k = f.expression
  if (isIdentifier(k)) {
    const d = c.im.get(k.text); if (d && FSM.has(d.m))
      return se(fsop(d.i, f.arguments[1], c, ctx), `${d.m}:${d.i}`, f.arguments[0], c, ctx)
  }
  if (!isAccess(k)) return null
  const g = k.name.text, b = k.expression, s = li(b)
  const ns = s ? c.im.get(s.text) : undefined
  if (ns?.n && FSM.has(ns.m)) {
    const l = se(fsop(g, f.arguments[1], c, ctx), `${ns.m}:namespace`, f.arguments[0], c, ctx); if (l) return l
  }
  const q = rty(b, ctx), a = ti(b, c, ctx)
  if (a?.m === 'typeorm' && ['Repository', 'MongoRepository'].includes(a.i)) {
    const o = se(typeormOperation(g), q || `${a.m}:${a.i}`, f.arguments[0], c, ctx); if (o) return o
  }
  if (pd(b, ctx, '/node_modules/@prisma/client/', '/node_modules/.prisma/client/')) {
    const p = se(prismaOperation(g), q || 'PrismaClient', f.arguments[0], c, ctx); if (p) return p
  }
  if (g !== 'send' || !(a?.m === '@aws-sdk/client-s3' && a.i === 'S3Client' || pd(b, ctx, '/node_modules/@aws-sdk/client-s3/'))) return null
  const h = f.arguments[0]
  if (h && isNew(uw(h))) {
    const e = uw(h) as ts.NewExpression, j = ib(e.expression, c)
    if (j?.m === '@aws-sdk/client-s3') {
      const r = ['PutObjectCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand'], t = ['GetObjectCommand', 'HeadObjectCommand']
      return se(r.includes(j.i) ? 'object_write' : t.includes(j.i) ? 'object_read' : null, q, e.arguments?.[0], c, ctx)
    }
  }
  return null
}
function li(b: ts.Expression): ts.Identifier | null {
  let a = b
  while (isAccess(a)) a = a.expression
  return isIdentifier(a) ? a : null
}
function pd(h: ts.Expression, ctx: CollectionState, ...b: readonly string[]): boolean {
    const d = ctx.i.checker
    let a: ts.Expression = h
    while (true) {
        try {
            const g = d.getTypeAtLocation(a)
            const e = [g.aliasSymbol, g.getSymbol()]
            if (e.some((f) => f?.declarations?.some((j) => {
                const k = j.getSourceFile().fileName.replaceAll('\\', '/')
                return b.some((c) => k.includes(c))
            }))) return true
        } catch { return false }
        if (!isAccess(a)) return false
        a = a.expression
    }
}
function no(b: string, a: Readonly<Record<string, IndexPersistenceOperation>>): IndexPersistenceOperation | null {
    return Object.hasOwn(a, b) ? a[b]! : null;
}
function fsop(
  b: string, d: ts.Expression | undefined, e: FileContext, ctx: CollectionState,
): IndexPersistenceOperation | null {
  if (!['open', 'openSync'].includes(b)) return no(b, FSO)
  if (!d) return null
  const a = ss(rd(d, e, ctx, { c: true }))
  if (!a) return null
  if (a.includes('+') || /^[aw]/u.test(a)) return 'file_write'
  return /^r(?:s|sr)?$/u.test(a) ? 'file_read' : null
}
const typeormOperation = (a: string): IndexPersistenceOperation | null =>
  no(a, TOO)
const prismaOperation = (a: string): IndexPersistenceOperation | null =>
  no(a, PRO)
function re(a: ts.CallExpression | ts.NewExpression, sym: IndexSymbol, d: FileContext, ctx: CollectionState): void {
  if ((ctx.ci.get(a)?.length ?? 0) > 1) return
  const f = [a, 'high', 'framework'] as const
  if (isNew(a)) {
    if (ii(a.expression, d, ['bullmq'], ['Worker']) && a.arguments?.[0] && a.arguments[1])
      ae(ctx, sym.id, ['bull-consume', rd(a.arguments[0], d, ctx, { c: true }), hv(a.arguments[1], d, ctx), 'bullmq', undefined, ...f])
    return
  }
  if (isAccess(a.expression)) {
    const h = a.expression.name.text, g = a.expression.expression
    if (h === 'add' && a.arguments[0]) {
      const i = qo(g, sym, d, ctx); if (i) ae(ctx, sym.id, ['bull-publish', i[0],
        rd(a.arguments[0], d, ctx, { c: true }), i[1], undefined, ...f])
    }
    const b = es(g, sym, d, ctx)
    if (b && h === 'emit' && a.arguments[0])
      ae(ctx, sym.id, ['event-publish', rd(a.arguments[0], d, ctx, { c: true }), undefined, b[1], b[0], ...f])
    else if (b && ['addListener', 'on', 'once', 'prependListener'].includes(h)
      && a.arguments[0] && a.arguments[1])
      ae(ctx, sym.id, ['event-consume', rd(a.arguments[0], d, ctx, { c: true }), hv(a.arguments[1], d, ctx), b[1], b[0], ...f])
  }
  const e = po(a, d, ctx); if (e) ae(ctx, sym.id, ['persistence', ...e, undefined, ...f])
}
function pc(b: ts.CallExpression, ctx: CollectionState): {
  combinator: 'all' | 'allSettled' | 'any' | 'race'
  completion: 'all_or_first_rejection' | 'all_settled' | 'first_fulfilled' | 'first_settled'
} | null {
    if (!isAccess(b.expression)
        || !isIdentifier(b.expression.expression)
        || b.expression.expression.text !== 'Promise') return null
    const c = sy(b.expression.expression, ctx)
    if (!c?.declarations?.some((d) => d.getSourceFile().isDeclarationFile
        && /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(d.getSourceFile().fileName.replaceAll('\\', '/'))))
        return null
    const a = b.expression.name.text
    return Object.hasOwn(PMC, a)
      ? { combinator: a as keyof typeof PMC,
        completion: PMC[a as keyof typeof PMC] } : null
}
function pl(c: ts.Expression | undefined): readonly ts.Expression[] | null {
    if (!c) return null
    const b = uw(c);
    if (!ts.isArrayLiteralExpression(b)
      || b.elements.length > VELE
      || b.elements.some((a) =>
        ts.isOmittedExpression(a) || ts.isSpreadElement(a))) return null
    return [...b.elements] as ts.Expression[]
}
function mi(b: ts.Expression | undefined, e: FileContext, ctx: CollectionState): {
  call: ts.CallExpression; input: IndexValue; receiver: ts.Expression
} | null {
    if (!b) return null
    const a = uw(b)
    if (!isCall(a)
        || !isAccess(a.expression)
        || a.expression.name.text !== 'map') return null
    const d = rd(a.expression.expression, e, ctx, { c: true })
    return d.kind === 'array'
      ? { call: a, input: d, receiver: a.expression.expression } : null
}
function sk(
  f: ts.Expression, g?: FileContext, ctx?: CollectionState,
): string | null {
  const d = g && ctx ? rd(f, g, ctx, { c: true }) : null
  if (d?.kind === 'literal')
    return JSON.stringify([typeof d.value, d.value])
  const b = uw(f)
  if (ts.isPrefixUnaryExpression(b) && isNumeric(b.operand)
    && [K.PlusToken, K.MinusToken].includes(b.operator)
    && Number(b.operand.text) === 0) return JSON.stringify(['number', 0])
  if (ctx && (isAccess(b) || ts.isElementAccessExpression(b))) {
    const e = sy(b, ctx)?.declarations?.find(ts.isEnumMember)
    const a = e ? ctx.i.checker.getConstantValue(e)
      : ctx.i.checker.getConstantValue(b)
    if (typeof a === 'number' && Number.isFinite(a))
      return JSON.stringify(['number', Object.is(a, -0) ? 0 : a])
  }
  return null
}
const XN = 1, XT = 2, XO = 4, XB = 8
function xq(
  b: readonly ts.Statement[], d?: FileContext,
  ctx?: CollectionState, a = XN,
): number {
  for (const c of b) {
    if (!(a & XN)) break
    a = a & ~XN | xp(c, d, ctx)
  }
  return a
}
function xp(
  a: ts.Statement, d?: FileContext, ctx?: CollectionState,
): number {
  if (ts.isReturnStatement(a) || ts.isContinueStatement(a)) return XO
  if (ts.isBreakStatement(a)) return a.label ? XO : XB
  if (ts.isThrowStatement(a)) return XT
  if (ts.isBlock(a)) return xq(a.statements, d, ctx)
  if (isIf(a)) return xp(a.thenStatement, d, ctx)
    | (a.elseStatement ? xp(a.elseStatement, d, ctx) : XN)
  if (ts.isSwitchStatement(a)) {
    let f = a.caseBlock.clauses.some(ts.isDefaultClause) ? 0 : XN
    const j = new Set<string>()
    for (let e = 0; e < a.caseBlock.clauses.length; e += 1) {
      const g = a.caseBlock.clauses[e]!
      if (ts.isCaseClause(g)) {
        const key = sk(g.expression, d, ctx)
        if (key && j.has(key)) continue
        if (key) j.add(key)
      }
      let b = XN
      for (let h = e;
        h < a.caseBlock.clauses.length && b & XN;
        h += 1) {
        b = xq(a.caseBlock.clauses[h]!.statements, d, ctx, b)
      }
      if (b & XB) b = b & ~XB | XN
      f |= b
    }
    return f
  }
  if (ts.isTryStatement(a)) {
    let c = xp(a.tryBlock, d, ctx)
    if (a.catchClause && c & XT)
      c = c & ~XT | xp(a.catchClause.block, d, ctx)
    if (a.finallyBlock) {
      const i = xp(a.finallyBlock, d, ctx)
      c = (i & XN ? c : 0) | i & ~XN
    }
    return c
  }
  return XN
}
function ex(
  a: ts.Statement, b?: FileContext, ctx?: CollectionState,
): boolean { return !(xp(a, b, ctx) & XN) }
function sx(a: ts.Node): boolean {
  return isCall(a) || isNew(a)
    || isBinary(a) && AOP.has(a.operatorToken.kind)
    || (ts.isPrefixUnaryExpression(a) || ts.isPostfixUnaryExpression(a))
      && [K.PlusPlusToken, K.MinusMinusToken].includes(a.operator)
    || ts.isDeleteExpression(a) || ts.isTaggedTemplateExpression(a)
    || ts.isAwaitExpression(a) || ts.isYieldExpression(a)
    || ts.forEachChild(a, sx) === true
}
function gc(
  c: ts.IfStatement, d?: FileContext, ctx?: CollectionState,
): BranchArm | 'unreachable' | null {
  const a = ex(c.thenStatement, d, ctx)
  const b = c.elseStatement
    ? ex(c.elseStatement, d, ctx) : false
  if (a && b) return 'unreachable'
  if (a) return 'else'
  return b ? 'then' : null
}
function tv(b: ts.VariableDeclaration, sym: IndexSymbol, d: FileContext, ctx: CollectionState): IndexValue | null {
    if (!b.initializer || b.parent.parent.parent !== d.sf) return null
    const a = rd(b.initializer, d, ctx, {
        c: true,
        s: isIdentifier(b.name) && SNM.test(b.name.text),
    });
    if (a.kind === 'unknown' || a.kind === 'symbol'
      || a.kind === 'parameter') return null
    if (a.kind === 'literal'
        && typeof a.value === 'string'
        && a.value.length === 0) return null
    return sym.id === ds(b, d, ctx)?.id ? a : null;
}
function collect(b: FileContext, ctx: CollectionState): void {
  const d = (
    a: ts.Node,
    z: readonly IndexControlFrame[],
    i = false,
  ): void => {
    if (ts.isDecorator(a)) return
    const sym = ow(a, b)
    if (ts.isFunctionLike(a)) {
      const t = ca(a, b, ctx)
      if (t?.id !== sym?.id && !i) return
      if (t?.id === sym?.id && sym && !ctx.p.has(sym.id)) {
        ctx.p.set(sym.id, a.parameters.map((j) =>
          j.initializer
            ? rd(j.initializer, b, ctx, { c: true }) : uk()))
      }
    }
    if (sym && z.length > INDEX_BODY_FACT_CONTROL_LIMIT) {
      ctx.o.add(sym.id)
      return
    }
    if (sym && ts.isBlock(a)) {
      let e = z
      for (const w of a.statements) {
        d(w, e)
        if (!isIf(w)) {
          if (ex(w, b, ctx)) break
          continue
        }
        const u = gc(w, b, ctx)
        if (u === 'unreachable') break
        if (u) {
          const T = fb(
            sym.id,
            'condition',
            w.expression,
            b,
            e,
            { n: w },
          )
          ctx.q.set(T.id, u)
          e = br(e, T.id, u)
        }
      }
      return
    }
    if (sym && isVariable(a) && isIdentifier(a.name)) {
      const Z = tv(a, sym, b, ctx)
      if (Z) {
        af(ctx, {
          ...fb(sym.id, 'literal', a.initializer!, b, z, {
            n: stmt(a),
          }),
          kind: 'literal',
          value: Z,
          role: 'initializer',
        })
      }
    }
    if (sym && isIf(a)) {
      const u = gc(a, b, ctx)
      const U = ac(
        sym.id, u ? 'guard' : 'if',
        a.expression, b, ctx, z, a,
      )
      d(a.expression, z)
      d(a.thenStatement, br(z, U.id, 'then'))
      if (a.elseStatement) {
        d(a.elseStatement, br(z, U.id, 'else'))
      }
      return
    }
    if (sym && ts.isSwitchStatement(a)) {
      if (a.caseBlock.clauses.length > VELE
        || a.caseBlock.clauses.some((H) =>
          ts.isCaseClause(H) && sx(H.expression))) {
        ctx.o.add(sym.id)
        return
      }
      const $c = ac(
        sym.id, 'switch', a.expression, b, ctx, z, a,
      )
      d(a.expression, z)
      let ft: IndexControlFrame[][] = []
      const iv = b.v
      const k = new Set<string>()
      for (const g of a.caseBlock.clauses) {
        const arm = ts.isDefaultClause(g)
          ? 'default' as const
          : `case:${hash(`${g.expression.getText(b.sf)}:${g.pos}`).slice(0, 16)}` as const
        if (ts.isCaseClause(g)) d(g.expression, z)
        let I = true
        if (ts.isCaseClause(g)) {
          const key = sk(g.expression, b, ctx)
          if (key) {
            I = !k.has(key)
            k.add(key)
          }
        }
        const $ = [...(I ? [br(z, $c.id, arm)] : []), ...ft]
        const V: IndexControlFrame[][] = []
        for (const [path, entry] of $.entries()) {
          b.v = path === 0
            ? iv
            : b.nv++
          let q = entry, O = true
          for (const x of g.statements) {
            d(x, q)
            if (!isIf(x)) {
              if (ex(x, b, ctx)) { O = false; break }
              continue
            }
            const u = gc(x, b, ctx)
            if (u === 'unreachable') { O = false; break }
            if (u) q = br(
              q, fb(
                sym.id, 'condition', x.expression, b, q,
                { n: x },
              ).id, u,
            )
          }
          if (O) V.push(q)
          if (ctx.o.has(sym.id)) break
        }
        b.v = iv
        ft = V
        if (ctx.o.has(sym.id)) break
      }
      return
    }
    if (sym && ts.isConditionalExpression(a)) {
      const W = ac(
        sym.id, 'ternary', a.condition, b, ctx, z, stmt(a),
      )
      d(a.condition, z)
      d(a.whenTrue, br(z, W.id, 'truthy'))
      d(a.whenFalse, br(z, W.id, 'falsy'))
      return
    }
    const l = isBinary(a) ? LFL.get(a.operatorToken.kind) : undefined
    if (sym && isBinary(a) && l) {
      const $d = ac(
        sym.id, l[0], a.left, b, ctx, z, stmt(a),
      )
      d(a.left, z)
      d(a.right, br(z, $d.id, l[1]))
      return
    }
    const s = ld(a)
    if (sym && s) {
      const X = fb(sym.id, 'loop', a, b, z)
      const r = [...z, {
        kind: 'loop' as const,
        controller_fact_id: X.id,
      }]
      af(ctx, {
        ...X,
        kind: 'loop',
        loop_kind: s.kind,
        ...(s.test
          ? { test: rd(s.test, b, ctx, { c: true }) }
          : {}),
      })
      for (const _ of s.once) d(_, z)
      for (const L of s.repeated) d(L, r)
      d(s.body, r)
      return
    }
    if (sym && ts.isTryStatement(a)) {
      d(a.tryBlock, [...z, { kind: 'exception', arm: 'try' }])
      if (a.catchClause) {
        d(a.catchClause, [...z, { kind: 'exception', arm: 'catch' }])
      }
      if (a.finallyBlock) {
        d(a.finallyBlock, [...z, { kind: 'exception', arm: 'finally' }])
      }
      return
    }
    if (sym && ts.isReturnStatement(a)) {
      af(ctx, {
        ...fb(sym.id, 'return', a, b, z),
        kind: 'return',
        ...(a.expression
          ? { value: rd(a.expression, b, ctx, { c: true }) }
          : {}),
      })
      if (a.expression) d(a.expression, z)
      return
    }
    if (sym && ts.isThrowStatement(a)) {
      af(ctx, {
        ...fb(sym.id, 'throw', a, b, z),
        kind: 'throw',
        value: rd(a.expression, b, ctx, { c: true }),
      })
      d(a.expression, z)
      return
    }
    if (sym && isBinary(a) && AOP.has(a.operatorToken.kind)) {
      am(sym.id, a, 'assign', a.left, b, ctx, z, a.right)
    } else if (
      sym
      && (ts.isPrefixUnaryExpression(a) || ts.isPostfixUnaryExpression(a))
      && [K.PlusPlusToken, K.MinusMinusToken].includes(a.operator)
    ) {
      am(
        sym.id, a,
        a.operator === K.PlusPlusToken ? 'increment' : 'decrement',
        a.operand, b, ctx, z,
      )
    } else if (sym && ts.isDeleteExpression(a)) {
      am(sym.id, a, 'delete', a.expression, b, ctx, z)
    }
    if (sym && (isCall(a) || isNew(a))) {
      cf(a, sym, b, ctx, z)
      re(a, sym, b, ctx)
      if (isCall(a)) {
        const G = pc(a, ctx)
        if (G) {
          const h = mi(a.arguments[0], b, ctx)
          const E = h ? null : pl(a.arguments[0])
          const F = h?.input ?? (E
            ? rd(a.arguments[0]!, b, ctx, { c: true })
            : null)
          if (!F || F.kind !== 'array'
            || (E && E.length !== F.elements.length)) {
            for (const M of a.arguments) d(M, z)
            return
          }
          const J = fb(sym.id, 'parallel', a, b, z)
          const Q = ctx.f.get(sym.id)?.length ?? 0
          if (h) {
            cf(h.call, sym, b, ctx, z)
            re(h.call, sym, b, ctx)
            const R = ai(sym.id, h.call, b, ctx, z)
            d(h.receiver, z)
            for (const y of h.call.arguments) {
              const A = uw(y)
              const B = isArrow(A)
                || isFunction(A)
              d(
                y,
                B
                  ? [
                      ...z,
                      { kind: 'loop', controller_fact_id: R },
                      {
                        kind: 'parallel',
                        controller_fact_id: J.id,
                        lane: 'each',
                      },
                    ]
                  : z,
                B,
              )
            }
          } else {
            for (const [lane, expr] of E!.entries()) {
              d(expr, [...z, {
                kind: 'parallel',
                controller_fact_id: J.id,
                lane,
              }])
            }
          }
          const ids = (ctx.f.get(sym.id) ?? [])
            .slice(Q)
            .filter((Y) => Y.kind === 'call'
              && Y.control.some((P) =>
                P.kind === 'parallel'
                && P.controller_fact_id === J.id))
            .map(($e) => $e.id)
          af(ctx, {
            ...J,
            kind: 'parallel',
            ...G,
            lane_count: F.elements.length,
            input: F,
            member_fact_ids: ids,
          })
          return
        }
        if (
          isAccess(a.expression)
          && AIM.has(a.expression.name.text)
        ) {
          const $a = rd(
            a.expression.expression,
            b,
            ctx,
            { c: true },
          )
          d(a.expression.expression, z)
          if ($a.kind !== 'array') {
            for (const N of a.arguments) d(N, z)
            return
          }
          const S = ai(sym.id, a, b, ctx, z)
          for (const C of a.arguments) {
            const D = uw(C)
            d(C, [...z, {
              kind: 'loop',
              controller_fact_id: S,
            }], isArrow(D) || isFunction(D))
          }
          return
        }
        const m = isAccess(a.expression)
          ? AMU.get(a.expression.name.text)
          : undefined
        if (m && isAccess(a.expression)
          && iar(a.expression.expression, ctx)) {
          am(
            sym.id, a, m, a.expression.expression, b, ctx,
            z, m === 'append' ? a.arguments[0] : undefined, 1,
          )
        }
      }
    }
    ts.forEachChild(a, ($b) => d($b, z))
  }
  d(b.sf, [])
}
function ld(a: ts.Node): {
  kind: 'for' | 'for_in' | 'for_of' | 'while' | 'do_while'; test?: ts.Expression
  once: readonly ts.Node[]; repeated: readonly ts.Node[]; body: ts.Statement
} | null {
  if (ts.isForStatement(a)) {
    const c: ts.Node[] = []
    const b: ts.Node[] = []
    if (a.initializer) c.push(a.initializer)
    if (a.condition) b.push(a.condition)
    if (a.incrementor) b.push(a.incrementor)
    return {
      kind: 'for',
      ...(a.condition ? { test: a.condition } : {}),
      once: c,
      repeated: b,
      body: a.statement,
    }
  }
  if (ts.isForInStatement(a) || ts.isForOfStatement(a)) {
    return {
      kind: ts.isForInStatement(a) ? 'for_in' : 'for_of',
      test: a.expression,
      once: [a.expression],
      repeated: [a.initializer],
      body: a.statement,
    }
  }
  if (ts.isWhileStatement(a) || ts.isDoStatement(a)) {
    return {
      kind: ts.isWhileStatement(a) ? 'while' : 'do_while',
      test: a.expression,
      once: [],
      repeated: [a.expression],
      body: a.statement,
    }
  }
  return null
}
function dc(a: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(a) ? ts.getDecorators(a) ?? [] : []
}
function bv(
  g: ts.Node, h: 'InjectQueue' | 'Processor' | 'Process',
  f: FileContext, ctx: CollectionState,
): { value: IndexValue; transport: QueueTransport } | null {
  let d: { value: IndexValue; transport: QueueTransport } | null = null
  for (const a of dc(g)) {
    if (!isCall(a.expression)) continue
    const e = a.expression
    if (!e.arguments[0]) continue
    const b = ib(e.expression, f)
    if (b?.i === h
      && ['@nestjs/bull', '@nestjs/bullmq'].includes(b.m)) {
      d = {
        value: rd(e.arguments[0], f, ctx, { c: true }),
        transport: b.m === '@nestjs/bull' ? 'bull' : 'bullmq',
      }
    }
  }
  return d
}
function cnest(g: FileContext, ctx: CollectionState): void {
  for (const e of g.sf.statements) {
    if (!ts.isClassDeclaration(e) || !e.name) continue
    const c = `${g.id}\0${e.name.text}`
    const a = ctx.nq.get(c)
      ?? new Map<string, QueueOrigin>()
    for (const f of e.members) {
      if (!ts.isConstructorDeclaration(f)) continue
      for (const b of f.parameters) {
        if (!isIdentifier(b.name)) continue
        const d = bv(b, 'InjectQueue', g, ctx)
        if (d) {
          a.set(b.name.text, [d.value, d.transport])
        }
      }
    }
    if (a.size > 0) ctx.nq.set(c, a)
  }
}
function nc(d: FileContext, ctx: CollectionState): void {
  for (const j of d.sf.statements) {
    if (!ts.isClassDeclaration(j) || !j.name) continue
    const c = bv(j, 'Processor', d, ctx)
    if (!c) continue
    for (const a of j.members) {
      if (!ts.isMethodDeclaration(a) || !a.name || !isIdentifier(a.name)) continue
      const b = ds(a, d, ctx)
      if (!b) continue
      const job = bv(a, 'Process', d, ctx)
      if (job?.transport === c.transport) {
        const f = ss(c.value)
        const k = ss(job.value)
        if (f && k) {
          const e = ch(ctx, {
            channel_kind: 'queue',
            transport: c.transport,
            key: f,
          })
          const h = ch(ctx, {
            channel_kind: 'job',
            transport: c.transport,
            key: k,
            parent_channel_id: e.id,
          })
          ce(ctx, b.id, h.id, b.id, 'consumed_by', a, d, 'framework-decorator')
          ce(ctx, b.id, h.id, e.id, 'routes_through', a, d, 'framework-decorator')
        }
      } else if (!job && a.name.text === 'process') {
        const g = ss(c.value)
        if (g) {
          const i = ch(ctx, {
            channel_kind: 'queue',
            transport: c.transport,
            key: g,
          })
          ce(ctx, b.id, i.id, b.id, 'consumed_by', a, d, 'framework-decorator')
        }
      }
    }
  }
}
function ep(e: Predicate, h: readonly IndexValue[]): boolean | null {
  const [op, left, right, negated] = e
  const a = sub(left, h)
  if (a.kind !== 'literal') return null
  let c: boolean
  if (op === K.Unknown) c = Boolean(a.value)
  else {
    const b = sub(right!, h)
    if (b.kind !== 'literal') return null
    const g = typeof a.value === typeof b.value
      || a.value === null && b.value === null
    if ([K.EqualsEqualsToken, K.EqualsEqualsEqualsToken].includes(op))
      c = g && a.value === b.value
    else if ([K.ExclamationEqualsToken, K.ExclamationEqualsEqualsToken].includes(op))
      c = !g || a.value !== b.value
    else {
      if (!g || !['number', 'string'].includes(typeof a.value)) return null
      const f = a.value as number | string
      const d = b.value as number | string
      if (op === K.LessThanToken) c = f < d
      else if (op === K.LessThanEqualsToken) c = f <= d
      else if (op === K.GreaterThanToken) c = f > d
      else c = f >= d
    }
  }
  return negated ? !c : c
}
function wp(
  d: string, fx: ExecutionEffect, h: readonly IndexValue[],
  ctx: CollectionState,
): boolean {
  let e = ctx.w.get(d)
  if (!e) {
    e = new Map((ctx.f.get(d) ?? []).map((i) => [i.id, i]))
    ctx.w.set(d, e)
  }
  const ids = ctx.ci.get(fx[5]) ?? []
  return ids.some((id) => {
    const j = e.get(id)
    return j?.kind === 'call'
    && j.control.every((a) => {
      if (a.kind === 'loop' || a.kind === 'parallel') return false
      if (a.kind === 'exception') return a.arm !== 'catch'
      const b = e.get(a.controller_fact_id)
      if (!b || b.kind !== 'condition') return false
      if (!b.test || b.condition_kind === 'switch') return false
      const c = ctx.r.get(a.controller_fact_id)
      const g = c ? ep(c, h) : null
      if (g !== null) {
        if (a.arm === 'nullish') {
          const raw = c![0] === K.Unknown
            ? sub(c![1], h) : null
          return !c![3] && raw?.kind === 'literal' && raw.value === null
        }
        if (a.arm === 'then' || a.arm === 'truthy') return g
        return (a.arm === 'else' || a.arm === 'falsy')
          && !g
      }
      return b.condition_kind === 'guard'
        && ctx.q.get(a.controller_fact_id) === a.arm
    })
  })
}
function da(e: string, d: readonly IndexValue[], ctx: CollectionState): readonly IndexValue[] {
  const a = ctx.p.get(e)
  if (!a || d.length >= a.length) return d
  const b = [...d]
  for (let c = d.length; c < a.length; c += 1)
    b.push(sub(a[c]!, b))
  return b
}
function ee(a: string, ctx: CollectionState, d: number, h: ReadonlySet<string>): ExecutionEffect[] {
  const b = [...(ctx.e.get(a) ?? [])]
  if (b.length > EMAX) { ctx.o.add(a); return [] }
  if (d >= WHOP || h.has(a)) return b
  const f = new Set(h).add(a)
  for (const g of ctx.c.get(a) ?? []) {
    if (f.has(g[0])) continue
    const i = ee(g[0], ctx, d + 1, f), j = da(g[0], g[1], ctx)
    if (ctx.o.has(g[0])) { ctx.o.add(a); return [] }
    for (const fx of i) {
      if (b.length >= EMAX) { ctx.o.add(a); return [] }
      if (!wp(g[0], fx, j, ctx)) continue; b.push(ie(fx, j, g[2]))
    }
  }
  return de(b)
}
function de(c: readonly ExecutionEffect[]): ExecutionEffect[] {
  const b: ExecutionEffect[] = [], d = new Set<string>()
  for (const fx of c) {
    const a = fx[5]
    const key = JSON.stringify([
      ...fx.slice(0, 5),
      a.getSourceFile().fileName,
      a.getStart(a.getSourceFile(), false),
      a.getEnd(),
    ])
    if (fx[0] === 'persistence' || !d.has(key)) b.push(fx)
    d.add(key)
  }
  return b
}
type ChannelDescriptor = Omit<IndexChannelNode, 'id' | 'node_kind'>
function ch(ctx: CollectionState, a: ChannelDescriptor): IndexChannelNode {
  const id = indexChannelId(a)
  const b: IndexChannelNode = { id, node_kind: 'channel', ...a }
  const c = ctx.ch.get(id)
  if (c && JSON.stringify(c) !== JSON.stringify(b))
    throw new Error(`Conflicting execution channel identity ${id}`)
  ctx.ch.set(id, b)
  return b
}
function ce(
  ctx: CollectionState, a: string, h: string, to: string,
  i: Extract<IndexEdge['kind'], 'publishes_to' | 'routes_through' | 'consumed_by'>,
  b: ts.Node, c: FileContext, f: IndexEdge['source'],
  d: Confidence = 'high',
): void {
  const e = ev(b, c.sf, c.id)
  ctx.g.push({
    from: h, to, kind: i, confidence: d, source: f, evidence: e,
    metadata: { execution_owner_id: a },
  })
}
function edgeS(a: IndexFactSource): IndexEdge['source'] {
  return a === 'framework' ? 'framework-decorator' : a
}
function fn(c: ts.Node, ctx: CollectionState, a: ReadonlyMap<string, FileContext>): FileContext | null {
    const b = ctx.i.pathToFileId.get(c.getSourceFile().fileName)
    return b ? a.get(b) ?? null : null
}
function ur(ctx: CollectionState, c: string, fx: ExecutionEffect, b: FileContext): void {
    const a = fx[5];
    const id = `canonical-index.execution.unresolved.${hash([
        c,
        fx[0],
        b.id,
        a.getStart(b.sf, false),
        a.getEnd(),
    ].join(':')).slice(0, 16)}`;
    if (ctx.sd.has(id))
        return;
    ctx.sd.add(id);
    ctx.d.push({
        id,
        level: 'info',
        message: `Dynamic or ambiguous ${fx[0]} identity; unresolved channel parts were omitted`,
        evidence: {
            file_id: b.id,
            range: ro(a, b.sf),
        },
    });
}
function pe(ctx: CollectionState, w: ReadonlyMap<string, FileContext>): void {
  for (const sym of ctx.i.symbols.filter(io)) {
    if (ctx.o.has(sym.id)) continue
    let b = 0
    for (const fx of ee(sym.id, ctx, 0, new Set())) {
      if (ctx.o.has(sym.id)) break
      const [kind, primary, endpoint, qualifier, scope, witness, confidence, source] = fx
      const k = fn(witness, ctx, w)
      if (!k) continue
      const m = (
        C: string,
        F: string,
        A: 'publishes_to' | 'consumed_by' | 'routes_through',
      ): void => ce(
        ctx, sym.id, C, F, A, witness, k,
        edgeS(source), confidence,
      )
      if (kind === 'bull-publish') {
        const n = ss(primary)
        const z = ss(endpoint)
        if (!n) {
          ur(ctx, sym.id, fx, k)
          continue
        }
        const e = ch(ctx, {
          channel_kind: 'queue',
          transport: qualifier,
          key: n,
        })
        if (!z) {
          m(sym.id, e.id, 'publishes_to')
          ur(ctx, sym.id, fx, k)
          continue
        }
        const u = ch(ctx, {
          channel_kind: 'job',
          transport: qualifier,
          key: z,
          parent_channel_id: e.id,
        })
        m(sym.id, u.id, 'publishes_to')
        m(u.id, e.id, 'routes_through')
      } else if (kind === 'bull-consume') {
        const p = ss(primary)
        const g = si(endpoint)
        if (!p || !g || !ctx.y.has(g)) {
          ur(ctx, sym.id, fx, k)
          continue
        }
        const x = ch(ctx, {
          channel_kind: 'queue',
          transport: qualifier,
          key: p,
        })
        m(x.id, g, 'consumed_by')
      } else if (kind === 'event-publish' || kind === 'event-consume') {
        const q = ss(primary)
        const h = kind === 'event-consume' ? si(endpoint!) : null
        if (!q || (kind === 'event-consume'
          && (!h || !ctx.y.has(h)))) {
          ur(ctx, sym.id, fx, k)
          continue
        }
        const l = ch(ctx, {
          channel_kind: 'event',
          transport: qualifier,
          key: q,
          scope,
        })
        if (kind === 'event-publish') {
          m(sym.id, l.id, 'publishes_to')
        } else {
          m(l.id, h!, 'consumed_by')
        }
      } else {
        const a = fx as PersistenceEffect
        const E = a[1]
        const B = a[2]
        const d = a[3]
        const v = ctx.f.get(sym.id) ?? []
        const r = fi(sym.id, witness, ctx)
        const t = [...new Set(ctx.ci.get(witness)
          ?? (r ? [r] : []))]
        for (const j of t) {
          const D = v.find((G) => G.id === j)
          if (!d || D?.kind !== 'call') continue
          af(ctx, {
            ...fb(
              sym.id, 'persistence', witness, k, D.control,
              { c: confidence, s: source, o: ++b },
            ),
            kind: 'persistence',
            operation: E,
            call_fact_id: j,
            ...(B ? { resource: B } : {}),
            receiver_type: d,
          })
        }
      }
    }
  }
}
function fi(d: string, b: ts.Node, ctx: CollectionState): string | null {
    const sf = b.getSourceFile(), a = ro(b, sf)
    return ctx.f.get(d)?.find((c) => c.kind === 'call'
        && c.evidence.range.start.line === a.start.line
        && c.evidence.range.start.column === a.start.column
        && c.evidence.range.end.line === a.end.line
        && c.evidence.range.end.column === a.end.column)?.id ?? null
}
function at(ctx: CollectionState): void {
  for (const a of ctx.i.symbols) {
    if (ctx.o.has(a.id)) {
      ctx.d.push({
        id: `canonical-index.execution.owner-bound.${hash(a.id).slice(0, 16)}`,
        level: 'error', evidence: { file_id: a.file_id, range: a.range }, message: `Execution facts exceeded a per-owner safety bound for ${a.name}; body facts were omitted` })
      continue
    }
    const e = ctx.f.get(a.id); if (!e || e.length === 0) continue
    const k = new Map<string, IndexBodyFact>(); for (const l of e) k.set(l.id, l)
    const j = [...k.values()].sort((m, g) => co(m.order, g.order) || ct(m.id, g.id))
    try {
      const h = encodeIndexBodyFactTable(j), b = decodeIndexBodyFactTable(h, a.id, a.file_id)
      if (!b) throw new Error('execution fact codec rejected its output'); a.body_facts = b
    } catch (n) {
      const c = n instanceof IndexBodyFactBoundsError
      ctx.d.push({
        id: `canonical-index.execution.${c ? 'owner-bound' : 'invalid'}.${hash(a.id).slice(0, 16)}`,
        level: 'error', evidence: { file_id: a.file_id, range: a.range }, message: c
          ? `Execution facts exceeded a per-owner safety bound for ${a.name}; body facts were omitted` : `Invalid execution facts for ${a.name}; body facts were omitted` })
      delete a.body_facts
    }
  }
}
function sort(e: readonly IndexEdge[]): IndexEdge[] {
    const a = new Map<string, IndexEdge>(), c: IndexEdge[] = []
    for (const b of e) {
        if (b.kind !== 'routes_through') {
            c.push(b); continue
        }
        const key = `${b.from}\u0000${b.to}\u0000${b.kind}`
        const d = a.get(key)
        if (!d
            || ct(JSON.stringify(b), JSON.stringify(d)) < 0)
          a.set(key, b)
    }
    return [...c, ...a.values()].sort((g, f) =>
      ct(JSON.stringify(g), JSON.stringify(f)))
}
export function collectExecutionSemantics(h: CollectExecutionInput): CollectExecutionResult {
  const j = new Map(h.symbols.map((k) => [k.id, k]))
  const ctx: CollectionState = {
    i: h, y: j, f: new Map(), o: new Set(),
    e: new Map(), c: new Map(), ci: new Map(), ch: new Map(),
    g: [], d: [], sd: new Set(), u: new Set(), q: new Map(), w: new Map(),
    p: new Map(), r: new Map(), mq: new Map(), em: new Map(),
    nq: new Map(), fs: new Map(),
  }
  const a = new Map<string, FileContext>()
  for (const sf of h.sourceFiles) {
    const b = h.pathToFileId.get(sf.fileName)
    if (!b) continue
    const l: FileContext = {
      sf, id: b, im: im(sf),
      os: os(sf, h.symbolsByFile.get(b) ?? []), v: 0, nv: 1,
    }
    a.set(b, l)
    ctx.fs.set(sf, l)
  }
  prep(ctx)
  for (const t of a.values()) cnest(t, ctx)
  for (const m of a.values()) {
    collect(m, ctx)
    nc(m, ctx)
  }
  pe(ctx, a)
  at(ctx)
  return {
    channels: [...ctx.ch.values()].sort((x, n) =>
      ct(x.id, n.id)),
    edges: sort(ctx.g),
    diagnostics: [...ctx.d].sort((z, s) =>
      ct(z.id, s.id)),
  }
}
