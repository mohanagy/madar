import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { readBoundedSource as readBounded, readSourceIgnorePolicy as readPolicy } from '../shared/source-access.js'
import { classifySourceDomain, isDiscoveryPathIgnored } from '../shared/source-discovery.js'
import { JS_TS_SOURCE_EXTENSIONS } from '../shared/source-extensions.js'
import { isPackageManifestPath, readPackageManifest } from '../shared/package-manifest.js'
import { sourceDeclarationKind, sourceDeclarationQualifiedName, resolveSourceSymbolRange, sourcePathForEvidence, sourceSyntaxTree } from './retrieve/source-evidence.js'
import { sourceBracketedBranchRanges, sourceExcerptGuardRanges, sourceTypeRejectionQueryIdentifiers, sourceTypeRejectionUnits } from './retrieve/source-excerpt-guards.js'
import { sourceQuerySymbols } from './retrieve/source-query-symbols.js'
import type { SourceCallsiteBundle, SourceFunctionValueReference, SourceFlowCatalog, SourceFlowOwner } from './retrieve/source-dependencies.js'
import { flowRange, sourceFlowDonorRanges, sourceFlowExpandable, sourceFlowQueryNames, sourceFlowReadNames } from './source-flow-budget.js'
import { classifyRetrievalLevel, extractPromptExclusions } from './retrieval-gate.js'
import { compileSourceExclusions } from './source-exclusions.js'
import { fitPreparedSourceEvidenceResponse, omitDisconnectedSourceForCallsite, resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT, MIN_SOURCE_EVIDENCE_BUDGET } from './source-evidence-response.js'
import { estimateQueryTokens } from './serve.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
const MAX_SOURCE_BYTES = 256 * 1024
const MAX_LINES_PER_CALL = 4096
const MAX_SOURCE_PROBES = 32
const MAX_PARTIAL_OWNER_ATTEMPTS = 32
const JS_TS_EXTENSIONS = new Set<string>(JS_TS_SOURCE_EXTENSIONS)

export interface SourceContinuationHandle {
  kind: 'source_continuation'
  version: 1
  source_file: string
  logical_root: string
  real_root: string
  canonical_file: string
  file_sha256: string
  owner_range: Range
  pending_ranges: Range[]
  node_id: string
  label: string
  scope: 'symbol' | 'source_file'
  node_kind?: string
  evidence_role?: string
  task?: string
  task_intent?: string
  evidence: RecordValue
}

type SourceRead = { logical: string; canonical: string; realRoot: string; hash: string; policyFingerprint: string; lines: string[]; readBytes: number }
type VerifiedNode = { node: RecordValue; source: SourceRead; range: Range; omitted: Range[]; delivered: Range[] }
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const withinRoot = (path: string, root: string): boolean => {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}
function validRange(value: unknown): value is Range {
  const r = record(value)
  return Number.isSafeInteger(r.start_line) && Number.isSafeInteger(r.end_line)
    && Number(r.start_line) > 0 && Number(r.end_line) >= Number(r.start_line)
}
function validRanges(value: unknown, owner: Range, allowEmpty = false): value is Range[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_LINES_PER_CALL
    && value.every((r: unknown, index: number) => validRange(r) && r.start_line >= owner.start_line && r.end_line <= owner.end_line
      && (index === 0 || r.start_line > (value[index - 1] as Range).end_line))
}
export function isSourceContinuationHandle(value: unknown): value is SourceContinuationHandle {
  const h = record(value)
  return h.kind === 'source_continuation' && h.version === 1
    && ['source_file', 'logical_root', 'real_root', 'canonical_file', 'node_id', 'label'].every(key => typeof h[key] === 'string' && String(h[key]).length > 0)
    && typeof h.file_sha256 === 'string' && /^[a-f0-9]{64}$/.test(h.file_sha256)
    && validRange(h.owner_range) && validRanges(h.pending_ranges, h.owner_range)
    && (h.scope === 'symbol' || h.scope === 'source_file') && h.evidence !== null && typeof h.evidence === 'object' && !Array.isArray(h.evidence)
}
function fresh(governance: unknown): boolean {
  const state = record(record(governance).graph_freshness)
  return state.status === 'fresh' && state.selected_context_status === 'fresh'
}

function readSource(sourceFile: string, rootPath: string): SourceRead {
  const root = resolve(rootPath), realRoot = fs.realpathSync(root), logical = resolve(root, sourceFile)
  const policy = readPolicy(root, realRoot)
  const safe = sourcePathForEvidence(logical, root)
  if (!safe || isDiscoveryPathIgnored(logical, root, policy.patterns)
    || isDiscoveryPathIgnored(safe, realRoot, policy.patterns)) throw new Error('Source continuation source is excluded by current policy')
  const configuration = isPackageManifestPath(logical) ? readPackageManifest(logical, root) : null
  if (isPackageManifestPath(logical) && !configuration) throw new Error('Package continuation source is bounded, invalid, or excluded by policy')
  const source = configuration
    ? { text: configuration.text, canonical: configuration.path, hash: digest(configuration.text), bytes: Buffer.byteLength(configuration.text) }
    : readBounded(logical, root, realRoot, MAX_SOURCE_BYTES, true)
  const afterPolicy = readPolicy(root, realRoot)
  if (source.canonical !== safe || afterPolicy.fingerprint !== policy.fingerprint) throw new Error('Source continuation source or policy changed while reading')
  return { logical, canonical: source.canonical, realRoot, hash: source.hash, policyFingerprint: policy.fingerprint,
    lines: source.text.split(/\r?\n/), readBytes: source.bytes + policy.bytes + afterPolicy.bytes }
}
// Internal source selection uses the same descriptor, canonical and current
// ignore-policy proof as continuations; this does not create an expansion handle.
export { readSource as readVerifiedSourceSnapshot }
function subtract(ranges: readonly Range[], removed: readonly Range[]): Range[] {
  const result: Range[] = []
  for (const range of ranges) {
    let cursor = range.start_line
    for (const gap of removed) {
      if (gap.end_line < cursor || gap.start_line > range.end_line) continue
      if (gap.start_line > cursor) result.push({ start_line: cursor, end_line: gap.start_line - 1 })
      cursor = Math.max(cursor, gap.end_line + 1)
      if (cursor > range.end_line) break
    }
    if (cursor <= range.end_line) result.push({ start_line: cursor, end_line: range.end_line })
  }
  return result
}
function union(ranges: readonly Range[]): Range[] {
  const result: Range[] = []
  for (const range of [...ranges].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)) {
    const prior = result.at(-1)
    if (prior && range.start_line <= prior.end_line + 1) prior.end_line = Math.max(prior.end_line, range.end_line)
    else result.push({ ...range })
  }
  return result
}
function render(lines: readonly string[], range: Range, delivered: readonly Range[]): { snippet: string; omitted: Range[] } {
  const omitted = subtract([range], delivered), pieces: string[] = []
  for (const part of [...delivered.map(r => ({ ...r, omitted: false })), ...omitted.map(r => ({ ...r, omitted: true }))].sort((a, b) => a.start_line - b.start_line)) {
    if (part.omitted) pieces.push(`[omitted lines ${part.start_line}-${part.end_line}]`)
    else for (let line = part.start_line; line <= part.end_line; line++) pieces.push(lines[line - 1]!)
  }
  return { snippet: pieces.join('\n'), omitted }
}
function validOwner(source: SourceRead, range: Range, label: string, scope: unknown): scope is 'symbol' | 'source_file' {
  if (range.end_line > source.lines.length) return false
  if (scope === 'source_file') return range.start_line === 1 && (range.end_line === source.lines.length
    || source.lines.at(-1) === '' && range.end_line === source.lines.length - 1)
  return scope === 'symbol' && JS_TS_EXTENSIONS.has(extname(source.logical).toLowerCase())
    && sourceDeclarationKind(source.lines, { start: range.start_line, end: range.end_line }, label, source.logical) !== undefined
}
function verifyNode(node: RecordValue, nodes: readonly RecordValue[], source: SourceRead): VerifiedNode | null {
  if (node.snippet_source === 'derived' || node.snippet_unverified === true || !validRange(node.snippet_line_range)
    || !['symbol', 'source_file', 'excerpt'].includes(String(node.snippet_scope))) return null
  const range = node.snippet_line_range, omitted = node.snippet_omitted_ranges ?? []
  if (!validRanges(omitted, range, true) || range.end_line > source.lines.length) return null
  const delivered = subtract([range], omitted)
  if (resolveSourceSnippet(node, nodes) !== render(source.lines, range, delivered).snippet) return null
  return { node, source, range, omitted, delivered }
}
function handleId(handle: SourceContinuationHandle): string {
  return `source-expand:${digest(JSON.stringify(handle)).slice(0, 32)}`
}
export { handleId as sourceContinuationHandleId }
function recount(payload: RecordValue, maxTokens: number): number {
  payload.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
  const receipt = record(payload.serialized_budget)
  for (let i = 0; i < 12; i++) {
    const count = estimateQueryTokens(JSON.stringify(payload))
    if (receipt.token_count === count) return count
    receipt.token_count = count
  }
  throw new Error('Source continuation token receipt did not stabilize')
}
function requireBudget(budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < MIN_SOURCE_EVIDENCE_BUDGET) throw new Error(`Source continuation budget must be at least ${MIN_SOURCE_EVIDENCE_BUDGET}`)
}

