import { createHash } from 'node:crypto'
import ts from 'typescript'
const {
  forEachChild: fc, isArrayLiteralExpression: iA, isArrowFunction: iR,
  isAsExpression: iAs, isAwaitExpression: iAw, isBinaryExpression: iB,
  isBindingElement: iBe, isBlock: iBl, isCallExpression: iC,
  isCaseClause: iK, isClassDeclaration: iCl,
  isConstructorDeclaration: iCd, isDefaultClause: iDc,
  isDeleteExpression: iDe, isElementAccessExpression: iE,
  isEnumMember: iEm, isExpressionStatement: iEs,
  isForInStatement: iFi, isForOfStatement: iFo,
  isForStatement: iFs, isFunctionDeclaration: iFd,
  isFunctionExpression: iF, isFunctionLike: iFl, isIdentifier: iI,
  isIfStatement: iJ, isMethodDeclaration: iMd, isNewExpression: iN,
  isNonNullExpression: iNl, isObjectLiteralExpression: iO,
  isNumericLiteral: iM, isParameter: iP, isPropertyAccessExpression: iX,
  isOmittedExpression: iOm,
  isParenthesizedExpression: iPa, isPostfixUnaryExpression: iPf,
  isPropertyDeclaration: iD, isTypeReferenceNode: iT,
  isPrefixUnaryExpression: iU, isReturnStatement: iRe,
  isShorthandPropertyAssignment: iSh, isStatement: iSt,
  isSatisfiesExpression: iSa, isSourceFile: iSf,
  isSpreadElement: iSp, isStringLiteralLike: iSl,
  isSwitchStatement: iSw, isThrowStatement: iTh,
  isTryStatement: iTr, isTypeNode: iTn,
  isTypeAssertionExpression: iTa, isVariableDeclaration: iV,
  isVoidExpression: iVo, isWhileStatement: iWh,
  isYieldExpression: iYi, isGetAccessorDeclaration: iGa,
  isSetAccessorDeclaration: iSd, isTypeOfExpression: iTy,
  isDoStatement: iDo, isConditionalExpression: iCo,
} = ts
const K = ts.SyntaxKind, NF = ts.NodeFlags, TF = ts.TypeFlags
import {
  decodeIndexBodyFactTable as dt, encodeIndexBodyFactTable as eb,
  INDEX_BODY_FACT_CONTROL_LIMIT as ICL, IndexBodyFactBoundsError as BE,
  indexBodyFactId as bf, indexChannelId as ki,
} from '../../domain/index/model.js'
import type {
  IndexBodyFact, IndexCallFact, IndexChannelNode, IndexControlFrame,
  IndexDiagnostic, IndexEdge, IndexFactEvidence, IndexFactSource,
  IndexChannelTransport, IndexPersistenceOperation, IndexRange, IndexScalarValue,
  IndexSymbol, IndexValue,
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
type CallSite = readonly [targetId: string, arguments: readonly IndexValue[],
  node: EffectWitness, strictArguments: readonly IndexValue[]]
type QueueTransport = Extract<IndexChannelTransport, 'bull' | 'bullmq'>
type QueueOrigin = readonly [key: IndexValue, transport: QueueTransport]
type MapQueueEntry = readonly [key: ts.Expression, file: FileContext, queueKey: ts.Expression, transport: QueueTransport]
type EmitterScope = readonly [scope: string, transport: 'node-event-emitter' | 'nestjs-event-emitter']
type EffectWitness = ts.CallExpression | ts.NewExpression
type BullEffect = readonly [
  kind: 'bull-publish' | 'bull-consume', queue: IndexValue,
  endpoint: IndexValue, transport: QueueTransport, payload: IndexValue | undefined,
  witness: EffectWitness, confidence: Confidence, source: IndexFactSource,
  payloadArgument: number | undefined]
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
  fs: Map<ts.SourceFile, FileContext>; x: Set<ts.SourceFile>
}
const EX = 'expression', AR = 'arguments', IZ = 'initializer',
  DC = 'declarations', VD = 'valueDeclaration', OT = 'operatorToken',
  AX = 'argumentExpression', EL = 'elseStatement', TH = 'thenStatement',
  CB = 'caseBlock', ST = 'statements', PA = 'parameters',
  DD = 'dotDotDotToken', QD = 'questionDotToken', PR = 'parent',
  LN = 'length', CN = 'condition', OP = 'operator', LE = 'elements',
  CL = 'clauses', IC = 'includes', GT = 'getStart',
  TL = 'getTypeAtLocation', BP = 'bull-publish', BC = 'bull-consume',
  EP = 'event-publish', EC = 'event-consume', WS = 'wrapper-summary',
  PU = 'publishes_to', RT = 'routes_through', CY = 'consumed_by',
  FD = 'framework-decorator', PE = 'persistence'
const gs = (a: ts.Node): ts.SourceFile => a.getSourceFile()
const ck = (a: CollectionState): ts.TypeChecker => a.i.checker
const lb = (a: ts.Declaration): boolean => {
  const f = gs(a)
  return f.isDeclarationFile
    && /\/typescript\/lib\/lib\..+\.d\.ts$/u.test(
      f.fileName.replaceAll('\\', '/'))
}
// Internal helpers and local bindings are abbreviated because their emitted
// names count against the protected npm ceiling; public/schema names stay explicit.
const VDEP = 5, VELE = 32
const SBYT = 512, TBYT = 256, bl = Buffer.byteLength, js = JSON.stringify
const WHOP = 2, U0 = void 0
const FMAX = 8_192, EMAX = 8_192
const FSM = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises'])
const FSO = { readFile: 'file_read', readFileSync: 'file_read', opendir: 'file_read', readdir: 'file_read', appendFile: 'file_write', appendFileSync: 'file_write', copyFile: 'file_write', copyFileSync: 'file_write', rename: 'file_write', writeFile: 'file_write', writeFileSync: 'file_write', rm: 'delete', rmSync: 'delete', unlink: 'delete', unlinkSync: 'delete' } as const satisfies Record<string, IndexPersistenceOperation>
const TOO = { find: 'read', findOne: 'read', findOneBy: 'read', findMany: 'read', findUnique: 'read', count: 'read', aggregate: 'read', insert: 'create', save: 'upsert', update: 'update', updateOne: 'update', updateMany: 'update', delete: 'delete', deleteOne: 'delete', deleteMany: 'delete', remove: 'delete', upsert: 'upsert', transaction: 'transaction' } as const satisfies Record<string, IndexPersistenceOperation>
const PRO = { findUnique: 'read', findFirst: 'read', findMany: 'read', count: 'read', aggregate: 'read', groupBy: 'read', create: 'create', createMany: 'create', update: 'update', updateMany: 'update', delete: 'delete', deleteMany: 'delete', upsert: 'upsert', $transaction: 'transaction' } as const satisfies Record<string, IndexPersistenceOperation>
const PMC = { all: 'all_or_first_rejection', allSettled: 'all_settled', any: 'first_fulfilled', race: 'first_settled' } as const
const LFL = new Map<ts.SyntaxKind, readonly [ConditionKind, BranchArm]>([[K.AmpersandAmpersandToken, ['logical_and', 'truthy']], [K.BarBarToken, ['logical_or', 'falsy']], [K.QuestionQuestionToken, ['nullish', 'nullish']]])
const AMU = new Map<string, MutationOperation>([['push', 'append'], ['unshift', 'append'], ['pop', 'remove'], ['shift', 'remove'], ['splice', 'remove']])
const FORD: Readonly<Record<IndexBodyFact['kind'], number>> = { condition: 0, loop: 1, parallel: 2, call: 3, literal: 4, mutation: 5, persistence: 6, return: 7, throw: 8 }
const AOP = new Set<ts.SyntaxKind>([K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.AsteriskAsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken, K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken, K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken, K.QuestionQuestionEqualsToken])
const SEQ = new Set<ts.SyntaxKind>([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken])
const PT = new Set<ts.SyntaxKind>([K.StringKeyword, K.NumberKeyword, K.BooleanKeyword, K.BigIntKeyword, K.SymbolKeyword, K.NullKeyword, K.UndefinedKeyword, K.VoidKeyword])
const COP = new Set<ts.SyntaxKind>([K.EqualsEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsToken, K.ExclamationEqualsEqualsToken, K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken])
const AIM = new Set(['every', 'filter', 'find', 'findIndex', 'flatMap', 'forEach', 'map', 'reduce', 'reduceRight', 'some'])
const SLT = new Set([K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.RegularExpressionLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail])
const SNM = /(?:api[_-]?key|authorization|cookie|credential|database[_-]?url|dsn|jwt|passwd|password|private[_-]?key|secret|token)/i
const SVAL = /^(?:bearer\s+|gh[pousr]_|github_pat_|sk-(?:live|test|proj)-|xox[baprs]-|[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:[^@\s/]+@|eyJ[\w-]+\.[\w-]+\.[\w-]+$)/i
const hash = (a: string): string =>
  createHash('sha256').update(a, 'utf8').digest('hex')
function bd(d: string, b = TBYT): string { if (bl(d) <= b) return d; let c = ''; for (const a of d) { if (bl(c + a) > b) break; c += a } return c }
function st(d: ts.Node, sf: ts.SourceFile): string { const a = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, d.getText(sf)), c: string[] = []; for (let b = a.scan(); b !== K.EndOfFileToken; b = a.scan()) c.push(SLT.has(b) ? '<literal>' : a.getTokenText()); return bd(c.join(' ')) }
const ct = (b: string, a: string): number => b < a ? -1 : b > a ? 1 : 0
function co(d: readonly number[], c: readonly number[]): number { const e = Math.min(d[LN], c[LN]); for (let b = 0; b < e; b += 1) { const a = (d[b] ?? 0) - (c[b] ?? 0); if (a !== 0) return a } return d[LN] - c[LN] }
const ro = (a: ts.Node, sf: ts.SourceFile): IndexRange =>
  rf(sf, a[GT](sf, false), a.getEnd())
function rf(sf: ts.SourceFile, c: number, end: number): IndexRange { const a = sf.getLineAndCharacterOfPosition(c), b = sf.getLineAndCharacterOfPosition(end); return { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } } }
function stmt(b: ts.Node): ts.Node { let a: ts.Node = b; while (a[PR]) { if (iSt(a) || iV(a) || iD(a) || iP(a) || iSf(a[PR])) return a; a = a[PR] } return a }
function sc(b: ts.Node): ts.Node | undefined { let a = b; while (a[PR] && !iBl(a[PR]) && !iSf(a[PR]) && !iK(a[PR]) && !iDc(a[PR])) a = a[PR]; return a[PR] }
function dm(d: ts.Node, u: ts.Node): boolean { if (gs(d) !== gs(u)) return true; const p = sc(d); if (!p) return false; let a = u; while (a[PR] && a[PR] !== p) a = a[PR]; return a[PR] === p && stmt(d).getEnd() <= a[GT](gs(u), false) }
function ev(g: ts.Node, sf: ts.SourceFile, f: string, d: ts.Node = stmt(g),
  c?: OwnerSpan, h?: ts.Node): IndexFactEvidence {
  const a = (h ?? d)[GT](sf, false), b = d.getEnd()
  const e = c ? Math.max(a, c.a) : a, end = c ? Math.min(b, c.b) : b
  return { file_id: f, range: ro(g, sf), statement_range: rf(sf, e, end),
    excerpt_sha256: hash(sf.text.slice(e, end)) }
}
function fo(c: IndexBodyFact['kind'], a: ts.Node, b = 0): readonly number[] { const sf = gs(a); return [a[GT](sf, false), FORD[c], a.getEnd(), b] }
function fb(a: string, g: IndexBodyFact['kind'], h: ts.Node, d: FileContext,
  z: readonly IndexControlFrame[], e: { c?: Confidence; s?: IndexFactSource
    n?: ts.Node; o?: number; a?: ts.Node | undefined } = {}):
  Pick<IndexBodyFact, 'id' | 'owner_symbol_id' | 'order' | 'evidence' | 'control' | 'confidence' | 'source'> {
  const b = d.os.find((j) => j.s.id === a)
  const i = fo(g, h, (e.o ?? 0) + d.v * (EMAX + 1)), f = ev(h, d.sf, d.id, e.n, b, e.a)
  return { id: bf(a, g, i, f.excerpt_sha256), owner_symbol_id: a,
    order: i, evidence: f, control: [...z],
    confidence: e.c ?? 'high', source: e.s ?? 'typescript-syntactic' }
}
type ConditionKind = Extract<IndexBodyFact, { kind: 'condition' }>['condition_kind']
type BranchArm = Extract<IndexControlFrame, { kind: 'branch' }>['arm']
type SwitchProof = readonly [IndexValue, ts.Node | undefined]
type MutationOperation = Extract<IndexBodyFact, { kind: 'mutation' }>['operation']
function ac(h: string, e: ConditionKind, i: ts.Expression, f: FileContext, q0: CollectionState,
  z: readonly IndexControlFrame[], g: ts.Node, p?: SwitchProof): ReturnType<typeof fb> {
  const j = fb(h, 'condition', i, f, z, { n: g, a: p?.[1] })
  let a = uw(i), d = false
  while (iU(a) && a[OP] === K.ExclamationToken) { d = !d; a = uw(a.operand) }
  const b = iB(a) && COP.has(a[OT].kind) ? a : null
  q0.r.set(j.id, b ? [b[OT].kind, rv(b.left, f, q0), rv(b.right, f, q0), d] : [K.Unknown, rv(a, f, q0), U0, d])
  af(q0, { ...j, kind: 'condition', condition_kind: e, test: p?.[0] ?? rv(i, f, q0) })
  return j }
