import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import type { SourceFragment } from './source-fragments.js'
import type { SourceSelectionProvenance } from './source-selection-provenance.js'

interface Candidate { id: string; label: string; sourceFile: string; sourceLocation: string | null }
interface File { lines: string[]; source: ts.SourceFile; hash: string; methods: ts.MethodDeclaration[] }
interface Owner<T> { candidate: T; file: File; method: ts.MethodDeclaration; fragment: SourceFragment }
const hash = (lines: readonly string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex')

/** Definition context only. A lexical counterpart never resolves virtual this dispatch. */
export function sourceDiagnosticLexicalCompanions<T extends Candidate>(
  rootIds: readonly string[], candidates: readonly T[], provenance: SourceSelectionProvenance | undefined,
  authorityOwnerIds: readonly string[], allowedOwner: (file: string, label: string, text: string) => boolean,
  rootPath?: string,
): Array<{ candidate: T; fragment: SourceFragment }> {
  if (!rootPath || !rootIds.length || rootIds.length > 3 || new Set(rootIds).size !== rootIds.length
    || !provenance || provenance.root_path !== resolve(rootPath) || provenance.scans.identity !== 'complete'
    || provenance.scans.calls !== 'complete' || provenance.owners.length > 8192
    || provenance.unresolved.length > 8192 || candidates.length > 16_384 || authorityOwnerIds.length > 8192) return []
  const authority = new Set(authorityOwnerIds), byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  if (byId.size !== candidates.length) return []
  const proofs = new Map(provenance.owners.map(owner => [owner.node_id, owner]))
  if (proofs.size !== provenance.owners.length) return []
  const files = new Map<string, File>(), owners = new Map<string, Owner<T> | null>()
  let bytes = 0, visited = 0, bounded = false
  const ownerFor = (id: string): Owner<T> | undefined => {
    if (owners.has(id)) return owners.get(id) ?? undefined
    if (owners.size >= 32) { bounded = true; return undefined }
    owners.set(id, null)
    const candidate = byId.get(id), proof = proofs.get(id)
    if (!candidate || !proof || proof.status !== 'unique' || !proof.declaration_offsets || !authority.has(id)
      || resolve(rootPath, proof.source_file) !== resolve(rootPath, candidate.sourceFile)) return undefined
    const canonical = sourcePathForEvidence(candidate.sourceFile, rootPath)
    const indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
    if (!canonical || !indexed || indexed.start !== proof.indexed_range.start || indexed.end !== proof.indexed_range.end) return undefined
    const inputs = provenance.sources.filter(input => input.in_program && input.canonical_file === canonical)
    if (inputs.length !== 1) return undefined
    let file = files.get(canonical)
    if (!file) {
      if (files.size >= 32) { bounded = true; return undefined }
      const lines = readEvidenceLines(candidate.sourceFile, rootPath)
      if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024) { bounded = true; return undefined }
      if (hash(lines) !== inputs[0]!.source_sha256) return undefined
      const source = sourceSyntaxTree(lines, canonical), methods: ts.MethodDeclaration[] = []
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
      const visit = (node: ts.Node): void => {
        if (++visited > 100_000) { bounded = true; return }
        if (ts.isMethodDeclaration(node)) methods.push(node)
        if (!bounded) ts.forEachChild(node, visit)
      }
      visit(source)
      if (bounded) return undefined
      file = { lines, source, hash: inputs[0]!.source_sha256, methods }; files.set(canonical, file)
    }
    const range = resolveSourceSymbolRange(file.lines, indexed, candidate.label, canonical)
    const qualified = sourceDeclarationQualifiedName(file.lines, indexed, candidate.label, canonical)
    const name = candidate.label.replace(/\(\)$/, '').replace(/^\./, '')
    if (!range || !qualified || name.includes('.') && name !== qualified) return undefined
    const methods = file.methods.filter(method => method.getStart(file!.source) === proof.declaration_offsets!.start
      && method.getEnd() === proof.declaration_offsets!.end)
    if (methods.length !== 1) return undefined
    const method = methods[0]!, container = method.parent
    if (!method.body || !ts.isIdentifier(method.name) || method.name.text !== name.split('.').at(-1)
      || !ts.isClassLike(container) || method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
      || container.members.filter(member => member.name?.getText(file!.source) === method.name.getText(file!.source)).length !== 1
      || file.source.getLineAndCharacterOfPosition(method.getStart(file.source)).line + 1 !== range.start
      || file.source.getLineAndCharacterOfPosition(method.getEnd() - 1).line + 1 !== range.end) return undefined
    // Different graph IDs for one declaration do not supply unique definition identity.
    if (provenance.owners.filter(other => other.declaration_offsets?.start === proof.declaration_offsets!.start
      && other.declaration_offsets?.end === proof.declaration_offsets!.end
      && resolve(rootPath, other.source_file) === resolve(rootPath, proof.source_file)).length !== 1) return undefined
    const text = file.lines.slice(range.start - 1, range.end).join('\n')
    if (!allowedOwner(candidate.sourceFile, candidate.label, text) || !allowedOwner(canonical, candidate.label, text)) return undefined
    const owner = { candidate, file, method, fragment: { sourceHash: file.hash, range,
      retained: [{ start_line: range.start, end_line: range.end }] } }
    owners.set(id, owner); return owner
  }
  const roots = rootIds.flatMap(id => { const owner = ownerFor(id); return owner ? [owner] : [] })
  const selected = new Map<string, Owner<T>>()
  let lines = 0, chars = 0
  for (const root of roots) {
    const names = new Set<string>()
    const inspect = (node: ts.Node): void => {
      if (++visited > 100_000) { bounded = true; return }
      if (ts.isClassLike(node) || ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return
      if (ts.isCallExpression(node) && !node.questionDotToken && ts.isPropertyAccessExpression(node.expression)
        && !node.expression.questionDotToken && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        && ts.isIdentifier(node.expression.name)) {
        const line = root.file.source.getLineAndCharacterOfPosition(node.getStart(root.file.source)).line + 1
        if (provenance.unresolved.some(call => call.from_id === root.candidate.id && call.relation === 'calls'
          && resolve(rootPath, call.source_file) === resolve(rootPath, root.candidate.sourceFile)
          && call.reason === 'unresolved' && call.line_number === line && call.callee === node.expression.getText(root.file.source))) names.add(node.expression.name.text)
      }
      if (!bounded) ts.forEachChild(node, inspect)
    }
    inspect(root.method.body!)
    if (bounded) return []
    for (const name of names) {
      if (selected.size >= 4) break
      const methods = root.file.methods.filter(method => method.parent === root.method.parent && ts.isIdentifier(method.name) && method.name.text === name)
      if (methods.length !== 1) continue
      const target = methods[0]!, start = target.getStart(root.file.source), end = target.getEnd()
      const matches = provenance.owners.filter(proof => proof.declaration_offsets?.start === start && proof.declaration_offsets.end === end
        && resolve(rootPath, proof.source_file) === resolve(rootPath, root.candidate.sourceFile))
      if (matches.length !== 1 || rootIds.includes(matches[0]!.node_id) || selected.has(matches[0]!.node_id)) continue
      const owner = ownerFor(matches[0]!.node_id)
      if (!owner || owner.method !== target) continue
      const count = owner.fragment.range.end - owner.fragment.range.start + 1
      const length = owner.file.lines.slice(owner.fragment.range.start - 1, owner.fragment.range.end).join('\n').length
      if (lines + count > 80 || chars + length > 12_000) continue
      selected.set(owner.candidate.id, owner); lines += count; chars += length
    }
  }
  if (bounded) return []
  // A fresh read, not a request cache, binds the optional definition admission.
  for (const [canonical, file] of files) {
    const current = readEvidenceLines(canonical, rootPath)
    if (!current || sourcePathForEvidence(canonical, rootPath) !== canonical || hash(current) !== file.hash) return []
  }
  return [...selected.values()].map(({ candidate, fragment }) => ({ candidate, fragment }))
}