/** Admit navigation only into spare serialized space. Never rerun packing or evict evidence. */
export function attachSourceContinuationHandles(
  payload: RecordValue, maxTokens: number, rootPath: string, store: (id: string, handle: SourceContinuationHandle) => void,
  lookupExisting?: (id: string) => SourceContinuationHandle | undefined,
): RecordValue {
  requireBudget(maxTokens)
  if (payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || payload.mode === 'delta' || payload.delta_session_id
    || payload.verbose === true || !fresh(payload.governance)
    || record(record(payload.evidence).answerability).broad_search_fallback === 'blocked') return payload
  if (Object.keys(record(payload.serialized_budget)).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))) return payload
  const nodes = Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as RecordValue[] : []
  const sourceCache = new Map<string, SourceRead | null>()
  let probes = 0
  const sourceFor = (node: RecordValue): SourceRead | null => {
    if (typeof node.source_file !== 'string') return null
    const key = resolve(rootPath, node.source_file)
    if (!sourceCache.has(key)) {
      if (++probes > MAX_SOURCE_PROBES) return null
      try { sourceCache.set(key, readSource(node.source_file, rootPath)) } catch { sourceCache.set(key, null) }
    }
    return sourceCache.get(key) ?? null
  }
  const verified = nodes.flatMap(node => {
    if (!node || typeof node !== 'object') return []
    const source = sourceFor(node), proof = source ? verifyNode(node, nodes, source) : null
    return proof ? [proof] : []
  })
  const delivered = new Map<string, Range[]>(), allocated = new Map<string, Range[]>()
  const identity = (source: SourceRead): string => `${source.canonical}\0${source.hash}`
  for (const proof of verified) delivered.set(identity(proof.source), union([...(delivered.get(identity(proof.source)) ?? []), ...proof.delivered]))
  // The final retry starts from the accepted packet. Existing cursors reserve
  // their source; never replace an unknown/stale cursor or allocate it twice.
  if (lookupExisting) {
    for (const node of nodes.filter(node => node.source_expand_handle !== undefined)) {
      const proof = verified.find(value => value.node === node)
      const handle = typeof node.source_expand_handle === 'string' ? lookupExisting(node.source_expand_handle) : undefined
      if (!proof || !isSourceContinuationHandle(handle) || handleId(handle) !== node.source_expand_handle
        || handle.node_id !== node.node_id || handle.label !== node.label || handle.scope !== node.snippet_scope
        || resolve(handle.logical_root) !== resolve(rootPath) || handle.real_root !== proof.source.realRoot
        || resolve(rootPath, handle.source_file) !== proof.source.logical || handle.canonical_file !== proof.source.canonical
        || handle.file_sha256 !== proof.source.hash || JSON.stringify(handle.owner_range) !== JSON.stringify(proof.range)
        || !validOwner(proof.source, proof.range, handle.label, handle.scope)
        || subtract(handle.pending_ranges, proof.omitted).length
        || JSON.stringify(subtract(handle.pending_ranges, delivered.get(identity(proof.source)) ?? [])) !== JSON.stringify(handle.pending_ranges)) return payload
      allocated.set(identity(proof.source), union([...(allocated.get(identity(proof.source)) ?? []), ...handle.pending_ranges]))
    }
  }
  let result = payload, admitted = 0, attempted = 0
  const pendingStores = new Map<string, SourceContinuationHandle>()
  for (const proof of verified) {
    const { node, source, range } = proof
    // Preserve the legacy allowance before callsite/source completion. Only the
    // final retry may use remaining space for additional current partial owners.
    if (!lookupExisting && admitted === 3) break
    if (!proof.omitted.length || typeof node.node_id !== 'string' || typeof node.label !== 'string'
      || !validOwner(source, range, node.label, node.snippet_scope)) continue
    if (++attempted > MAX_PARTIAL_OWNER_ATTEMPTS) break
    if (lookupExisting && node.source_expand_handle !== undefined) continue
    const pending = subtract(proof.omitted, union([...(delivered.get(identity(source)) ?? []), ...(allocated.get(identity(source)) ?? [])]))
    if (!pending.length) continue
    const handle: SourceContinuationHandle = {
      kind: 'source_continuation', version: 1, source_file: String(node.source_file), logical_root: resolve(rootPath),
      real_root: source.realRoot, canonical_file: source.canonical, file_sha256: source.hash,
      owner_range: { ...range }, pending_ranges: pending, node_id: node.node_id, label: node.label, scope: node.snippet_scope,
      ...(typeof node.node_kind === 'string' ? { node_kind: node.node_kind } : {}),
      ...(typeof node.evidence_class === 'string' ? { evidence_role: node.evidence_class } : {}),
      ...(typeof payload.task === 'string' ? { task: payload.task } : {}),
      ...(typeof payload.task_intent === 'string' ? { task_intent: payload.task_intent } : {}),
      evidence: clone(record(payload.evidence)),
    }
    const id = handleId(handle), trial = clone(result)
    const target = (record(trial.pack).matched_nodes as RecordValue[])[nodes.indexOf(node)]!
    target.source_expand_handle = id
    if (recount(trial, maxTokens) > maxTokens) continue
    pendingStores.set(id, clone(handle)); result = trial; admitted++
    allocated.set(identity(source), union([...(allocated.get(identity(source)) ?? []), ...pending]))
  }
  if (lookupExisting && pendingStores.size) {
    try {
      for (const [path, prior] of sourceCache) {
        if (!prior) continue
        const current = readSource(path, rootPath)
        if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot) return payload
      }
    } catch { return payload }
  }
  for (const [id, handle] of pendingStores) store(id, handle)
  return result
}

export interface PreparedSourceContinuations {
  payload: RecordValue
  handles: Map<string, SourceContinuationHandle>
  rejectedNodeIds: string[]
  valid: boolean
  refused: boolean
  validate: () => boolean
}

/** Missing complete implementations of original visible calls that consume a value. */
export function sourceValueConsumedCallees(
  baseline: RecordValue, raw: RecordValue, rootPath: string, prompt: string, bundles: readonly SourceCallsiteBundle[],
): { candidates: Array<{ node: RecordValue; edge: RecordValue }>; refused: boolean; validate: () => boolean } {
  return sourceCallsiteCallees(baseline, raw, rootPath, prompt, bundles)
}

/** A separate local type-rejection witness; it never changes value-consumption admission. */
export function sourceTypeRejectionCallees(
  baseline: RecordValue, raw: RecordValue, rootPath: string, prompt: string, bundles: readonly SourceCallsiteBundle[],
): ReturnType<typeof sourceValueConsumedCallees> {
  const identifiers = sourceTypeRejectionQueryIdentifiers(extractPromptExclusions(prompt).positivePrompt)
  return identifiers ? sourceCallsiteCallees(baseline, raw, rootPath, prompt, bundles, identifiers)
    : { candidates: [], refused: false, validate: () => true }
}

function sourceCallsiteCallees(
  baseline: RecordValue, raw: RecordValue, rootPath: string, prompt: string, bundles: readonly SourceCallsiteBundle[],
  typeIdentifiers?: ReadonlySet<string>,
): ReturnType<typeof sourceValueConsumedCallees> {
  const originals = Array.isArray(record(baseline.pack).matched_nodes) ? record(baseline.pack).matched_nodes as RecordValue[] : []
  const targets = Array.isArray(record(raw.pack).matched_nodes) ? record(raw.pack).matched_nodes as RecordValue[] : []
  const edges = Array.isArray(record(raw.pack).relationships) ? record(raw.pack).relationships as RecordValue[] : []
  const paths = new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths.map(file => resolve(rootPath, file)))
  const exclusions = extractPromptExclusions(prompt)
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  const excluded = (source: SourceRead, label: string): boolean => sourceExclusions.matchesSource(source.logical, label)
    || sourceExclusions.matchesPath(source.canonical, source.realRoot)
    || exclusions.excludedDomains.includes(classifySourceDomain(source.logical, rootPath) as never)
    || exclusions.excludedDomains.includes(classifySourceDomain(source.canonical, source.realRoot) as never)
  const sources = new Map<string, SourceRead>(), calls = new Map<string, Map<string, ts.CallExpression>>()
  let refused = false, bounded = false, bytes = 0, visited = 0
  const read = (file: string): SourceRead | undefined => {
    if (bounded || refused) return undefined
    const path = resolve(rootPath, file)
    if (!sources.has(path)) {
      if (sources.size >= MAX_SOURCE_PROBES) { bounded = true; return undefined }
      try {
        const source = readSource(file, rootPath)
        sources.set(path, source); bytes += Buffer.byteLength(source.lines.join('\n'))
        if (bytes > 1024 * 1024) bounded = true
      } catch { refused = true }
    }
    return bounded ? undefined : sources.get(path)
  }
  const valueSites = (source: SourceRead): Map<string, ts.CallExpression> => {
    if (!calls.has(source.logical)) {
      const syntax = sourceSyntaxTree(source.lines, source.logical), found = new Map<string, ts.CallExpression>()
      if ((syntax as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) bounded = true
      const visit = (node: ts.Node): void => {
        if (bounded || ++visited > 100_000) { bounded = true; return }
        if (ts.isCallExpression(node)) {
          let value: ts.Node = node
          while (value.parent && (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent)
            || ts.isTypeAssertionExpression(value.parent) || ts.isNonNullExpression(value.parent) || ts.isSatisfiesExpression(value.parent))) value = value.parent
          const parent = value.parent
          if (typeIdentifiers || parent && (ts.isVariableDeclaration(parent) && parent.initializer === value
            || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value
            || ts.isReturnStatement(parent) && parent.expression === value)) found.set(`${node.getStart(syntax)}:${node.getEnd()}`, node)
        }
        ts.forEachChild(node, visit)
      }
      visit(syntax); calls.set(source.logical, found)
    }
    return calls.get(source.logical)!
  }
  const selected = new Map<string, { node: RecordValue; edge: RecordValue; order: number; cost: number }>()
  if (paths.size >= 2 && paths.size <= 8 && originals.length <= 128 && targets.length <= 128 && Array.isArray(bundles) && bundles.length <= 4096
    && [originals, targets].every(nodes => nodes.every(node => typeof node.node_id === 'string')
      && new Set(nodes.map(node => node.node_id)).size === nodes.length)) for (const bundle of bundles) {
    if (!bundle || typeof bundle.from_id !== 'string' || !bundle.from_id || typeof bundle.to_id !== 'string' || !bundle.to_id
      || typeof bundle.source_file !== 'string' || !bundle.source_file || typeof bundle.source_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(bundle.source_sha256) || !Array.isArray(bundle.sites) || !bundle.sites.length || bundle.sites.length > 4096
      || !bundle.sites.every((site: SourceCallsiteBundle['sites'][number]) => site && Number.isSafeInteger(site.start_offset) && Number.isSafeInteger(site.end_offset)
        && site.start_offset >= 0 && site.end_offset > site.start_offset)
      || !Array.isArray(bundle.source_dependencies) || !bundle.source_dependencies.length || bundle.source_dependencies.length > MAX_SOURCE_PROBES
      || !bundle.source_dependencies.every((input: SourceCallsiteBundle['source_dependencies'][number]) => input && typeof input.source_file === 'string' && input.source_file.length > 0
        && typeof input.source_sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.source_sha256))) { if (typeIdentifiers) bounded = true; continue }
    const caller = originals.find(node => node.node_id === bundle.from_id), target = targets.find(node => node.node_id === bundle.to_id)
    if (!caller || !target || originals.some(node => node.node_id === target.node_id)
      || typeof caller.source_file !== 'string' || typeof target.source_file !== 'string'
      || typeof caller.label !== 'string' || typeof target.label !== 'string'
      || !paths.has(resolve(rootPath, caller.source_file)) || !paths.has(resolve(rootPath, target.source_file))
      || target.snippet_scope !== 'symbol' || (!typeIdentifiers && target.snippet_truncated === true) || target.source_expand_handle !== undefined
      || !edges.some(edge => edge.relation === 'calls' && edge.from_id === bundle.from_id && edge.to_id === bundle.to_id)
      || ![caller, target].every(node => bundle.source_dependencies.some((input: SourceCallsiteBundle['source_dependencies'][number]) => resolve(rootPath, input.source_file) === resolve(rootPath, String(node.source_file))))) continue
    if (!bundle.source_dependencies.every((input: SourceCallsiteBundle['source_dependencies'][number]) => {
      const source = read(input.source_file)
      if (!source) return false
      if (digest(source.lines.join('\n')) !== input.source_sha256) { refused = true; return false }
      return true
    })) continue
    const source = read(caller.source_file), targetSource = read(target.source_file)
    if (!source || !targetSource || excluded(source, caller.label) || excluded(targetSource, target.label)) continue
    const proof = verifyNode(caller, originals, source), targetProof = verifyNode(target, targets, targetSource)
    if (!proof || !targetProof) { refused = true; continue }
    if (caller.snippet_scope !== 'symbol' || !validOwner(source, proof.range, caller.label, 'symbol')
      || (typeIdentifiers ? !targetProof.omitted.length : targetProof.omitted.length > 0)
      || !validOwner(targetSource, targetProof.range, target.label, 'symbol')
      || sourceDeclarationKind(targetSource.lines, { start: targetProof.range.start_line, end: targetProof.range.end_line }, target.label, targetSource.logical) !== 'function') continue
    const complete = resolveSourceSymbolRange(targetSource.lines, { start: targetProof.range.start_line, end: targetProof.range.end_line }, target.label, targetSource.logical)
    if (complete?.start !== targetProof.range.start_line || complete.end !== targetProof.range.end_line) continue
    if (resolve(rootPath, bundle.source_file) !== source.logical || digest(source.lines.join('\n')) !== bundle.source_sha256) { refused = true; continue }
    const syntax = sourceSyntaxTree(source.lines, source.logical), sites = valueSites(source)
    if (!bundle.sites.every((site: SourceCallsiteBundle['sites'][number]) => {
      const call = sites.get(`${site.start_offset}:${site.end_offset}`)
      if (!call || !Number.isSafeInteger(site.start_offset) || !Number.isSafeInteger(site.end_offset)) return false
      const range = { start_line: syntax.getLineAndCharacterOfPosition(site.start_offset).line + 1,
        end_line: syntax.getLineAndCharacterOfPosition(site.end_offset - 1).line + 1 }
      if (subtract([range], proof.delivered).length) return false
      for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return false
        if (ts.isFunctionLike(parent)) return syntax.getLineAndCharacterOfPosition(parent.getStart(syntax)).line + 1 === proof.range.start_line
          && syntax.getLineAndCharacterOfPosition(parent.getEnd() - 1).line + 1 === proof.range.end_line
      }
      return false
    })) continue
    const delivered = originals.flatMap(node => typeof node.source_file === 'string' && read(node.source_file)?.canonical === targetSource.canonical
      ? verifyNode(node, originals, targetSource)?.delivered ?? [] : [])
    const units = typeIdentifiers ? sourceTypeRejectionUnits(targetSource.lines, targetSource.logical, target.label, targetProof.range, typeIdentifiers)
      : [{ branch: targetProof.range, retained: [targetProof.range] }]
    if (units === null) { bounded = true; continue }
    for (const unit of units) {
      if (!subtract([unit.branch], union(delivered)).length) continue
      const node = clone(target), rendered = render(targetSource.lines, targetProof.range, union(unit.retained))
      node.snippet = rendered.snippet; delete node.snippet_ref
      if (typeIdentifiers) { node.snippet_omitted_ranges = rendered.omitted; node.snippet_truncated = true }
      const entry = { node, edge: { from_id: bundle.from_id, to_id: bundle.to_id, relation: 'calls' }, order: originals.indexOf(caller), cost: estimateQueryTokens(String(node.snippet)) }
      const key = typeIdentifiers ? `${bundle.to_id}:${unit.branch.start_line}:${unit.branch.end_line}` : bundle.to_id
      if (!selected.has(key) || selected.get(key)!.order > entry.order) selected.set(key, entry)
    }
  }
  return { candidates: refused || bounded || typeIdentifiers && selected.size !== 1 ? [] : [...selected.values()].sort((a, b) => a.order - b.order || a.cost - b.cost
    || String(a.node.node_id).localeCompare(String(b.node.node_id))).slice(0, 4).map(({ node, edge }) => ({ node, edge })), refused,
    validate: () => {
      try { for (const prior of sources.values()) {
        const current = readSource(prior.logical, rootPath)
        if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot
          || current.policyFingerprint !== prior.policyFingerprint) refused = true
      } } catch { refused = true }
      return !refused
    } }
}

