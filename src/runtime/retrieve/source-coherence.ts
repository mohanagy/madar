import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { coherentSourceSnippet, readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationKind, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './source-modules.js'
import type { SourceSelectionProvenance } from './source-selection-provenance.js'

interface SourceCandidate { id: string; label: string; sourceFile: string; sourceLocation: string | null }
type MethodOwner = { candidate: SourceCandidate; method: ts.MethodDeclaration; file: string }

/** Retain an admitted composition caller beside the two classes it connects.
 * Positive current sites guide presentation only, never new call authority. */
export function sourceCompositionPriority(
  independent: readonly SourceCandidate[], candidates: readonly SourceCandidate[],
  provenance: SourceSelectionProvenance | undefined,
  allowedPath: (file: string, canonical?: string) => boolean,
  allowedOwner: (file: string, label: string, text: string) => boolean, rootPath?: string,
): string[] {
  if (!rootPath || !provenance?.configuration || provenance.root_path !== resolve(rootPath)
    || independent.length < 2 || candidates.length > 256 || provenance.owners.length > 100_000
    || !provenance.observed_sites?.length || provenance.observed_sites.length > 4096
    || provenance.resolved_pairs.length > 8192
    || !(['identity', 'mutation', 'write_origins'] as const).every(scan => provenance.scans[scan] === 'complete')) return []
  const leading = independent.slice(0, 2)
  // Ordinary method coherence and function questions keep their existing path.
  if (!leading.every(candidate => {
    if (!allowedPath(candidate.sourceFile)) return false
    const canonical = sourcePathForEvidence(candidate.sourceFile, rootPath)
    if (!canonical || !allowedPath(candidate.sourceFile, canonical)) return false
    const range = lineRangeFromSourceLocation(candidate.sourceLocation)
    const lines = range && readEvidenceLines(candidate.sourceFile, rootPath)
    return range && lines && sourceDeclarationKind(lines, range, candidate.label, candidate.sourceFile) === 'class'
  })) return []
  try { if (realpathSync(rootPath) !== provenance.configuration.real_root) return [] } catch { return [] }
  if (!sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowedPath)) return []
  const inputs = provenance.sources.filter(source => source.in_program)
  if (!inputs.length || inputs.length > 32) return []
  const files = new Map<string, { lines: string[]; hash: string; source: ts.SourceFile }>()
  let bytes = 0, visited = 0
  for (const input of inputs) {
    if (!allowedPath(input.source_file)) return []
    const canonical = sourcePathForEvidence(input.source_file, rootPath)
    if (!canonical || canonical !== input.canonical_file || !allowedPath(input.source_file, canonical)) return []
    const lines = readEvidenceLines(input.source_file, rootPath)
    if (!lines) return []
    const text = lines.join('\n'), hash = createHash('sha256').update(text).digest('hex')
    if ((bytes += Buffer.byteLength(text)) > 1024 * 1024 || hash !== input.source_sha256) return []
    const source = sourceSyntaxTree(lines, canonical)
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return []
    files.set(canonical, { lines, hash, source })
  }
  const owners = new Map(provenance.owners.map(owner => [owner.node_id, owner]))
  const ownerFor = (candidate: SourceCandidate) => {
    if (!allowedPath(candidate.sourceFile)) return undefined
    const proof = owners.get(candidate.id), indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    const canonical = sourcePathForEvidence(candidate.sourceFile, rootPath), file = canonical && files.get(canonical)
    if (!canonical || !allowedPath(candidate.sourceFile, canonical)
      || !proof || proof.status !== 'unique' || !proof.declaration_offsets || !indexed || !file
      || indexed.start !== proof.indexed_range.start || indexed.end !== proof.indexed_range.end
      || resolve(rootPath, proof.source_file) !== resolve(rootPath, candidate.sourceFile)) return undefined
    const range = resolveSourceSymbolRange(file.lines, indexed, candidate.label, canonical)
    if (!range || !allowedOwner(candidate.sourceFile, candidate.label, file.lines.slice(range.start - 1, range.end).join('\n'))) return undefined
    let declaration: ts.Node | undefined
    const visit = (node: ts.Node): void => {
      if (++visited > 100_000) return
      if (node.getStart(file.source) === proof.declaration_offsets!.start && node.getEnd() === proof.declaration_offsets!.end) declaration = node
      else if (!declaration) ts.forEachChild(node, visit)
    }
    visit(file.source)
    return declaration && visited <= 100_000 ? { ...file, range, declaration, canonical } : undefined
  }
  const leaders = leading.map(ownerFor)
  if (new Set(leading.map(candidate => candidate.id)).size !== 2
    || !leaders.every(owner => owner && (ts.isClassDeclaration(owner.declaration) || ts.isClassExpression(owner.declaration)))) return []
  const leadingIds = new Set(leading.map(candidate => candidate.id))
  const bridges: string[] = []
  for (const candidate of candidates) {
    if (leadingIds.has(candidate.id) || !leading.every(target => provenance.resolved_pairs.some(pair =>
      pair.from_id === candidate.id && pair.to_id === target.id && pair.relation === 'calls' && pair.kind === 'call'))) continue
    const owner = ownerFor(candidate)
    if (!owner || sourceDeclarationKind(owner.lines, owner.range, candidate.label, candidate.sourceFile) !== 'function'
      || coherentSourceSnippet(owner.lines, owner.range, '', 'symbol')?.omittedRanges.length !== 0) continue
    const sites = provenance.observed_sites.filter(site => site.from_id === candidate.id && site.kind === 'call'
      && leadingIds.has(site.to_id) && site.source_sha256 === owner.hash
      && resolve(rootPath, site.source_file) === resolve(rootPath, candidate.sourceFile)
      && site.start_offset >= owner.declaration.getStart(owner.source) && site.end_offset <= owner.declaration.getEnd())
    const visibleTargets = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (++visited > 100_000) return
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const site of sites) {
        if (node.getStart(owner.source) === site.start_offset && node.getEnd() === site.end_offset) visibleTargets.add(site.to_id)
      }
      ts.forEachChild(node, visit)
    }
    visit(owner.declaration)
    if (visited > 100_000) return []
    if (leading.every(target => visibleTargets.has(target.id))) bridges.push(candidate.id)
    if (bridges.length >= 10) break
  }
  if (!bridges.length || !sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowedPath)) return []
  // Cached request text is not a freshness certificate for positive bindings.
  let currentBytes = 0
  for (const input of inputs) {
    if (!allowedPath(input.source_file)) return []
    const canonical = sourcePathForEvidence(input.source_file, rootPath)
    if (!canonical || canonical !== input.canonical_file || !allowedPath(input.source_file, canonical)) return []
    const lines = readEvidenceLines(input.source_file, rootPath)
    if (!lines) return []
    const text = lines.join('\n')
    if ((currentBytes += Buffer.byteLength(text)) > 1024 * 1024
      || createHash('sha256').update(text).digest('hex') !== input.source_sha256) return []
  }
  return sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowedPath) ? [...leadingIds, ...bridges] : []
}