const br = (
  z: readonly IndexControlFrame[], a: string, arm: BranchArm,
): IndexControlFrame[] => [...z, {
  kind: 'branch', controller_fact_id: a, arm,
}]
function sa(a: ts.CaseClause, f: FileContext, c: CollectionState): `case:${string}` {
  const k = sk(a[EX], f, c), v = k ? `case:${Buffer.from(k).toString('base64url')}` : ''
  return k && bl(v) <= 96 ? v as `case:${string}` : `case:${hash(`${a[EX].getText(f.sf)}:${a.pos}`).slice(0, 16)}` }
function sd(a: ts.SwitchStatement, o: string, f: FileContext, c: CollectionState): SwitchProof | undefined {
  let x = uw(a[EX]), q: ts.Node | undefined; const r: string[] = []
  if (iI(x)) {
    const s = sy(x, c), d = s?.[VD]
    if (s && d && !c.u.has(s) && iBe(d) && ts.isObjectBindingPattern(d[PR]) && iV(d[PR][PR]) && !d[DD] && !d[IZ]) {
      const v = d[PR][PR], k = pn((d.propertyName ?? d.name) as ts.PropertyName), n = v[PR][PR]
      const w = k !== null && v[IZ] ? ck(c)[TL](v[IZ]).getProperty(k) : U0
      if (k !== null && !w?.[DC]?.some((e) => iGa(e) || iSd(e))
        && v[IZ] && !!(v[PR].flags & NF.Const) && dm(v, a)) {
        r.unshift(k); x = uw(v[IZ]); q = n
      }
    }
  }
  while (iX(x) && !x[QD] && r[LN] < VDEP) {
    const s = sy(x.name, c)
    if (s?.[DC]?.some((d) => iGa(d) || iSd(d))) return U0
    r.unshift(x.name.text); x = uw(x[EX]) }
  const y = iI(x) ? sy(x, c) : U0
  const ps = y?.[DC]?.filter(iP) ?? [], p = ps[LN] === 1 ? ps[0] : U0
  if (!y || !p || !iP(p) || p[IZ] || p[DD] || !iI(x) || !pu(p, x, c) || pi(p) < 0 || ca(p[PR], f, c)?.id !== o || r[LN] === 0 || r.some((k) => bl(k) > SBYT)) return U0
  const l = a[CB][CL].filter(iK).map((g) => sk(g[EX], f, c))
  if (l.some((k) => !k || bl(`case:${Buffer.from(k).toString('base64url')}`) > 96) || new Set(l).size !== l[LN] || a[CB][CL].filter(iDc)[LN] > 1) return U0
  return [{ kind: 'template',
    parts: [{ kind: 'parameter', position: pi(p) },
      ...r.map((v) => ({ kind: 'literal' as const, value: v })),
    ]}, q]
}
function am(
  g: string, b: ts.Node, k: MutationOperation,
  a: ts.Expression, e: FileContext, q0: CollectionState,
  z: readonly IndexControlFrame[],
  h?: ts.Expression, d = 0,
): void {
  const j = st(a, e.sf), raw = a.getText(e.sf)
  const i = uw(a)
  const key = iE(i) && i[AX] ? rv(i[AX], e, q0) : null
  const f = SNM.test(raw) || key !== null && (key.kind !== 'literal' || typeof key.value === 'string' && SNM.test(key.value))
  af(q0, {
    ...fb(g, 'mutation', b, e, z, { o: d }),
    kind: 'mutation',
    operation: k,
    target: f ? `redacted:${hash(raw).slice(0, 16)}` : bd(j),
    ...(h ? {
      value: rd(h, e, q0, {
        c: true,
        s: f,
      }),
    } : {}),
  })
}
function ai(a: string, c: ts.Node, d: FileContext, q0: CollectionState, z: readonly IndexControlFrame[]): string {
  const b = fb(a, 'loop', c, d, z, { o: 1 }); af(q0, { ...b,
    kind: 'loop', loop_kind: 'array_iteration' }); return b.id }
function af(q0: CollectionState, a: IndexBodyFact): void { if (q0.o.has(a.owner_symbol_id)) return; const b = q0.f.get(a.owner_symbol_id); if (!b) { q0.f.set(a.owner_symbol_id, [a]); return } if (b[LN] >= FMAX) { q0.o.add(a.owner_symbol_id); return } b.push(a) }
function ab<T>(q0: CollectionState, map: Map<string, T[]>, key: string, b: T): void { const a = map.get(key); if (!a) { map.set(key, [b]); return } if (a[LN] >= EMAX) q0.o.add(key); else a.push(b) }
const ae = (q0: CollectionState, a: string, fx: ExecutionEffect): void =>
  ab(q0, q0.e, a, fx)
const al = (q0: CollectionState, b: string, a: CallSite): void =>
  ab(q0, q0.c, b, a)
function io(a: IndexSymbol): boolean {
  if (!['function', 'method', 'constant', 'variable'][IC](a.kind)) return false
  // Execution facts require an authenticated owner span. Framework-only
  // synthetic nodes without declaration/definition ranges remain topology
  // nodes and must not become evidence owners.
  if (!a.declaration_range) return false
  if (a.framework_metadata?.external_call === true) return false
  if (typeof a.framework_metadata?.storage_operation === 'string') return false
  return true }
const oo = (sf: ts.SourceFile, a: IndexRange['start']): number =>
  sf.getPositionOfLineAndCharacter(a.line - 1, a.column - 1)
const os = (sf: ts.SourceFile, c: readonly IndexSymbol[]): OwnerSpan[] =>
  c.filter(io).map((s) => ({ s, a: oo(sf, s.range.start),
    b: oo(sf, s.range.end) })).sort((l, r) =>
    (l.b - l.a) - (r.b - r.a) || l.a - r.a || ct(l.s.id, r.s.id))
function ow(c: ts.Node, d: FileContext): IndexSymbol | null { const f = c[GT](d.sf, false), end = c.getEnd(); return d.os.find((e) => e.a <= f && e.b >= end)?.s ?? null }
function im(sf: ts.SourceFile): ReadonlyMap<string, ImportBinding> {
  const a = new Map<string, ImportBinding>()
  for (const e of sf[ST]) {
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
    for (const c of d[LE]) {
      a.set(c.name.text, {
        i: c.propertyName?.text ?? c.name.text,
        m,
        n: false,
      })
    }
  }
  return a }
function ib(a: ts.Expression, b: FileContext): ImportBinding | null { if (iI(a)) return b.im.get(a.text) ?? null; if (iX(a) && iI(a[EX])) { const ns = b.im.get(a[EX].text); if (ns?.n) return { i: a.name.text, m: ns.m, n: false } } return null }
const ii = (
  d: ts.Expression, e: FileContext, b: readonly string[], c: readonly string[],
): boolean => {
  const a = ib(d, e)
  return a !== null && b[IC](a.m) && c[IC](a.i) }
function fa(a: ts.Symbol | undefined, b: ts.TypeChecker): ts.Symbol | undefined {
  if (!a || (a.flags & ts.SymbolFlags.Alias) === 0) return a
  try {
    return b.getAliasedSymbol(a) } catch {
    return a }
}
const sy = (a: ts.Node, q0: CollectionState): ts.Symbol | undefined =>
  fa(ck(q0).getSymbolAtLocation(a), ck(q0))
function ds(d: ts.Node, e: FileContext, q0: CollectionState): IndexSymbol | null {
  const sf = gs(d), c = q0.i.pathToFileId.get(sf.fileName)
  if (!c) return null
  const g = sf === e.sf ? e.os : os(sf, q0.i.symbolsByFile.get(c) ?? [])
  const h = d[GT](sf, false), end = d.getEnd()
  return g.find((f) => f.a <= h && f.b >= end)?.s ?? null }
function ed(d: ts.Node, e: FileContext, q0: CollectionState): IndexSymbol | null { const c = ds(d, e, q0); if (!c) return null; const sf = gs(d), g = d[GT](sf, false), end = d.getEnd(), h = sf === e.sf ? e.os : os(sf, q0.i.symbolsByFile.get(q0.i.pathToFileId.get(sf.fileName) ?? '') ?? []); return h.some((f) => f.s.id === c.id && f.a === g && f.b === end) ? c : null }
function sb(a: ts.Declaration, q0: CollectionState): boolean { const c = (iV(a) || iD(a)) && iI(a.name) ? a.name : null, b = c ? sy(c, q0) : U0; return !!b && !q0.u.has(b) && (!iV(a) || !!(a[PR].flags & (NF.Let | NF.Const))) }
function sfor(b: ts.Expression, d: FileContext, q0: CollectionState): IndexSymbol | null { const c = sy(iX(b) ? b.name : b, q0); for (const e of c?.[DC] ?? []) { const a = ds(e, d, q0); if (a) return a } return null }
function us(b: ts.Node, q0: CollectionState): boolean { const a = iI(b) ? sy(b, q0) : U0; return !!a && q0.u.has(a) || fc(b, (c) => us(c, q0)) === true }
const iu = (a: ts.Expression, f: FileContext, q0: CollectionState): boolean => {
  const b = ib(a, f); return b ? q0.sd.has(`${b.m}\0${b.i}`) || q0.sd.has(`${b.m}\0*`) : us(a, q0) }
function cs(b: ts.CallExpression | ts.NewExpression, d: FileContext, q0: CollectionState): IndexSymbol | null { if (us(uw(b[EX]), q0)) return null; const c = ck(q0).getResolvedSignature(b)?.getDeclaration(); if (c && !gs(c).isDeclarationFile) { const a = ds(c, d, q0); if (a) return a } return sfor(b[EX], d, q0) }
function ca(a: ts.SignatureDeclaration, c: FileContext, q0: CollectionState): IndexSymbol | null {
  if (iR(a) || iF(a)) {
    const b = a[PR]
    if (iV(b) && b[IZ] === a) { const d = b[PR][PR]
      return ts.isVariableStatement(d) && iSf(d[PR]) ? ds(b, c, q0) : null }
    return iB(b) ? ed(a, c, q0) : null }
  return iFd(a) || iMd(a) || iCd(a) || iGa(a) || iSd(a) ? ed(a, c, q0) : null }
function pi(a: ts.ParameterDeclaration): number {
  const p = a[PR][PA]
  const t = p.filter((b) => iI(b.name) && b.name.text === 'this')
  const r = p.filter((b) => b[DD])
  const n = iI(a.name) ? a.name.text : null
  return t[LN] > 1 || t[LN] === 1 && p[0] !== t[0] || r[LN] > 1 || r[LN] === 1 && p[p[LN] - 1] !== r[0] || n !== null && p.filter((b) => iI(b.name) && b.name.text === n)[LN] !== 1 ? -1 : p.indexOf(a) - t[LN] }