/** Complete one already retained branch in an exactly requested current owner. */
export function sourceBracketedBranchCompletions(
  payload: RecordValue, rootPath: string, prompt: string,
): { candidates: RecordValue[]; refused: boolean; validate: () => boolean } {
  const nodes = Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as RecordValue[] : []
  const exclusions = extractPromptExclusions(prompt)
  const names = new Set(sourceQuerySymbols(exclusions.positivePrompt).map(occurrence => occurrence.name))
  const paths = new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths.map(path => resolve(rootPath, path)))
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  const sources = new Map<string, SourceRead>(), candidates: RecordValue[] = []
  let refused = false, bounded = false, bytes = 0
  if (nodes.length <= 128 && names.size && paths.size >= 2 && paths.size <= 8
    && nodes.every(node => typeof node.node_id === 'string') && new Set(nodes.map(node => node.node_id)).size === nodes.length) {
    for (const node of nodes) {
      if (typeof node.source_file !== 'string' || typeof node.label !== 'string' || node.snippet_scope !== 'symbol'
        || typeof node.source_expand_handle !== 'string' || node.snippet_ref !== undefined
        || nodes.some(other => other.snippet_ref === node.node_id) || !Array.isArray(node.snippet_omitted_ranges) || !node.snippet_omitted_ranges.length
        || !paths.has(resolve(rootPath, node.source_file))) continue
      const path = resolve(rootPath, node.source_file)
      if (sourceExclusions.matchesSource(path, node.label)
        || exclusions.excludedDomains.includes(classifySourceDomain(path, rootPath) as never)) continue
      if (!sources.has(path)) {
        if (sources.size >= MAX_SOURCE_PROBES) { bounded = true; break }
        try {
          const source = readSource(node.source_file, rootPath)
          sources.set(path, source); bytes += Buffer.byteLength(source.lines.join('\n'))
          if (bytes > 1024 * 1024) { bounded = true; break }
        } catch { refused = true; break }
      }
      const source = sources.get(path)!
      if (sourceExclusions.matchesPath(source.canonical, source.realRoot)
        || exclusions.excludedDomains.includes(classifySourceDomain(source.canonical, source.realRoot) as never)) continue
      const proof = verifyNode(node, nodes, source)
      if (!proof) { refused = true; break }
      const range = { start: proof.range.start_line, end: proof.range.end_line }
      const name = sourceDeclarationQualifiedName(source.lines, range, node.label, source.logical)
      if (!name || !names.has(name) || sourceDeclarationKind(source.lines, range, node.label, source.logical) !== 'function') continue
      const whole = resolveSourceSymbolRange(source.lines, range, node.label, source.logical)
      if (!whole || whole.start !== range.start || whole.end !== range.end) { bounded = true; break }
      const branches = sourceBracketedBranchRanges(source.lines, source.logical, node.label, proof.range, proof.delivered)
      if (branches === null) { bounded = true; break }
      for (const branch of branches) {
        const additional = subtract([branch], proof.delivered)
        if (additional.some(part => sourceExclusions.matchesText(source.lines.slice(part.start_line - 1, part.end_line).join('\n')))) continue
        const next = clone(node), rendered = render(source.lines, proof.range, union([...proof.delivered, branch]))
        next.snippet = rendered.snippet
        if (rendered.omitted.length) next.snippet_omitted_ranges = rendered.omitted
        else { delete next.snippet_omitted_ranges; delete next.snippet_truncated }
        // The wrapper authenticates the baseline cursor first. Its old pending
        // range includes this newly delivered interior and must be rebuilt.
        delete next.source_expand_handle
        candidates.push(next)
      }
    }
  }
  return { candidates: refused || bounded || candidates.length !== 1 ? [] : candidates, refused,
    validate: () => {
      try { for (const prior of sources.values()) {
        const current = readSource(prior.logical, rootPath)
        if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot
          || current.policyFingerprint !== prior.policyFingerprint) refused = true
      } } catch { refused = true }
      return !refused
    } }
}

export interface SourceFlowBudgetOptions {
  catalog: SourceFlowCatalog
  lookup: (id: string) => unknown
  store: (id: string, handle: unknown) => void
}