/** Presentation affinity only: this.member syntax does not prove runtime dispatch.
 * The result contains existing candidates; no call edge or coverage is created. */
export function sourceCoherenceGroup(
  independent: readonly SourceCandidate[], candidates: readonly SourceCandidate[],
  provenance: SourceSelectionProvenance | undefined, rootPath?: string,
  cache?: Map<string, string[] | null>,
): { methods: string[]; priority: string[] } | undefined {
  const files = new Map<string, { lines: string[]; methods: ts.MethodDeclaration[] } | null>()
  let bytes = 0, visited = 0, bounded = false
  const load = (file: string) => {
    if (files.has(file)) return files.get(file)
    if (files.size >= 32) { bounded = true; return null }
    const lines = readEvidenceLines(file, rootPath, cache)
    if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024) { bounded = true; return null }
    const source = sourceSyntaxTree(lines, file), methods: ts.MethodDeclaration[] = []
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null
    const visit = (node: ts.Node): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name)
        && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) methods.push(node)
      if (!bounded) ts.forEachChild(node, visit)
    }
    visit(source)
    const value = bounded ? null : { lines, methods }
    files.set(file, value); return value
  }
  const owner = (candidate: SourceCandidate): MethodOwner | undefined => {
    const indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    const file = sourcePathForEvidence(candidate.sourceFile, rootPath)
    if (!indexed || !file) return undefined
    const loaded = load(file)
    if (!loaded) return undefined
    const range = resolveSourceSymbolRange(loaded.lines, indexed, candidate.label, file)
    if (!range) return undefined
    const name = candidate.label.replace(/\(\)$/, '').replace(/^\./, '')
    if (name.includes('.') && name !== sourceDeclarationQualifiedName(loaded.lines, indexed, candidate.label, file)) return undefined
    const matches = loaded.methods.filter(method => {
      const source = method.getSourceFile()
      return method.name.getText(source) === name.split('.').at(-1)
        && source.getLineAndCharacterOfPosition(method.getStart(source)).line + 1 === range.start
        && source.getLineAndCharacterOfPosition(method.getEnd() - 1).line + 1 === range.end
    })
    return matches.length === 1 ? { candidate, method: matches[0]!, file } : undefined
  }
  const leading = independent.slice(0, 2).flatMap(candidate => {
    const current = owner(candidate); return current ? [current] : []
  })
  if (bounded || leading.length !== 2 || leading[0]!.method.parent !== leading[1]!.method.parent
    || leading[0]!.method === leading[1]!.method) return undefined
  const container = leading[0]!.method.parent
  if (!ts.isClassDeclaration(container) && !ts.isClassExpression(container)) return undefined
  // Static this has a different receiver domain; unsupported shapes do not rank.
  const instance = (method: ts.MethodDeclaration): boolean => !method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
  if (!leading.every(value => instance(value.method))) return undefined
  const peers = candidates.flatMap(candidate => {
    if (sourcePathForEvidence(candidate.sourceFile, rootPath) !== leading[0]!.file) return []
    const current = owner(candidate)
    return current && current.method.parent === container && instance(current.method) ? [current] : []
  })
  if (bounded) return undefined
  const byName = new Map<string, MethodOwner>()
  for (const peer of peers) {
    const name = peer.method.name.getText()
    if (byName.has(name)) return undefined
    // Unadmitted overloads/other declarations with this name remain ambiguous.
    if (container.members.filter(member => member.name?.getText() === name).length !== 1) return undefined
    byName.set(name, peer)
  }
  const references = new Map<ts.MethodDeclaration, Set<string>>()
  for (const peer of peers) {
    const names = new Set<string>()
    const inspect = (node: ts.Node): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
      if (ts.isCallExpression(node) && !node.questionDotToken && ts.isPropertyAccessExpression(node.expression)
        && !node.expression.questionDotToken && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) names.add(node.expression.name.text)
      if (!bounded) ts.forEachChild(node, inspect)
    }
    // Header initializers share the owner; nested closures remain unsupported.
    for (const parameter of peer.method.parameters) inspect(parameter)
    inspect(peer.method.body!)
    references.set(peer.method, names)
  }
  if (bounded) return undefined
  const bridges = peers.filter(peer => !leading.some(value => value.method === peer.method)
    && leading.every(value => references.get(peer.method)!.has(value.method.name.getText())))
  if (!bridges.length) return undefined
  const selected = new Set<string>(), limit = 12
  const add = (id: string): void => { if (selected.size < limit) selected.add(id) }
  for (const value of [...leading, ...bridges]) add(value.candidate.id)
  for (const value of [...leading, ...bridges]) for (const name of references.get(value.method) ?? []) {
    const target = byName.get(name); if (target) add(target.candidate.id)
  }
  const methods = [...selected]
  const admitted = new Set(candidates.map(candidate => candidate.id))
  const unique = new Set(provenance?.owners.filter(value => value.status === 'unique').map(value => value.node_id))
  const roots = new Set(selected)
  for (const pair of provenance?.resolved_pairs ?? []) if (roots.has(pair.from_id)
    && pair.relation === 'calls' && admitted.has(pair.to_id) && unique.has(pair.to_id)) add(pair.to_id)
  return { methods, priority: [...selected] }
}

export function sourceCoherencePriority(...args: Parameters<typeof sourceCoherenceGroup>): string[] {
  return sourceCoherenceGroup(...args)?.priority ?? []
}