function eo(a: ts.Node, r = false): ts.Node | undefined { let b = a; while (b[PR] && (!iFl(b[PR]) || r && iR(b[PR])) && !iSf(b[PR])) b = b[PR]; return b[PR] }
function dg(a: ts.Node, o: ts.Node | undefined, q0: CollectionState): boolean { if (!iC(a)) return false; const e = uw(a[EX]); if (!iI(e) || e.text !== 'eval') return false; let n: ts.Node | undefined = a; while (n && n !== o) n = n[PR]; const s = sy(e, q0); return n === o && s?.[DC]?.some(lb) === true }
function wa(a: ts.Node, p: (n: ts.Node) => boolean | null): boolean { const r = p(a); return r === null ? fc(a, (n) => wa(n, p)) === true : r }
function pm(a: ts.Node, q0: CollectionState): boolean { const t = ck(q0)[TL](a), q = t.isUnion() ? t.types : [t]; return q.every((v) => !!(v.flags & (TF.StringLike | TF.NumberLike | TF.BooleanLike | TF.BigIntLike | TF.ESSymbolLike | TF.EnumLike | TF.Null | TF.Undefined | TF.Void | TF.Never))) }
function ps(a: ts.Identifier, r: boolean, c: CollectionState, q = false): boolean {
  for (let t: ts.Node | undefined = a[PR]; t
    && !iSt(t) && !iP(t); t = t[PR])
    if (iTn(t)) return true
  let n: ts.Node = a
  while (n[PR] && (iAs(n[PR])
    || iTa(n[PR])
    || iNl(n[PR])
    || iPa(n[PR])
    || iSa(n[PR]))) n = n[PR]
  let v: ts.Node = a
  let b = false
  while (n[PR] && (iX(n[PR]) || iE(n[PR]))
    && n[PR][EX] === n) {
    n = n[PR]; v = n
    b ||= iE(n)
      || sy(n, c)?.[DC]?.some(iGa) === true
    while (n[PR] && (iAs(n[PR])
      || iNl(n[PR])
      || iPa(n[PR]))) n = n[PR]
  }
  if (b || !r && v !== a) return false
  if (pm(v, c)) return true
  const p = n[PR]
  if (q && v !== a && !!p && ts.isPropertyAssignment(p)
    && p[IZ] === n) return true
  return !!p && (iTy(p) || iVo(p)
    || iU(p) && p[OP] === K.ExclamationToken
    || iB(p) && SEQ.has(p[OT].kind)
    || iEs(p)
    || (iJ(p) || iWh(p) || iDo(p)) && p[EX] === n
    || iFs(p) && p[CN] === n
    || iCo(p) && p[CN] === n
    || iSw(p) && p[EX] === n)
}
const pt = (a: ts.ParameterDeclaration): boolean =>
  !!a.type && PT.has(a.type.kind)
function pa(a: ts.ParameterDeclaration, u: ts.Identifier, q0: CollectionState): boolean {
  const l = u[GT](gs(u), false)
  for (const b of a[PR][PA]) {
    if (b === a || pt(a) || pt(b)) continue
    if (!iI(b.name)) return true
    const s = sy(b.name, q0); if (!s) return true
    if (q0.u.has(s)) return true
    const q = (n: ts.Node, w = false): boolean => {
      if (n === b) return false
      if (!w && n[GT](gs(n), false) >= l) {
        return iFd(n) && q(n, true)
      }
      return iI(n) && sy(n, q0) === s && !ps(n, false, q0)
        || fc(n, (c) => q(c, w)) === true
    }
    if (q(a[PR])) return true
  }
  return false
}
function pu(
  a: ts.Declaration, u: ts.Identifier, q0: CollectionState, one = false,
): boolean {
  const o = eo(u)
  if (eo(a) !== o) return false
  if (iP(a) && wa(o!, (n) => iI(n) && n.text === 'arguments'
    && eo(n, true) === o ? true : null)) return false
  if (iP(a) && pa(a, u, q0)) return false
  for (let n: ts.Node | undefined = u[PR]; n && n !== o; n = n[PR]) {
    if (ts.isIterationStatement(n, false)) return false
  }
  const s = sy(u, q0); if (!s || one && q0.u.has(s)) return false
  const sf = gs(u)
  let q: ts.Node = u
  while (q[PR] && !iC(q) && q !== o) q = q[PR]
  const c = iC(q)
  if (c) while (iPa(q[PR]) || iAs(q[PR])
    || iNl(q[PR]) || iSa(q[PR]) || iTa(q[PR])) q = q[PR]
  // After an awaited dispatch settles, only direct property snapshots used as
  // metadata are passive; nested functions can run while arguments are built.
  const z = one && c && iAw(q[PR]) ? stmt(q[PR]).getEnd() : -1
  const bad = (n: ts.Node): boolean => iI(n) && sy(n, q0) === s
  const af = (v: ts.Node): boolean => {
    if (z < 0 || v[GT](sf, false) < z) return false
    for (let n = v[PR]; n && n !== o; n = n[PR])
      if (iFl(n)) return false
    return true
  }
  const sc = (n: ts.Node): boolean => wa(n, (v) => {
    if (v === a || v === u) return false
    if (dg(v, o, q0)) return true
    return bad(v) ? !(one && (ps(v as ts.Identifier, true, q0)
      || af(v) && ps(v as ts.Identifier, true, q0, true))) : null
  })
  if (one) return !sc(sf)
  else {
    const l = u[GT](sf, false)
    const p = (n: ts.Node): boolean => {
      if (n === a || n === u) return false
      if (n[GT](sf, false) >= l) {
        return iFd(n) && sc(n) }
      return dg(n, o, q0) || bad(n)
        || fc(n, p) === true
    }
    return !p(sf)
  }
}
function pv(a: ts.Identifier, d: FileContext, q0: CollectionState, strict = false): IndexValue | null {
  const s = sy(a, q0); if (!s || q0.u.has(s)) return null
  const p = s[DC]?.filter(iP) ?? []
  if (p[LN] !== 1) return null
  const b = p[0]!, c = pi(b)
  if (!b[DD] && iFl(b[PR]) && c >= 0 && eo(b) === eo(a) && (!strict || !b[IZ] && pu(b, a, q0, true)))
    return ca(b[PR], d, q0) ? { kind: 'parameter', position: c } : { kind: 'parameter', position: c, scope: 'iteration' }
  return null }
const red = (a: string): IndexValue => ({
  kind: 'redacted', sha256: hash(a), byte_length: bl(a),
})
function ls(b: string, c = false): IndexValue {
  const a = bl(b)
  if (c || SVAL.test(b) || a > SBYT) {
    return red(b) }
  return lv(b) }
const uk = (
  a: 'dynamic' | 'ambiguous' | 'unsupported' = 'dynamic',
): IndexValue => ({ kind: 'unknown', reason: a })
const uu = (): IndexValue => uk('unsupported')
const lv = (a: IndexScalarValue): IndexValue => ({ kind: 'literal', value: a })
function uw(b: ts.Expression): ts.Expression {
    let a = b
    while (iAs(a) || iTa(a) || iNl(a) || iPa(a) || iSa(a)) {
        a = a[EX]
    }
    return a }
type ValueOptions = { c?: boolean; s?: boolean; p?: boolean; d?: number; n?: ReadonlySet<ts.Node> }
function rd(
  L: ts.Expression, g: FileContext, q0: CollectionState,
  f: ValueOptions = {},
): IndexValue {
  const d = f.d ?? 0
  if (d >= VDEP) return uu()
  const z = new Set(f.n ?? [])
  const a = uw(L)
  if (z.has(a)) return uk('ambiguous')
  z.add(a)
  const b = (I: ts.Expression, J: Partial<ValueOptions> = {}): IndexValue =>
    rd(I, g, q0, { ...f, ...J, d: d + 1, n: z })
      if (iSl(a)) return ls(a.text, f.s)
  if (iM(a)) {
    const A = Number(a.text)
    return Number.isFinite(A) && !Object.is(A, -0) ? lv(A) : uu() }
  if (a.kind === K.TrueKeyword) return lv(true)
  if (a.kind === K.FalseKeyword) return lv(false)
  if (a.kind === K.NullKeyword) return lv(null)
  if (iU(a) && iM(a.operand)) {
    const B = Number(a.operand.text)
    const q = a[OP] === K.MinusToken ? -B : B
    if ((a[OP] === K.MinusToken || a[OP] === K.PlusToken) && Number.isFinite(q) && !Object.is(q, -0)) {
      return lv(q) }
  }
  if (iU(a) && a[OP] === K.ExclamationToken) {
    const C = b(a.operand, { c: true })
    if (C.kind === 'literal') return lv(!Boolean(C.value))
  }
  if (iI(a)) {
    const j = pv(a, g, q0, f.p)
    if (j) return j
    const u = sy(a, q0)
    const k = u?.[VD]
      ?? u?.[DC]?.find((t) => iV(t))
    if (
      f.c && k && iV(k) && sb(k, q0) && k[IZ] && dm(k, a) && (!f.p || pu(k, a, q0, true))
    ) {
      return b(k[IZ], {
        s: f.s || SNM.test(a.text),
      })
    }
    if (f.p && k && (iP(k) || iV(k))) return uk()
    const r = k ? ds(k, g, q0) : sfor(a, g, q0)
    return r ? { kind: 'symbol', symbol_id: r.id } : uk() }
  if (iA(a)) {
    if (a[LE][LN] > VELE) return uu()
    const y: IndexValue[] = []
    for (const l of a[LE]) {
      if (iSp(l) || iOm(l)) return uu()
      y.push(b(l, { c: true }))
    }
    return { kind: 'array', elements: y } }
  if (iO(a)) {
    if (a.properties[LN] > VELE) return uu()
    const m = new Map<string, IndexValue>()
    for (const e of a.properties) {
      if (ts.isPropertyAssignment(e)) {
        const key = pn(e.name)
        if (key === null || key === '__proto__'
          || key[IC]('\0') || bl(key) > SBYT) {
          return uu() }
        m.set(
          key,
          b(e[IZ], {
            c: true,
            s: f.s || SNM.test(key),
          }), )
      } else if (iSh(e)) {
        const key = e.name.text
        if (bl(key) > SBYT) {
          return uu() }
        m.set(
          key,
          b(e.name, {
            c: true,
            s: f.s || SNM.test(key),
          }), )
      } else {
        return uu() }
    }
    return {
      kind: 'object',
      entries: [...m].map(([key, value]) => ({ key, value })),
    }
  }
  if (ts.isNoSubstitutionTemplateLiteral(a)) return ls(a.text, f.s)
  if (ts.isTemplateExpression(a)) {
    if (1 + (2 * a.templateSpans[LN]) > VELE) {
      return uu() }
    const D: IndexValue[] = [ls(a.head.text, f.s)]
    for (const H of a.templateSpans) {
      D.push(b(H[EX], { c: true }))
      D.push(ls(H.literal.text, f.s))
    }
    return { kind: 'template', parts: D } }
  if (iC(a) && iX(a[EX])) {
    const v = a[EX].name.text
    const p = a[EX][EX]
    if (v === 'slice') {
      const E = b(p, { c: true })
      if (E.kind !== 'array') return uk()
      const F = ni(a[AR][0], g, q0)
      const end = ni(a[AR][1], g, q0)
      if (F === null || (a[AR][1] && end === null)) return uk()
      return { kind: 'array', elements: E[LE].slice(F, end ?? U0) } }
    if (v === 'map') {
      return b(p, { c: false }) }
  }
  if (iX(a) || iE(a)) {
    const w = sy(a, q0)?.[DC]?.find(iEm)
    const o = w && !us(a, q0) && dm(w[PR], a) ? ck(q0).getConstantValue(w) : U0
    if (typeof o === 'string') return ls(o, f.s)
    if (typeof o === 'number' && Number.isFinite(o) && !Object.is(o, -0))
      return lv(o) }
  if (iE(a)) {
    const h = b(a[EX], { c: true })
    const G = a[AX] ? ni(a[AX], g, q0) : null
    if (h.kind === 'array' && G !== null) {
      return h[LE][G] ?? uk() }
  }
  const x = sfor(a, g, q0)
  return x ? { kind: 'symbol', symbol_id: x.id } : uk() }
const rv = (
  a: ts.Expression, b: FileContext, c: CollectionState,
): IndexValue => rd(a, b, c, { c: true })
function pn(a: ts.PropertyName): string | null {
  if (iI(a) || iSl(a) || iM(a)) {
    return a.text }
  return null }
function ni(b: ts.Expression | undefined, d: FileContext, q0: CollectionState): number | null {
  if (!b) return 0
  const a = rv(b, d, q0)
  return a.kind === 'literal' && typeof a.value === 'number' && Number.isSafeInteger(a.value) ? a.value : null }
function ss(a: IndexValue): string | null {
  if (a.kind === 'literal' && typeof a.value === 'string') {
    return a.value[LN] > 0 && bl(a.value) <= TBYT ? a.value : null }
  if (a.kind !== 'template') return null
  let b = ''
  for (const c of a.parts) {
    if (c.kind !== 'literal' || !['string', 'number', 'boolean'][IC](typeof c.value)) return null
    b += String(c.value)
  }
  return b[LN] > 0 && bl(b) <= TBYT ? b : null }
const si = (a: IndexValue): string | null =>
  a.kind === 'symbol' ? a.symbol_id : null