/** At most three independent allocations at the existing final commit seam. No trial writes. */
export function allocateSourceFlowBudget(
  baseline: RecordValue, raw: RecordValue, budget: number, rootPath: string, prompt: string,
  bundles: readonly SourceCallsiteBundle[], flow: SourceFlowBudgetOptions,
  handles: Map<string, SourceContinuationHandle>, configurationFresh: () => boolean,
  functionReferences: readonly SourceFunctionValueReference[] = [],
): { payload: RecordValue; handles: Map<string, SourceContinuationHandle>; generic: Map<string, unknown> } {
  const unchanged = { payload: baseline, handles, generic: new Map<string, unknown>() }
  const pack = record(baseline.pack), catalog = flow.catalog
  const nodes = Array.isArray(pack.matched_nodes) ? pack.matched_nodes.map(record) : []
  const paths = new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths.map(path => resolve(rootPath, path)))
  if (baseline.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || baseline.task !== 'explain' || baseline.mode === 'delta'
    || baseline.delta_session_id || !fresh(baseline.governance) || pack.selection_scope !== 'task_context'
    || record(record(baseline.evidence).answerability).broad_search_fallback === 'blocked'
    || record(raw.pack).retrieval_strategy && record(raw.pack).retrieval_strategy !== 'default'
    || !nodes.length || nodes.length > 128 || !Array.isArray(pack.relationships) || paths.size < 2 || paths.size > 8
    || !catalog || catalog.version !== 1 || !Array.isArray(catalog.callees) || !Array.isArray(catalog.overflow)
    || !catalog.callees.length || !catalog.overflow.length || catalog.callees.length > 128 || catalog.overflow.length > 128
    || !Array.isArray(bundles) || bundles.length > 4096 || !isFinite(budget)
    || Object.keys(record(baseline.serialized_budget)).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))) return unchanged
  const descriptor = (owner: SourceFlowOwner): boolean => !!owner && typeof owner.node_id === 'string' && !!owner.node_id
    && typeof owner.label === 'string' && !!owner.label && typeof owner.source_file === 'string' && !!owner.source_file && validRange(owner.range)
  if (![catalog.callees, catalog.overflow].every(entries => entries.every(descriptor)
    && new Set(entries.map(owner => owner.node_id)).size === entries.length)
    || new Set(nodes.map(node => node.node_id)).size !== nodes.length) return unchanged
  const rawNodes = Array.isArray(record(raw.pack).matched_nodes) ? (record(raw.pack).matched_nodes as unknown[]).map(record) : []
  if (catalog.overflow.some(owner => rawNodes.some(node => node.node_id === owner.node_id))) return unchanged
  const dependencies = new Map<string, { source_file: string; source_sha256: string }>()
  for (const bundle of bundles) {
    if (!bundle || typeof bundle.from_id !== 'string' || typeof bundle.to_id !== 'string' || typeof bundle.source_file !== 'string'
      || typeof bundle.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.source_sha256)
      || !Array.isArray(bundle.sites) || !bundle.sites.length || bundle.sites.length > 4096
      || !bundle.sites.every((site: SourceCallsiteBundle['sites'][number]) => site && Number.isSafeInteger(site.start_offset)
        && Number.isSafeInteger(site.end_offset) && site.start_offset >= 0 && site.end_offset > site.start_offset)
      || !Array.isArray(bundle.source_dependencies) || !bundle.source_dependencies.length || bundle.source_dependencies.length > 32) return unchanged
    for (const dependency of bundle.source_dependencies) {
      if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
        || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return unchanged
      const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
      if (prior && prior.source_sha256 !== dependency.source_sha256) return unchanged
      dependencies.set(path, dependency)
      if (dependencies.size > 32) return unchanged
    }
  }
  if (!Array.isArray(functionReferences) || functionReferences.length > 4096) return unchanged
  for (const reference of functionReferences) {
    if (!reference || !Array.isArray(reference.source_dependencies) || reference.source_dependencies.length > 32) return unchanged
    for (const dependency of reference.source_dependencies) {
      if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
        || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) return unchanged
      const path = resolve(rootPath, dependency.source_file), prior = dependencies.get(path)
      if (prior && prior.source_sha256 !== dependency.source_sha256) return unchanged
      dependencies.set(path, dependency)
      if (dependencies.size > 32) return unchanged
    }
  }
  const prepare = createSourceContinuationPreparation(rootPath, id => handles.get(id), configurationFresh,
    { verifyAllSources: true, sourceDependencies: [...dependencies.values()] })
  const original = prepare(baseline)
  const refusal = () => ({ payload: fitPreparedSourceEvidenceResponse(baseline, budget,
    () => ({ ...original, refused: true })).payload, handles: new Map<string, SourceContinuationHandle>(), generic: new Map<string, unknown>() })
  if (original.refused || !original.validate()) return refusal()
  if (!original.valid) return unchanged
  const sources = new Map<string, SourceRead>(), syntax = new Map<string, ts.SourceFile>()
  const indexes = new Map<ts.SourceFile, {
    calls: Map<string, ts.CallExpression>
    functions: Map<string, ts.Node[]>
  }>()
  let refused = false, bounded = false, bytes = 0, visited = 0
  const read = (file: string): SourceRead | undefined => {
    const path = resolve(rootPath, file)
    if (!sources.has(path)) {
      if (sources.size >= 32) { bounded = true; return undefined }
      try {
        const source = readSource(file, rootPath); sources.set(path, source)
        bytes += Buffer.byteLength(source.lines.join('\n'))
        if (bytes > 1024 * 1024) bounded = true
        const ast = sourceSyntaxTree(source.lines, path)
        if ((ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) bounded = true
        syntax.set(path, ast)
      } catch { refused = true }
    }
    return bounded ? undefined : sources.get(path)
  }
  const index = (ast: ts.SourceFile) => {
    if (bounded) return undefined
    const cached = indexes.get(ast)
    if (cached) return cached
    const calls = new Map<string, ts.CallExpression>(), functions = new Map<string, ts.Node[]>()
    const visit = (node: ts.Node): void => {
      if (bounded) return
      if (visited >= 100_000) { bounded = true; return }
      visited++
      if (ts.isCallExpression(node)) calls.set(`${node.getStart(ast)}:${node.getEnd()}`, node)
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const range = flowRange(node, ast), key = `${range.start_line}:${range.end_line}`
        const matches = functions.get(key) ?? []
        matches.push(node); functions.set(key, matches)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    // Never use a partial index: unseen nodes can conceal an ambiguous owner.
    if (bounded) return undefined
    const complete = { calls, functions }
    indexes.set(ast, complete)
    return complete
  }
  const validate = (): boolean => {
    try { for (const prior of sources.values()) {
      const current = readSource(prior.logical, rootPath)
      if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot
        || current.policyFingerprint !== prior.policyFingerprint) refused = true
    } } catch { refused = true }
    return original.validate() && !refused
  }
  const exclusions = extractPromptExclusions(prompt)
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  const allowed = (source: SourceRead, label: string): boolean => !sourceExclusions.matchesSource(source.logical, label)
    && !sourceExclusions.matchesPath(source.canonical, source.realRoot)
    && !exclusions.excludedDomains.includes(classifySourceDomain(source.logical, rootPath) as never)
    && !exclusions.excludedDomains.includes(classifySourceDomain(source.canonical, source.realRoot) as never)
  const proofs = new Map<string, VerifiedNode>(), presentReads = new Set<string>()
  for (const node of nodes) {
    const source = typeof node.source_file === 'string' ? read(node.source_file) : undefined
    const proof = source ? verifyNode(node, nodes, source) : null
    if (!proof) { if (source) refused = true; continue }
    proofs.set(String(node.node_id), proof)
    const reads = sourceFlowReadNames(syntax.get(source!.logical)!, syntax.get(source!.logical)!, proof.delivered)
    if (!reads) bounded = true
    else for (const name of reads) presentReads.add(name)
  }
  const names = sourceFlowQueryNames(prompt)
  const materialize = (owner: SourceFlowOwner): RecordValue | undefined => {
    if (nodes.some(node => node.node_id === owner.node_id) || !paths.has(resolve(rootPath, owner.source_file))
      || owner.range.end_line - owner.range.start_line >= 64) return undefined
    const source = read(owner.source_file)
    if (!source || !allowed(source, owner.label) || !validOwner(source, owner.range, owner.label, 'symbol')
      || sourceDeclarationKind(source.lines, { start: owner.range.start_line, end: owner.range.end_line }, owner.label, source.logical) !== 'function') return undefined
    const full = resolveSourceSymbolRange(source.lines, { start: owner.range.start_line, end: owner.range.end_line }, owner.label, source.logical)
    if (full?.start !== owner.range.start_line || full.end !== owner.range.end_line) return undefined
    return { node_id: owner.node_id, label: owner.label, source_file: owner.source_file, line_number: owner.range.start_line,
      snippet_scope: 'symbol', snippet_line_range: { ...owner.range }, snippet: source.lines.slice(owner.range.start_line - 1, owner.range.end_line).join('\n') }
  }
  const calls = new Map<string, { node: RecordValue; edge: RecordValue; ranges: Range[]; caller: string }>()
  for (const bundle of bundles) {
    const proof = proofs.get(bundle.from_id), owner = catalog.callees.find(entry => entry.node_id === bundle.to_id)
    if (!proof || !owner || !paths.has(proof.source.logical)) continue
    const label = owner.label.replace(/\(\)$/, '').split('.').at(-1)!
    if (![...names].some(name => label === name || label.startsWith(name) && /^[A-Z_$]/.test(label.slice(name.length)))) continue
    const target = materialize(owner)
    if (!target) continue
    if (![proof.source.logical, resolve(rootPath, owner.source_file)].every(path =>
      bundle.source_dependencies.some((dependency: SourceCallsiteBundle['source_dependencies'][number]) => resolve(rootPath, dependency.source_file) === path))) continue
    if (resolve(rootPath, bundle.source_file) !== proof.source.logical || digest(proof.source.lines.join('\n')) !== bundle.source_sha256) { refused = true; continue }
    const ast = syntax.get(proof.source.logical)!, lookup = index(ast)
    if (!lookup) continue
    const ranges: Range[] = []
    const visible = bundle.sites.every((site: SourceCallsiteBundle['sites'][number]) => {
      const call = lookup.calls.get(`${site.start_offset}:${site.end_offset}`)
      if (!call) return false
      const range = flowRange(call, ast)
      if (subtract([range], proof.delivered).length) return false
      for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return false
        if (ts.isFunctionLike(parent)) {
          const enclosing = flowRange(parent, ast)
          if (enclosing.start_line !== proof.range.start_line || enclosing.end_line !== proof.range.end_line) return false
          ranges.push(range); return true
        }
      }
      return false
    })
    if (visible) calls.set(String(target.node_id), { node: target, edge: { from_id: bundle.from_id, to_id: bundle.to_id,
      relation: 'calls' }, ranges, caller: bundle.from_id })
  }
  const missing = new Set([...names].filter(name => !presentReads.has(name)))
  const overflow: Array<{ node: RecordValue; names: Set<string> }> = []
  for (const owner of catalog.overflow) {
    const node = materialize(owner)
    if (!node) continue
    const ast = syntax.get(resolve(rootPath, owner.source_file))!
    const lookup = index(ast)
    if (!lookup) continue
    const declarations = lookup.functions.get(`${owner.range.start_line}:${owner.range.end_line}`) ?? []
    if (declarations.length !== 1) continue
    const reads = sourceFlowReadNames(declarations[0]!, ast, [owner.range])
    if (!reads) { bounded = true; continue }
    const matches = new Set([...reads].filter(name => missing.has(name)))
    if (matches.size) overflow.push({ node, names: matches })
  }
  if (!validate()) return refusal()
  if (bounded || calls.size !== 1 || overflow.length !== 1) return unchanged
  const call = [...calls.values()][0]!, restored = overflow[0]!.node
  if (call.node.node_id === restored.node_id || catalog.overflow.some(owner => owner.node_id === call.node.node_id)) return unchanged
  let oldRefs: ReturnType<typeof sourceFlowExpandable>, newRefs: ReturnType<typeof sourceFlowExpandable>
  try { oldRefs = sourceFlowExpandable(catalog); newRefs = sourceFlowExpandable(catalog, String(restored.node_id)) } catch { return unchanged }
  const group = catalog.overflow.find(owner => owner.node_id === restored.node_id)!.evidence_class
  const oldRef = oldRefs.find(ref => ref.evidence_class === group), nextRef = newRefs.find(ref => ref.evidence_class === group)
  const exposed = Array.isArray(baseline.expandable) ? baseline.expandable.map(record) : []
  if (!oldRef || !nextRef || !exposed.some(ref => ref.handle_id === oldRef.handle_id && ref.count === oldRef.count)) return unchanged
  const rawRef = (Array.isArray(raw.expandable) ? raw.expandable : []).map(record).find(ref => ref.handle_id === oldRef.handle_id)
  if (!rawRef || rawRef.count !== oldRef.count || JSON.stringify(rawRef.follow_up) !== JSON.stringify(oldRef.follow_up)) return unchanged
  const priorGeneric = record(flow.lookup(oldRef.handle_id))
  if (priorGeneric.prompt !== prompt || priorGeneric.task !== 'explain'
    || JSON.stringify(priorGeneric.follow_up) !== JSON.stringify(oldRef.follow_up)) return unchanged
  const donorPayload = clone(baseline)
  const donorNodes = record(donorPayload.pack).matched_nodes as RecordValue[]
  const protectedIds = new Set(nodes.flatMap(node => typeof node.snippet_ref === 'string' ? [node.snippet_ref, String(node.node_id)] : []))
  let donors = 0, deferred = 0
  for (const node of donorNodes) {
    const proof = proofs.get(String(node.node_id))
    if (!proof || !paths.has(proof.source.logical) || protectedIds.has(String(node.node_id)) || donors >= 3) continue
    const protectedRanges: Range[] = []
    for (const bundle of bundles) if (bundle.from_id === node.node_id
      && ((pack.relationships as RecordValue[]).some(edge => edge.from_id === bundle.from_id && edge.to_id === bundle.to_id) || call.caller === node.node_id)) {
      const ast = syntax.get(proof.source.logical)!
      for (const site of bundle.sites) if (site.end_offset <= ast.text.length) protectedRanges.push({
        start_line: ast.getLineAndCharacterOfPosition(site.start_offset).line + 1, end_line: ast.getLineAndCharacterOfPosition(site.end_offset - 1).line + 1 })
    }
    const ranges = union(sourceFlowDonorRanges(syntax.get(proof.source.logical)!, proof.range, proof.delivered, prompt, protectedRanges, proof.omitted.length > 0))
    if (!ranges.length || subtract(ranges, proof.delivered).length) continue
    const count = ranges.reduce((sum, range) => sum + range.end_line - range.start_line + 1, 0)
    if (deferred + count > 120) return unchanged
    deferred += count; donors += 1
    const rendered = render(proof.source.lines, proof.range, subtract(proof.delivered, ranges))
    Object.assign(node, { snippet: rendered.snippet, snippet_omitted_ranges: rendered.omitted, snippet_truncated: true })
    delete node.source_expand_handle
  }
  if (!donors) return unchanged
  const baselineTokens = estimateQueryTokens(JSON.stringify(baseline))
  // Keep the same donor plan and original handle lookup for every proposal.
  // A failed fit must not donate more source or carry pointers into the next one.
  for (const proposal of [
    { callee: true, requestedRead: true },
    { callee: false, requestedRead: true },
    { callee: true, requestedRead: false },
  ]) {
    const trial = clone(donorPayload), trialPack = record(trial.pack)
    const trialNodes = trialPack.matched_nodes as RecordValue[]
    const generic = new Map<string, unknown>()
    if (proposal.callee) {
      trialNodes.push(clone(call.node))
      ;(trialPack.relationships as RecordValue[]).push(clone(call.edge))
    }
    if (proposal.requestedRead) {
      trialNodes.push(clone(restored))
      trial.expandable = exposed.map(ref => ref.handle_id !== oldRef.handle_id ? ref : { ...ref, handle_id: nextRef.handle_id,
        count: nextRef.count, focus_files: nextRef.follow_up.focus_files.slice(0, 4), focus_ranges: (nextRef.follow_up.focus_ranges ?? []).slice(0, 2) })
      const answerability = record(record(trial.evidence).answerability)
      if (Array.isArray(answerability.verification_targets)) answerability.verification_targets = answerability.verification_targets.map(target =>
        record(target).handle_id === oldRef.handle_id ? { ...record(target), handle_id: nextRef.handle_id } : target)
      generic.set(nextRef.handle_id, { ...priorGeneric, follow_up: nextRef.follow_up })
    }
    const fitted = fitPreparedSourceEvidenceResponse(trial, budget, prepare)
    if (fitted.status === 'unverifiable' || !validate()) return refusal()
    // The complete joint proposal may use the caller's requested budget.
    // Atomic fallbacks still have to preserve the smaller response size.
    const admissionBudget = proposal.callee && proposal.requestedRead ? budget : baselineTokens
    if (fitted.status !== 'fit' || !fitted.preparation || estimateQueryTokens(JSON.stringify(fitted.payload)) > admissionBudget) continue
    if (!fitted.preparation.validate()) return refusal()
    return { payload: fitted.payload, handles: fitted.preparation.handles, generic }
  }
  return unchanged
}

