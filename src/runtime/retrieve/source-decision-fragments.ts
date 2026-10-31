import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { retrievalEvidencePrompt } from '../retrieval-gate.js'
import { createSourceCompilerHost, sourceCompilerPath } from './source-compiler-host.js'
import { sourceSelectionProvenanceKey, type SourceDependencySelection } from './source-dependencies.js'
import { coherentSourceSnippet, readEvidenceLines, resolveSourceSymbolRange, sourcePathForEvidence, type EvidenceLineRange } from './source-evidence.js'
import { renderSourceFragment, type SourceFragment } from './source-fragments.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './source-modules.js'
import { sourceQuerySymbols } from './source-query-symbols.js'

interface Candidate { id: string; label: string; sourceFile: string; sourceLocation: string | null; sourceFragment?: SourceFragment }

/** Append-only presentation of an already admitted incoming call, not new call
 * authority or whole-caller coverage. Unsupported decisions retain ordinary excerpts. */
export function sourceIncomingDecisionFragment(
  independent: readonly Candidate[], candidates: readonly Candidate[], question: string,
  dependencies: SourceDependencySelection, allowedPath: (file: string, canonical?: string) => boolean,
  allowedOwner: (file: string, label: string, text: string) => boolean, rootPath?: string,
): { callerId: string; calleeId: string; fragment: SourceFragment } | undefined {
  const proof = dependencies[sourceSelectionProvenanceKey]
  if (question.length > 16_384 || !rootPath || !proof?.configuration || proof.root_path !== resolve(rootPath)
    || candidates.length > 256 || proof.owners.length > 100_000 || proof.admissions.length > 12
    || proof.resolved_pairs.length > 8192 || (dependencies.source_callsite_bundles?.length ?? 0) > 4096
    || !(['identity', 'calls', 'mutation', 'write_origins'] as const).every(scan => proof.scans[scan] === 'complete')
    || !sourceModuleConfigurationSnapshotIsFresh(proof.configuration, rootPath, allowedPath)) return undefined
  const positive = retrievalEvidencePrompt(question)
  const named = new Set(sourceQuerySymbols(positive).map(symbol => symbol.name))
  const explicit = new Set(Object.entries(proof.seed_origins ?? {}).filter(([key]) => key !== 'heuristic_anchor_ids')
    .flatMap(([, ids]) => ids))
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  let inspected = 0
  for (const callee of independent) {
    if (!proof.seed_ids.includes(callee.id) || !byId.has(callee.id)) continue
    for (const admission of proof.admissions) {
      if (admission.role !== 'incoming' || admission.depth !== 0 || proof.seed_ids.includes(admission.node_id)
        || explicit.has(admission.node_id)) continue
      const caller = byId.get(admission.node_id)
      if (!caller || caller.sourceFragment || named.has(caller.label.replace(/\(\)$/, ''))
        || !proof.selected_ids.includes(caller.id)
        || !proof.resolved_pairs.some(pair => pair.from_id === caller.id && pair.to_id === callee.id
          && pair.relation === 'calls' && pair.kind === 'call')) continue
      const bundles = (dependencies.source_callsite_bundles ?? []).filter(bundle => bundle.from_id === caller.id && bundle.to_id === callee.id)
      if (bundles.length !== 1 || bundles[0]!.sites.length !== 1 || !allowedPath(caller.sourceFile) || !allowedPath(callee.sourceFile)) continue
      const bundle = bundles[0]!, site = bundle.sites[0]!
      const canonical = sourcePathForEvidence(caller.sourceFile, rootPath)
      if (!canonical || sourcePathForEvidence(callee.sourceFile, rootPath) !== canonical
        || sourcePathForEvidence(bundle.source_file, rootPath) !== canonical
        || !allowedPath(caller.sourceFile, canonical) || !allowedPath(callee.sourceFile, canonical)) continue
      if (++inspected > 4) return undefined
      const lines = readEvidenceLines(caller.sourceFile, rootPath)
      if (!lines) continue
      const text = lines.join('\n'), hash = createHash('sha256').update(text).digest('hex')
      if (hash !== bundle.source_sha256 || !proof.sources.some(input => input.in_program
        && input.canonical_file === canonical && input.source_sha256 === hash)) continue
      const source = ts.createSourceFile(sourceCompilerPath(canonical), text, ts.ScriptTarget.Latest, true)
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) continue
      const line = (offset: number): number => source.getLineAndCharacterOfPosition(offset).line + 1
      const ownerFor = (candidate: Candidate) => {
        const owners = proof.owners.filter(owner => owner.node_id === candidate.id)
        const owner = owners[0], indexed = lineRangeFromSourceLocation(candidate.sourceLocation)
        if (owners.length !== 1 || !owner || owner.status !== 'unique' || !owner.declaration_offsets || !indexed
          || indexed.start !== owner.indexed_range.start || indexed.end !== owner.indexed_range.end
          || resolve(rootPath, owner.source_file) !== resolve(rootPath, candidate.sourceFile)) return undefined
        const range = resolveSourceSymbolRange(lines, indexed, candidate.label, canonical)
        const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement)
          && statement.getStart(source) === owner.declaration_offsets!.start && statement.getEnd() === owner.declaration_offsets!.end)
        if (!range || !declaration || !ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body
          || line(declaration.getStart(source)) !== range.start || line(declaration.getEnd() - 1) !== range.end
          || !allowedOwner(candidate.sourceFile, candidate.label, lines.slice(range.start - 1, range.end).join('\n'))) return undefined
        return { declaration, range }
      }
      const from = ownerFor(caller), to = ownerFor(callee)
      if (!from || !to) continue
      const host = createSourceCompilerHost(new Map([[canonical, source]]), rootPath)
      if (!host) continue
      const checker = ts.createProgram(host.rootNames, { noLib: true, noResolve: true, allowJs: true }, host.host).getTypeChecker()
      const symbol = checker.getSymbolAtLocation(to.declaration.name!)
      if (!symbol || symbol.declarations?.length !== 1 || symbol.declarations[0] !== to.declaration) continue
      let nodes = 0, unsafe = false
      const calls: ts.CallExpression[] = []
      const visit = (node: ts.Node): void => {
        if (++nodes > 100_000) { unsafe = true; return }
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol && node !== to.declaration.name) {
          if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) unsafe = true
          else if (node.pos >= from.declaration.pos && node.end <= from.declaration.end) calls.push(node.parent)
        }
        if (!unsafe) ts.forEachChild(node, visit)
      }
      visit(source)
      const call = calls[0]
      if (unsafe || calls.length !== 1 || !call || call.getStart(source) !== site.start_offset || call.getEnd() !== site.end_offset) continue
      const expression = ts.isAwaitExpression(call.parent) ? call.parent : call
      if (!ts.isExpressionStatement(expression.parent) || expression.parent.expression !== expression) continue
      const body = expression.parent.parent, branch = body.parent
      const terminal = ts.isBlock(body) ? body.statements[1] : undefined
      if (!ts.isBlock(body) || !ts.isIfStatement(branch) || branch.thenStatement !== body || branch.elseStatement
        || branch.parent !== from.declaration.body || body.statements.length !== 2 || body.statements[0] !== expression.parent
        || !terminal || !ts.isReturnStatement(terminal) || terminal.expression) continue
      const condition = branch.expression
      if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue
      const literal = ts.isStringLiteral(condition.left) && ts.isIdentifier(condition.right) ? condition.left
        : ts.isStringLiteral(condition.right) && ts.isIdentifier(condition.left) ? condition.right : undefined
      if (!literal || !literal.text.trim() || literal.text.length > 128) continue
      const escaped = literal.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (!new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`).test(positive)) continue
      if (line(branch.getEnd() - 1) - line(branch.getStart(source)) + 1 > 32) continue
      const original = coherentSourceSnippet(lines, from.range, question, 'symbol', caller.sourceFile)
      if (!original) continue
      const selected = new Set<number>()
      const keep = (start: number, end: number): boolean => {
        if (end < start) return true
        if (end - start + 1 > 80) return false
        for (let line = start; line <= end; line++) selected.add(line)
        return selected.size <= 80
      }
      // Keep every existing source witness, including independent decisions in
      // this same owner. This addition never substitutes a narrower excerpt.
      let next = from.range.start, fits = true
      for (const gap of original.omittedRanges) {
        if (!keep(next, gap.start_line - 1)) { fits = false; break }
        next = gap.end_line + 1
      }
      if (!fits || !keep(next, from.range.end)) continue
      if (!keep(from.range.start, line(from.declaration.body!.getStart(source)))
        || !keep(line(branch.getStart(source)), line(branch.getEnd() - 1)) || !keep(from.range.end, from.range.end)) continue
      const retained: EvidenceLineRange[] = []
      for (const line of [...selected].sort((left, right) => left - right)) {
        const previous = retained.at(-1)
        if (previous && line === previous.end_line + 1) previous.end_line = line
        else retained.push({ start_line: line, end_line: line })
      }
      const fragment: SourceFragment = { sourceHash: hash, range: from.range, retained }
      const rendered = renderSourceFragment(lines, from.range, fragment)
      if (!rendered || rendered.snippet.length > 12_000 || !allowedOwner(caller.sourceFile, caller.label, rendered.snippet)) continue
      // Local lexical binding does not depend on imported program completeness.
      // Recheck current bytes/configuration; generic global bundle guards stay unchanged.
      const current = readEvidenceLines(caller.sourceFile, rootPath)
      if (!current || sourcePathForEvidence(caller.sourceFile, rootPath) !== canonical
        || createHash('sha256').update(current.join('\n')).digest('hex') !== hash
        || !sourceModuleConfigurationSnapshotIsFresh(proof.configuration, rootPath, allowedPath)) return undefined
      return { callerId: caller.id, calleeId: callee.id, fragment }
    }
  }
  return undefined
}