function mv(a: IndexValue, d: number, b?: (g: number) => IndexValue): IndexValue {
  if (a.kind === 'parameter' && a.scope !== 'iteration' && b) return mv(b(a.position), d)
  if (a.kind === 'array') {
    if (d >= VDEP && a[LE][LN] > 0) return uu(); return {
      kind: 'array', elements: a[LE].map((e) => mv(e, d + 1, b)) }
  }
  if (a.kind === 'object') {
    if (d >= VDEP && a.entries[LN] > 0) return uu(); return {
      kind: 'object', entries: a.entries.map((c) => ({ key: c.key, value: mv(c.value, d + 1, b) })) }
  }
  if (a.kind === 'template') {
    if (d >= VDEP && a.parts[LN] > 0) return uu(); return {
      kind: 'template', parts: a.parts.map((f) => mv(f, d + 1, b)) }
  }
  return a }
const sub = (b: IndexValue, c: readonly IndexValue[]): IndexValue =>
  mv(b, 0, (a) => c[a] ?? uk())
const kn = (a: IndexValue): boolean =>
  a.kind !== 'unknown'
  && (a.kind !== 'array' || a[LE].every(kn))
  && (a.kind !== 'object' || a.entries.every((e) => kn(e.value)))
  && (a.kind !== 'template' || a.parts.every(kn))
function ie(fx: ExecutionEffect, b: readonly IndexValue[], s: readonly IndexValue[],
  a: EffectWitness): ExecutionEffect {
  switch (fx[0]) {
    case BP: {
      const p = fx[4], n = p?.kind === 'parameter' && p.scope !== 'iteration' && p.position < s[LN] ? p.position : U0
      const q = p ? sub(p, s) : U0, r = p ? sub(p, b) : U0
      const m = n !== U0
        && !(a[AR] ?? []).slice(0, n + 1).some(iSp)
      return [BP, sub(fx[1], b), sub(fx[2], b), fx[3],
        q, a, fx[6], WS,
        m && q && r && kn(q) && js(q) === js(r) ? n : U0]
    }
    case BC: return [BC, sub(fx[1], b),
      sub(fx[2], s), fx[3], U0, a, fx[6], WS, U0]
    case EP: return [fx[0], sub(fx[1], b), U0, fx[3], fx[4], a, fx[6], WS]
    case EC: return [fx[0], sub(fx[1], b), sub(fx[2]!, b), fx[3], fx[4], a, fx[6], WS]
    case PE: return [fx[0], fx[1], fx[2] ? sub(fx[2], b) : U0, fx[3], U0, a, fx[6], WS]
  }
}
function cn(a: ts.CallExpression | ts.NewExpression): string {
  const sf = gs(a)
  const b = st(a[EX], sf)
  return bd(iN(a) ? `new ${b}` : b) }
function th(b: ts.CallExpression | ts.NewExpression, q0: CollectionState): boolean {
  try {
    const a = ck(q0).getResolvedSignature(b)
    const d = a && ck(q0).getReturnTypeOfSignature(a)
    const c = d?.getProperty('then')
    return !!c && ck(q0).getTypeOfSymbolAtLocation(c, b).getCallSignatures()[LN] > 0 } catch { return false }
}
function sch(b: ts.CallExpression | ts.NewExpression, q0: CollectionState): IndexCallFact['scheduling'] {
    let a: ts.Node = b
    while (iPa(a[PR]) || iAs(a[PR]) || iNl(a[PR])) {
        a = a[PR]
    }
    if (iAw(a[PR])) return 'awaited'
    if ((iVo(a[PR]) || iEs(a[PR])) && th(b, q0))
      return 'fire_and_forget'
    return 'sync' }
function iar(b: ts.Expression, q0: CollectionState): boolean {
  try {
    const a = ck(q0)[TL](b)
    return ck(q0).isArrayType(a) || ck(q0).isTupleType(a) } catch { return false }
}
function cf(
  b: ts.CallExpression | ts.NewExpression, s0: IndexSymbol,
  e: FileContext, q0: CollectionState,
  z: readonly IndexControlFrame[],
): IndexCallFact {
  const a = cs(b, e, q0)
  const h = (b[AR] ?? []).map((g) => {
    const d = uw(g)
    return iR(d) || iF(d) ? hv(d, e, q0) : rd(d, e, q0, {
          c: true,
          s: SNM.test(d.getText(e.sf)),
        })
  })
  const f: IndexCallFact = {
    ...fb(s0.id, 'call', b, e, z, {
      c: a ? 'high' : 'medium',
      s: a ? 'typescript-semantic' : 'typescript-syntactic',
    }),
    kind: 'call',
    callee: cn(b),
    ...(a ? { target_symbol_id: a.id } : {}),
    arguments: h,
    scheduling: sch(b, q0),
  }
  af(q0, f)
  const ids = q0.ci.get(b)
  if (ids) ids.push(f.id); else q0.ci.set(b, [f.id])
  if (a && !ids) {
    const k = (b[AR] ?? []).map((g, i) => {
      const d = uw(g)
      return iR(d) || iF(d) ? hv(d, e, q0, true) : rd(d, e, q0, { c: true, p: true }) })
    al(q0, s0.id, [a.id, f[AR], b, k])
  }
  return f }
function rty(a: ts.Expression, q0: CollectionState): string {
  try {
    return bd(
      ck(q0).typeToString(
        ck(q0)[TL](a),
        U0,
        ts.TypeFormatFlags.NoTruncation,
      ).replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/gu, '<literal>'), )
  } catch {
    return '' }
}
function ti(e: ts.Expression, f: FileContext, q0: CollectionState): ImportBinding | null {
    for (const c of sy(e, q0)?.[DC] ?? []) {
        const a = iP(c) || iD(c) || iV(c) ? c.type : U0
        if (!a) continue
        const d = iT(a) ? (ts.isQualifiedName(a.typeName) ? a.typeName.left : a.typeName) : null
        if (d && iI(d)) {
            const b = f.im.get(d.text)
            if (b) return b
        }
    }
    return null }
const bt = (a: ImportBinding | null): QueueTransport | null =>
  !a || !['bull', 'bullmq'][IC](a.m)
    || !['Queue', 'default'][IC](a.i) ? null : a.m as QueueTransport
const cx = (sf: ts.SourceFile, q0: CollectionState): FileContext | null =>
  q0.fs.get(sf) ?? null
function xs(b: ts.Expression, q0: CollectionState): ts.Symbol | undefined {
  const a = uw(b)
  return sy(iX(a) ? a.name : a, q0) }
function eq(d: ts.Expression, c: ts.Expression, q0: CollectionState): boolean {
  const a = uw(d), b = uw(c)
  if (iSl(a) && iSl(b)) {
    return a.text === b.text }
  if (iI(a) && iI(b)) return sy(a, q0) === sy(b, q0)
  if (iX(a) && iX(b)) {
    return a.name.text === b.name.text && xs(a.name, q0) === xs(b.name, q0) && (a[EX].kind === K.ThisKeyword && b[EX].kind === K.ThisKeyword || eq(a[EX], b[EX], q0)) }
  return false }
function qc(f: ts.Expression, q0: CollectionState, e: ReadonlySet<ts.Node> = new Set()): readonly [ts.Expression, FileContext, QueueTransport] | null {
  const a = uw(f)
  if (e.has(a)) return null
  const g = new Set(e).add(a)
  const d = cx(gs(a), q0)
  if (!d) return null
  if (iN(a) && a[AR]?.[0]) {
    const k = uw(a[EX]), b = iu(k, d, q0) ? null : bt(ib(a[EX], d))
    return b ? [a[AR][0], d, b] : null }
  if (!iI(a)) return null
  const c = sy(a, q0)?.[VD]
  return c && iV(c) && sb(c, q0) && c[IZ] ? qc(c[IZ], q0, g) : null }
function xe(a: ts.Statement, b: FileContext, q0: CollectionState): boolean {
  if (iBl(a)) return a[ST].some((f) => xe(f, b, q0))
  if (iJ(a)) {
    const e = rv(a[EX], b, q0)
    if (e.kind === 'literal') {
      const d = Boolean(e.value) ? a[TH] : a[EL]
      return !!d && xe(d, b, q0) }}
  return ex(a, b, q0) }
function rr(
  b: ts.Statement, j: ts.MethodDeclaration | ts.ConstructorDeclaration,
  e: FileContext, q0: CollectionState,
): boolean {
  let d: ts.Node = b, a = b[PR]
  while (a !== j) {
    if (iBl(a)) {
      const f = a[ST].indexOf(d as ts.Statement)
      if (f >= 0 && a[ST].slice(0, f) .some((l) => xe(l, e, q0))) return false
    } else if (iJ(a)) {
      const g = rv(a[EX], e, q0)
      if (g.kind !== 'literal' || Boolean(g.value) !== (d === a[TH])) return false
    } else if ((iWh(a) || iFs(a)) && a.statement === d) {
      const k = iWh(a) ? a[EX] : a[CN]
      const h = k ? rv(k, e, q0) : null
      if (h?.kind === 'literal' && !Boolean(h.value)) return false
    } else if (iFo(a) && a.statement === d) {
      const i = rv(a[EX], e, q0)
      if (i.kind !== 'array' || i[LE][LN] === 0) return false
    }
    d = a
    a = a[PR]
  }
  return true }