/** Prepare recovery with no store writes or budget-dependent pointer omissions.
 * Source snapshots and probe bounds belong to this one final fitting transaction.
 */
export function createSourceContinuationPreparation(
  rootPath: string,
  lookupExisting: (id: string) => SourceContinuationHandle | undefined = () => undefined,
  configurationFresh: () => boolean = () => true,
  options: { verifyAllSources?: boolean; sourceDependencies?: readonly { source_file: string; source_sha256: string }[] } = {},
): (payload: RecordValue) => PreparedSourceContinuations {
  const sources = new Map<string, SourceRead | null>()
  const inspectedSources = new Set<SourceRead>()
  let probes = 0, refused = false
  let dependenciesChecked = false, dependenciesSupported = true
  const sourceFor = (file: string): SourceRead | null => {
    const path = resolve(rootPath, file)
    if (!sources.has(path)) {
      if (++probes > MAX_SOURCE_PROBES) sources.set(path, null)
      else try { sources.set(path, readSource(file, rootPath)) } catch { sources.set(path, null); refused = true }
    }
    return sources.get(path) ?? null
  }
  return input => {
    try { if (!configurationFresh()) refused = true } catch { refused = true }
    if (!dependenciesChecked) {
      dependenciesChecked = true
      const dependencies = options.sourceDependencies
      if (dependencies !== undefined) {
        const unique = new Map<string, { source_file: string; source_sha256: string }>()
        if (!Array.isArray(dependencies) || dependencies.length > MAX_SOURCE_PROBES) dependenciesSupported = false
        else for (const dependency of dependencies) {
          if (!dependency || typeof dependency.source_file !== 'string' || !dependency.source_file
            || typeof dependency.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)) { dependenciesSupported = false; break }
          const path = resolve(rootPath, dependency.source_file), prior = unique.get(path)
          if (prior && prior.source_sha256 !== dependency.source_sha256) { dependenciesSupported = false; break }
          unique.set(path, dependency)
        }
        if (dependenciesSupported) for (const dependency of unique.values()) {
          const source = sourceFor(dependency.source_file)
          if (!source) { dependenciesSupported = false; continue }
          inspectedSources.add(source)
          if (digest(source.lines.join('\n')) !== dependency.source_sha256) refused = true
        }
      }
    }
    const payload = clone(input)
    const nodes = Array.isArray(record(payload.pack).matched_nodes) ? record(payload.pack).matched_nodes as RecordValue[] : []
    const handles = new Map<string, SourceContinuationHandle>(), rejectedNodeIds: string[] = []
    const partial = nodes.filter(node => Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0
      || node.snippet_truncated === true || node.source_expand_handle !== undefined)
    const files = new Set(partial.flatMap(node => typeof node.source_file === 'string' ? [resolve(rootPath, node.source_file)] : []))
    const verified = new Map<RecordValue, VerifiedNode>()
    const delivered = new Map<string, Range[]>(), allocated = new Map<string, Range[]>()
    const identity = (source: SourceRead): string => `${source.canonical}\0${source.hash}`
    let valid = dependenciesSupported, attempts = 0
    const reject = (node: RecordValue): void => {
      valid = false
      if (typeof node.node_id === 'string') rejectedNodeIds.push(node.node_id)
    }
    // Complete owners in the same files may already supply some omitted lines.
    for (const node of nodes) {
      if (typeof node.source_file !== 'string') { if (options.verifyAllSources) reject(node); continue }
      if (!options.verifyAllSources && !files.has(resolve(rootPath, node.source_file))) continue
      if (node.snippet_source === 'derived' || node.snippet_unverified === true
        || typeof node.snippet !== 'string' && typeof node.snippet_ref !== 'string') {
        if (options.verifyAllSources) reject(node)
        continue
      }
      const source = sourceFor(node.source_file)
      if (options.verifyAllSources && source) inspectedSources.add(source)
      const proof = source ? verifyNode(node, nodes, source) : null
      // A bounded/unsupported owner may be refused alone. Observed source
      // disagreement must not disappear when its partial sibling is culled.
      if (!proof) { if (source) refused = true; if (options.verifyAllSources) reject(node); continue }
      if (options.verifyAllSources && (typeof node.label !== 'string'
        || !validOwner(source!, proof.range, node.label, node.snippet_scope))) { reject(node); continue }
      verified.set(node, proof)
      inspectedSources.add(proof.source)
      delivered.set(identity(proof.source), union([...(delivered.get(identity(proof.source)) ?? []), ...proof.delivered]))
    }
    for (const node of partial) {
      const priorId = node.source_expand_handle
      delete node.source_expand_handle
      const proof = verified.get(node)
      if (++attempts > MAX_PARTIAL_OWNER_ATTEMPTS || !proof || typeof node.node_id !== 'string' || typeof node.label !== 'string'
        || !validOwner(proof.source, proof.range, node.label, node.snippet_scope)
        || node.snippet_truncated === true && !proof.omitted.length) { reject(node); continue }
      const { source, range } = proof
      if (priorId !== undefined) {
        const prior = typeof priorId === 'string' ? lookupExisting(priorId) : undefined
        if (isSourceContinuationHandle(prior) && (prior.file_sha256 !== source.hash
          || prior.canonical_file !== source.canonical || prior.real_root !== source.realRoot)) refused = true
        if (!isSourceContinuationHandle(prior) || handleId(prior) !== priorId
          || prior.node_id !== node.node_id || prior.label !== node.label || prior.scope !== node.snippet_scope
          || resolve(prior.logical_root) !== resolve(rootPath) || prior.real_root !== source.realRoot
          || resolve(rootPath, prior.source_file) !== source.logical || prior.canonical_file !== source.canonical
          || prior.file_sha256 !== source.hash || JSON.stringify(prior.owner_range) !== JSON.stringify(range)
          || subtract(prior.pending_ranges, proof.omitted).length) { reject(node); continue }
      }
      const key = identity(source)
      const pending = subtract(proof.omitted, union([...(delivered.get(key) ?? []), ...(allocated.get(key) ?? [])]))
      if (!pending.length) continue
      const handle: SourceContinuationHandle = {
        kind: 'source_continuation', version: 1, source_file: String(node.source_file), logical_root: resolve(rootPath),
        real_root: source.realRoot, canonical_file: source.canonical, file_sha256: source.hash,
        owner_range: { ...range }, pending_ranges: pending, node_id: node.node_id, label: node.label, scope: node.snippet_scope,
        ...(typeof node.node_kind === 'string' ? { node_kind: node.node_kind } : {}),
        ...(typeof node.evidence_class === 'string' ? { evidence_role: node.evidence_class } : {}),
        ...(typeof payload.task === 'string' ? { task: payload.task } : {}),
        ...(typeof payload.task_intent === 'string' ? { task_intent: payload.task_intent } : {}),
        evidence: clone(record(payload.evidence)),
      }
      const id = handleId(handle)
      node.source_expand_handle = id
      handles.set(id, handle)
      allocated.set(key, union([...(allocated.get(key) ?? []), ...pending]))
    }
    return { payload, handles, rejectedNodeIds, valid, refused, validate: () => {
      try {
        if (!configurationFresh()) refused = true
        // Keep every observed source identity through culling, including a file
        // whose last partial owner has since been removed.
        for (const prior of inspectedSources) {
          const current = readSource(prior.logical, rootPath)
          if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot
            || current.policyFingerprint !== prior.policyFingerprint) refused = true
        }
        if (!configurationFresh()) refused = true
      } catch { refused = true }
      return !refused
    } }
  }
}

