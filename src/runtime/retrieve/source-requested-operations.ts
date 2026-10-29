import ts from 'typescript'
import { realpathSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { KnowledgeGraph } from '../../contracts/graph.js'
import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { extractPromptExclusions, retrievalDirectivePrompt } from '../retrieval-gate.js'
import { compileSourceExclusions } from '../source-exclusions.js'
import { readVerifiedSourceSnapshot } from '../source-continuation.js'
import { classifySourceDomain } from '../../shared/source-discovery.js'
import { JS_TS_SOURCE_EXTENSIONS } from '../../shared/source-extensions.js'
import { readEvidenceLines, resolveSourceSymbolRange, sourceDeclarationKind, sourceDeclarationQualifiedName, sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import { sourceQuerySymbols, type SourceSymbolOccurrence } from './source-query-symbols.js'

/** An action applied to a qualified implementation is a request; quoted examples are data. */
export function sourceRequestedOperations(question: string): SourceSymbolOccurrence[] {
  const text = retrievalDirectivePrompt(question)
  return sourceQuerySymbols(text).filter(item => item.explicit && item.name.includes('.')
    && (/\b(?:trace|explain|inspect|analyze)\s+(?:the\s+)?(?:(?:exact\s+)?(?:behavior|implementation)\s+of\s+)?$/i.test(text.slice(0, item.start))
      || /^\s*\(/.test(text.slice(item.end))
        && /\b(?:show|follow)\s+(?:the\s+)?$/i.test(text.slice(0, item.start))))
}

/** A complete simple request list only. Unsupported tails and mixed receivers
 * abstain as one group; this does not extend the complex-task operation grammar. */
export function sourceSimplePrototypeRequests(question: string): SourceSymbolOccurrence[] {
  if (question.length > 16_384 || /[\x22\x27\x60]/.test(question)) return []
  const text = retrievalDirectivePrompt(question)
  const prefix = /^\s*(?:please\s+)?(?:explain|show|inspect|analyze)\s+(?:the\s+)?/i.exec(text)
  if (!prefix) return []
  const requests = new Map<string, SourceSymbolOccurrence>()
  let cursor = prefix[0].length, count = 0
  while (cursor < text.length) {
    const item = /^([A-Z][\w$]*\.[A-Za-z_$][\w$]*)(?:\s*\(\s*\))?/.exec(text.slice(cursor))
    if (!item || ++count > 8) return []
    if (!requests.has(item[1]!)) requests.set(item[1]!, { name: item[1]!, start: cursor, end: cursor + item[1]!.length, explicit: true })
    cursor += item[0].length
    const tail = text.slice(cursor)
    if (/^\s*(?:from\s+(?:the\s+)?source(?:\s+code)?)?\s*[.!?]?\s*$/i.test(tail)) return [...requests.values()]
    const separator = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+)/i.exec(tail)
    if (!separator) return []
    cursor += separator[0].length
  }
  return []
}

/** A direct source request can survive structural ranking, but never policy or
 * current-owner verification. Unknown receivers retain the ordinary admitted path. */
export function selectVerifiedExplicitPrototypeOwners(
  graph: KnowledgeGraph, question: string, rootPath: string | undefined, cache: Map<string, string[] | null>,
  eligibleNodeIds: ReadonlySet<string>, eligibleSourceFiles: ReadonlySet<string>,
  explicitRequests?: readonly SourceSymbolOccurrence[],
): string[] {
  if (!rootPath || question.length > 16_384 || graph.numberOfNodes() > 50_000) return []
  const requests = explicitRequests ?? sourceRequestedOperations(question)
  if (!requests.length || requests.length > 8 || requests.some(item => !/^[A-Z][\w$]*\.[A-Za-z_$][\w$]*$/.test(item.name))) return []
  const constructors = new Set(requests.map(item => item.name.split('.')[0]!))
  const leaves = new Set(requests.map(item => item.name.split('.')[1]!))
  const rows = graph.nodeEntries().filter(([, node]) => node.file_type === 'code' && node.external_call !== true
    && (leaves.has(String(node.label ?? '').replace(/\(\)$/, '').split('.').at(-1)!)
      || constructors.has(String(node.label ?? '').replace(/\(\)$/, ''))))
  if (!rows.length || rows.length > 64) return []
  const scope = extractPromptExclusions(question)
  const excluded = compileSourceExclusions(scope.excludedTerms, scope.excludedPathHints, rootPath)
  if (!excluded.valid || requests.some(request => excluded.matchesLabel(request.name))) return []
  const snapshots = new Map<string, ReturnType<typeof readVerifiedSourceSnapshot>>()
  const proofCache = new Map<string, string[] | null>()
  let readBytes = 0
  try {
    const realRoot = realpathSync(rootPath)
    for (const [, node] of rows) {
      const file = String(node.source_file ?? ''), logical = resolve(rootPath, file), label = String(node.label ?? '')
      if (!eligibleSourceFiles.has(logical) || !JS_TS_SOURCE_EXTENSIONS.includes(extname(file).toLowerCase())
        || /\.d\.[cm]?tsx?$/i.test(file)
        || scope.excludedDomains.includes(classifySourceDomain(logical, rootPath) as never)
        || excluded.matchesSource(logical, label)) return []
      const canonical = sourcePathForEvidence(logical, rootPath)
      if (!canonical || scope.excludedDomains.includes(classifySourceDomain(canonical, realRoot) as never)
        || excluded.matchesPath(canonical, realRoot)) return []
      let source = snapshots.get(logical)
      if (!source) {
        if (snapshots.size >= 16) return []
        source = readVerifiedSourceSnapshot(file, rootPath)
        // Reserve the other half for rereading every identity/ambiguity input.
        // Include policy reads, not just normalized source bytes, in this bound.
        if ((readBytes += source.readBytes) > 512 * 1024) return []
        if (cache.has(source.canonical) && cache.get(source.canonical)?.join('\n') !== source.lines.join('\n')) return []
        snapshots.set(logical, source)
        proofCache.set(source.canonical, source.lines)
      }
      if (source.canonical !== canonical || source.realRoot !== realRoot) return []
    }
    const selected = selectRequestedPrototypeOwners(graph, question, rootPath, proofCache, eligibleSourceFiles, explicitRequests)
    if (!selected.length || selected.length > 8 || selected.some(id => !eligibleNodeIds.has(id))) return []
    const completeOwners = new Map<string, string>()
    // A point or stale indexed range cannot acquire new admission by expansion.
    for (const [id, node] of rows) {
      const source = snapshots.get(resolve(rootPath, String(node.source_file ?? '')))!
      const indexed = lineRangeFromSourceLocation(node.source_location), label = String(node.label ?? '')
      if (!indexed) return []
      const kind = sourceDeclarationKind(source.lines, indexed, label, source.canonical)
      if (!selected.includes(id) && kind !== 'function' && kind !== 'class') continue
      const current = resolveSourceSymbolRange(source.lines, indexed, label, source.canonical)
      if (!current || current.start !== indexed.start || current.end !== indexed.end) return []
      if (explicitRequests && selected.includes(id)) {
        const qualified = sourceDeclarationQualifiedName(source.lines, indexed, label, source.canonical)
        if (kind !== 'function' || !qualified || completeOwners.has(qualified)) return []
        completeOwners.set(qualified, id)
      }
    }
    if (explicitRequests && (selected.length !== requests.length || requests.some(request => {
      const [constructor, member] = request.name.split('.')
      return !completeOwners.has(`${constructor}.prototype.${member}`)
    }))) return []
    for (const source of snapshots.values()) {
      const current = readVerifiedSourceSnapshot(source.logical, rootPath)
      if ((readBytes += current.readBytes) > 1024 * 1024 || current.canonical !== source.canonical
        || current.realRoot !== source.realRoot || current.hash !== source.hash || current.policyFingerprint !== source.policyFingerprint
        || cache.has(source.canonical) && cache.get(source.canonical)?.join('\n') !== source.lines.join('\n')) return []
    }
    // Publish only a complete proof; never replace a conflicting request snapshot.
    for (const source of snapshots.values()) if (!cache.has(source.canonical)) cache.set(source.canonical, source.lines)
    return selected
  } catch { return [] }
}

/** Promotion candidates only: the caller must intersect already admitted evidence.
 * A named constructor plus a requested member is not receiver/call authority. */
export function selectRequestedPrototypeOwners(
  graph: KnowledgeGraph, question: string, rootPath: string | undefined, cache: Map<string, string[] | null>, eligibleSourceFiles: ReadonlySet<string>,
  explicitRequests?: readonly SourceSymbolOccurrence[],
): string[] {
  if (!rootPath || question.length > 16_384 || graph.numberOfNodes() > 50_000) return []
  const text = retrievalDirectivePrompt(question)
  const occurrences = sourceQuerySymbols(text)
  const operations = explicitRequests ?? sourceRequestedOperations(question)
  const requests = operations.filter(item => /^[A-Za-z][\w$]*\.[A-Za-z_$][\w$]*$/.test(item.name))
  // Explicit owners already define the constructor candidates. Capitalized
  // background prose is relevant only when a requested receiver is unknown.
  // Unsupported/mixed operations retain the existing conservative pool.
  const explicitOwnersOnly = operations.length === requests.length && requests.every(item => /^[A-Z]/.test(item.name))
  const constructors = new Set([
    ...(explicitOwnersOnly ? [] : occurrences.filter(item => item.explicit && /^[A-Z][\w$]*$/.test(item.name)).map(item => item.name)),
    ...requests.filter(item => /^[A-Z]/.test(item.name)).map(item => item.name.split('.')[0]!),
  ])
  if (!constructors.size || constructors.size > 16 || !requests.length || requests.length > 8) return []
  const leaves = new Set(requests.map(item => item.name.split('.')[1]!))
  const rows = graph.nodeEntries().filter(([, node]) => node.file_type === 'code' && node.external_call !== true
    && (leaves.has(String(node.label ?? '').replace(/\(\)$/, '').split('.').at(-1)!)
      || constructors.has(String(node.label ?? '').replace(/\(\)$/, ''))))
  if (!rows.length || rows.length > 64) return []

  type Facts = { source: ts.SourceFile; lines: string[]; names: Map<string, ts.Node[]>; assignments: Map<string, ts.BinaryExpression[]>;
    wildcard: Set<string>; exact: Set<string>; ranges: Map<string, Set<ts.Node>> }
  const files = new Map<string, Facts>()
  const owners: Array<{ id: string; path: string; qualified: string; kind: string; start: number; end: number }> = []
  let bytes = 0, visited = 0
  const staticName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const receiver = staticName(node.expression)
      return receiver ? `${receiver}.${node.name.text}` : undefined
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      const receiver = staticName(node.expression)
      return receiver ? `${receiver}.${node.argumentExpression.text}` : undefined
    }
    return undefined
  }
  for (const [id, node] of rows) {
    const file = String(node.source_file ?? ''), label = String(node.label ?? '')
    // Do not use excluded or unadmitted files to infer an operation owner.
    // Their existence makes this bounded source reconciliation inconclusive.
    if (!eligibleSourceFiles.has(resolve(rootPath, file))) return []
    const path = sourcePathForEvidence(file, rootPath), indexed = lineRangeFromSourceLocation(node.source_location)
    if (!path || !indexed || !/\.[cm]?[jt]sx?$/i.test(path) || /\.d\.[cm]?tsx?$/i.test(path)) return []
    let facts = files.get(path)
    if (!facts) {
      if (files.size >= 16) return []
      const lines = readEvidenceLines(file, rootPath, cache)
      if (!lines || (bytes += Buffer.byteLength(lines.join('\n'))) > 1024 * 1024) return []
      const source = sourceSyntaxTree(lines, path)
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return []
      facts = { source, lines, names: new Map(), assignments: new Map(), wildcard: new Set(), exact: new Set(), ranges: new Map() }
      files.set(path, facts)
      const rangeOf = (value: ts.Node): string => `${source.getLineAndCharacterOfPosition(value.getStart(source)).line + 1}:${source.getLineAndCharacterOfPosition(value.getEnd()).line + 1}`
      const addRange = (value: ts.Node, key = rangeOf(value)): void => {
        const entries = facts!.ranges.get(key) ?? new Set<ts.Node>()
        entries.add(value); facts!.ranges.set(key, entries)
      }
      const visit = (value: ts.Node): void => {
        if (++visited > 100_000) return
        const occurrence = sourceFunctionOccurrence(value, source)
        if (occurrence) {
          addRange(value, `${occurrence.start}:${occurrence.end}`)
          if (leaves.has(occurrence.name)) facts!.exact.add(occurrence.qualifiedName)
        }
        const callable = ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value) || ts.isConstructorDeclaration(value)
          || ts.isGetAccessorDeclaration(value) || ts.isSetAccessorDeclaration(value)
        const initialized = (ts.isVariableDeclaration(value) || ts.isPropertyDeclaration(value)) && value.initializer
          && (ts.isArrowFunction(value.initializer) || ts.isFunctionExpression(value.initializer) || ts.isClassExpression(value.initializer))
        if (callable || initialized) addRange(value)
        if ((ts.isFunctionDeclaration(value) || ts.isClassDeclaration(value) || ts.isVariableDeclaration(value))
          && value.name && ts.isIdentifier(value.name) && constructors.has(value.name.text)) {
          const entries = facts!.names.get(value.name.text) ?? []
          entries.push(value); facts!.names.set(value.name.text, entries)
        }
        if ((ts.isMethodDeclaration(value) || ts.isPropertyDeclaration(value) || ts.isGetAccessorDeclaration(value) || ts.isSetAccessorDeclaration(value))
          && ts.isClassLike(value.parent) && value.parent.name) {
          const member = ts.isIdentifier(value.name) || ts.isStringLiteralLike(value.name) ? value.name.text
            : ts.isComputedPropertyName(value.name) && ts.isStringLiteralLike(value.name.expression) ? value.name.expression.text : undefined
          if (member && leaves.has(member)) facts!.exact.add(`${value.parent.name.text}.${member}`)
          else if (ts.isComputedPropertyName(value.name) && member === undefined) facts!.wildcard.add(value.parent.name.text)
        }
        if (ts.isCallExpression(value)) {
          const call = staticName(value.expression), target = value.arguments[0] && staticName(value.arguments[0])
          const targetConstructor = target?.replace(/\.prototype$/, '')
          if (target && targetConstructor && constructors.has(targetConstructor)
            && (call === 'Object.defineProperty' || call === 'Reflect.defineProperty'
              || call === 'Object.defineProperties' || call === 'Object.assign')) {
            // Reflective writes can compete with a prototype owner. These are
            // conflict facts only; they never establish a callable or binding.
            const conflict = (member: string | undefined): void => {
              if (member === undefined || leaves.has(member) || member === 'prototype' && target === targetConstructor) facts!.wildcard.add(target)
              if (member !== undefined && leaves.has(member)) facts!.exact.add(`${target}.${member}`)
            }
            if (call === 'Object.defineProperty' || call === 'Reflect.defineProperty') {
              const key = value.arguments[1]
              conflict(key && ts.isStringLiteralLike(key) ? key.text : undefined)
            } else {
              const inputs = call === 'Object.assign' ? value.arguments.slice(1) : [value.arguments[1]]
              for (const input of inputs) {
                if (!input || !ts.isObjectLiteralExpression(input)) { conflict(undefined); continue }
                for (const property of input.properties) {
                  const key = property.name
                  conflict(key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ? key.text
                    : key && ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression) ? key.expression.text : undefined)
                }
              }
            }
          }
        }
        if (ts.isBinaryExpression(value) && value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && value.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          const name = staticName(value.left)
          if (name) {
            const entries = facts!.assignments.get(name) ?? []
            entries.push(value); facts!.assignments.set(name, entries)
            if (/^[A-Z][\w$]*\.prototype$/.test(name)) facts!.wildcard.add(name)
            if (leaves.has(name.split('.').at(-1)!)) facts!.exact.add(name)
          } else if (ts.isElementAccessExpression(value.left)) {
            const receiver = staticName(value.left.expression)
            if (receiver) facts!.wildcard.add(receiver)
          }
        }
        ts.forEachChild(value, visit)
      }
      visit(source)
      if (visited > 100_000) return []
    }
    const kind = sourceDeclarationKind(facts.lines, indexed, label, path)
    const qualified = sourceDeclarationQualifiedName(facts.lines, indexed, label, path)
    const range = resolveSourceSymbolRange(facts.lines, indexed, label, path)
    if (!kind || !qualified || !range) return []
    owners.push({ id, path, qualified, kind, start: range.start, end: range.end })
  }
  const selected = new Set<string>()
  for (const request of requests) {
    if (owners.some(owner => owner.qualified === request.name) || [...files.values()].some(facts => facts.exact.has(request.name))) continue
    const leaf = request.name.split('.')[1]!
    // Constructor.member is a source-identity shorthand only when no exact
    // static/class member competes. Unknown receivers still consider every
    // explicitly mentioned constructor; neither form establishes a binding.
    const requestedConstructors = /^[A-Z]/.test(request.name) ? new Set([request.name.split('.')[0]!]) : constructors
    const compatible = owners.filter(owner => {
      const parts = owner.qualified.split('.')
      return owner.kind === 'function' && parts.length === 3 && parts[1] === 'prototype' && parts[2] === leaf && requestedConstructors.has(parts[0]!)
    })
    // Duplicate graph rows also abstain; a ranking subset cannot resolve a tie.
    if (compatible.length !== 1) continue
    const owner = compatible[0]!, ctor = owner.qualified.split('.')[0]!, facts = files.get(owner.path)!
    // An unknown instance may refer to any mentioned owner. A different class
    // member or static assignment competes even though this path only promotes
    // supported prototype functions; absence from that subset is not proof.
    const members = [...files.values()].flatMap(file => [...file.exact].filter(name => {
      const parts = name.split('.')
      return requestedConstructors.has(parts[0]!) && parts.at(-1) === leaf
        && (parts.length === 2 || (parts.length === 3 && parts[1] === 'prototype'))
    }))
    if (members.length !== 1 || members[0] !== owner.qualified
      || [...files.values()].some(file => [...requestedConstructors].some(name => file.wildcard.has(name) || file.wildcard.has(`${name}.prototype`)))) continue
    const declarations = facts.names.get(ctor), assignments = facts.assignments.get(owner.qualified)
    const constructor = declarations?.length === 1 ? declarations[0] : undefined
    const assignment = assignments?.length === 1 ? assignments[0] : undefined
    const sourceConstructors = [...files.values()].flatMap(file => (file.names.get(ctor) ?? []).filter(node =>
      ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || (ts.isVariableDeclaration(node) && node.initializer
        && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer) || ts.isClassExpression(node.initializer)))))
    if (sourceConstructors.length !== 1 || sourceConstructors[0] !== constructor
      || !constructor || !ts.isFunctionDeclaration(constructor) || !constructor.body || constructor.asteriskToken
      || constructor.parent !== facts.source || ts.getCombinedModifierFlags(constructor) & ts.ModifierFlags.Async
      || !assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      || !ts.isExpressionStatement(assignment.parent) || assignment.parent.parent !== facts.source
      || facts.wildcard.has(`${ctor}.prototype`)) continue
    const ctorStart = facts.source.getLineAndCharacterOfPosition(constructor.getStart(facts.source)).line + 1
    const ctorEnd = facts.source.getLineAndCharacterOfPosition(constructor.getEnd()).line + 1
    const ctorOwners = owners.filter(item => item.qualified === ctor && (item.kind === 'function' || item.kind === 'class'))
    if (ctorOwners.length !== 1 || ctorOwners[0]!.path !== owner.path || ctorOwners[0]!.kind !== 'function'
      || ctorOwners[0]!.start !== ctorStart || ctorOwners[0]!.end !== ctorEnd
      || facts.ranges.get(`${ctorStart}:${ctorEnd}`)?.size !== 1
      || facts.ranges.get(`${owner.start}:${owner.end}`)?.size !== 1) continue
    // Every compatible prototype assignment in inspected source participates,
    // including declarations absent from the graph or beyond the rank cutoff.
    const sourceCandidates = [...files.values()].flatMap(file => [...file.assignments].flatMap(([name, nodes]) => {
      const parts = name.split('.')
      return parts.length === 3 && parts[1] === 'prototype' && parts[2] === leaf && requestedConstructors.has(parts[0]!) ? nodes : []
    }))
    if (sourceCandidates.length === 1) selected.add(owner.id)
  }
  return [...selected]
}
