import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { extractPromptExclusions, retrievalSearchPrompt } from '../retrieval-gate.js'
import { tokenizeQuestion } from './pipeline.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceBodyWords, sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import { renderSourceFragment } from './source-fragments.js'
import { sourceModuleConfigurationSnapshotIsFresh, type SourceModuleConfigurationSnapshot } from './source-modules.js'
import type { SourceSelectionProvenance } from './source-selection-provenance.js'

type Range = { start_line: number; end_line: number }
interface Candidate { id: string; label: string; sourceFile: string; sourceLocation: string | null }
type Declaration = ts.FunctionDeclaration | ts.MethodDeclaration | ts.VariableDeclaration
type Site = NonNullable<SourceSelectionProvenance['observed_sites']>[number]
type Owner<T> = { candidate: T; source: ts.SourceFile; lines: string[]; declaration: Declaration;
  range: { start: number; end: number }; hash: string }
export interface SourceCoherentContinuationOwner {
  node_id: string
  label: string
  source_file: string
  source_sha256: string
  owner_range: Range
  /** These spans alone authorize continuation; owner_range does not authorize its omitted gaps. */
  retained_ranges: Range[]
  snippet: string
  snippet_omitted_ranges: Range[]
}
export interface SourceCoherentContinuationCatalog {
  version: 1
  /** Discovery stopped at its existing inspection bound; never a completeness claim. */
  bounded: boolean
  root_path: string
  real_root: string
  configuration: SourceModuleConfigurationSnapshot
  source_dependencies: Array<{ source_file: string; source_sha256: string; canonical_file: string }>
  owners: SourceCoherentContinuationOwner[]
  groups: Array<{ anchor_ids: string[]; owner_ids: string[] }>
}
/** Request-private discovery only, never serialized as call or completeness authority. */
export const sourceCoherentContinuationCatalogKey = Symbol('sourceCoherentContinuationCatalog')
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const contains = (outer: Range, inner: Range): boolean => outer.start_line <= inner.start_line && outer.end_line >= inner.end_line
const span = (node: ts.Node, source: ts.SourceFile): Range => ({
  start_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  end_line: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
})
function union(ranges: readonly Range[]): Range[] {
  const result: Range[] = []
  for (const range of [...ranges].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)) {
    const previous = result.at(-1)
    if (previous && range.start_line <= previous.end_line + 1) previous.end_line = Math.max(previous.end_line, range.end_line)
    else result.push({ ...range })
  }
  return result
}

/** No selection, ranking, graph membership or relationship is changed. Positive
 * individual sites guide a bounded later source read; missing sites stay unknown. */