/** Complete an overlapping owner only when shared source buys new lines for fewer wire tokens. */
export function completeOverlappingSourceOwners(
  payload: RecordValue, maxTokens: number, rootPath: string, prompt: string,
): RecordValue {
  const pack = record(payload.pack)
  // The shared recount writes the known receipt shape. Preserve extensions by
  // leaving such responses untouched instead of discarding future fields.
  if (Object.keys(record(payload.serialized_budget)).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))) return payload
  if (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_SOURCE_EVIDENCE_BUDGET
    || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || payload.task !== 'explain'
    || payload.mode === 'delta' || payload.delta_session_id || payload.verbose === true || !fresh(payload.governance)
    || pack.selection_scope !== 'task_context' || (pack.retrieval_strategy && pack.retrieval_strategy !== 'default')
    || record(record(payload.evidence).answerability).broad_search_fallback === 'blocked'
    || !Array.isArray(pack.matched_nodes)) return payload
  const exclusions = extractPromptExclusions(prompt)
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  if (!sourceExclusions.valid) return payload
  const nodesOf = (value: RecordValue): RecordValue[] => record(value.pack).matched_nodes as RecordValue[]
  const originalNodes = nodesOf(payload)
  if (new Set(originalNodes.map(node => record(node).node_id)).size !== originalNodes.length) return payload
  const sources = new Map<string, SourceRead | null>()
  const sourceFor = (node: RecordValue): SourceRead | null => {
    if (typeof node.source_file !== 'string' || typeof node.label !== 'string'
      || sourceExclusions.matchesSource(resolve(rootPath, node.source_file), node.label)) return null
    const path = resolve(rootPath, node.source_file)
    if (!sources.has(path)) {
      if (sources.size === MAX_SOURCE_PROBES) return null
      try {
        const source = readSource(node.source_file, rootPath)
        sources.set(path, sourceExclusions.matchesPath(source.canonical, source.realRoot) ? null : source)
      } catch { sources.set(path, null) }
    }
    return sources.get(path) ?? null
  }
  const identity = (source: SourceRead): string => `${source.canonical}\0${source.hash}`
  let result = payload, completedLines = 0
  let currentTokens = estimateQueryTokens(JSON.stringify(payload))
  try {
    for (const original of originalNodes) {
      const nodes = nodesOf(result)
      const parent = nodes.find(node => node.node_id === record(original).node_id)
      if (!parent || typeof parent.node_id !== 'string' || parent.snippet_scope !== 'symbol'
        || typeof parent.label !== 'string') continue
      const source = sourceFor(parent), proof = source ? verifyNode(parent, nodes, source) : null
      if (!source || !proof || !proof.omitted.length
        || !validOwner(source, proof.range, parent.label, 'symbol')
        || sourceDeclarationKind(source.lines, { start: proof.range.start_line, end: proof.range.end_line }, parent.label, source.logical) !== 'function') continue
      const lineCount = proof.range.end_line - proof.range.start_line + 1
      if (completedLines + lineCount > MAX_LINES_PER_CALL) continue
      // Completing a parent also changes the representation of its children.
      // Respect exclusions across that whole owner, including already delivered
      // children that were filtered out of the coalescing candidates below.
      const fullText = source.lines.slice(proof.range.start_line - 1, proof.range.end_line).join('\n')
      if (sourceExclusions.matchesText(fullText)) continue
      const verified = nodes.flatMap(node => {
        const current = sourceFor(node), checked = current ? verifyNode(node, nodes, current) : null
        return checked ? [checked] : []
      })
      const delivered = union(verified.filter(entry => identity(entry.source) === identity(source)).flatMap(entry => entry.delivered))
      const additional = subtract([proof.range], delivered)
      if (!additional.length || additional.some(range => sourceExclusions.matchesText(source.lines.slice(range.start_line - 1, range.end_line).join('\n')))) continue
      const children = verified.filter(child => child.node !== parent && child.node.source_file === parent.source_file
        && child.node.snippet_scope === 'symbol' && typeof child.node.node_id === 'string' && typeof child.node.label === 'string'
        && child.node.snippet_truncated !== true && !child.omitted.length
        && child.range.start_line >= proof.range.start_line && child.range.end_line <= proof.range.end_line
        && (child.range.start_line > proof.range.start_line || child.range.end_line < proof.range.end_line)
        && validOwner(child.source, child.range, child.node.label, 'symbol'))
      if (!children.length) continue
      const beforeText = nodes.map(node => resolveSourceSnippet(node, nodes))
      const trial = clone(result), trialNodes = nodesOf(trial), index = nodes.indexOf(parent), target = trialNodes[index]!
      target.snippet = fullText
      delete target.snippet_ref
      delete target.snippet_omitted_ranges
      delete target.snippet_truncated
      // The complete owner now directly includes every line pending in its
      // continuation. All other handles retain their original identity.
      delete target.source_expand_handle
      if (Object.hasOwn(target, 'snippet_line_number')) target.snippet_line_number = proof.range.start_line
      for (const child of children) {
        const entry = trialNodes[nodes.indexOf(child.node)]!
        delete entry.snippet
        entry.snippet_ref = parent.node_id
      }
      const trialPack = record(trial.pack)
      if (!Object.hasOwn(trialPack, 'snippet_references')) {
        trialPack.snippet_references = "snippet_ref points to node_id; select this node's snippet_line_range from that source. Equal ranges share the excerpt."
      }
      // Strict containment prevents new reference cycles. Recheck every old
      // reference too: completing its target must not silently change its text.
      if (trialNodes.some((node, position) => resolveSourceSnippet(node, trialNodes) !== (position === index ? fullText : beforeText[position]))) continue
      const count = recount(trial, maxTokens)
      if (count > maxTokens || count >= currentTokens) continue
      result = trial; currentTokens = count; completedLines += lineCount
    }
    if (result === payload) return payload
    for (const [path, before] of sources) if (before) {
      const after = readSource(path, rootPath)
      if (after.hash !== before.hash || after.canonical !== before.canonical || after.realRoot !== before.realRoot) return payload
    }
    return result
  } catch { return payload }
}

/** Add verified syntax only into spare final wire space; never rerun selection or evict source. */
export function completeSourceExcerptGuards(
  payload: RecordValue, maxTokens: number, rootPath: string, prompt: string,
  lookupHandle: (id: string) => SourceContinuationHandle | undefined,
  storeHandle: (id: string, handle: SourceContinuationHandle) => void,
  configurationFresh: () => boolean,
): RecordValue {
  const pack = record(payload.pack)
  if (Object.keys(record(payload.serialized_budget)).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))) return payload
  if (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_SOURCE_EVIDENCE_BUDGET
    || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || payload.task !== 'explain'
    || payload.mode === 'delta' || payload.delta_session_id || payload.verbose === true || !fresh(payload.governance)
    || pack.selection_scope !== 'task_context' || (pack.retrieval_strategy && pack.retrieval_strategy !== 'default')
    || record(record(payload.evidence).answerability).broad_search_fallback === 'blocked'
    || !Array.isArray(pack.matched_nodes)) return payload
  const exclusions = extractPromptExclusions(prompt)
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  if (!sourceExclusions.valid) return payload
  const nodesOf = (value: RecordValue): RecordValue[] => record(value.pack).matched_nodes as RecordValue[]
  const originals = nodesOf(payload)
  if (originals.some(node => typeof record(node).node_id !== 'string')
    || new Set(originals.map(node => node.node_id)).size !== originals.length) return payload
  const sources = new Map<string, SourceRead | null>()
  let sourceBytes = 0
  const sourceFor = (node: RecordValue): SourceRead | null => {
    if (typeof node.source_file !== 'string' || typeof node.label !== 'string'
      || sourceExclusions.matchesSource(resolve(rootPath, node.source_file), node.label)) return null
    const path = resolve(rootPath, node.source_file)
    if (exclusions.excludedDomains.includes(classifySourceDomain(path, rootPath) as never)) return null
    if (!sources.has(path)) {
      if (sources.size >= MAX_SOURCE_PROBES || sourceBytes >= 1024 * 1024) return null
      try {
        const canonical = sourcePathForEvidence(path, rootPath), realRoot = fs.realpathSync(rootPath)
        if (!canonical || exclusions.excludedDomains.includes(classifySourceDomain(canonical, realRoot) as never)
          || sourceExclusions.matchesPath(canonical, realRoot)) { sources.set(path, null); return null }
        const bytes = fs.statSync(canonical).size
        if (bytes > 1024 * 1024 - sourceBytes) { sources.set(path, null); return null }
        const source = readSource(node.source_file, rootPath)
        sourceBytes += Math.max(bytes, Buffer.byteLength(source.lines.join('\n')))
        sources.set(path, sourceBytes > 1024 * 1024
          || exclusions.excludedDomains.includes(classifySourceDomain(source.canonical, source.realRoot) as never)
          || sourceExclusions.matchesPath(source.canonical, source.realRoot) ? null : source)
      } catch { sources.set(path, null) }
    }
    return sources.get(path) ?? null
  }
  const staged = new Map<string, SourceContinuationHandle>()
  const legacySyntax = new Map<string, Range[]>()
  let result = payload, addedLines = 0, trials = 0
  try {
    if (!configurationFresh()) return payload
    // Reserve the full legacy guard result before spending any remaining
    // shared trial/line allowance on optional branch exits. Otherwise an early
    // exit could crowd out a later owner's previously admitted guard syntax.
    for (const includeTerminalSiblings of [false, true]) {
      for (const original of originals) {
        const nodes = nodesOf(result), node = nodes.find(value => value.node_id === original.node_id)
        if (!node || node.snippet_scope !== 'symbol' || typeof node.label !== 'string'
          || node.snippet_ref || nodes.some(value => value.snippet_ref === node.node_id)) continue
        if (++trials > 32) break
        const source = sourceFor(node), proof = source ? verifyNode(node, nodes, source) : null
        if (!source || !proof || !proof.omitted.length || !validOwner(source, proof.range, node.label, 'symbol')
          || sourceDeclarationKind(source.lines, { start: proof.range.start_line, end: proof.range.end_line }, node.label, source.logical) !== 'function') continue
        // Optional exits must originate in the initial excerpt, not in source
        // supplied by this function's earlier guard completion.
        const initialProof = includeTerminalSiblings ? verifyNode(original, originals, source) : proof
        if (!initialProof || JSON.stringify(initialProof.range) !== JSON.stringify(proof.range)) continue
        const syntax = sourceExcerptGuardRanges(source.lines, source.logical, node.label, proof.range, initialProof.delivered,
          { includeTerminalSiblings })
        if (!syntax?.length) continue
        if (!includeTerminalSiblings) legacySyntax.set(String(node.node_id), syntax)
        else {
          const baselineSyntax = legacySyntax.get(String(node.node_id))
          if (!baselineSyntax) continue
          // A failed or empty optional scan returns legacy syntax. Do not use
          // the second phase to retry unrelated guard-only budget refusals.
          const terminalDelta = subtract(subtract(union(syntax), union(baselineSyntax)),
            union([...initialProof.delivered, ...proof.delivered]))
          if (!terminalDelta.length) continue
        }
        const delivered = union([...proof.delivered, ...syntax]), additional = subtract(delivered, proof.delivered)
        const count = additional.reduce((sum, range) => sum + range.end_line - range.start_line + 1, 0)
        if (!count || addedLines + count > MAX_LINES_PER_CALL
          || additional.some(range => sourceExclusions.matchesText(source.lines.slice(range.start_line - 1, range.end_line).join('\n')))) continue
        const trial = clone(result), trialNodes = nodesOf(trial), target = trialNodes[nodes.indexOf(node)]!
        const rendered = render(source.lines, proof.range, delivered)
        target.snippet = rendered.snippet
        if (rendered.omitted.length) target.snippet_omitted_ranges = rendered.omitted
        else { delete target.snippet_omitted_ranges; delete target.snippet_truncated }
        const updates = new Map<string, SourceContinuationHandle>()
        let handlesValid = true
        for (let index = 0; index < nodes.length; index++) {
          const prior = nodes[index]!
          if (typeof prior.source_expand_handle !== 'string' || typeof prior.source_file !== 'string'
            || resolve(rootPath, prior.source_file) !== source.logical) continue
          const handle = staged.get(prior.source_expand_handle) ?? lookupHandle(prior.source_expand_handle)
          const checked = verifyNode(prior, nodes, source)
          if (!isSourceContinuationHandle(handle) || !checked || handle.node_id !== prior.node_id || handle.label !== prior.label
            || handleId(handle) !== prior.source_expand_handle || handle.scope !== prior.snippet_scope
            || handle.logical_root !== resolve(rootPath) || handle.real_root !== source.realRoot || handle.canonical_file !== source.canonical
            || resolve(rootPath, handle.source_file) !== source.logical || handle.file_sha256 !== source.hash
            || JSON.stringify(handle.owner_range) !== JSON.stringify(checked.range)
            || subtract(handle.pending_ranges, checked.omitted).length) { handlesValid = false; break }
          const pending = subtract(handle.pending_ranges, additional)
          if (JSON.stringify(pending) === JSON.stringify(handle.pending_ranges)) continue
          const changed = trialNodes[index]!
          if (!pending.length) delete changed.source_expand_handle
          else {
            const next = { ...clone(handle), pending_ranges: pending }, id = handleId(next)
            changed.source_expand_handle = id
            updates.set(id, next)
          }
        }
        if (!handlesValid || trialNodes.some((entry, index) => index !== nodes.indexOf(node)
          && resolveSourceSnippet(entry, trialNodes) !== resolveSourceSnippet(nodes[index]!, nodes))) continue
        if (recount(trial, maxTokens) > maxTokens) continue
        result = trial; addedLines += count
        for (const [id, handle] of updates) staged.set(id, handle)
      }
    }
    if (result === payload || !configurationFresh()) return payload
    for (const [path, prior] of sources) if (prior) {
      const current = readSource(path, rootPath)
      if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot) return payload
    }
    if (!configurationFresh()) return payload
    const referenced = new Set(nodesOf(result).map(node => node.source_expand_handle))
    for (const [id, handle] of staged) if (referenced.has(id)) storeHandle(id, clone(handle))
    return result
  } catch { return payload }
}

