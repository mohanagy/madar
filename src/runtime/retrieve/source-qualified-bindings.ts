import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import ts from 'typescript'

import { isPromptDataOffset, scanPromptRegions } from '../../shared/prompt-regions.js'
import { classifySourceDomain } from '../../shared/source-discovery.js'
import { extractPromptExclusions } from '../retrieval-gate.js'
import { readVerifiedSourceSnapshot } from '../source-continuation.js'
import { compileSourceExclusions } from '../source-exclusions.js'
import { sourceSelectionProvenanceKey, type SourceDependencySelection } from './source-dependencies.js'
import { sourcePathForEvidence, sourceSyntaxTree } from './source-evidence.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './source-modules.js'
import type { SourceSymbolOccurrence } from './source-query-symbols.js'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
function staticExpression(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name)) return undefined
  const parent = staticExpression(node.expression)
  return parent ? `${parent}.${node.name.text}` : undefined
}

/** Parse the occurrence's relation role independently of the source proof.
 * An implicit expression needs an explicit caller subject; a passive clause
 * still needs its through/via expression. Unsupported continuations abstain. */
function implementationRelation(suffix: string): {
  length: number; grammarOffset: number; expression?: string; subject: 'it' | 'each' | 'passive'
} | undefined {
  const head = /^[`"']?\s+implementation\b/i.exec(suffix)
  if (!head) return undefined
  const predicate = /^\s+(?:(?:that\s+)?(it|each)\s+(?:calls|invokes)|(?:called|invoked))\b/i.exec(suffix.slice(head[0].length))
  if (!predicate) return undefined
  const subject = (predicate[1]?.toLowerCase() ?? 'passive') as 'it' | 'each' | 'passive'
  const length = head[0].length + predicate[0].length
  const rest = suffix.slice(length)
  const qualifier = /^\s+(?:through|via)\s+([`"']?)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\1(?=$|[\s.,;:!?])/i.exec(rest)
  if (!qualifier && (subject === 'passive' || !/^\s*(?:$|[.,;:!?])/.test(rest))) return undefined
  return { length: length + (qualifier?.[0].length ?? 0), grammarOffset: head[0].search(/implementation/i),
    subject, ...(qualifier ? { expression: qualifier[2]! } : {}) }
}

/** Only a caller-qualified occurrence can use a current binding to settle a
 * shared declaration name. This changes query scope, never call authority. */
export function sourceQualifiedBindingScope(options: {
  question: string
  occurrences: readonly { nodeId: string; occurrence: SourceSymbolOccurrence }[]
  callerIds: readonly string[]
  dependencies: SourceDependencySelection
  rootPath: string | undefined
}): false | { qualified_ranges: Array<{ start: number; end: number }> } {
  const { question, occurrences, dependencies, rootPath } = options
  if (!rootPath || question.length > 8192 || occurrences.length > 256) return false
  const groups = new Map<number, { occurrence: SourceSymbolOccurrence; ids: Set<string> }>()
  for (const { nodeId, occurrence } of occurrences) {
    const group = groups.get(occurrence.start) ?? { occurrence, ids: new Set<string>() }
    group.ids.add(nodeId); groups.set(occurrence.start, group)
  }
  const ambiguous = [...groups.values()].filter(group => group.ids.size > 1)
  const callers = [...new Set(options.callerIds)]
  if (!ambiguous.length || ambiguous.length > 8 || !callers.length || callers.length > 8) return false
  const regions = scanPromptRegions(question)
  const qualifications = ambiguous.map(group => {
    const suffix = question.slice(group.occurrence.end)
    const relation = implementationRelation(suffix)
    if (!relation || relation.subject === 'it' && callers.length !== 1) return undefined
    const grammarStart = group.occurrence.end + relation.grammarOffset
    if (isPromptDataOffset(regions, grammarStart)) return undefined
    const quote = question[group.occurrence.start - 1]
    const start = quote && /[`"']/.test(quote) && suffix.startsWith(quote) ? group.occurrence.start - 1 : group.occurrence.start
    return { ...group, expression: relation.expression, requireEveryCaller: relation.subject !== 'passive',
      range: { start, end: group.occurrence.end + relation.length } }
  })
  // A second bare occurrence is independent evidence, even when an earlier
  // occurrence of the same name has a resolvable alias qualifier.
  if (qualifications.some(value => !value)) return false
  const provenance = dependencies[sourceSelectionProvenanceKey]
  const bundles = dependencies.source_callsite_bundles
  if (!provenance?.configuration || !bundles?.length || bundles.length > 4096
    || !(['source_loading', 'program', 'identity', 'calls', 'mutation', 'write_origins'] as const)
      .every(scan => provenance.scans[scan] === 'complete')) return false
  const exclusion = extractPromptExclusions(question)
  const excluded = compileSourceExclusions(exclusion.excludedTerms, exclusion.excludedPathHints, rootPath)
  if (!excluded.valid) return false
  const allowed = (logical: string, canonical?: string): boolean => [logical, ...(canonical ? [canonical] : [])]
    .every(file => !excluded.matchesSource(file, basename(file), rootPath)
      && !exclusion.excludedDomains.includes(classifySourceDomain(file, rootPath) as never))
  const inputs = provenance.sources.filter(source => source.in_program)
  if (!inputs.length || inputs.length > 32) return false
  const files = new Map<string, { source: ts.SourceFile; hash: string }>()
  const validateInputs = (capture: boolean): boolean => {
    if (!sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowed)) return false
    let bytes = 0
    for (const input of inputs) {
      if (!allowed(input.source_file)) return false
      const canonical = sourcePathForEvidence(input.source_file, rootPath)
      if (!canonical || canonical !== input.canonical_file || !allowed(input.source_file, canonical)) return false
      let snapshot: ReturnType<typeof readVerifiedSourceSnapshot>
      try { snapshot = readVerifiedSourceSnapshot(input.source_file, rootPath) } catch { return false }
      const { lines } = snapshot
      const text = lines.join('\n')
      if (snapshot.canonical !== canonical || (bytes += snapshot.readBytes) > 1024 * 1024 || digest(text) !== input.source_sha256
        || excluded.matchesText(text)) return false
      if (capture) files.set(resolve(rootPath, input.source_file), { source: sourceSyntaxTree(lines, input.source_file), hash: input.source_sha256 })
    }
    return sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowed)
  }
  if (!validateInputs(true)) return false
  const unique = new Map(provenance.owners.filter(owner => owner.status === 'unique' && owner.declaration_offsets)
    .map(owner => [owner.node_id, owner]))
  const selected = new Set([...provenance.seed_ids, ...dependencies.node_ids])
  const callerFunctions = new Map<string, { fn: ts.FunctionLikeDeclaration; source: ts.SourceFile; hash: string }>()
  let visited = 0
  for (const id of callers) {
    const owner = unique.get(id), file = owner ? files.get(resolve(rootPath, owner.source_file)) : undefined
    if (!owner || !file || (file.source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return false
    const found: ts.FunctionLikeDeclaration[] = []
    const visit = (node: ts.Node): void => {
      if (++visited > 100_000) return
      if (node.getStart(file.source) === owner.declaration_offsets!.start && node.getEnd() === owner.declaration_offsets!.end) {
        if (ts.isFunctionLike(node) && 'body' in node && node.body) found.push(node as ts.FunctionLikeDeclaration)
        else if (ts.isVariableDeclaration(node) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found.push(node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(file.source)
    if (visited > 100_000 || found.length !== 1) return false
    callerFunctions.set(id, { fn: found[0]!, ...file })
  }
  for (const qualified of qualifications) {
    if (!qualified) return false
    const targets = new Set<string>()
    for (const [callerId, { fn, source, hash }] of callerFunctions) {
      const sites: ts.CallExpression[] = []
      let unsupportedDirectSite = false
      const inspect = (node: ts.Node): void => {
        if (++visited > 100_000 || ts.isFunctionLike(node) || ts.isClassLike(node)) return
        if (qualified.expression === undefined && (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node))) unsupportedDirectSite = true
        if (ts.isCallExpression(node) && (qualified.expression === undefined || staticExpression(node.expression) === qualified.expression)) sites.push(node)
        ts.forEachChild(node, inspect)
      }
      for (const parameter of fn.parameters) inspect(parameter)
      inspect(fn.body!)
      if (visited > 100_000 || unsupportedDirectSite) return false
      const callerTargets = new Set<string>()
      for (const site of sites) {
        if (site.questionDotToken || (site.expression.flags & ts.NodeFlags.OptionalChain) !== 0) return false
        const matches = bundles.filter(bundle => bundle.from_id === callerId && bundle.source_sha256 === hash
          && resolve(rootPath, bundle.source_file) === resolve(rootPath, source.fileName)
          && bundle.sites.some(candidate => candidate.start_offset === site.getStart(source) && candidate.end_offset === site.getEnd())
          && bundle.source_dependencies.length === inputs.length
          && bundle.source_dependencies.every(input => files.get(resolve(rootPath, input.source_file))?.hash === input.source_sha256))
        const ids = new Set(matches.map(bundle => bundle.to_id))
        if (ids.size !== 1) return false
        const target = [...ids][0]!
        if (!unique.has(target)) return false
        // With no expression in the request, every direct call must first be
        // authenticated. An unresolved different alias could be the requested
        // implementation too. Intersect proved owner IDs, never call spellings.
        if (!qualified.ids.has(target)) {
          if (qualified.expression !== undefined) return false
          continue
        }
        if (!selected.has(target)) return false
        callerTargets.add(target)
      }
      // "Each" quantifies the requested roots. A successful binding in one
      // root cannot stand in for a missing or unsupported call in another.
      if (callerTargets.size > 1 || qualified.requireEveryCaller && callerTargets.size !== 1) return false
      for (const target of callerTargets) targets.add(target)
    }
    if (!targets.size) return false
  }
  const qualified_ranges = qualifications.map(qualified => qualified!.range)
    .sort((left, right) => left.start - right.start)
  if (qualified_ranges.some((range, index) => index > 0 && range.start < qualified_ranges[index - 1]!.end)) return false
  return validateInputs(false) && { qualified_ranges }
}
