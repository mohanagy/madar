import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import ts from 'typescript'

import type { KnowledgeGraph } from '../contracts/graph.js'
import { classifySourceDomain } from '../shared/source-discovery.js'
import { ExplicitSourceTargetError, type ExplicitSourceTarget, type ExplicitSourceTargetOwner } from './explicit-source-targets.js'
import { extractPromptExclusions } from './retrieval-gate.js'
import { compileSourceExclusions } from './source-exclusions.js'
import { readEvidenceLines } from './retrieve/source-evidence.js'
import { selectSourceDependencies, type SourceFlowOwner } from './retrieve/source-dependencies.js'
import { getSourceModuleConfigurationSnapshot, sourceModuleConfigurationSnapshotIsFresh, type SourceReadPolicy } from './retrieve/source-modules.js'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const rangeOf = (node: ts.Node, source: ts.SourceFile) => ({
  start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  end: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
})
function staticExpression(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken || !ts.isIdentifier(node.name)) return undefined
  const parent = staticExpression(node.expression)
  return parent ? `${parent}.${node.name.text}` : undefined
}

/** Exact caller syntax selects a binding; names never search for a callee owner. */
export function resolveExplicitSourceCallees(options: {
  graph: KnowledgeGraph; rootPath: string; prompt: string
  targets: readonly ExplicitSourceTarget[]; callers: readonly ExplicitSourceTargetOwner[]
  verifyTarget(owner: SourceFlowOwner): ExplicitSourceTargetOwner
}): ExplicitSourceTargetOwner[] {
  const { graph, rootPath, prompt, targets, callers } = options
  if (!targets.some(target => target.callee !== undefined)) return [...callers]
  if (targets.length !== callers.length || !targets.length || targets.length > 8) throw new ExplicitSourceTargetError('Callee lookup requires at most 8 exact caller targets')
  const realRoot = realpathSync(rootPath), exclusions = extractPromptExclusions(prompt)
  const excluded = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, rootPath)
  if (!excluded.valid) throw new ExplicitSourceTargetError('Callee lookup cannot verify the requested exclusion scope')
  const sourceInputs = new Map<string, number>()
  const readPolicy: SourceReadPolicy = (logical, canonical) => {
    if (excluded.matchesSource(logical, basename(logical)) || excluded.matchesPath(logical, rootPath)
      || exclusions.excludedDomains.includes(classifySourceDomain(logical, rootPath) as never)) return false
    if (canonical && (excluded.matchesPath(canonical, realRoot)
      || exclusions.excludedDomains.includes(classifySourceDomain(canonical, realRoot) as never))) return false
    // Share the existing source program bounds across all requested bindings,
    // including import-frontier reads that do not enter the final program.
    if (canonical && /\.[cm]?[jt]sx?$/i.test(logical)) {
      const size = statSync(canonical).size
      if (!sourceInputs.has(canonical) && sourceInputs.size >= 32
        || [...sourceInputs.values()].reduce((sum, bytes) => sum + bytes, 0) - (sourceInputs.get(canonical) ?? 0) + size > 1024 * 1024) return false
      sourceInputs.set(canonical, size)
    }
    return true
  }
  const cache = new Map<string, string[] | null>()
  const seeds = [...new Set(callers.filter((_, index) => targets[index]!.callee !== undefined).map(owner => owner.nodeId))]
  const selection = selectSourceDependencies(graph, seeds, rootPath, cache, {
    includeCallers: false, inspectionOnly: true, readPolicy,
  })
  const configuration = getSourceModuleConfigurationSnapshot(selection.receipt)
  const bundles = selection.source_callsite_bundles ?? []
  const dependencies = new Map<string, string>()
  for (const bundle of bundles) for (const input of bundle.source_dependencies) {
    const path = resolve(rootPath, input.source_file), prior = dependencies.get(path)
    if (prior && prior !== input.source_sha256) throw new ExplicitSourceTargetError('Callee lookup has inconsistent source inputs')
    dependencies.set(path, input.source_sha256)
  }
  const fail = (index: number, reason: string): never => {
    const target = targets[index]!
    throw new ExplicitSourceTargetError(`Target '${target.file}:${target.symbol}' callee '${target.callee}': ${reason}. Request a fresh exact caller lookup; no alternate owner was selected`)
  }
  const validate = (): void => {
    if (realpathSync(rootPath) !== realRoot || !sourceModuleConfigurationSnapshotIsFresh(configuration, rootPath, readPolicy)) {
      throw new ExplicitSourceTargetError('Callee lookup source configuration or policy changed or could not be verified')
    }
    for (const [file, hash] of dependencies) {
      const canonical = realpathSync(file)
      if (!readPolicy(file, canonical)) throw new ExplicitSourceTargetError('Callee lookup source is excluded or exceeds its read bound')
      // Never validate against the inspection cache: import/barrel edits can
      // redirect a binding while leaving the caller and callee bytes unchanged.
      const lines = readEvidenceLines(file, rootPath)
      if (!lines || digest(lines.join('\n')) !== hash) throw new ExplicitSourceTargetError('Callee lookup source binding changed; request a fresh exact caller lookup')
    }
    for (const caller of callers) caller.validate()
  }
  if (!configuration || !dependencies.size || dependencies.size > 32) throw new ExplicitSourceTargetError('Callee lookup could not prove bindings within its source/configuration bounds')
  validate()
  let visited = 0
  const syntaxCache = new Map<string, ts.SourceFile>()
  const result = callers.map((caller, index) => {
    const callee = targets[index]!.callee
    if (callee === undefined) return caller
    const file = resolve(rootPath, caller.sourceFile), canonical = realpathSync(file)
    const lines = cache.get(canonical) ?? cache.get(file)
    if (!lines || !dependencies.has(file) || !readPolicy(file, canonical)) return fail(index, 'caller was not verified in the bounded program')
    if (!syntaxCache.has(file)) syntaxCache.set(file, ts.createSourceFile(file, lines.join('\n'), ts.ScriptTarget.Latest, true))
    const source = syntaxCache.get(file)!
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return fail(index, 'caller syntax is not complete')
    const functions: ts.FunctionLikeDeclaration[] = []
    const scan = (node: ts.Node): void => {
      if (++visited > 100_000) return
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        let boundary: ts.Node = node
        if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
          while (ts.isParenthesizedExpression(boundary.parent) || ts.isAsExpression(boundary.parent) || ts.isNonNullExpression(boundary.parent)) boundary = boundary.parent
          if (ts.isVariableDeclaration(boundary.parent) || ts.isPropertyDeclaration(boundary.parent)
            || ts.isBinaryExpression(boundary.parent) && boundary.parent.right === boundary) boundary = boundary.parent
        }
        const range = rangeOf(boundary, source)
        if (range.start === caller.range.start && range.end === caller.range.end) functions.push(node as ts.FunctionLikeDeclaration)
      }
      ts.forEachChild(node, scan)
    }
    scan(source)
    if (visited > 100_000 || functions.length !== 1) return fail(index, 'caller has no unique direct function body')
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node): void => {
      if (++visited > 100_000 || ts.isFunctionLike(node) || ts.isClassLike(node)) return
      if (ts.isCallExpression(node) && staticExpression(node.expression) === callee) calls.push(node)
      ts.forEachChild(node, inspect)
    }
    for (const parameter of functions[0]!.parameters) inspect(parameter)
    inspect(functions[0]!.body!)
    if (visited > 100_000 || !calls.length) return fail(index, 'no matching supported direct call was proven')
    const targetIds = new Set<string>()
    for (const call of calls) {
      if (call.questionDotToken) return fail(index, 'optional call binding is unsupported')
      const matching = bundles.filter(bundle => bundle.from_id === caller.nodeId
        && resolve(rootPath, bundle.source_file) === file && bundle.source_sha256 === dependencies.get(file)
        && bundle.sites.some(site => site.start_offset === call.getStart(source) && site.end_offset === call.getEnd()))
      const ids = new Set(matching.map(bundle => bundle.to_id))
      if (ids.size !== 1) return fail(index, 'a matching direct call has unresolved or ambiguous local binding')
      targetIds.add([...ids][0]!)
    }
    if (targetIds.size !== 1) return fail(index, 'matching direct calls bind different local owners')
    const targetId = [...targetIds][0]!, owners = (selection.source_flow_callees ?? []).filter(owner => owner.node_id === targetId)
    if (owners.length !== 1 || !dependencies.has(resolve(rootPath, owners[0]!.source_file))) return fail(index, 'callee has no unique current source owner')
    const owner = options.verifyTarget(owners[0]!)
    if (owner.nodeId !== targetId) return fail(index, 'callee identity changed during verification')
    return { ...owner, validate: () => { validate(); owner.validate() } }
  })
  validate()
  return result
}