/** Append a complete function used as a visible value, without asserting its invocation. */
export function completeSourceFunctionValueReferences(
  payload: RecordValue, maxTokens: number, rootPath: string, prompt: string,
  references: readonly SourceFunctionValueReference[],
  lookupHandle: (id: string) => SourceContinuationHandle | undefined,
  storeHandle: (id: string, handle: SourceContinuationHandle) => void,
  configurationFresh: () => boolean,
  options: { scoped?: boolean; onVerificationFailure?: () => void } = {},
): RecordValue {
  const pack = record(payload.pack)
  if (Object.keys(record(payload.serialized_budget)).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || !Number.isSafeInteger(maxTokens) || maxTokens < MIN_SOURCE_EVIDENCE_BUDGET
    || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || payload.task !== 'explain'
    || payload.mode === 'delta' || payload.delta_session_id || payload.verbose === true || !fresh(payload.governance)
    || pack.selection_scope !== 'task_context' || (pack.retrieval_strategy && pack.retrieval_strategy !== 'default')
    || record(record(payload.evidence).answerability).broad_search_fallback === 'blocked'
    || !Array.isArray(pack.matched_nodes) || !references.length || references.length > 4096) return payload
  const originals = pack.matched_nodes as RecordValue[]
  if (originals.some(node => typeof record(node).node_id !== 'string')
    || new Set(originals.map(node => node.node_id)).size !== originals.length) return payload
  const scopedPaths = options.scoped ? new Set(classifyRetrievalLevel({ prompt }).signals.mentioned_paths.map(path => resolve(rootPath, path))) : undefined
  const requestedNames = options.scoped ? new Set(sourceQuerySymbols(extractPromptExclusions(prompt).positivePrompt).map(occurrence => occurrence.name)) : undefined
  if (options.scoped && (originals.length > 128 || !scopedPaths || scopedPaths.size < 2 || scopedPaths.size > 8)) return payload
  const scopedTargets = new Set<string>()
  const exclusions = extractPromptExclusions(prompt)
  const sourceExclusions = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  if (!sourceExclusions.valid) return payload
  const sources = new Map<string, SourceRead>(), staged = new Map<string, SourceContinuationHandle>()
  let bytes = 0, addedLines = 0, result = payload, boundReached = false
  const verificationFailure = (): void => { if (options.scoped) options.onVerificationFailure?.() }
  const nodesOf = (value: RecordValue): RecordValue[] => record(value.pack).matched_nodes as RecordValue[]
  const read = (file: string): SourceRead => {
    const path = resolve(rootPath, file)
    if (!sources.has(path)) {
      if (sources.size >= MAX_SOURCE_PROBES) { boundReached = true; throw new Error('Function reference source bound exceeded') }
      const source = readSource(file, rootPath)
      bytes += Buffer.byteLength(source.lines.join('\n'))
      if (bytes > 1024 * 1024) { boundReached = true; throw new Error('Function reference byte bound exceeded') }
      sources.set(path, source)
    }
    return sources.get(path)!
  }
  const permitted = (source: SourceRead, label: string): boolean => !sourceExclusions.matchesSource(source.logical, label)
    && !sourceExclusions.matchesPath(source.canonical, source.realRoot)
    && !exclusions.excludedDomains.includes(classifySourceDomain(source.logical, rootPath) as never)
    && !exclusions.excludedDomains.includes(classifySourceDomain(source.canonical, source.realRoot) as never)
  const exactFunction = (source: SourceRead, owner: SourceFunctionValueReference['target']): boolean => {
    if (!validRange(owner.range) || !validOwner(source, owner.range, owner.label, 'symbol')
      || sourceDeclarationKind(source.lines, { start: owner.range.start_line, end: owner.range.end_line }, owner.label, source.logical) !== 'function') return false
    const range = resolveSourceSymbolRange(source.lines, { start: owner.range.start_line, end: owner.range.end_line }, owner.label, source.logical)
    return range?.start === owner.range.start_line && range.end === owner.range.end_line
  }
  try {
    if (!configurationFresh()) return payload
    for (const reference of references) {
      if (options.scoped && (!reference || typeof reference !== 'object')) return payload
      const caller = record(reference.caller), target = record(reference.target), occurrence = record(reference.read)
      if (![caller, target].every(owner => typeof owner.node_id === 'string' && typeof owner.label === 'string'
        && typeof owner.source_file === 'string' && validRange(owner.range))
        || !Number.isSafeInteger(occurrence.start_offset) || !Number.isSafeInteger(occurrence.end_offset)) {
        if (options.scoped) return payload
        continue
      }
      if (options.scoped && (!scopedPaths!.has(resolve(rootPath, String(caller.source_file)))
        || resolve(rootPath, String(caller.source_file)) !== resolve(rootPath, String(target.source_file))
        || reference.target.range.end_line - reference.target.range.start_line >= 16)) continue
      const original = originals.find(node => node.node_id === caller.node_id)
      if (!original || original.label !== caller.label || typeof original.source_file !== 'string'
        || resolve(rootPath, original.source_file) !== resolve(rootPath, String(caller.source_file))
        || nodesOf(result).some(node => node.node_id === target.node_id)) continue
      if (!Array.isArray(reference.source_dependencies) || !reference.source_dependencies.length
        || reference.source_dependencies.length > MAX_SOURCE_PROBES
        || ![caller, target].every(owner => reference.source_dependencies.some(input => resolve(rootPath, input.source_file) === resolve(rootPath, String(owner.source_file))))
        || !reference.source_dependencies.every(input => {
          if (typeof input.source_file !== 'string' || !/^[a-f0-9]{64}$/.test(input.source_sha256)) return false
          if (digest(read(input.source_file).lines.join('\n')) !== input.source_sha256) { verificationFailure(); return false }
          return true
        })) continue
      const callerSource = read(String(caller.source_file)), targetSource = read(String(target.source_file))
      const proof = verifyNode(original, originals, callerSource)
      if (!proof) verificationFailure()
      if (!proof || original.snippet_scope !== 'symbol' || !permitted(callerSource, String(caller.label))
        || JSON.stringify(proof.range) !== JSON.stringify(caller.range)
        || !exactFunction(callerSource, reference.caller) || !exactFunction(targetSource, reference.target)
        || !permitted(targetSource, String(target.label))) continue
      if (options.scoped && (!requestedNames!.has(sourceDeclarationQualifiedName(callerSource.lines,
        { start: proof.range.start_line, end: proof.range.end_line }, String(caller.label), callerSource.logical) ?? '')
        || callerSource.canonical !== targetSource.canonical)) continue
      const text = callerSource.lines.join('\n'), start = Number(occurrence.start_offset), end = Number(occurrence.end_offset)
      if (start < 0 || end <= start || end > text.length) continue
      const readRange = { start_line: text.slice(0, start).split('\n').length, end_line: text.slice(0, end - 1).split('\n').length }
      if (readRange.start_line < proof.range.start_line || readRange.end_line > proof.range.end_line
        || subtract([readRange], proof.delivered).length) continue
      const targetRange = reference.target.range, count = targetRange.end_line - targetRange.start_line + 1
      const snippet = targetSource.lines.slice(targetRange.start_line - 1, targetRange.end_line).join('\n')
      if (addedLines + count > MAX_LINES_PER_CALL || sourceExclusions.matchesText(snippet)) continue
      const nodes = options.scoped ? originals : nodesOf(result), delivered = nodes.flatMap(node => {
        if (typeof node.source_file !== 'string' || read(node.source_file).canonical !== targetSource.canonical) return []
        return verifyNode(node, nodes, targetSource)?.delivered ?? []
      })
      if (!subtract([targetRange], union(delivered)).length) continue
      if (options.scoped) {
        scopedTargets.add(String(target.node_id))
        if (scopedTargets.size > 1) return payload
      }
      const trial = clone(result), trialNodes = nodesOf(trial), updates = new Map<string, SourceContinuationHandle>()
      let handlesValid = true
      for (let index = 0; index < nodes.length; index++) {
        const prior = nodes[index]!
        if (typeof prior.source_expand_handle !== 'string' || typeof prior.source_file !== 'string'
          || read(prior.source_file).canonical !== targetSource.canonical) continue
        const handle = staged.get(prior.source_expand_handle) ?? lookupHandle(prior.source_expand_handle)
        const checked = verifyNode(prior, nodes, targetSource)
        if (!isSourceContinuationHandle(handle) || !checked || handle.node_id !== prior.node_id || handle.label !== prior.label
          || handleId(handle) !== prior.source_expand_handle || handle.scope !== prior.snippet_scope
          || handle.logical_root !== resolve(rootPath) || handle.real_root !== targetSource.realRoot || handle.canonical_file !== targetSource.canonical
          || resolve(rootPath, handle.source_file) !== resolve(rootPath, prior.source_file) || handle.file_sha256 !== targetSource.hash
          || JSON.stringify(handle.owner_range) !== JSON.stringify(checked.range)
          || subtract(handle.pending_ranges, checked.omitted).length) { handlesValid = false; break }
        const pending = subtract(handle.pending_ranges, [targetRange])
        if (JSON.stringify(pending) === JSON.stringify(handle.pending_ranges)) continue
        if (!pending.length) delete trialNodes[index]!.source_expand_handle
        else {
          const next = { ...clone(handle), pending_ranges: pending }, id = handleId(next)
          trialNodes[index]!.source_expand_handle = id; updates.set(id, next)
        }
      }
      if (!handlesValid) continue
      trialNodes.push({ node_id: target.node_id, label: target.label, source_file: relative(rootPath, targetSource.logical).split(sep).join('/'),
        line_number: targetRange.start_line, snippet, snippet_scope: 'symbol', snippet_line_range: { ...targetRange } })
      if (nodes.some((node, index) => resolveSourceSnippet(node, nodes) !== resolveSourceSnippet(trialNodes[index]!, trialNodes))
        || recount(trial, maxTokens) > maxTokens) continue
      result = trial; addedLines += count
      for (const [id, handle] of updates) staged.set(id, handle)
    }
    if (result === payload || !configurationFresh()) return payload
    for (const [path, prior] of sources) {
      const current = readSource(path, rootPath)
      if (current.hash !== prior.hash || current.canonical !== prior.canonical || current.realRoot !== prior.realRoot
        || options.scoped && current.policyFingerprint !== prior.policyFingerprint) { verificationFailure(); return payload }
    }
    if (!configurationFresh()) return payload
    const referenced = new Set(nodesOf(result).map(node => node.source_expand_handle))
    for (const [id, handle] of staged) if (referenced.has(id)) storeHandle(id, clone(handle))
    return result
  } catch { if (!boundReached) verificationFailure(); return payload }
}