export function buildSourceCoherentContinuationCatalog<T extends Candidate>(
  methods: readonly string[], candidates: readonly T[], question: string,
  provenance: SourceSelectionProvenance | undefined, resolveCandidate: (id: string) => T | undefined,
  allowedPath: (file: string, canonical?: string) => boolean,
  allowedOwner: (file: string, label: string, text: string) => boolean, rootPath?: string,
): SourceCoherentContinuationCatalog | undefined {
  if (!rootPath || !methods.length || methods.length > 12 || new Set(methods).size !== methods.length
    || question.length > 8192 || !provenance?.configuration || !provenance.observed_sites?.length
    || provenance.observed_sites.length > 4096 || provenance.resolved_pairs.length > 8192
    || !(['identity', 'mutation', 'write_origins'] as const).every(scan => provenance.scans[scan] === 'complete')
    || !sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowedPath)) return undefined
  let realRoot: string
  try { realRoot = realpathSync(rootPath) } catch { return undefined }
  if (realRoot !== provenance.configuration.real_root) return undefined
  const inputs = provenance.sources.filter(source => source.in_program)
  if (!inputs.length || inputs.length > 32) return undefined
  const files = new Map<string, { lines: string[]; hash: string; logical: string;
    source?: ts.SourceFile; declarations?: Map<string, Declaration> }>()
  let bytes = 0, visited = 0, bounded = false
  for (const input of inputs) {
    if (!allowedPath(input.source_file)) return undefined
    const canonical = sourcePathForEvidence(input.source_file, rootPath)
    if (!canonical || canonical !== input.canonical_file || !allowedPath(input.source_file, canonical)) return undefined
    const lines = readEvidenceLines(input.source_file, rootPath)
    if (!lines) return undefined
    const text = lines.join('\n'), hash = digest(text), previous = files.get(canonical)
    if ((bytes += Buffer.byteLength(text)) > 1024 * 1024 || hash !== input.source_sha256
      || previous && previous.hash !== hash) return undefined
    files.set(canonical, { lines, hash, logical: input.source_file })
  }
  const unique = new Map(provenance.owners.filter(owner => owner.status === 'unique').map(owner => [owner.node_id, owner]))
  const owners = new Map<string, Owner<T> | null>()
  const ownerFor = (id: string): Owner<T> | undefined => {
    if (bounded) return undefined
    if (owners.has(id)) return owners.get(id) ?? undefined
    if (owners.size >= 32) { bounded = true; return undefined }
    owners.set(id, null)
    const candidate = resolveCandidate(id), proof = unique.get(id)
    if (!candidate || !proof?.declaration_offsets || !allowedPath(candidate.sourceFile)) return undefined
    const canonical = sourcePathForEvidence(candidate.sourceFile, rootPath)
    if (!canonical || !allowedPath(candidate.sourceFile, canonical)) return undefined
    const file = files.get(canonical), indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    if (!file || !indexed || indexed.start !== proof.indexed_range.start || indexed.end !== proof.indexed_range.end
      || resolve(rootPath, proof.source_file) !== resolve(rootPath, candidate.sourceFile)) return undefined
    const range = resolveSourceSymbolRange(file.lines, indexed, candidate.label, canonical)
    if (!range || !allowedOwner(candidate.sourceFile, candidate.label, file.lines.slice(range.start - 1, range.end).join('\n'))) return undefined
    if (!file.source) {
      const source = sourceSyntaxTree(file.lines, canonical), declarations = new Map<string, Declaration>()
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
      const visit = (node: ts.Node): void => {
        if (++visited > 100_000) { bounded = true; return }
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
          declarations.set(`${node.getStart(source)}:${node.getEnd()}`, node)
        }
        if (!bounded) ts.forEachChild(node, visit)
      }
      visit(source); file.source = source; file.declarations = declarations
    }
    const declaration = file.declarations!.get(`${proof.declaration_offsets.start}:${proof.declaration_offsets.end}`)
    if (bounded || !declaration) return undefined
    if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent, statement = list.parent
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isVariableDeclarationList(list)
        || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1
        || !ts.isVariableStatement(statement) || statement.parent !== file.source
        || !contains({ start_line: range.start, end_line: range.end }, span(statement, file.source))) return undefined
    } else if (!declaration.body) return undefined
    const current = { candidate, source: file.source, lines: file.lines, declaration, range, hash: file.hash }
    owners.set(id, current); return current
  }
  const query = new Set(tokenizeQuestion(sourceBodyWords(retrievalSearchPrompt(extractPromptExclusions(question).positivePrompt)).join(' ')))
  const selected = new Map<string, { owner: Owner<T>; ranges: Range[]; full: boolean }>()
  const fullRange = (owner: Owner<T>): Range => ({ start_line: owner.range.start, end_line: owner.range.end })
  const rangesFor = (owner: Owner<T>): Range[] | undefined => {
    if (owner.range.end - owner.range.start + 1 <= 80) return [fullRange(owner)]
    if (ts.isVariableDeclaration(owner.declaration) || !owner.declaration.body || !ts.isBlock(owner.declaration.body)) return undefined
    const body = owner.declaration.body, guards: ts.Statement[] = []
    for (const statement of body.statements) {
      if (!ts.isIfStatement(statement) && !ts.isSwitchStatement(statement) && !ts.isForOfStatement(statement)) continue
      let matched = false
      const visit = (node: ts.Node): void => {
        if (++visited > 100_000) { bounded = true; return }
        if (ts.isTypeNode(node) || ts.isFunctionLike(node) || ts.isClassLike(node)) return
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
          if (sourceBodyWords(node.text).some(term => query.has(term))) matched = true
        }
        if (!bounded) ts.forEachChild(node, visit)
      }
      visit(statement.expression)
      if (ts.isForOfStatement(statement)) visit(statement.initializer)
      if (matched) guards.push(statement)
    }
    if (bounded || !guards.length || guards.length > 4) return undefined
    const leading: ts.Statement[] = []
    for (const statement of body.statements) {
      if (!ts.isVariableStatement(statement)) break
      leading.push(statement)
    }
    // Keep contiguous declaration context immediately before a selected guard.
    // Adjacency supplies readable initialization, never a dependency binding.
    const preceding: ts.Statement[] = []
    for (const guard of guards) for (let index = body.statements.indexOf(guard) - 1; index >= 0; index--) {
      const statement = body.statements[index]!
      if (!ts.isVariableStatement(statement)) break
      preceding.push(statement)
    }
    const last = body.statements.at(-1)
    const ranges = union([{ start_line: owner.range.start, end_line: span(body, owner.source).start_line },
      ...leading.map(node => span(node, owner.source)), ...preceding.map(node => span(node, owner.source)),
      ...guards.map(node => span(node, owner.source)),
      ...(last && ts.isReturnStatement(last) ? [span(last, owner.source)] : []),
      { start_line: span(body, owner.source).end_line, end_line: owner.range.end }])
    return ranges.reduce((n, r) => n + r.end_line - r.start_line + 1, 0) <= 80
      && ranges.reduce((n, r) => n + owner.lines.slice(r.start_line - 1, r.end_line).join('\n').length, 0) <= 12_000 ? ranges : undefined
  }
  const add = (owner: Owner<T>, ranges: Range[]): boolean => {
    if (selected.has(owner.candidate.id)) return true
    if (selected.size >= 32) { bounded = true; return false }
    selected.set(owner.candidate.id, { owner, ranges, full: ranges.length === 1
      && ranges[0]!.start_line === owner.range.start && ranges[0]!.end_line === owner.range.end })
    return true
  }
  const sitesFor = (owner: Owner<T>, ranges: readonly Range[]): Site[] => provenance.observed_sites!
    .filter(site => site.from_id === owner.candidate.id && site.source_sha256 === owner.hash
      && resolve(rootPath, site.source_file) === resolve(rootPath, owner.candidate.sourceFile)
      && site.start_offset >= owner.declaration.getStart(owner.source) && site.end_offset <= owner.declaration.getEnd()
      && site.end_offset > site.start_offset && ranges.some(range => contains(range, {
        start_line: owner.source.getLineAndCharacterOfPosition(site.start_offset).line + 1,
        end_line: owner.source.getLineAndCharacterOfPosition(site.end_offset - 1).line + 1,
      })))
    .sort((a, b) => a.start_offset - b.start_offset || a.end_offset - b.end_offset)
  for (const id of methods) {
    const owner = ownerFor(id)
    if (!owner || ts.isVariableDeclaration(owner.declaration) || owner.range.end - owner.range.start + 1 > 80) return undefined
    add(owner, [fullRange(owner)])
  }
  const ranking = new Map(candidates.map((candidate, index) => [candidate.id, index]))
  const direct = [...new Set(methods.flatMap(id => {
    const entry = selected.get(id)!; return sitesFor(entry.owner, entry.ranges)
      .filter(site => site.kind !== 'data_reference').map(site => site.to_id)
  }))].sort((a, b) => (ranking.get(a) ?? Infinity) - (ranking.get(b) ?? Infinity))
  for (const id of direct) {
    if (bounded) break
    if (selected.has(id)) continue
    const owner = ownerFor(id), ranges = owner ? rangesFor(owner) : undefined
    if (bounded) break
    if (!owner || !ranges || !add(owner, ranges)) continue
    const guardedGap = owner.range.end - owner.range.start + 1 > 80
    for (const site of sitesFor(owner, ranges)) {
      if (bounded) break
      if (site.kind === 'data_reference') continue
      // Complete small direct owners are useful source, not fresh closure
      // roots. Keep their bound function-value arguments without recursively
      // chasing ordinary calls. Two helper levels belong only to a selected
      // guarded source gap; otherwise incidental closures exhaust this catalog.
      if (!guardedGap && site.kind !== 'function_value_argument') continue
      const helper = ownerFor(site.to_id)
      if (!helper || ts.isVariableDeclaration(helper.declaration) || helper.range.end - helper.range.start + 1 > 80) continue
      add(helper, [fullRange(helper)])
      if (!guardedGap) continue
      for (const nested of sitesFor(helper, [fullRange(helper)])) {
        if (bounded) break
        if (nested.kind === 'data_reference') continue
        const target = ownerFor(nested.to_id)
        if (target && !ts.isVariableDeclaration(target.declaration) && target.range.end - target.range.start + 1 <= 80) add(target, [fullRange(target)])
      }
    }
  }
  // An owner-level pair is sufficient only for a complete current caller. A
  // partial caller requires an individually proved visible value-use site.
  // Neither form proves const value immutability or complete dependency discovery.
  for (const entry of [...selected.values()]) {
    if (bounded) break
    const values = entry.full
      ? provenance.resolved_pairs.filter(pair => pair.from_id === entry.owner.candidate.id && pair.kind === 'data_reference')
      : sitesFor(entry.owner, entry.ranges).filter(site => site.kind === 'data_reference')
    for (const value of values) {
      if (bounded) break
      const target = ownerFor(value.to_id)
      if (target && ts.isVariableDeclaration(target.declaration) && target.range.end - target.range.start + 1 <= 80) add(target, [fullRange(target)])
    }
  }
  // A capacity cutoff is not a contradiction of earlier individual proofs.
  // Keep only the fully verified prefix; no partially inspected owner enters it.
  if (selected.size <= methods.length) return undefined
  const entries: SourceCoherentContinuationOwner[] = []
  for (const { owner, ranges } of selected.values()) {
    const rendered = renderSourceFragment(owner.lines, owner.range, { sourceHash: owner.hash, range: owner.range, retained: ranges })
    if (!rendered || !allowedOwner(owner.candidate.sourceFile, owner.candidate.label, rendered.snippet)) return undefined
    entries.push({ node_id: owner.candidate.id, label: owner.candidate.label, source_file: owner.candidate.sourceFile,
      source_sha256: owner.hash, owner_range: rendered.lineRange, retained_ranges: ranges.map(range => ({ ...range })),
      snippet: rendered.snippet, snippet_omitted_ranges: rendered.omittedRanges })
  }
  // No cached source/config read can silently validate discovery after mutation.
  for (const input of inputs) {
    if (!allowedPath(input.source_file)) return undefined
    const canonical = sourcePathForEvidence(input.source_file, rootPath)
    if (!canonical || canonical !== input.canonical_file || !files.has(canonical) || !allowedPath(input.source_file, canonical)) return undefined
    const lines = readEvidenceLines(input.source_file, rootPath)
    if (!lines || digest(lines.join('\n')) !== input.source_sha256) return undefined
  }
  if (!sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowedPath)) return undefined
  try { if (realpathSync(rootPath) !== realRoot) return undefined } catch { return undefined }
  return { version: 1, bounded, root_path: resolve(rootPath), real_root: realRoot, configuration: provenance.configuration,
    source_dependencies: inputs.map(input => ({ source_file: input.source_file, source_sha256: input.source_sha256, canonical_file: input.canonical_file! })),
    owners: entries, groups: [{ anchor_ids: [...methods], owner_ids: entries.map(entry => entry.node_id) }] }
}