function xr(j: ts.CallExpression, f: FileContext, q0: CollectionState): boolean {
  const b = stmt(j)
  if (!iEs(b)) return false
  if (iSf(b[PR])) return true
  if (iBl(b[PR]) && iCd(b[PR][PR])) return rr(
      b, b[PR][PR], f, q0)
  let a: ts.Node = b[PR]
  while (!iSf(a) && !iMd(a)) {
    if (iFl(a)) return false
    a = a[PR]
  }
  if (!iMd(a) || !iI(a.name) || a.name.text !== 'onModuleInit' || !ts.isClassLike(a[PR])) return false
  const h = dc(a[PR]).some((c) => {
    const k = iC(c[EX]) ? c[EX][EX] : c[EX]
    const d = ib(k, f)
    return d?.m === '@nestjs/common' && ['Controller', 'Injectable', 'Module'][IC](d.i) })
  return h && rr(b, a, f, q0) && a[PR].heritageClauses?.some((g) =>
      g.token === K.ImplementsKeyword && g.types.some((l) => {
        const e = ib(l[EX], f)
        return e?.m === '@nestjs/common' && e.i === 'OnModuleInit' })) === true
}
function prep(q0: CollectionState): void {
  const s: Array<readonly [ts.Symbol, ts.Expression, ts.Expression]> = []
  const t = new Set<ts.Symbol>()
  const add = (d: ts.Symbol): void => {
    if (t.has(d)) return
    t.add(d); q0.u.add(d)
    let b: ts.Node | undefined = d[VD]
    const z = b && iBe(b) ? b : null
    if (z)
      while (b && !iV(b)) b = b[PR]
    const f = b && iV(b) && b[IZ] ? uw(b[IZ]) : null
    if (f && (iI(f) || iX(f) || iE(f) || iO(f) || iA(f))) {
      const p = z && !z[DD] && z[PR][PR] === b ? z.propertyName ?? z.name : null
      const x = iI(f) ? cx(gs(f), q0) : null, n = x ? ib(f, x) : null
      if (n?.n && p && (iI(p) || iSl(p))) q0.sd.add(`${n.m}\0${p.text}`)
      else g(f)
    }
  }
  const g = (l: ts.Node): void => {
    if (iI(l) || iX(l)) {
      const f = cx(gs(l), q0), b = f ? ib(l as ts.Expression, f) : null
      if (b) { q0.sd.add(`${b.m}\0${b.i}`); if (iX(l)) return }
    }
    if (iSh(l)) {
      const h = ck(q0).getShorthandAssignmentValueSymbol(l)
      if (h) add(fa(h, ck(q0)) ?? h)
    }
    if (iI(l)) {
      const o = sy(l, q0)
      if (o) add(o)
    }
    fc(l, g)
  }
  const j = (q: ts.Node): void => g(iE(q) ? q[EX] : q)
  for (const sf of q0.i.sourceFiles) {
    if (q0.x.has(sf)) continue
    const r = (a: ts.Node): void => {
      if (iB(a) && AOP.has(a[OT].kind)) {
        j(a.left); const c = uw(a.right)
        if (a[OT].kind === K.EqualsToken && (iI(c) || iX(c) || iE(c) || iO(c) || iA(c))) g(c)
      } else if ((iU(a) || iPf(a)) && [K.PlusPlusToken, K.MinusMinusToken][IC](a[OP]))
        j(a.operand)
      else if (iDe(a)) j(a[EX])
      else if ((iFi(a) || iFo(a)) && !ts.isVariableDeclarationList(a[IZ])) j(a[IZ])
      if (iC(a) && iX(a[EX])) {
        const e = a[EX].name.text, o = a[EX][EX]
        const lib = iI(o) && sy(o, q0)?.[DC]?.some(lb)
        if (lib && a[AR][0] && (o.text === 'Object'
          && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'][IC](e)
          || o.text === 'Reflect'
          && ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'][IC](e)))
          g(a[AR][0])
        if (AMU.has(e) || ['clear', 'delete', 'copyWithin', 'fill', 'reverse', 'sort'][IC](e)) {
          g(a[EX][EX])
        } else if (e === 'set' && a[AR][0] && a[AR][1] && xr(a, cx(gs(a), q0)!, q0)) {
          const p = xs(a[EX][EX], q0)
          if (p) s.push([p, a[AR][0], a[AR][1]])
        }
      }
      fc(a, r)
    }
    r(sf)
  }
  for (const [symbol, key, value] of s) {
    const m = q0.mq.get(symbol) ?? []
    const n = qc(value, q0)
    const w = cx(gs(key), q0)
    m.push(n && w ? [key, w, n[0], n[2]] : null)
    q0.mq.set(symbol, m)
  }
}
function sm(b: ts.Declaration, q0: CollectionState): boolean {
  try {
    const a = ck(q0)[TL](b).getSymbol()
    return a?.name === 'Map' && !!a[DC]?.some(lb)
  } catch { return false }
}
function mq(map: ts.Expression, key: ts.Expression, k: FileContext, q0: CollectionState): QueueOrigin | null {
  const a = xs(map, q0)
  const g = a?.[VD]
  if (!a || !g || !(iV(g) || iD(g)) || !sb(g, q0) || !sm(g, q0)) return null
  const b = q0.mq.get(a) ?? []
  if (b[LN] === 0 || b.some((l) => !l)) return null
  const f = b as MapQueueEntry[]
  const i = ss(rv(key, k, q0))
  if (i) {
    const h = f.filter(([a, b]) => ss(rv(a, b, q0)) === i)
    if (h[LN]) {
      const d = h.map(([, f, q, t]) => [rv(q, f, q0), t] as const)
      const m = js(d[0])
      return d.every((j) => js(j) === m) ? d[0]! : null }
  }
  const e = f[0]![3]
  return f.every(([a, , b, c]) =>
    c === e && eq(a, b, q0)) ? [rv(key, k, q0), e] : null
}
function qo(n: ts.Expression, s0: IndexSymbol, l: FileContext, q0: CollectionState, m: ReadonlySet<ts.Node> = new Set()): QueueOrigin | null {
  const a = uw(n); if (m.has(a)) return null
  const d = new Set(m).add(a)
  if (iN(a) && a[AR]?.[0]) {
    const k = uw(a[EX]), b = iu(k, l, q0) ? null : bt(ib(a[EX], l))
    if (b) return [rv(a[AR][0], l, q0), b]
  }
  if (iI(a)) {
    const e = sy(a, q0)?.[VD]
    if (e && iV(e) && sb(e, q0) && e[IZ]) {
      const f = cx(gs(e), q0); return f ? qo(e[IZ], s0, f, q0, d) : null
    }
  }
  if (iX(a) && a[EX].kind === K.ThisKeyword) {
    const j = sy(a.name, q0), k = s0.kind === 'method' ? s0.name.slice(0, s0.name.lastIndexOf('.')) : s0.name
    const g = q0.nq.get(`${s0.file_id}\0${k}`)?.get(a.name.text)
    if (g && j && !q0.u.has(j)) return g
    const h = j?.[VD]
    if (h && iD(h) && sb(h, q0) && h[IZ]) {
      const i = cx(gs(h), q0); if (i) return qo(h[IZ], s0, i, q0, d)
    }
  }
  if (iC(a) && iX(a[EX]) && a[EX].name.text === 'get' && a[AR][0])
    return mq(a[EX][EX], a[AR][0], l, q0)
  return null }
function es(j: ts.Expression, s0: IndexSymbol, l: FileContext, q0: CollectionState, g: ReadonlySet<ts.Node> = new Set()): EmitterScope | null {
  const e = uw(j); if (g.has(e)) return null
  g = new Set(g).add(e)
  if (iI(e)) {
    const c = sy(e, q0)?.[VD]
    if (c) {
      const a = cx(gs(c), q0), b = a ? `${a.id}:${c[GT](a.sf, false)}` : null
      const f = b ? q0.em.get(b) : U0
      if (f) return f
      if (iV(c) && sb(c, q0) && c[IZ] && iN(uw(c[IZ]))) {
        const k = uw(c[IZ]) as ts.NewExpression; if (!a) return null
        const d = iu(uw(k[EX]), a, q0) ? null : et(k[EX], a)
        if (d) {
          const h = b!, i: EmitterScope = [h, d]; q0.em.set(h, i); return i
        }
      }
    }
  }
  return null }
const et = (
  a: ts.Expression, b: FileContext,
): 'node-event-emitter' | 'nestjs-event-emitter' | null =>
  ii(a, b, ['node:events', 'events'], ['EventEmitter'])
    ? 'node-event-emitter'
    : ii(a, b, ['@nestjs/event-emitter'], ['EventEmitter2'])
      ? 'nestjs-event-emitter' : null
function hc(a: ts.NewExpression, q0: CollectionState): boolean {
  const b = uw(a[EX]), s = iI(b) || iX(b) ? sy(b, q0) : U0
  return !!s && !q0.u.has(s) && s[DC]?.some(iCl) === true
}
function hr(
  a: ts.Expression, q0: CollectionState,
  n: ReadonlySet<ts.Node> = new Set(),
): boolean {
  const b = uw(a)
  if (n.has(b) || us(b, q0)) return false
  const seen = new Set(n).add(b)
  if (b.kind === K.ThisKeyword) return true
  if (iN(b)) return false
  if (iI(b)) {
    const d = sy(b, q0)?.[VD]
    if (d && iV(d) && d[IZ]) {
      const f = cx(gs(d), q0)
      const x = uw(d[IZ])
      return !!f && sb(d, q0)
        && (iN(x) ? hc(x, q0) : hr(x, q0, seen))
    }
  } else if (iX(b) || iE(b)) {
    if (b[QD] || iE(b)
      && (!b[AX] || !iSl(uw(b[AX])))
      || sy(b, q0)?.[DC]?.some(iGa))
      return false
    if (!hr(b[EX], q0, seen)) return false
  } else return false
  const t = ck(q0)[TL](b)
  if (t.isUnion() || t.flags & (TF.Any | TF.Unknown | TF.TypeParameter))
    return false
  return t.getSymbol()?.[DC]?.some(ts.isClassDeclaration) === true
}
function ht(a: ts.CallExpression, g: FileContext, q0: CollectionState): IndexValue {
  const b = uw(a[EX]), s = sy(b, q0), q = cs(a, g, q0)
  if (!s || !q || us(b, q0)) return uk()
  const ok = iI(b)
    ? s[DC]?.some((v) => iFd(v) || iMd(v))
    : (iX(b) || iE(b)) && s[DC]?.some(iMd)
      && hr(b[EX], q0)
  return ok ? { kind: 'symbol', symbol_id: q.id } : uk()
}
function hs(a: ts.Expression, q0: CollectionState): boolean {
  const b = uw(a)
  if (iI(b)) return !!sy(b, q0)
  if (iSl(b) || iM(b) || [
    K.TrueKeyword, K.FalseKeyword, K.NullKeyword,
  ][IC](b.kind)) return true
  if (iTy(b) && iI(uw(b[EX]))) return true
  if (iVo(b) && iI(uw(b[EX])))
    return !!sy(uw(b[EX]), q0)
  return iB(b) && SEQ.has(b[OT].kind)
    && hs(b.left, q0) && hs(b.right, q0)
}
function hv(h: ts.Expression, g: FileContext, q0: CollectionState, r = false): IndexValue {
  const d = uw(h)
  if (iR(d) || iF(d)) {
    const p = d[PA].find((e) => pi(e) === 0), n = p && iI(p.name) ? p.name : null
    if (r) {
      if (!p || !n || p[IZ] || p[DD]) return uk()
      let v: IndexValue | undefined
      for (const s of iBl(d.body) ? d.body[ST] : [d.body]) {
        let e = ts.isExpression(s) ? s
          : (iEs(s) || iRe(s)) && s[EX] ? s[EX] : U0
        if (!e) continue
        e = uw(e); while (iAw(e) || iVo(e)) e = uw(e[EX])
        if (!iC(e) || e[QD] || !e[AR][0]) continue
        let x = uw(e[AR][0])
        while (iX(x) && !x[QD] || iE(x) && !x[QD] && x[AX] && iSl(uw(x[AX]))) x = uw(x[EX])
        const a = ht(e, g, q0)
        if ((a.kind === 'symbol' || a.kind === 'parameter') && iI(x)
          && sy(x, q0) === sy(n, q0) && pu(p, x, q0, true)
          && e[AR].slice(1).every((y) => !iSp(y) && hs(y, q0))) {
          if (v) return uk(); v = a
        }
      }
      return v ?? uk()
    }
    let b: ts.Node | undefined = d.body
    if (iBl(b)) b = b[ST][LN] === 1 ? b[ST][0] : U0
    if (b && (iRe(b) || iEs(b))) b = b[EX]
    if (!b || !ts.isExpression(b)) return uk()
    let e = uw(b)
    while (iAw(e) || iVo(e)) e = uw(e[EX])
    if (!iC(e) || e[QD]) return uk()
    let k = uw(e[EX])
    while (iX(k) || iE(k)) {
      if (k[QD] || iE(k)
        && (!k[AX] || !iSl(uw(k[AX]))))
        return uk()
      k = uw(k[EX])
    }
    if (!iI(k) && k.kind !== K.ThisKeyword) return uk()
    const a = ht(e, g, q0)
    if (a.kind !== 'symbol' && a.kind !== 'parameter') return uk()
    const safe = e[AR].every((y) => !iSp(y) && hs(y, q0))
    return safe ? a : uk()
  }
  return rd(d, g, q0, { c: false }) }
type PersistenceSummary = readonly [operation: IndexPersistenceOperation, resource: IndexValue | undefined, receiverType: string]
const se = (
  a: IndexPersistenceOperation | null, b: string,
  d: ts.Expression | undefined, e: FileContext, q0: CollectionState,
): PersistenceSummary | null => a ? [a, d ? rv(d, e, q0) : U0, b] : null
function po(f: ts.CallExpression, c: FileContext, q0: CollectionState): PersistenceSummary | null {
  const k = f[EX]
  if (iI(k)) {
    const d = c.im.get(k.text); if (d && FSM.has(d.m))
      return se(fsop(d.i, f[AR][1], c, q0), `${d.m}:${d.i}`, f[AR][0], c, q0) }
  if (!iX(k)) return null
  const g = k.name.text, b = k[EX], s = li(b)
  const ns = s ? c.im.get(s.text) : U0
  if (ns?.n && FSM.has(ns.m)) {
    const l = se(fsop(g, f[AR][1], c, q0), `${ns.m}:namespace`, f[AR][0], c, q0); if (l) return l
  }
  const q = rty(b, q0), a = ti(b, c, q0)
  if (a?.m === 'typeorm' && ['Repository', 'MongoRepository'][IC](a.i)) {
    const o = se(ty(g), q || `${a.m}:${a.i}`, f[AR][0], c, q0); if (o) return o
  }
  if (pd(b, q0, '/node_modules/@prisma/client/', '/node_modules/.prisma/client/')) {
    const p = se(pr(g), q || 'PrismaClient', f[AR][0], c, q0); if (p) return p
  }
  if (g !== 'send' || !(a?.m === '@aws-sdk/client-s3' && a.i === 'S3Client' || pd(b, q0, '/node_modules/@aws-sdk/client-s3/'))) return null
  const h = f[AR][0]
  if (h && iN(uw(h))) {
    const e = uw(h) as ts.NewExpression, j = ib(e[EX], c)
    if (j?.m === '@aws-sdk/client-s3') {
      const r = ['PutObjectCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand'], t = ['GetObjectCommand', 'HeadObjectCommand']
      return se(r[IC](j.i) ? 'object_write' : t[IC](j.i) ? 'object_read' : null, q, e[AR]?.[0], c, q0) }
  }
  return null }
function li(b: ts.Expression): ts.Identifier | null {
  let a = b
  while (iX(a)) a = a[EX]
  return iI(a) ? a : null }
function pd(h: ts.Expression, q0: CollectionState, ...b: readonly string[]): boolean {
    const d = ck(q0)
    let a: ts.Expression = h
    while (true) {
        try {
            const g = d[TL](a)
            const e = [g.aliasSymbol, g.getSymbol()]
            if (e.some((f) => f?.[DC]?.some((j) => {
                const k = gs(j).fileName.replaceAll('\\', '/')
                return b.some((c) => k[IC](c)) }))) return true
        } catch { return false }
        if (!iX(a)) return false
        a = a[EX]
    }
}
const no = (
  b: string, a: Readonly<Record<string, IndexPersistenceOperation>>,
): IndexPersistenceOperation | null => Object.hasOwn(a, b) ? a[b]! : null
function fsop(
  b: string, d: ts.Expression | undefined, e: FileContext, q0: CollectionState,
): IndexPersistenceOperation | null {
  if (!['open', 'openSync'][IC](b)) return no(b, FSO)
  if (!d) return null
  const a = ss(rv(d, e, q0))
  if (!a) return null
  if (a[IC]('+') || /^[aw]/u.test(a)) return 'file_write'
  return /^r(?:s|sr)?$/u.test(a) ? 'file_read' : null }
const ty = (a: string): IndexPersistenceOperation | null =>
  no(a, TOO)
const pr = (a: string): IndexPersistenceOperation | null =>
  no(a, PRO)
function bi(a: ts.Expression, q0: CollectionState): 0 | 1 | -1 {
  const c = ck(q0), t = c[TL](a), s = c.getStringType()
  const one = (v: ts.Type): 0 | 1 | -1 => {
    if (v.flags & (TF.Any | TF.Unknown | TF.TypeParameter | TF.Never))
      return -1
    if (c.isTypeAssignableTo(v, s)) return 1
    return c.isTypeAssignableTo(s, v) ? -1 : 0
  }
  const q = t.isUnion() ? t.types.map(one) : [one(t)]
  return q.every((v) => v === q[0]) ? q[0]! : -1 }
function re(a: ts.CallExpression | ts.NewExpression, s0: IndexSymbol, d: FileContext, q0: CollectionState): void {
  if ((q0.ci.get(a)?.[LN] ?? 0) > 1) return
  const f = [a, 'high', 'framework'] as const
  if (iN(a)) {
    if (!iu(uw(a[EX]), d, q0)
      && ii(a[EX], d, ['bullmq'], ['Worker'])
      && a[AR]?.[0] && a[AR][1])
      ae(q0, s0.id, [BC, rv(a[AR][0], d, q0),
        hv(a[AR][1], d, q0, true), 'bullmq', U0, ...f, U0])
    return }
  if (iX(a[EX])) {
    const h = a[EX].name.text, g = a[EX][EX]
    if (h === 'add' && a[AR][0]) {
      const i = qo(g, s0, d, q0)
      if (i) {
        const n = i[1] === 'bull' ? bi(a[AR][0], q0) : 1
        const l = n >= 0 && !a[AR].slice(0, n + 1)
          .some(iSp)
        const x = l ? a[AR][n] : U0
        const p = x && !iSp(x)
          ? rd(x, d, q0, { c: true, p: true }) : U0
        const v = x && !iSp(x) ? rv(x, d, q0) : U0
        ae(q0, s0.id, [BP, i[0],
          n === 1 && !iSp(a[AR][0])
            ? rv(a[AR][0], d, q0) : uk(),
          i[1], p, ...f,
          p && v && kn(p) && js(p) === js(v) ? n : U0])
      }
    }
    const b = es(g, s0, d, q0)
    if (b && h === 'emit' && a[AR][0])
      ae(q0, s0.id, [EP, rv(a[AR][0], d, q0), U0, b[1], b[0], ...f])
    else if (b && ['addListener', 'on', 'once', 'prependListener'][IC](h) && a[AR][0] && a[AR][1])
      ae(q0, s0.id, [EC, rv(a[AR][0], d, q0), hv(a[AR][1], d, q0), b[1], b[0], ...f])
  }
  const e = po(a, d, q0); if (e) ae(q0, s0.id, [PE, ...e, U0, ...f])
}
function pc(b: ts.CallExpression, q0: CollectionState): readonly [
  'all' | 'allSettled' | 'any' | 'race',
  'all_or_first_rejection' | 'all_settled' | 'first_fulfilled' | 'first_settled',
] | null {
    if (!iX(b[EX]) || !iI(b[EX][EX]) || b[EX][EX].text !== 'Promise') return null
    const c = sy(b[EX][EX], q0)
    if (!c?.[DC]?.some(lb))
        return null
    const a = b[EX].name.text
    return Object.hasOwn(PMC, a) ? [a as keyof typeof PMC,
        PMC[a as keyof typeof PMC]] : null
}
function pl(c: ts.Expression | undefined): readonly ts.Expression[] | null {
    if (!c) return null
    const b = uw(c);
    if (!iA(b) || b[LE][LN] > VELE || b[LE].some((a) =>
        iOm(a) || iSp(a))) return null
    return [...b[LE]] as ts.Expression[] }
function mi(b: ts.Expression | undefined, e: FileContext, q0: CollectionState): readonly [
  ts.CallExpression, IndexValue, ts.Expression,
] | null {
    if (!b) return null
    const a = uw(b)
    if (!iC(a) || !iX(a[EX]) || a[EX].name.text !== 'map') return null
    const d = rv(a[EX][EX], e, q0)
    return d.kind === 'array' ? [a, d, a[EX][EX]] : null }
function eu(a: ts.EnumDeclaration, u: ts.Identifier, q0: CollectionState): boolean {
  const s = sy(u, q0); if (!s || q0.u.has(s)) return false
  const r: ts.Node = gs(u)
  let ok = true
  const visit = (x: ts.Node): void => {
    if (!ok || x === a || x === u) return
    if (iI(x) && sy(x, q0) === s) {
      let p: ts.Node = x
      while (p[PR] && p[PR] !== r && !iK(p[PR]) && !iTn(p[PR])) p = p[PR]
      if (!iTn(p[PR]) && (!iK(p[PR]) || p[PR][EX] !== p)) {
        ok = false
        return }
    }
    fc(x, visit)
  }
  visit(r)
  return ok }
function sk(
  f: ts.Expression, g?: FileContext, q0?: CollectionState,
): string | null {
  const b = uw(f)
  if (q0 && (iX(b) || iE(b))) {
    const e = sy(b, q0)?.[DC]?.find(iEm), r = li(b)
    if (e && r && ts.isEnumDeclaration(e[PR])) {
      const d = e[PR], s = sy(d.name, q0)
      const m = ck(q0).getSymbolAtLocation(gs(d))
      const x = gs(d).isDeclarationFile || d.modifiers?.some((v) => [
          K.ExportKeyword, K.DefaultKeyword, K.DeclareKeyword,
        ][IC](v.kind)) || !!s && !!m?.exports && [...m.exports.values()].some((v) => fa(v, ck(q0)) === s)
      if (x || gs(e) !== gs(b) || !dm(e[PR], b) || !eu(e[PR], r, q0)) return null
      const a = ck(q0).getConstantValue(e)
      const n = pn(e.name)
      if (typeof a === 'string' && (SVAL.test(a)
        || SNM.test(d.name.text) || n !== null && SNM.test(n))) return null
      if (typeof a === 'string' || typeof a === 'number' && Number.isFinite(a))
        return js([typeof a, typeof a === 'number' && Object.is(a, -0) ? 0 : a])
      return null }
  }
  const d = g && q0 ? rv(f, g, q0) : null
  if (d?.kind === 'literal')
    return js([typeof d.value, d.value])
  if (iU(b) && iM(b.operand) && [K.PlusToken, K.MinusToken][IC](b[OP]) && Number(b.operand.text) === 0) return js(['number', 0])
  return null }
const XN = 1, XT = 2, XO = 4, XB = 8, XC = 16
function xl(
  a: ts.Statement, d?: FileContext, q0?: CollectionState,
): number {
  const b = xp(a, d, q0)
  return b & (XT | XO) | (b & XB ? XN : 0)
}
function xt(
  a: ts.Expression, d?: FileContext, q0?: CollectionState,
): boolean | null {
  const c = uw(a)
  if (c.kind === K.TrueKeyword) return true
  if (c.kind === K.FalseKeyword) return false
  if (!d || !q0) return null
  if (iB(c) && SEQ.has(c[OT].kind)) {
    const p = ep([
      c[OT].kind, rv(c.left, d, q0), rv(c.right, d, q0), false,
    ], [])
    if (p !== null) return p
  }
  const b = rv(a, d, q0)
  return b.kind === 'literal' ? Boolean(b.value)
    : b.kind === 'object' || b.kind === 'array' ? true : null
}
function xq(
  b: readonly ts.Statement[], d?: FileContext,
  q0?: CollectionState, a = XN,
): number {
  for (const c of b) {
    if (!(a & XN)) break
    a = a & ~XN | xp(c, d, q0)
  }
  return a }
function xp(
  a: ts.Statement, d?: FileContext, q0?: CollectionState,
): number {
  if (iRe(a)) return XO
  if (ts.isContinueStatement(a)) return XC
  if (ts.isBreakStatement(a)) return a.label ? XO : XB
  if (iTh(a)) return XT
  if (iBl(a)) return xq(a[ST], d, q0)
  if (iJ(a)) {
    const b = xt(a[EX], d, q0)
    if (b !== null) return b
      ? xp(a[TH], d, q0)
      : a[EL] ? xp(a[EL], d, q0) : XN
    return xp(a[TH], d, q0)
      | (a[EL] ? xp(a[EL], d, q0) : XN)
  }
  if (iDo(a)) {
    const b = xp(a.statement, d, q0), q = xt(a[EX], d, q0)
    return b & (XT | XO) | (b & XB ? XN : 0)
      | (q !== true && b & (XN | XC) ? XN : 0)
  }
  if (iWh(a) || iFs(a)) {
    const q = iWh(a) ? xt(a[EX], d, q0)
      : a[CN] ? xt(a[CN], d, q0) : true
    if (q === false) return XN
    const b = xl(a.statement, d, q0)
    return q === true ? b : XN | b & (XT | XO)
  }
  if (iSw(a)) {
    let f = a[CB][CL].some(iDc) ? 0 : XN
    const j = new Set<string>()
    for (let e = 0; e < a[CB][CL][LN]; e += 1) {
      const g = a[CB][CL][e]!
      if (iK(g)) {
        const key = sk(g[EX], d, q0)
        if (key && j.has(key)) continue
        if (key) j.add(key)
      }
      let b = XN
      for (let h = e;
        h < a[CB][CL][LN] && b & XN;
        h += 1) {
        b = xq(a[CB][CL][h]![ST], d, q0, b)
      }
      if (b & XB) b = b & ~XB | XN
      f |= b
    }
    return f }
  if (iTr(a)) {
    let c = xp(a.tryBlock, d, q0)
    if (a.catchClause && c & XT)
      c = c & ~XT | xp(a.catchClause.block, d, q0)
    if (a.finallyBlock) {
      const i = xp(a.finallyBlock, d, q0)
      c = (i & XN ? c : 0) | i & ~XN
    }
    return c }
  return XN }
const ex = (
  a: ts.Statement, b?: FileContext, q0?: CollectionState,
): boolean => !(xp(a, b, q0) & XN)
const sx = (a: ts.Node): boolean =>
  iC(a) || iN(a) || iB(a) && AOP.has(a[OT].kind)
  || (iU(a) || iPf(a))
    && [K.PlusPlusToken, K.MinusMinusToken][IC](a[OP])
  || iDe(a) || ts.isTaggedTemplateExpression(a)
  || iAw(a) || iYi(a) || fc(a, sx) === true
function gc(
  c: ts.IfStatement, d?: FileContext, q0?: CollectionState,
): BranchArm | 'unreachable' | null {
  const t = xt(c[EX], d, q0)
  if (t !== null) {
    const s = t ? c[TH] : c[EL]
    return s && ex(s, d, q0) ? 'unreachable' : null
  }
  const a = ex(c[TH], d, q0)
  const b = c[EL] ? ex(c[EL], d, q0) : false
  if (a && b) return 'unreachable'
  if (a) return 'else'
  return b ? 'then' : null }
function tv(b: ts.VariableDeclaration, s0: IndexSymbol, d: FileContext, q0: CollectionState): IndexValue | null {
    if (!b[IZ] || b[PR][PR][PR] !== d.sf) return null
    const a = rd(b[IZ], d, q0, {
        c: true,
        s: iI(b.name) && SNM.test(b.name.text),
    });
    if (a.kind === 'unknown' || a.kind === 'symbol' || a.kind === 'parameter') return null
    if (a.kind === 'literal' && typeof a.value === 'string' && a.value[LN] === 0) return null
    return s0.id === ds(b, d, q0)?.id ? a : null; }
function collect(b: FileContext, q0: CollectionState): void {
  const d = (
    a: ts.Node,
    z: readonly IndexControlFrame[],
    i = false,
  ): void => {
    if (ts.isDecorator(a)) return
    const s0 = ow(a, b)
    if (iFl(a)) {
      const t = ca(a, b, q0)
      if (t?.id !== s0?.id && !i) return
      if (t?.id === s0?.id && s0 && !q0.p.has(s0.id)) {
        q0.p.set(s0.id, a[PA].filter((j) => pi(j) >= 0).map((j) =>
          j[IZ] ? rv(j[IZ], b, q0) : uk()))
      }
    }
    if (s0 && z[LN] > ICL) {
      q0.o.add(s0.id)
      return }
    if (s0 && iBl(a)) {
      let e = z
      for (const w of a[ST]) {
        d(w, e)
        if (!iJ(w)) {
          if (ex(w, b, q0)) break
          continue
        }
        const u = gc(w, b, q0)
        if (u === 'unreachable') break
        if (u) {
          const T = fb(
            s0.id,
            'condition',
            w[EX],
            b,
            e,
            { n: w }, )
          q0.q.set(T.id, u)
          e = br(e, T.id, u)
        }
      }
      return }
    if (s0 && iV(a) && iI(a.name)) {
      const Z = tv(a, s0, b, q0)
      if (Z) {
        af(q0, {
          ...fb(s0.id, 'literal', a[IZ]!, b, z, {
            n: stmt(a),
          }),
          kind: 'literal',
          value: Z,
          role: 'initializer',
        })
      }
    }
    if (s0 && iJ(a)) {
      const u = gc(a, b, q0)
      const U = ac(
        s0.id, u ? 'guard' : 'if',
        a[EX], b, q0, z, a, )
      d(a[EX], z)
      const t = xt(a[EX], b, q0)
      if (t !== false) d(a[TH], br(z, U.id, 'then'))
      if (t !== true && a[EL]) {
        d(a[EL], br(z, U.id, 'else'))
      }
      return }
    if (s0 && iSw(a)) {
      if (a[CB][CL][LN] > VELE || a[CB][CL].some((H) =>
          iK(H) && sx(H[EX]))) {
        q0.o.add(s0.id)
        return }
      const $c = ac(
        s0.id, 'switch', a[EX], b, q0, z, a,
        sd(a, s0.id, b, q0), )
      d(a[EX], z)
      let ft: IndexControlFrame[][] = []
      const iv = b.v
      const k = new Set<string>()
      for (const g of a[CB][CL]) {
        const arm = iDc(g) ? 'default' as const : sa(g, b, q0)
        if (iK(g)) d(g[EX], z)
        let I = true
        if (iK(g)) {
          const key = sk(g[EX], b, q0)
          if (key) {
            I = !k.has(key)
            k.add(key)
          }
        }
        const $ = [...(I ? [br(z, $c.id, arm)] : []), ...ft]
        const V: IndexControlFrame[][] = []
        for (const [path, entry] of $.entries()) {
          b.v = path === 0 ? iv : b.nv++
          let q = entry, O = true
          for (const x of g[ST]) {
            d(x, q)
            if (!iJ(x)) {
              if (ex(x, b, q0)) { O = false; break }
              continue
            }
            const u = gc(x, b, q0)
            if (u === 'unreachable') { O = false; break }
            if (u) q = br(
              q, fb(
                s0.id, 'condition', x[EX], b, q,
                { n: x },
              ).id, u, )
          }
          if (O) V.push(q)
          if (q0.o.has(s0.id)) break
        }
        b.v = iv
        ft = V
        if (q0.o.has(s0.id)) break
      }
      return }
    if (s0 && iCo(a)) {
      const W = ac(
        s0.id, 'ternary', a[CN], b, q0, z, stmt(a), )
      d(a[CN], z)
      d(a.whenTrue, br(z, W.id, 'truthy'))
      d(a.whenFalse, br(z, W.id, 'falsy'))
      return }
    const l = iB(a) ? LFL.get(a[OT].kind) : U0
    if (s0 && iB(a) && l) {
      const $d = ac(
        s0.id, l[0], a.left, b, q0, z, stmt(a), )
      d(a.left, z)
      d(a.right, br(z, $d.id, l[1]))
      return }
        const s = ld(a)
        if (s0 && s) {
          const X = fb(s0.id, 'loop', a, b, z)
      const r = [...z, {
        kind: 'loop' as const,
        controller_fact_id: X.id,
      }]
      af(q0, {
        ...X,
        kind: 'loop',
            loop_kind: s[0],
            ...(s[1] ? { test: rv(s[1], b, q0) } : {}),
          })
          for (const _ of s[2]) d(_, z)
          for (const L of s[3]) d(L, r)
          d(s[4], r)
      return }
    if (s0 && iTr(a)) {
      d(a.tryBlock, [...z, { kind: 'exception', arm: 'try' }])
      if (a.catchClause) {
        d(a.catchClause, [...z, { kind: 'exception', arm: 'catch' }])
      }
      if (a.finallyBlock) {
        d(a.finallyBlock, [...z, { kind: 'exception', arm: 'finally' }])
      }
      return }
    if (s0 && iRe(a)) {
      af(q0, {
        ...fb(s0.id, 'return', a, b, z),
        kind: 'return',
        ...(a[EX] ? { value: rv(a[EX], b, q0) } : {}),
      })
      if (a[EX]) d(a[EX], z)
      return }
    if (s0 && iTh(a)) {
      af(q0, {
        ...fb(s0.id, 'throw', a, b, z),
        kind: 'throw',
        value: rv(a[EX], b, q0),
      })
      d(a[EX], z)
      return }
    if (s0 && iB(a) && AOP.has(a[OT].kind)) {
      am(s0.id, a, 'assign', a.left, b, q0, z, a.right)
    } else if (
      s0 && (iU(a) || iPf(a)) && [K.PlusPlusToken, K.MinusMinusToken][IC](a[OP])
    ) {
      am(
        s0.id, a,
        a[OP] === K.PlusPlusToken ? 'increment' : 'decrement',
        a.operand, b, q0, z, )
    } else if (s0 && iDe(a)) {
      am(s0.id, a, 'delete', a[EX], b, q0, z)
    }
    if (s0 && (iC(a) || iN(a))) {
      cf(a, s0, b, q0, z)
      re(a, s0, b, q0)
      if (iC(a)) {
        const G = pc(a, q0)
        if (G) {
          const h = mi(a[AR][0], b, q0)
          const E = h ? null : pl(a[AR][0])
          const F = h?.[1] ?? (E ? rv(a[AR][0]!, b, q0) : null)
          if (!F || F.kind !== 'array' || (E && E[LN] !== F[LE][LN])) {
            for (const M of a[AR]) d(M, z)
            return }
          const J = fb(s0.id, 'parallel', a, b, z)
          const Q = q0.f.get(s0.id)?.[LN] ?? 0
          if (h) {
            cf(h[0], s0, b, q0, z)
            re(h[0], s0, b, q0)
            const R = ai(s0.id, h[0], b, q0, z)
            d(h[2], z)
            for (const y of h[0][AR]) {
              const A = uw(y)
              const B = iR(A) || iF(A)
              d(
                y,
                B ? [
                      ...z,
                      { kind: 'loop', controller_fact_id: R },
                      {
                        kind: 'parallel',
                        controller_fact_id: J.id,
                        lane: 'each',
                      },
                    ] : z,
                B, )
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
          const ids = (q0.f.get(s0.id) ?? []) .slice(Q) .filter((Y) => Y.kind === 'call' && Y.control.some((P) =>
                P.kind === 'parallel' && P.controller_fact_id === J.id)) .map(($e) => $e.id)
          af(q0, {
            ...J,
            kind: 'parallel',
            combinator: G[0],
            completion: G[1],
            lane_count: F[LE][LN],
            input: F,
            member_fact_ids: ids,
          })
          return }
        if (
          iX(a[EX]) && AIM.has(a[EX].name.text)
        ) {
          const $a = rd(
            a[EX][EX],
            b,
            q0,
            { c: true }, )
          d(a[EX][EX], z)
          if ($a.kind !== 'array') {
            for (const N of a[AR]) d(N, z)
            return }
          const S = ai(s0.id, a, b, q0, z)
          for (const C of a[AR]) {
            const D = uw(C)
            d(C, [...z, {
              kind: 'loop',
              controller_fact_id: S,
            }], iR(D) || iF(D))
          }
          return }
        const m = iX(a[EX]) ? AMU.get(a[EX].name.text) : U0
        if (m && iX(a[EX]) && iar(a[EX][EX], q0)) {
          am(
            s0.id, a, m, a[EX][EX], b, q0,
            z, m === 'append' ? a[AR][0] : U0, 1, )
        }
      }
    }
    fc(a, ($b) => d($b, z))
  }
  d(b.sf, [])
}
function ld(a: ts.Node): readonly [
  'for' | 'for_in' | 'for_of' | 'while' | 'do_while',
  ts.Expression | undefined, readonly ts.Node[], readonly ts.Node[], ts.Statement,
] | null {
  if (iFs(a)) {
    const c: ts.Node[] = []
    const b: ts.Node[] = []
    if (a[IZ]) c.push(a[IZ])
    if (a[CN]) b.push(a[CN])
    if (a.incrementor) b.push(a.incrementor)
    return ['for', a[CN], c, b, a.statement]
  }
  if (iFi(a) || iFo(a)) {
    return [iFi(a) ? 'for_in' : 'for_of', a[EX], [a[EX]], [a[IZ]], a.statement]
  }
  if (iWh(a) || iDo(a)) {
    return [iWh(a) ? 'while' : 'do_while', a[EX], [], [a[EX]], a.statement]
  }
  return null }
const dc = (a: ts.Node): readonly ts.Decorator[] =>
  ts.canHaveDecorators(a) ? ts.getDecorators(a) ?? [] : []
function bv(
  g: ts.Node, h: 'InjectQueue' | 'Processor' | 'Process',
  f: FileContext, q0: CollectionState,
): readonly [IndexValue, QueueTransport] | null {
  let d: readonly [IndexValue, QueueTransport] | null = null
  for (const a of dc(g)) {
    if (!iC(a[EX])) continue
    const e = a[EX]
    if (!e[AR][0]) continue
    const b = ib(e[EX], f)
    if (!iu(uw(e[EX]), f, q0) && b?.i === h
      && ['@nestjs/bull', '@nestjs/bullmq'][IC](b.m)) {
      d = [rv(e[AR][0], f, q0),
        b.m === '@nestjs/bull' ? 'bull' : 'bullmq']
    }
  }
  return d }
function cnest(g: FileContext, q0: CollectionState): void {
  for (const e of g.sf[ST]) {
    if (!iCl(e) || !e.name) continue
    const c = `${g.id}\0${e.name.text}`
    const a = q0.nq.get(c)
      ?? new Map<string, QueueOrigin>()
    for (const f of e.members) {
      if (!iCd(f)) continue
      for (const b of f[PA]) {
        if (!iI(b.name)) continue
        const d = bv(b, 'InjectQueue', g, q0)
        const t = b.type && iT(b.type)
          ? ts.isQualifiedName(b.type.typeName)
            ? b.type.typeName.left : b.type.typeName
          : null
        if (t && iu(t as ts.Expression, g, q0)) continue
        if (d) a.set(b.name.text, d)
      }
    }
    if (a.size > 0) q0.nq.set(c, a)
  }
}
function nc(d: FileContext, q0: CollectionState): void {
  for (const j of d.sf[ST]) {
    if (!iCl(j) || !j.name) continue
    const c = bv(j, 'Processor', d, q0)
    if (!c) continue
    for (const a of j.members) {
      if (!iMd(a) || !a.name || !iI(a.name)) continue
      const b = ds(a, d, q0)
      if (!b) continue
      const job = bv(a, 'Process', d, q0)
      if (job?.[1] === c[1]) {
        const f = ss(c[0])
        const k = ss(job[0])
        if (f && k) {
          const e = ch(q0, {
            channel_kind: 'queue',
            transport: c[1],
            key: f,
          })
          const h = ch(q0, {
            channel_kind: 'job',
            transport: c[1],
            key: k,
            parent_channel_id: e.id,
          })
          ce(q0, b.id, h.id, b.id, CY, a, d, FD)
          ce(q0, b.id, h.id, e.id, RT, a, d, FD)
        }
      } else if (!job && a.name.text === 'process') {
        const g = ss(c[0])
        if (g) {
          const i = ch(q0, {
            channel_kind: 'queue',
            transport: c[1],
            key: g,
          })
          ce(q0, b.id, i.id, b.id, CY, a, d, FD)
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
    const g = typeof a.value === typeof b.value || a.value === null && b.value === null
    if ([K.EqualsEqualsToken, K.EqualsEqualsEqualsToken][IC](op))
      c = g && a.value === b.value
    else if ([K.ExclamationEqualsToken, K.ExclamationEqualsEqualsToken][IC](op))
      c = !g || a.value !== b.value
    else {
      if (!g || !['number', 'string'][IC](typeof a.value)) return null
      const f = a.value as number | string
      const d = b.value as number | string
      if (op === K.LessThanToken) c = f < d
      else if (op === K.LessThanEqualsToken) c = f <= d
      else if (op === K.GreaterThanToken) c = f > d
      else c = f >= d
    }
  }
  return negated ? !c : c }
function wp(
  d: string, fx: ExecutionEffect, h: readonly IndexValue[],
  q0: CollectionState,
): boolean {
  let e = q0.w.get(d)
  if (!e) {
    e = new Map((q0.f.get(d) ?? []).map((i) => [i.id, i]))
    q0.w.set(d, e)
  }
  const ids = q0.ci.get(fx[5]) ?? []
  return ids.some((id) => {
    const j = e.get(id)
    return j?.kind === 'call' && j.control.every((a) => {
      if (a.kind === 'loop' || a.kind === 'parallel') return false
      if (a.kind === 'exception') return a.arm !== 'catch'
      const b = e.get(a.controller_fact_id)
      if (!b || b.kind !== 'condition') return false
      if (!b.test || b.condition_kind === 'switch') return false
      const c = q0.r.get(a.controller_fact_id)
      const g = c ? ep(c, h) : null
      if (g !== null) {
        if (a.arm === 'nullish') {
          const raw = c![0] === K.Unknown ? sub(c![1], h) : null
          return !c![3] && raw?.kind === 'literal' && raw.value === null }
        if (a.arm === 'then' || a.arm === 'truthy') return g
        return (a.arm === 'else' || a.arm === 'falsy') && !g }
      return b.condition_kind === 'guard' && q0.q.get(a.controller_fact_id) === a.arm })
  })
}
function da(e: string, d: readonly IndexValue[], q0: CollectionState): readonly IndexValue[] {
  const a = q0.p.get(e)
  if (!a || d[LN] >= a[LN]) return d
  const b = [...d]
  for (let c = d[LN]; c < a[LN]; c += 1)
    b.push(sub(a[c]!, b))
  return b }
function ms(a: readonly IndexValue[], b: EffectWitness): readonly IndexValue[] {
  const i = (b[AR] ?? []).findIndex(iSp)
  return i < 0 ? a : a.map((v, n) => n < i ? v : uk('ambiguous')) }
function ee(a: string, q0: CollectionState, d: number, h: ReadonlySet<string>): ExecutionEffect[] {
  const b = [...(q0.e.get(a) ?? [])]
  if (b[LN] > EMAX) { q0.o.add(a); return [] }
  if (d >= WHOP || h.has(a)) return b
  const f = new Set(h).add(a)
  for (const g of q0.c.get(a) ?? []) {
    if (f.has(g[0])) continue
    const i = ee(g[0], q0, d + 1, f)
    if (q0.o.has(g[0])) { q0.o.add(a); return [] }
    for (const fx of i) {
      if (b[LN] >= EMAX) { q0.o.add(a); return [] }
      const j = ms(da(g[0], g[1], q0), g[2])
      const k = ms(da(g[0], g[3], q0), g[2])
      if (!wp(g[0], fx, j, q0)) continue; b.push(ie(fx, j, k, g[2]))
    }
  }
  return de(b) }
function de(c: readonly ExecutionEffect[]): ExecutionEffect[] {
  const b: ExecutionEffect[] = [], d = new Set<string>()
  for (const fx of c) {
    const a = fx[5]
    const key = js([
      ...fx.slice(0, 5),
      gs(a).fileName,
      a[GT](gs(a), false),
      a.getEnd(),
    ])
    if (fx[0] === PE || !d.has(key)) b.push(fx)
    d.add(key)
  }
  return b }
type ChannelDescriptor = Omit<IndexChannelNode, 'id' | 'node_kind'>
function ch(q0: CollectionState, a: ChannelDescriptor): IndexChannelNode {
  const id = ki(a)
  const b: IndexChannelNode = { id, node_kind: 'channel', ...a }
  const c = q0.ch.get(id)
  if (c && js(c) !== js(b))
    throw new Error(`Conflicting execution channel identity ${id}`)
  q0.ch.set(id, b)
  return b }
function ce(
  q0: CollectionState, a: string, h: string, to: string,
  i: Extract<IndexEdge['kind'], 'publishes_to' | 'routes_through' | 'consumed_by'>,
  b: ts.Node, c: FileContext, f: IndexEdge['source'],
  d: Confidence = 'high', p?: number,
): void {
  const e = ev(b, c.sf, c.id)
  q0.g.push({
    from: h, to, kind: i, confidence: d, source: f, evidence: e,
    metadata: {
      execution_owner_id: a,
      ...(p === U0 ? {} : { dispatch_payload_argument: p }),
    },
  })
}
const edgeS = (a: IndexFactSource): IndexEdge['source'] =>
  a === 'framework' ? FD : a
function fn(c: ts.Node, q0: CollectionState, a: ReadonlyMap<string, FileContext>): FileContext | null {
    const b = q0.i.pathToFileId.get(gs(c).fileName)
    return b ? a.get(b) ?? null : null }
function ur(q0: CollectionState, c: string, fx: ExecutionEffect, b: FileContext): void {
    const a = fx[5];
    const id = `canonical-index.execution.unresolved.${hash([
        c,
        fx[0],
        b.id,
        a[GT](b.sf, false),
        a.getEnd(),
    ].join(':')).slice(0, 16)}`;
    if (q0.sd.has(id))
        return;
    q0.sd.add(id);
    q0.d.push({
        id,
        level: 'info',
        message: `Dynamic or ambiguous ${fx[0]} identity; unresolved channel parts were omitted`,
        evidence: {
            file_id: b.id,
            range: ro(a, b.sf),
        },
    });
}
function pe(q0: CollectionState, w: ReadonlyMap<string, FileContext>): void {
  for (const s0 of q0.i.symbols.filter(io)) {
    if (q0.o.has(s0.id)) continue
    let b = 0
    for (const fx of ee(s0.id, q0, 0, new Set())) {
      if (q0.o.has(s0.id)) break
      const [a, c, d, e, f, g, h, i] = fx
      const k = fn(g, q0, w)
      if (!k) continue
      const m = (
        C: string,
        F: string,
        A: 'publishes_to' | 'consumed_by' | 'routes_through',
        P?: number,
      ): void => ce(
        q0, s0.id, C, F, A, g, k,
        edgeS(i), h, P, )
      if (a === BP) {
        const n = ss(c)
        const z = ss(d)
        const p = (q0.ci.get(g)?.[LN] ?? 0) === 1 ? fx[8] : U0
        if (!n) {
          ur(q0, s0.id, fx, k)
          continue
        }
        const q = ch(q0, {
          channel_kind: 'queue',
          transport: e,
          key: n,
        })
        if (!z) {
          m(s0.id, q.id, PU, p)
          ur(q0, s0.id, fx, k)
          continue
        }
        const u = ch(q0, {
          channel_kind: 'job',
          transport: e,
          key: z,
          parent_channel_id: q.id,
        })
        m(s0.id, u.id, PU, p)
        m(u.id, q.id, RT)
      } else if (a === BC) {
        const p = ss(c)
        const n = si(d)
        if (!p || !n || !q0.y.has(n)) {
          ur(q0, s0.id, fx, k)
          continue
        }
        const x = ch(q0, {
          channel_kind: 'queue',
          transport: e,
          key: p,
        })
        m(x.id, n, CY)
      } else if (a === EP || a === EC) {
        const q = ss(c)
        const n = a === EC ? si(d!) : null
        if (!q || (a === EC && (!n || !q0.y.has(n)))) {
          ur(q0, s0.id, fx, k)
          continue
        }
        const l = ch(q0, {
          channel_kind: 'event',
          transport: e,
          key: q,
          scope: f,
        })
        if (a === EP) {
          m(s0.id, l.id, PU)
        } else {
          m(l.id, n!, CY)
        }
      } else {
        const a = fx as PersistenceEffect
        const E = a[1]
        const B = a[2]
        const d = a[3]
        const v = q0.f.get(s0.id) ?? []
        const r = fi(s0.id, g, q0)
        const t = [...new Set(q0.ci.get(g)
          ?? (r ? [r] : []))]
        for (const j of t) {
          const D = v.find((G) => G.id === j)
          if (!d || D?.kind !== 'call') continue
          af(q0, {
            ...fb(
              s0.id, PE, g, k, D.control,
              { c: h, s: i, o: ++b }, ),
            kind: PE,
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
function fi(d: string, b: ts.Node, q0: CollectionState): string | null {
    const sf = gs(b), a = ro(b, sf)
    return q0.f.get(d)?.find((c) => c.kind === 'call' && c.evidence.range.start.line === a.start.line && c.evidence.range.start.column === a.start.column && c.evidence.range.end.line === a.end.line && c.evidence.range.end.column === a.end.column)?.id ?? null }
function at(q0: CollectionState): void {
  for (const a of q0.i.symbols) {
    if (q0.o.has(a.id)) {
      q0.d.push({
        id: `canonical-index.execution.owner-bound.${hash(a.id).slice(0, 16)}`,
        level: 'error', evidence: { file_id: a.file_id, range: a.range }, message: `Execution facts exceeded a per-owner safety bound for ${a.name}; body facts were omitted` })
      continue
    }
    const e = q0.f.get(a.id); if (!e || e[LN] === 0) continue
    const k = new Map<string, IndexBodyFact>(); for (const l of e) k.set(l.id, l)
    const j = [...k.values()].sort((m, g) => co(m.order, g.order) || ct(m.id, g.id))
    try {
      const h = eb(j), b = dt(h, a.id, a.file_id)
      if (!b) throw new Error('execution fact codec rejected its output'); a.body_facts = b
    } catch (n) {
      const c = n instanceof BE
      q0.d.push({
        id: `canonical-index.execution.${c ? 'owner-bound' : 'invalid'}.${hash(a.id).slice(0, 16)}`,
        level: 'error', evidence: { file_id: a.file_id, range: a.range }, message: c ? `Execution facts exceeded a per-owner safety bound for ${a.name}; body facts were omitted` : `Invalid execution facts for ${a.name}; body facts were omitted` })
      delete a.body_facts
    }
  }
}
function sort(e: readonly IndexEdge[]): IndexEdge[] {
    const a = new Map<string, IndexEdge>(), p = new Map<string, IndexEdge>(), c: IndexEdge[] = []
    for (const b of e) {
        if (b.kind === PU) {
          const k = js([b.from, b.to, b.kind, b.source, b.evidence]), d = p.get(k)
          if (!d) p.set(k, b)
          else if (d.metadata?.dispatch_payload_argument !== b.metadata?.dispatch_payload_argument) {
            const m = { ...(d.metadata ?? {}) }; delete m.dispatch_payload_argument
            p.set(k, { ...d, metadata: m })
          } else if (ct(js(b), js(d)) < 0) p.set(k, b)
          continue
        }
        if (b.kind !== RT) { c.push(b); continue }
        const key = `${b.from}\u0000${b.to}\u0000${b.kind}`
        const d = a.get(key)
        if (!d || ct(js(b), js(d)) < 0)
          a.set(key, b)
    }
    return [...c, ...a.values(), ...p.values()].sort((g, f) =>
      ct(js(g), js(f)))
}
export function collectExecutionSemantics(h: CollectExecutionInput): CollectExecutionResult {
  const j = new Map(h.symbols.map((k) => [k.id, k]))
  const q0: CollectionState = {
    i: h, y: j, f: new Map(), o: new Set(),
    e: new Map(), c: new Map(), ci: new Map(), ch: new Map(),
    g: [], d: [], sd: new Set(), u: new Set(), q: new Map(), w: new Map(),
    p: new Map(), r: new Map(), mq: new Map(), em: new Map(),
    nq: new Map(), fs: new Map(), x: new Set(),
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
    q0.fs.set(sf, l)
  }
  for (const sf of h.sourceFiles) {
    const e = (n: ts.Node): boolean => dg(n, sf, q0) || fc(n, e) === true
    if (e(sf)) q0.x.add(sf)
  }
  prep(q0)
  for (const t of a.values())
    if (!q0.x.has(t.sf)) cnest(t, q0)
  for (const m of a.values()) {
    if (q0.x.has(m.sf)) continue
    collect(m, q0)
    nc(m, q0)
  }
  pe(q0, a)
  at(q0)
  return {
    channels: [...q0.ch.values()].sort((x, n) =>
      ct(x.id, n.id)),
    edges: sort(q0.g),
    diagnostics: [...q0.d].sort((z, s) =>
      ct(z.id, s.id)),
  }
}