/** Add complete, current callsites. Optional joint allocation can exchange one disconnected helper. */
export function finalizeSourceCallsiteCompletion(
  payload: RecordValue, maxTokens: number, rootPath: string, bundles: readonly SourceCallsiteBundle[],
  store: (id: string, handle: SourceContinuationHandle) => void,
  configurationFresh: () => boolean = () => true,
  allocation?: { prompt: string },
): RecordValue {
  // Trial handles must never enter the session store. Even the baseline is staged
  // until we know which exact source ranges will be emitted.
  const stage = (input: RecordValue) => {
    const handles = new Map<string, SourceContinuationHandle>()
    return { payload: attachSourceContinuationHandles(input, maxTokens, rootPath, (id, handle) => handles.set(id, handle)), handles }
  }
  const baseline = stage(payload)
  const commit = (result: ReturnType<typeof stage>): RecordValue => {
    for (const [id, handle] of result.handles) store(id, handle)
    return result.payload
  }
  if (payload.task !== 'explain' || payload.verbose === true || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT
    || payload.mode === 'delta' || payload.delta_session_id || !fresh(payload.governance)
    || record(record(payload.evidence).answerability).broad_search_fallback === 'blocked'
    || !bundles.length || bundles.length > 4096) return commit(baseline)
  const nodesOf = (value: RecordValue): RecordValue[] => Array.isArray(record(value.pack).matched_nodes)
    ? record(value.pack).matched_nodes as RecordValue[] : []
  const originalNodes = nodesOf(payload)
  // Existing handle cursors and shared excerpt references need their own update
  // semantics. The first implementation conservatively leaves these untouched.
  if (originalNodes.some(node => node.source_expand_handle)) return commit(baseline)
  const protectedHandles = nodesOf(baseline.payload).filter(node => node.source_expand_handle).map(node => node.node_id)
  const sources = new Map<string, SourceRead>()
  let sourceBytes = 0
  const read = (file: string): SourceRead => {
    const path = resolve(rootPath, file)
    if (!sources.has(path)) {
      if (sources.size >= MAX_SOURCE_PROBES) throw new Error('Callsite source read bound exceeded')
      const source = readSource(file, rootPath)
      sourceBytes += Buffer.byteLength(source.lines.join('\n'))
      if (sourceBytes > 1024 * 1024) throw new Error('Callsite source byte bound exceeded')
      sources.set(path, source)
    }
    return sources.get(path)!
  }
  let current = payload, selected = baseline, trials = 0, exchanged = false
  try {
    if (!configurationFresh()) return commit(baseline)
    for (const bundle of bundles) {
      const nodes = nodesOf(current)
      const caller = nodes.find(node => node.node_id === bundle.from_id)
      const callee = nodes.find(node => node.node_id === bundle.to_id)
      const edges = record(current.pack).relationships
      if (!caller || !callee || caller === callee || typeof caller.source_file !== 'string'
        || typeof callee.source_file !== 'string' || typeof caller.label !== 'string'
        || caller.snippet_ref || nodes.some(node => node.snippet_ref === caller.node_id)
        || !Array.isArray(edges) || !edges.some(value => {
          const edge = record(value)
          return edge.relation === 'calls' && edge.from_id === bundle.from_id && edge.to_id === bundle.to_id
        })) continue
      if (++trials > 32) break
      if (!bundle.source_dependencies.length || bundle.source_dependencies.length > MAX_SOURCE_PROBES
        || !bundle.source_dependencies.some(input => resolve(rootPath, input.source_file) === resolve(rootPath, caller.source_file as string))
        || !bundle.source_dependencies.some(input => resolve(rootPath, input.source_file) === resolve(rootPath, callee.source_file as string))) continue
      if (!bundle.source_dependencies.every(input => digest(read(input.source_file).lines.join('\n')) === input.source_sha256)) continue
      const source = read(caller.source_file), proof = verifyNode(caller, nodes, source)
      if (!proof || !proof.omitted.length || !validOwner(source, proof.range, caller.label, caller.snippet_scope)
        || resolve(rootPath, bundle.source_file) !== resolve(rootPath, caller.source_file)
        || digest(source.lines.join('\n')) !== bundle.source_sha256
        || !verifyNode(callee, nodes, read(callee.source_file))
        || !validRanges(bundle.ranges, proof.range) || !bundle.sites.length) continue
      const text = source.lines.join('\n')
      if (bundle.sites.length > 4096 || !bundle.sites.every(site => {
        if (!Number.isSafeInteger(site.start_offset) || !Number.isSafeInteger(site.end_offset)
          || site.start_offset < 0 || site.end_offset <= site.start_offset || site.end_offset > text.length) return false
        const start = text.slice(0, site.start_offset).split('\n').length
        const end = text.slice(0, site.end_offset - 1).split('\n').length
        return bundle.ranges.some(range => range.start_line <= start && range.end_line >= end)
      })) continue
      const delivered = union([...proof.delivered, ...bundle.ranges])
      if (JSON.stringify(delivered) === JSON.stringify(proof.delivered)) continue
      let trial = clone(current)
      const target = nodesOf(trial)[nodes.indexOf(caller)]!
      const rendered = render(source.lines, proof.range, delivered)
      target.snippet = rendered.snippet
      if (rendered.omitted.length) target.snippet_omitted_ranges = rendered.omitted
      else { delete target.snippet_omitted_ranges; delete target.snippet_truncated }
      let exchange = false
      if (recount(trial, maxTokens) > maxTokens) {
        if (!allocation || exchanged) continue
        const replacement = omitDisconnectedSourceForCallsite(trial, { rootPath, prompt: allocation.prompt })
        if (!replacement || recount(replacement, maxTokens) > maxTokens) continue
        trial = replacement; exchange = true
      }
      const staged = stage(trial)
      // An addition cannot spend the budget previously allocated to a recovery
      // handle unless that owner's missing source is now completely delivered.
      if (protectedHandles.some(id => {
        const node = nodesOf(staged.payload).find(value => value.node_id === id)
        return !node || (!node.source_expand_handle && Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0)
      })) continue
      current = trial; selected = staged; exchanged ||= exchange
    }
    if (selected !== baseline) {
      if (!configurationFresh()) return commit(baseline)
      // Content identity, not mtime, binds every source input to this addition.
      for (const [path, prior] of sources) {
        const latest = readSource(path, rootPath)
        if (latest.canonical !== prior.canonical || latest.realRoot !== prior.realRoot || latest.hash !== prior.hash) return commit(baseline)
      }
    }
  } catch { return commit(baseline) }
  return commit(selected)
}

/** Start source pagination only from an already selected, exact current owner. */
export function beginSourceContinuation(
  owner: { node_id: string; label: string; source_file: string; range: Range; snippet: string },
  context: RecordValue, budget: number, rootPath: string,
): ReturnType<typeof expandSourceContinuation> {
  requireBudget(budget)
  if (!fresh(context.governance)) throw new Error('Source continuation refused stale or unknown source freshness; request a new context pack')
  const evidence = clone(record(context.evidence)), answerability = record(evidence.answerability)
  if (answerability.broad_search_fallback === 'blocked') throw new Error('Source continuation is blocked by its evidence policy')
  if (!owner.node_id || !owner.label || !validRange(owner.range)) throw new Error('Source continuation requires a verified source owner')
  const source = readSource(owner.source_file, rootPath)
  if (!validOwner(source, owner.range, owner.label, 'symbol')
    || sourceDeclarationKind(source.lines, { start: owner.range.start_line, end: owner.range.end_line }, owner.label, source.logical) !== 'function'
    || source.lines.slice(owner.range.start_line - 1, owner.range.end_line).join('\n') !== owner.snippet) {
    throw new Error('Source continuation source changed or does not match its selected owner; request a new context pack')
  }
  evidence.answerability = { ...answerability, state: 'insufficient', answer_scope: 'partial', advisory: true }
  const handle: SourceContinuationHandle = {
    kind: 'source_continuation', version: 1,
    source_file: relative(resolve(rootPath), source.logical).split(sep).join('/'),
    logical_root: resolve(rootPath), real_root: source.realRoot, canonical_file: source.canonical,
    file_sha256: source.hash, owner_range: { ...owner.range }, pending_ranges: [{ ...owner.range }],
    node_id: owner.node_id, label: owner.label, scope: 'symbol', evidence,
    ...(typeof context.task === 'string' ? { task: context.task } : {}),
    ...(typeof context.task_intent === 'string' ? { task_intent: context.task_intent } : {}),
  }
  return expandSourceContinuation(handle, budget, rootPath, context.governance)
}

export function expandSourceContinuation(
  handle: SourceContinuationHandle, budget: number, rootPath: string, governance: unknown,
): { payload: RecordValue; child?: { id: string; handle: SourceContinuationHandle } } {
  requireBudget(budget)
  if (!isSourceContinuationHandle(handle)) throw new Error('Malformed source continuation handle')
  if (!fresh(governance)) throw new Error('Source continuation refused stale or unknown source freshness; request a new context pack')
  if (record(handle.evidence.answerability).broad_search_fallback === 'blocked') throw new Error('Source continuation is blocked by its evidence policy')
  if (resolve(rootPath) !== handle.logical_root) throw new Error('Source continuation belongs to a different source root')
  const source = readSource(handle.source_file, rootPath)
  if (source.realRoot !== handle.real_root || source.canonical !== handle.canonical_file || source.hash !== handle.file_sha256
    || !validOwner(source, handle.owner_range, handle.label, handle.scope)) throw new Error('Source continuation source changed, moved, or was retargeted; request a new context pack')
  const available: number[] = []
  for (const range of handle.pending_ranges) {
    for (let line = range.start_line; line <= range.end_line && available.length < MAX_LINES_PER_CALL; line++) available.push(line)
    if (available.length === MAX_LINES_PER_CALL) break
  }
  const base = (): RecordValue => ({ response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
    ...(handle.task ? { task: handle.task } : {}), ...(handle.task_intent ? { task_intent: handle.task_intent } : {}),
    evidence: clone(handle.evidence), governance: clone(governance), pack: { matched_nodes: [] } })
  const build = (count: number): { payload: RecordValue; child?: { id: string; handle: SourceContinuationHandle } } => {
    const delivered = union(available.slice(0, count).map(line => ({ start_line: line, end_line: line })))
    const remaining = subtract(handle.pending_ranges, delivered), rendered = render(source.lines, handle.owner_range, delivered)
    const childHandle = remaining.length ? { ...clone(handle), pending_ranges: remaining } : undefined
    const child = childHandle ? { id: handleId(childHandle), handle: childHandle } : undefined
    const payload = base()
    // Zero remaining lines exhausts this handle's source, not the task's evidence obligations.
    payload.source_continuation = { delivered_lines: count,
      remaining_lines: remaining.reduce((total, range) => total + range.end_line - range.start_line + 1, 0) }
    record(payload.pack).matched_nodes = [{ node_id: handle.node_id, label: handle.label, source_file: handle.source_file,
      line_number: handle.owner_range.start_line, snippet: rendered.snippet, snippet_scope: handle.scope,
      snippet_line_range: { ...handle.owner_range }, snippet_truncated: rendered.omitted.length > 0,
      ...(rendered.omitted.length ? { snippet_omitted_ranges: rendered.omitted } : {}),
      ...(handle.node_kind ? { node_kind: handle.node_kind } : {}),
      ...(child ? { source_expand_handle: child.id } : {}),
    }]
    recount(payload, budget)
    return { payload, ...(child ? { child } : {}) }
  }
  // Check the whole pending prefix first: completing it can remove the child-handle overhead.
  const whole = build(available.length)
  if (Number(record(whole.payload.serialized_budget).token_count) <= budget) return whole
  let low = 1, high = available.length - 1
  let best: ReturnType<typeof build> | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), trial = build(middle)
    if (Number(record(trial.payload.serialized_budget).token_count) <= budget) { best = trial; low = middle + 1 }
    else high = middle - 1
  }
  if (best) return best
  const insufficient = base()
  insufficient.source_continuation_status = 'budget_insufficient'
  if (recount(insufficient, budget) <= budget) return { payload: insufficient }
  // The handle retains all obligations; a tiny envelope explicitly withholds them, never resolves them.
  const answerability = record(handle.evidence.answerability)
  const minimal: RecordValue = {
    source_continuation_status: 'budget_insufficient',
    evidence: { answerability: { state: 'insufficient', advisory: true,
      ...(answerability.answer_scope === 'partial' ? { answer_scope: 'partial' } : {}),
      broad_search_fallback: answerability.broad_search_fallback === 'blocked' ? 'blocked' : 'allowed' } },
    limitations: { graph: 'fresh', source: 'fresh', prior_evidence_obligations: 'retained_in_handle; not_reassessed' },
  }
  if (recount(minimal, budget) > budget) throw new Error('Source continuation budget cannot carry its required status')
  return { payload: minimal }
}
