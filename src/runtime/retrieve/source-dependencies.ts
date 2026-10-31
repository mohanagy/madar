import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createSourceCompilerHost } from './source-compiler-host.js'

import type { KnowledgeGraph } from '../../contracts/graph.js'
import type { ContextPackSourceDependencies, ContextPackTaskContract, ContextPackEvidenceClass } from '../../contracts/context-pack.js'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { coherentSourceSnippet, readEvidenceLines, sourceBodyQueryTerms, sourceBodyWords, sourcePathForEvidence, sourceRangeMatchesSymbol } from './source-evidence.js'
import { createSourceModuleResolver, getSourceModuleConfigurationSnapshot, sourceModuleConfigurationSnapshotIsFresh, type SourceReadPolicy } from './source-modules.js'
import { sourceClientImportGroup, sourceHasDirective } from './source-client-context.js'
import { sourceSubjectQueries } from './source-subject-priority.js'
import { sourceSelectionProvenanceKey, recordKnownForwardReachability, type SourceSelectionProvenance, type SourceSeedOrigins, type SourceAdmissionRole } from './source-selection-provenance.js'
export { sourceSelectionProvenanceKey, type SourceSelectionProvenance, type SourceSeedOrigins } from './source-selection-provenance.js'

const MAX_FILES = 32
const MAX_BYTES = 1024 * 1024
const MAX_IMPORT_SCAN_FILES = 256
const MAX_IMPORT_SCAN_BYTES = 2 * 1024 * 1024
const MAX_CALLS = 4096
const MAX_MUTATION_NODES = 100_000
const MAX_MUTATION_ORIGINS = 16
const MAX_CALLSITE_ANCESTORS = 256
const MAX_ADDITIONS = 12
const JS_SOURCE = /\.[cm]?[jt]sx?$/i

interface Owner { id: string; start: number; end: number; file: boolean; label: string; snippet: string }
type CallsiteRange = { start_line: number; end_line: number }
interface Call { from: string; to?: string; line: number; file: string; callee: string; relation: 'calls' | 'depends_on'; dataReference?: boolean; observed?: { start_offset: number; end_offset: number }; reason?: 'unresolved' | 'external' | 'no_implementation' | 'outside_index'; site?: { start_offset: number; end_offset: number; ranges: CallsiteRange[]; alternatives?: [CallsiteRange[], CallsiteRange[]] } }

/** Internal source provenance, never a new runtime call or completeness claim. */
export const sourceCallsiteBundlesKey = Symbol('sourceCallsiteBundles')
export const sourceFunctionValueReferencesKey = Symbol('sourceFunctionValueReferences')
export const sourceFlowCatalogKey = Symbol('sourceFlowCatalog')
/** Request-local presentation preference; never serialized dependency authority. */
export const sourceLocalPriorityKey = Symbol('sourceLocalPriority')
export const sourceClientPriorityKey = Symbol('sourceClientPriority')
export const sourceSubjectPriorityKey = Symbol('sourceSubjectPriority')

export interface SourceFlowOwner {
  node_id: string
  label: string
  source_file: string
  range: { start_line: number; end_line: number }
}
/** Data-only provenance. Neither index membership nor overflow implies a call. */
export interface SourceFlowCatalog {
  version: 1
  task_contract: ContextPackTaskContract
  callees: SourceFlowOwner[]
  overflow: Array<SourceFlowOwner & { evidence_class: ContextPackEvidenceClass }>
}

export interface SourceFunctionValueReference {
  caller: { node_id: string; label: string; source_file: string; range: { start_line: number; end_line: number } }
  target: { node_id: string; label: string; source_file: string; range: { start_line: number; end_line: number } }
  read: { start_offset: number; end_offset: number }
  source_dependencies: SourceCallsiteBundle['source_dependencies']
}

export interface SourceCallsiteBundle {
  from_id: string
  to_id: string
  source_file: string
  /** Hash of readEvidenceLines(...).join('\n'), matching the parsed source. */
  source_sha256: string
  /** Complete call statements or const-object properties, with ancestor syntax and explicit sibling omissions. */
  ranges: Array<{ start_line: number; end_line: number }>
  /** Optional all-sites source context, never a completeness or execution claim. */
  range_alternatives?: CallsiteRange[][]
  /** Exact call-expression offsets in that same normalized source. */
  sites: Array<{ start_offset: number; end_offset: number }>
  /** All program inputs must remain current; an imported alias can change a binding. */
  source_dependencies: Array<{ source_file: string; source_sha256: string }>
}


export interface SourceDependencySelection {
  [sourceSelectionProvenanceKey]?: SourceSelectionProvenance
  [sourceLocalPriorityKey]?: string[]
  [sourceClientPriorityKey]?: string[]
  [sourceSubjectPriorityKey]?: string[]
  node_ids: string[]
  relationships: Array<{ from_id: string; to_id: string; relation: 'calls' | 'depends_on' }>
  receipt: ContextPackSourceDependencies
  /** Current declaration candidates subject to source call confirmation; not proof of unique ownership or complete resolution. */
  source_call_authority_owner_ids?: string[]
  /** All bounded inspected static calls, including owners outside the selected closure. Internal only. */
  source_resolved_call_pairs?: Array<{ from_id: string; to_id: string }>
  /** All inspected sites for each resolved pair, withheld when the call scan is incomplete. Internal only. */
  source_callsite_bundles?: SourceCallsiteBundle[]
  /** Runtime function-value reads only; never call or callback invocation authority. */
  source_function_value_references?: SourceFunctionValueReference[]
  source_flow_callees?: SourceFlowOwner[]
}

function moduleSpecifiers(text: string): string[] {
  // TypeScript's scanner excludes comments and string contents, including text
  // that merely looks like an import inside a function or an error message.
  return ts.preProcessFile(text, true, true).importedFiles.map(entry => entry.fileName)
}

function executable(node: ts.Node): boolean {
  return (ts.isFunctionLike(node) && 'body' in node && !!node.body)
    || ts.isClassDeclaration(node) || ts.isClassExpression(node)
    || (ts.isVariableDeclaration(node) && !!node.initializer)
}

/** A bounded source call closure. Type declarations are never promoted into implementations. */
export function selectSourceDependencies(
  graph: KnowledgeGraph,
  seedIds: readonly string[],
  rootPath: string | undefined,
  cache: Map<string, string[] | null>,
  options: { includeCallers?: boolean; dependenciesOnly?: boolean; callerPriority?: boolean; inspectionOnly?: boolean; allowedSourceFiles?: ReadonlySet<string>; functionValueCallerIds?: readonly string[]; seedOrigins?: SourceSeedOrigins; readPolicy?: SourceReadPolicy;
    localPriority?: { seedId: string; allowedOwner: (file: string, label: string, text: string) => boolean };
    clientPriority?: { seedId: string; question: string; allowedOwner: (file: string, label: string, text: string) => boolean };
    subjectPriority?: { seedId: string; question: string; allowedPath: SourceReadPolicy; allowedOwner: (file: string, label: string, text: string) => boolean } } = {},
): SourceDependencySelection {
  const receipt: ContextPackSourceDependencies = { scanned_files: 0, resolved_calls: 0, unresolved_calls: 0, bounded: false }
  const provenance: SourceSelectionProvenance = {
    version: 1, scope: 'bounded_supported_static_source', ...(rootPath ? { root_path: resolve(rootPath) } : {}),
    seed_ids: [...seedIds], ...(options.seedOrigins ? { seed_origins: structuredClone(options.seedOrigins) } : {}),
    policy: { include_callers: options.includeCallers !== false, caller_priority: options.callerPriority === true,
      inspection_only: options.inspectionOnly === true },
    admissions: [], observed_roles: [], selected_ids: [...new Set(seedIds)], addition_limit_hit: false,
    scans: { source_loading: 'not_started', program: 'not_started', identity: 'not_started', calls: 'not_started',
      data_references: 'not_started', mutation: 'not_started', write_origins: 'not_started' },
    limitations: [], sources: [], owners: [], resolved_pairs: [], unresolved: [], unattributed_calls: 0,
    forward: { known_reachable_ids: [...new Set(seedIds)], unresolved_from_reachable_ids: [], exclusion_proof: 'not_provided' },
  }
  const result: SourceDependencySelection = { node_ids: [], relationships: [], receipt, [sourceSelectionProvenanceKey]: provenance }
  const limitations = new Set<string>()
  const note = (reason: string): void => { limitations.add(reason); provenance.limitations = [...limitations] }
  const byPath = new Map<string, Array<{ id: string; label: string; location: string; file: boolean; snippet: string }>>()
  const nodePaths = new Map<string, string>()
  for (const [id, node] of graph.nodeEntries()) {
    const path = String(node.source_file ?? '')
    if (node.file_type !== 'code' || node.external_call === true || !JS_SOURCE.test(path)) continue
    const canonical = resolve(rootPath ?? '.', path)
    if (options.allowedSourceFiles && !options.allowedSourceFiles.has(canonical)) continue
    const entries = byPath.get(canonical) ?? []
    entries.push({ id, snippet: typeof node.snippet === 'string' ? node.snippet : '', label: String(node.label ?? ''), location: String(node.source_location ?? ''), file: /(?:^|[/\\])[^/\\]+$/.test(path) && String(node.label ?? '') === path.split(/[/\\]/).at(-1) })
    byPath.set(canonical, entries)
    nodePaths.set(id, canonical)
  }
  const indexed = new Set(byPath.keys())
  const modulePath = createSourceModuleResolver(indexed, rootPath, () => { receipt.bounded = true; provenance.scans.program = 'incomplete'; note('module_configuration_or_resolution_incomplete') }, receipt, options.readPolicy)
  const seedFiles = [...new Set(seedIds.flatMap(id => nodePaths.get(id) ? [nodePaths.get(id)!] : []))]
  if (!seedFiles.length) { note('no_supported_seed_files'); return result }
  provenance.scans.source_loading = 'complete'
  provenance.scans.program = 'complete'
  const imports = new Map<string, string[]>()
  const texts = new Map<string, string>()
  // Private identity receipt only; absence never changes the existing binding scan.
  const sourceCanonicalInputs = new Map<string, string>()
  let inspectedBytes = 0
  const loadText = (path: string): string | undefined => {
    if (options.readPolicy) {
      let allowed = options.readPolicy(path)
      try { allowed &&= options.readPolicy(path, realpathSync(path)) } catch { allowed = false }
      if (!allowed) { receipt.bounded = true; provenance.scans.source_loading = 'incomplete'; note('source_read_policy'); return undefined }
    }
    if (texts.has(path)) return texts.get(path)
    if (texts.size >= MAX_IMPORT_SCAN_FILES) { receipt.bounded = true; provenance.scans.source_loading = 'incomplete'; note('import_file_limit'); return undefined }
    const originalCanonical = sourcePathForEvidence(path, rootPath)
    const lines = readEvidenceLines(path, rootPath, cache)
    if (!lines) { receipt.bounded = true; provenance.scans.source_loading = 'incomplete'; note('source_unreadable_or_excluded'); return undefined }
    const text = lines.join('\n')
    if (originalCanonical && sourcePathForEvidence(path, rootPath) === originalCanonical) sourceCanonicalInputs.set(path, originalCanonical)
    if (inspectedBytes + Buffer.byteLength(text) > MAX_IMPORT_SCAN_BYTES) { receipt.bounded = true; provenance.scans.source_loading = 'incomplete'; note('import_byte_limit'); return undefined }
    inspectedBytes += Buffer.byteLength(text)
    texts.set(path, text)
    imports.set(path, moduleSpecifiers(text).flatMap(specifier => modulePath(specifier, path) ?? []))
    return text
  }
  // A current client import group only navigates the bounded program. It does
  // not admit an owner, and a later failed binding proof gives it no priority.
  const clientSeed = options.clientPriority && !options.callerPriority && !options.inspectionOnly
    && seedIds.includes(options.clientPriority.seedId) ? nodePaths.get(options.clientPriority.seedId) : undefined
  const clientText = clientSeed ? loadText(clientSeed) : undefined
  const clientGroup = clientSeed && clientText !== undefined
    ? sourceClientImportGroup(ts.createSourceFile(clientSeed, clientText, ts.ScriptTarget.Latest, true), options.clientPriority!.question) : undefined
  const clientModule = clientGroup && clientSeed ? modulePath(clientGroup.specifier, clientSeed) : undefined
  const clientModuleText = clientModule ? loadText(clientModule) : undefined
  const clientHint = clientModule && clientModuleText !== undefined
    && !sourceHasDirective(ts.createSourceFile(clientModule, clientModuleText, ts.ScriptTarget.Latest, true), 'use server')
    ? { file: clientModule, group: clientGroup! } : undefined
  const preferredInputs = clientHint ? [...new Set([clientHint.file, ...(imports.get(clientHint.file) ?? [])])] : []
  const includeCallers = options.includeCallers !== false && !clientHint
  provenance.policy.include_callers = includeCallers
  // Resolve known dependencies before a reverse-import scan can spend the
  // bounded read allowance on unrelated files.
  const importFrontier = [...new Set([...seedFiles, ...preferredInputs])]
  const importSeen = new Set(importFrontier)
  for (let index = 0; index < Math.min(importFrontier.length, MAX_FILES); index += 1) {
    const path = importFrontier[index]!
    loadText(path)
    for (const target of imports.get(path) ?? []) if (!importSeen.has(target)) { importSeen.add(target); importFrontier.push(target) }
  }
  if (importFrontier.length > MAX_FILES) { receipt.bounded = true; note('import_frontier_limit'); provenance.scans.source_loading = 'incomplete' }
  // Source body search normally populated this request cache already. The scan is
  // still capped, and only imports determine which files enter the type program.
  if (includeCallers) {
    const paths = [...indexed].sort()
    if (paths.length > MAX_IMPORT_SCAN_FILES) { receipt.bounded = true; note('reverse_import_file_limit'); provenance.scans.source_loading = 'incomplete' }
    for (const path of paths.slice(0, MAX_IMPORT_SCAN_FILES)) loadText(path)
  }
  const selectedFiles = new Map<string, ts.SourceFile>()
  const owners = new Map<string, Owner[]>()
  let bytes = 0
  const queue = [...seedFiles.map(path => ({ path, depth: 0 })),
    ...preferredInputs.filter(path => !seedFiles.includes(path)).map(path => ({ path, depth: path === clientHint!.file ? 1 : 2 }))]
  const queued = new Set(queue.map(entry => entry.path))
  const enqueue = (path: string, depth: number): void => {
    if (!queued.has(path)) { queued.add(path); queue.push({ path, depth }) }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const { path, depth } = queue[index]!
    const text = loadText(path)
    if (text === undefined) { provenance.scans.program = 'incomplete'; continue }
    if (selectedFiles.size >= MAX_FILES || bytes + Buffer.byteLength(text) > MAX_BYTES) { receipt.bounded = true; provenance.scans.program = 'incomplete'; note('program_file_or_byte_limit'); continue }
    const safePath = sourcePathForEvidence(path, rootPath)
    if (!safePath) { receipt.bounded = true; provenance.scans.program = 'incomplete'; note('program_source_excluded'); continue }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    // A recovered parser tree is not authority over the legacy graph.
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) {
      receipt.bounded = true; provenance.scans.program = 'incomplete'; note('program_parse_diagnostics')
      continue
    }
    selectedFiles.set(path, source)
    bytes += Buffer.byteLength(text)
    const lines = cache.get(safePath) ?? text.split('\n')
    const fileOwners: Owner[] = []
    for (const entry of byPath.get(path) ?? []) {
      const indexedRange = lineRangeFromSourceLocation(entry.location)
      if (!indexedRange) { note('owner_range_unavailable'); continue }
      const range = entry.file ? { start: 1, end: lines.length } : indexedRange
      if (range) fileOwners.push({ id: entry.id, start: range.start, end: range.end, file: entry.file, label: entry.label, snippet: entry.snippet })
      else receipt.bounded = true
    }
    owners.set(path, fileOwners.sort((left, right) => Number(left.file) - Number(right.file) || (left.end - left.start) - (right.end - right.start) || left.id.localeCompare(right.id)))
    if (depth < 3) for (const target of imports.get(path) ?? []) enqueue(target, depth + 1)
    else if ((imports.get(path)?.length ?? 0) > 0) { receipt.bounded = true; provenance.scans.program = 'incomplete'; note('program_import_depth_limit') }
    if (includeCallers && depth < 2) {
      for (const [importer, targets] of imports) if (targets.includes(path)) enqueue(importer, depth + 1)
    }
  }
  receipt.scanned_files = texts.size
  const snapshotInputs = (): void => {
    provenance.sources = [...texts].map(([source_file, text]) => ({ source_file,
      source_sha256: createHash('sha256').update(text).digest('hex'), in_program: selectedFiles.has(source_file),
      ...(sourceCanonicalInputs.has(source_file) ? { canonical_file: sourceCanonicalInputs.get(source_file)! } : {}) }))
    const configuration = getSourceModuleConfigurationSnapshot(receipt)
    if (configuration) provenance.configuration = structuredClone(configuration)
  }
  if (!selectedFiles.size) { snapshotInputs(); note('no_selected_program'); return result }
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, noLib: true, noResolve: false, allowJs: true, checkJs: true, skipLibCheck: true }
  const compiler = createSourceCompilerHost(selectedFiles, rootPath ?? '/', modulePath)
  if (!compiler) {
    receipt.bounded = true; provenance.scans.program = 'incomplete'; note('ambiguous_compiler_source_path')
    snapshotInputs(); return result
  }
  const nativeSourcePath = compiler.nativePath
  const program = ts.createProgram(compiler.rootNames, compilerOptions, compiler.host)
  const checker = program.getTypeChecker()
  // Line containment cannot distinguish adjacent declarations on one line.
  // Map graph evidence to actual declarations before assigning call ownership.
  interface DeclarationIdentity {
    node: ts.Node; name: string; qualified: string; role: 'function' | 'method' | 'class' | 'value' | 'namespace';
    start: number; nameLine: number; end: number; text: string; callable: boolean; assignment?: boolean;
  }
  const declarationOwners = new Map<ts.Node, Owner>()
  const ownerDeclarations = new Map<string, ts.Node>()
  const ownerBoundaries = new Set<ts.Node>()
  const fileOwners = new Map<string, Owner>()
  const canonicalDeclaration = (node: ts.Node): ts.Node => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
      let value: ts.Node = node
      while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent)
        || ts.isNonNullExpression(value.parent)) value = value.parent
      if ((ts.isVariableDeclaration(value.parent) || ts.isPropertyDeclaration(value.parent))
        && value.parent.initializer === value) return value.parent
      // The source index names the static assignment occurrence, not the
      // expression's private function name. This is containment identity only.
      if (ts.isBinaryExpression(value.parent) && value.parent.right === value
        && sourceFunctionOccurrence(value.parent, value.getSourceFile())) return value.parent
    }
    return node
  }
  const valueInitializer = (node: ts.Node): ts.Expression | undefined => {
    let initializer = ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) ? node.initializer
      : ts.isBinaryExpression(node) && sourceFunctionOccurrence(node, node.getSourceFile()) ? node.right : undefined
    while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
      || ts.isNonNullExpression(initializer))) initializer = initializer.expression
    return initializer
  }
  const namedIdentity = (node: ts.Node): DeclarationIdentity | undefined => {
    if (ts.isBinaryExpression(node)) {
      const source = node.getSourceFile(), occurrence = sourceFunctionOccurrence(node, source)
      if (occurrence) return { node, name: occurrence.name, qualified: occurrence.qualifiedName, role: 'function',
        start: occurrence.start, nameLine: occurrence.start, end: occurrence.end,
        text: node.getText(source).replace(/\r\n?/g, '\n').trim(), callable: true, assignment: true }
    }
    if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
      || ts.isClassExpression(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isVariableDeclaration(node)
      || ts.isPropertyDeclaration(node) || ts.isModuleDeclaration(node))) return undefined
    if (canonicalDeclaration(node) !== node) return undefined
    const nameNode = 'name' in node ? node.name : undefined
    const name = ts.isConstructorDeclaration(node) ? 'constructor'
      : nameNode && (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) ? nameNode.text : undefined
    if (!name) return undefined
    const role = ts.isClassDeclaration(node) || ts.isClassExpression(node) ? 'class'
      : ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ? 'method'
        : ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? 'function'
          : ts.isModuleDeclaration(node) ? 'namespace' : 'value'
    const containers: string[] = []
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isModuleDeclaration(parent))
        && parent.name && ts.isIdentifier(parent.name)) containers.unshift(parent.name.text)
    }
    const source = node.getSourceFile()
    const initializer = valueInitializer(node)
    return { node, name, qualified: [...containers, name].join('.'), role,
      start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      nameLine: source.getLineAndCharacterOfPosition(nameNode?.getStart(source) ?? node.getStart(source)).line + 1,
      end: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      text: node.getText(source).replace(/\r\n?/g, '\n').trim(),
      callable: role === 'function' || role === 'method'
        || !!initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)),
    }
  }
  let identityNodes = 0
  let identityScanComplete = true
  const eligibleOwners = new Set<string>()
  for (const source of selectedFiles.values()) {
    const declarations = new Map<string, DeclarationIdentity[]>()
    const collect = (node: ts.Node): void => {
      if (++identityNodes > MAX_MUTATION_NODES) { identityScanComplete = false; receipt.bounded = true; return }
      const identity = namedIdentity(node)
      // Unindexed ordinary local values are not executable scope boundaries.
      // Named callable/class initializers still stop ownership at their binding.
      const value = ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)
      const initializer = valueInitializer(node)
      if ((!value && identity) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
        || initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
          || ts.isClassExpression(initializer))) ownerBoundaries.add(node)
      if (identity) {
        const entries = declarations.get(identity.name) ?? []
        entries.push(identity); declarations.set(identity.name, entries)
      }
      ts.forEachChild(node, collect)
    }
    collect(source)
    if (!identityScanComplete) break
    const entries = owners.get(nativeSourcePath(source)) ?? []
    const files = entries.filter(owner => owner.file)
    if (files.length === 1) { fileOwners.set(nativeSourcePath(source), files[0]!); eligibleOwners.add(files[0]!.id) }
    for (const owner of files) provenance.owners.push({ node_id: owner.id, source_file: nativeSourcePath(source),
      indexed_range: { start: owner.start, end: owner.end }, status: files.length === 1 ? 'unique' : 'ambiguous' })
    if (files.length > 1) note('ambiguous_file_owner')
    const candidates = new Map<Owner, DeclarationIdentity[]>()
    for (const owner of entries.filter(entry => !entry.file)) {
      const label = owner.label.replace(/\(\)$/, '')
      const name = label.split('.').at(-1) ?? ''
      let matches = (declarations.get(name) ?? []).filter(declaration => declaration.start <= owner.start
        && declaration.nameLine >= owner.start && (owner.end === owner.start || declaration.end === owner.end)
        && (!owner.label.endsWith('()') || declaration.callable)
        && (!label.startsWith('.') || declaration.role === 'method')
        && (!label.includes('.') || label.startsWith('.') || declaration.qualified === label)
        && (!declaration.assignment || sourceRangeMatchesSymbol(cache.get(nativeSourcePath(source)) ?? source.text.split('\n'),
          { start: owner.start, end: owner.end }, owner.label, nativeSourcePath(source))))
      // Stored partial snippets never prove a column or declaration identity.
      if (matches.length > 1 && owner.snippet) {
        const exact = matches.filter(declaration => declaration.text === owner.snippet.replace(/\r\n?/g, '\n').trim())
        if (exact.length) matches = exact
      }
      candidates.set(owner, matches)
      // Ambiguous current declarations still cannot authorize legacy call
      // guesses. Withholding is safe here; positive binding below stays unique.
      if (matches.length) eligibleOwners.add(owner.id)
    }
    const declarationCandidates = new Map<ts.Node, Owner[]>()
    for (const [owner, matches] of candidates) for (const declaration of matches) {
      const entries = declarationCandidates.get(declaration.node) ?? []
      entries.push(owner); declarationCandidates.set(declaration.node, entries)
    }
    for (const [owner, matches] of candidates) {
      const unique = matches.length === 1 && declarationCandidates.get(matches[0]!.node)?.length === 1
      provenance.owners.push({ node_id: owner.id, source_file: nativeSourcePath(source),
        indexed_range: { start: owner.start, end: owner.end }, status: unique ? 'unique' : matches.length ? 'ambiguous' : 'unmatched',
        ...(unique ? { declaration_offsets: { start: matches[0]!.node.getStart(source), end: matches[0]!.node.getEnd() } } : {}) })
      if (!unique) note(matches.length ? 'ambiguous_owner_identity' : 'unmatched_owner_identity')
      // Do not infer identity by elimination: the same direct evidence must be
      // unique in both directions even when an index misses/duplicates nodes.
      if (matches.length === 1 && declarationCandidates.get(matches[0]!.node)?.length === 1) {
        declarationOwners.set(matches[0]!.node, owner); ownerDeclarations.set(owner.id, matches[0]!.node); eligibleOwners.add(owner.id)
      } else receipt.bounded = true
    }
  }
  if (!identityScanComplete) {
    declarationOwners.clear(); ownerDeclarations.clear(); fileOwners.clear(); eligibleOwners.clear()
    for (const owner of provenance.owners) if (owner.status !== 'ambiguous') {
      owner.status = 'incomplete'; delete owner.declaration_offsets
    }
  }
  result.source_call_authority_owner_ids = [...eligibleOwners]
  const declarationOwner = (node: ts.Node): Owner | undefined => declarationOwners.get(canonicalDeclaration(node))
  const callerOwner = (node: ts.Node): Owner | undefined => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      const canonical = canonicalDeclaration(parent)
      // Evaluating the assignment target is outside its callable. Only a walk
      // through the RHS function can establish ownership of that function body.
      if (ts.isBinaryExpression(parent) && sourceFunctionOccurrence(parent, parent.getSourceFile())) continue
      if (declarationOwners.has(canonical) || ownerBoundaries.has(canonical)) return declarationOwners.get(canonical)
      if (ts.isSourceFile(parent)) return fileOwners.get(nativeSourcePath(parent))
      // Unnamed callback functions retain lexical containment. This does not
      // claim the callback is invoked by the surrounding function.
    }
    return undefined
  }
  const callsite = (node: ts.CallExpression | ts.NewExpression, caller: Owner): Call['site'] => {
    const source = node.getSourceFile()
    const declaration = ownerDeclarations.get(caller.id)
    const initializer = declaration ? valueInitializer(declaration) : undefined
    const callable = declaration && ts.isFunctionLike(declaration) ? declaration
      : initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : undefined
    const body = callable && 'body' in callable ? callable.body : undefined
    // File-level and expression-bodied calls do not have a verified statement
    // boundary inside a callable. Leave their existing relationship untouched.
    if (!declaration || !body || !ts.isBlock(body)) return undefined
    let cursor: ts.Node | undefined = node
    let ancestors = 0
    while (cursor && cursor !== body && (!ts.isStatement(cursor) || ts.isBlock(cursor))) {
      if (++ancestors > MAX_CALLSITE_ANCESTORS) return undefined
      cursor = cursor.parent
    }
    if (!cursor || cursor === body || !ts.isStatement(cursor)) return undefined
    const ranges: [CallsiteRange[], CallsiteRange[], CallsiteRange[]] = [[], [], []]
    let optionalNodes = 0, optionalBounded = false
    const simpleBlock = (block: ts.Block): boolean => {
      const statement = block.statements.length === 1 ? block.statements[0] : undefined
      if (!statement || !(ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
        || ts.isReturnStatement(statement) || ts.isThrowStatement(statement))) return false
      let simple = true
      const inspect = (child: ts.Node): void => {
        if (++optionalNodes > MAX_CALLSITE_ANCESTORS) { optionalBounded = true; return }
        if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isConditionalExpression(child)
          || child !== statement && ts.isStatement(child)
          || ts.isBinaryExpression(child) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) { simple = false; return }
        if (!optionalBounded && simple) ts.forEachChild(child, inspect)
      }
      inspect(statement)
      return simple && !optionalBounded
    }
    const keep = (start: number, end: number, output?: number): void => {
      // Whole source lines are the wire unit. Ignore padding at interval edges
      // so a suffix beginning after a block does not accidentally retain its
      // final unrelated statement just because of a leading newline.
      while (start < end && /\s/.test(source.text[start]!)) start += 1
      while (end > start && /\s/.test(source.text[end - 1]!)) end -= 1
      if (end > start) for (const target of output === undefined ? ranges : [ranges[output]!]) target.push({
        start_line: source.getLineAndCharacterOfPosition(start).line + 1,
        end_line: source.getLineAndCharacterOfPosition(end - 1).line + 1,
      })
    }
    const keepOutside = (start: number, end: number, blocks: readonly ts.Block[], output: number): void => {
      for (const block of blocks) {
        const from = block.getStart(source) + 1, to = block.getEnd() - 1
        if (to <= start || from >= end) continue
        keep(start, Math.min(from, end), output); start = Math.max(start, to)
      }
      keep(start, end, output)
    }
    // A single const object can expose one complete property without adding
    // every sibling initializer. The property remains indivisible, including
    // its computed key, conditional branches, and short-circuit conditions.
    let property: ts.PropertyAssignment | undefined
    let object: ts.ObjectLiteralExpression | undefined
    if (ts.isVariableStatement(cursor) && (cursor.declarationList.flags & ts.NodeFlags.Const)
      && cursor.declarationList.declarations.length === 1) {
      const variable = cursor.declarationList.declarations[0]!
      if (ts.isIdentifier(variable.name) && variable.initializer && ts.isObjectLiteralExpression(variable.initializer)) {
        const container = variable.initializer
        let child: ts.Node = node
        let propertyAncestors = ancestors
        while (child.parent && child.parent !== container && child !== cursor) {
          if (++propertyAncestors > MAX_CALLSITE_ANCESTORS) break
          if (ts.isFunctionLike(child.parent) || ts.isClassLike(child.parent)) break
          child = child.parent
        }
        if (child.parent === container && ts.isPropertyAssignment(child)
          && child.initializer.getStart(source) <= node.getStart(source) && node.getEnd() <= child.initializer.getEnd()) {
          property = child; object = container
        }
      }
    }
    if (property && object) {
      keep(cursor.getStart(source), object.getStart(source) + 1)
      keep(property.getStart(source), property.getEnd())
      keep(object.getEnd() - 1, cursor.getEnd())
    } else {
      // Unsupported containers keep the original complete statement. Walk its
      // syntax path rather than replacing it with a guessed execution summary.
      keep(cursor.getStart(source), cursor.getEnd())
    }
    while (cursor !== body) {
      if (++ancestors > MAX_CALLSITE_ANCESTORS) return undefined
      const parent: ts.Node | undefined = cursor.parent
      if (!parent) return undefined
      if (ts.isBlock(parent)) {
        // Retain the braces, with every skipped sibling explicitly represented
        // by the final snippet renderer's omitted-line ranges.
        keep(parent.getStart(source), parent.getStart(source) + 1)
        keep(parent.getEnd() - 1, parent.getEnd())
      } else {
        // This includes callback registration/signatures/other arguments and
        // complete if/else, loop, switch, catch/finally syntax around the path.
        // Non-block siblings are preserved conservatively as exact source.
        keep(parent.getStart(source), cursor.getStart(source), 0)
        keep(cursor.getEnd(), parent.getEnd(), 0)
        const branches = ts.isIfStatement(parent) ? [parent.thenStatement, parent.elseStatement]
          : ts.isTryStatement(parent) ? [parent.tryBlock, parent.catchClause?.block, parent.finallyBlock]
            : ts.isCatchClause(parent) ? [parent.block] : []
        const siblings = branches.filter((branch): branch is ts.Block => !!branch && ts.isBlock(branch)
          && !(branch.getStart(source) <= cursor!.getStart(source) && branch.getEnd() >= cursor!.getEnd()))
          .sort((left, right) => left.getStart(source) - right.getStart(source))
        const larger = siblings.filter(block => !simpleBlock(block))
        for (const [index, blocks] of [larger, siblings].entries()) {
          keepOutside(parent.getStart(source), cursor.getStart(source), blocks, index + 1)
          keepOutside(cursor.getEnd(), parent.getEnd(), blocks, index + 1)
        }
      }
      cursor = parent
    }
    keep(declaration.getStart(source), body.getStart(source) + 1)
    const ordered: [CallsiteRange[], CallsiteRange[], CallsiteRange[]] = [[], [], []]
    for (const [index, parts] of ranges.entries()) for (const range of parts.sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line)) {
      if (range.start_line < caller.start || range.end_line > caller.end) return undefined
      const target = ordered[index]!, last = target.at(-1)
      if (last && range.start_line <= last.end_line + 1) last.end_line = Math.max(last.end_line, range.end_line)
      else target.push({ ...range })
    }
    return { start_offset: node.getStart(source), end_offset: node.getEnd(), ranges: ordered[0],
      ...(!optionalBounded ? { alternatives: [ordered[1], ordered[2]] as [CallsiteRange[], CallsiteRange[]] } : {}) }
  }

  let unattributedCalls = 0
  let callScanComplete = true
  let dataScanComplete = true
  const calls: Call[] = []
  const dataReferences = new Map<string, Call>()
  const observedDataReferences: Call[] = []
  const classAnchors = new Map<string, Set<string>>()
  const valueExports = new Map<ts.Symbol, Map<string, boolean>>()
  const identity = (symbol: ts.Symbol): ts.Symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const runtimeExport = (module: ts.Symbol, name: string, seen = new Set<ts.Symbol>()): boolean => {
    if (seen.has(module) || seen.size >= 8) return false
    if (valueExports.get(module)?.has(name)) return valueExports.get(module)!.get(name)!
    seen.add(module)
    const exported = checker.getExportsOfModule(module).find(symbol => symbol.name === name)
    const source = module.valueDeclaration
    let allowed = false
    if (exported && source && ts.isSourceFile(source)
      && !exported.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) {
      allowed = exported.declarations?.some(declaration => declaration.getSourceFile() === source) ?? false
      // A type-only export-star has no per-name alias declaration. Require an
      // actual value-export route to the same symbol instead of erasing it.
      if (!allowed) for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.exportClause || !statement.moduleSpecifier) continue
        const next = checker.getSymbolAtLocation(statement.moduleSpecifier)
        const candidate = next ? checker.getExportsOfModule(next).find(symbol => symbol.name === name) : undefined
        if (next && candidate && identity(candidate) === identity(exported) && runtimeExport(next, name, new Set(seen))) { allowed = true; break }
      }
    }
    const cache = valueExports.get(module) ?? new Map<string, boolean>()
    cache.set(name, allowed); valueExports.set(module, cache)
    return allowed
  }
  const unalias = (initial: ts.Symbol | undefined): ts.Symbol | undefined => {
    let symbol = initial
    const seen = new Set<ts.Symbol>()
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      if (seen.has(symbol) || seen.size >= 8 || symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return undefined
      seen.add(symbol)
      for (const declaration of symbol.declarations ?? []) {
        let module: ts.Expression | undefined
        let name: string | undefined
        if (ts.isImportSpecifier(declaration)) { module = declaration.parent.parent.parent.moduleSpecifier; name = (declaration.propertyName ?? declaration.name).text }
        else if (ts.isImportClause(declaration) && declaration.name) { module = declaration.parent.moduleSpecifier; name = 'default' }
        else if (ts.isExportSpecifier(declaration)) { module = declaration.parent.parent.moduleSpecifier; name = (declaration.propertyName ?? declaration.name).text }
        const target = module ? checker.getSymbolAtLocation(module) : undefined
        if (target && name && !runtimeExport(target, name)) return undefined
      }
      symbol = checker.getImmediateAliasedSymbol(symbol)
    }
    return symbol
  }
  // A declaration is a binding, not a promise that its value never changes.
  // Inspect only this already-bounded source program, using checker identity so
  // a same-name write in a nested scope cannot poison an unrelated binding.
  const bindingWrites = new Set<ts.Symbol>()
  // The new module-local path has its own write identity checks. In particular,
  // a shorthand assignment's property symbol is not its assigned value symbol.
  const localBindingWrites = new Set<ts.Symbol>()
  const unresolvedLocalWriteNames = new Map<ts.SourceFile, Set<string>>()
  const unsafeLocalBindingFiles = new Set<ts.SourceFile>()
  const blockFunctionNames = new Map<ts.SourceFile, Set<string>>()
  const assignedValues = new Map<ts.Symbol, Set<ts.Expression>>()
  const memberTargets: Array<ts.PropertyAccessExpression | ts.ElementAccessExpression> = []
  let mutationScanComplete = true
  let mutationNodes = 0
  const transparentLocalExpression = (node: ts.Node): ts.Node | undefined => {
    for (let depth = 0; depth < 8; depth += 1) {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
      else return node
    }
    return undefined
  }
  const recordLocalWrite = (target: ts.Node, depth = 0): void => {
    const source = target.getSourceFile()
    if (depth >= 32) { unsafeLocalBindingFiles.add(source); return }
    const node = transparentLocalExpression(target)
    if (!node) { unsafeLocalBindingFiles.add(source); return }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
      if (symbol) localBindingWrites.add(symbol)
      else {
        // A different lexical name cannot assign this module-local binding.
        // Retain unknown same-name writes without poisoning unrelated helpers.
        const names = unresolvedLocalWriteNames.get(source) ?? new Set<string>()
        names.add(node.text); unresolvedLocalWriteNames.set(source, names)
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) recordLocalWrite(property.initializer, depth + 1)
        else if (ts.isShorthandPropertyAssignment(property)) recordLocalWrite(property.name, depth + 1)
        else if (ts.isSpreadAssignment(property)) recordLocalWrite(property.expression, depth + 1)
        else unsafeLocalBindingFiles.add(source)
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) recordLocalWrite(ts.isSpreadElement(element) ? element.expression : element, depth + 1)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      recordLocalWrite(node.left, depth + 1)
    } else if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node) && !ts.isOmittedExpression(node)) {
      unsafeLocalBindingFiles.add(source)
    }
  }
  const recordWrite = (target: ts.Node, value?: ts.Expression): void => {
    if (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isNonNullExpression(target)) {
      recordWrite(target.expression, value)
    } else if (ts.isIdentifier(target)) {
      const symbol = unalias(checker.getSymbolAtLocation(target))
      if (symbol) {
        bindingWrites.add(symbol)
        if (value) {
          const values = assignedValues.get(symbol) ?? new Set<ts.Expression>()
          values.add(value); assignedValues.set(symbol, values)
        }
      }
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      memberTargets.push(target)
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) recordWrite(property.initializer)
        else if (ts.isShorthandPropertyAssignment(property)) recordWrite(property.name)
        else if (ts.isSpreadAssignment(property)) recordWrite(property.expression)
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) recordWrite(ts.isSpreadElement(element) ? element.expression : element)
    }
  }
  const scanWrites = (node: ts.Node): void => {
    if (!mutationScanComplete) return
    if (++mutationNodes > MAX_MUTATION_NODES) { mutationScanComplete = false; receipt.bounded = true; return }
    // Direct eval may write lexical bindings without an assignment in this AST.
    // A hazard anywhere in the module, including a nested body, disables only
    // the new mutable-binding route. Property keys such as { eval: true } do not.
    if (ts.isWithStatement(node)) unsafeLocalBindingFiles.add(node.getSourceFile())
    // Sloppy-mode Annex B declarations can assign an enclosing var binding
    // even when the checker gives the block declaration a different symbol.
    if (ts.isFunctionDeclaration(node) && node.name && !ts.isSourceFile(node.parent)
      && !(ts.isBlock(node.parent) && ts.isFunctionLike(node.parent.parent)
        && 'body' in node.parent.parent && node.parent.parent.body === node.parent)) {
      const source = node.getSourceFile(), names = blockFunctionNames.get(source) ?? new Set<string>()
      names.add(node.name.text); blockFunctionNames.set(source, names)
    }
    if (ts.isCallExpression(node)) {
      const callee = transparentLocalExpression(node.expression)
      if (!callee || ts.isIdentifier(callee) && callee.text === 'eval') unsafeLocalBindingFiles.add(node.getSourceFile())
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const assignsValue = node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
      recordWrite(node.left, assignsValue ? node.right : undefined)
      recordLocalWrite(node.left)
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      recordWrite(node.operand)
      recordLocalWrite(node.operand)
    } else if (ts.isDeleteExpression(node)) {
      recordWrite(node.expression)
      recordLocalWrite(node.expression)
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      recordWrite(node.initializer)
      recordLocalWrite(node.initializer)
    }
    ts.forEachChild(node, scanWrites)
  }
  for (const source of selectedFiles.values()) scanWrites(source)

  type ReceiverOrigin = ts.Node | ts.Symbol
  const memberWrites = new Map<ReceiverOrigin, Set<string>>()
  let writeOriginsComplete = true
  const originSymbol = (expression: ts.Expression, depth = 0): ts.Symbol | undefined => {
    if (depth >= 8) { writeOriginsComplete = false; receipt.bounded = true; return undefined }
    if (ts.isIdentifier(expression)) return unalias(checker.getSymbolAtLocation(expression))
    if (!ts.isPropertyAccessExpression(expression)) return undefined
    const namespace = originSymbol(expression.expression, depth + 1)
    if (!namespace || !(namespace.flags & ts.SymbolFlags.Module) || !runtimeExport(namespace, expression.name.text)) return undefined
    return unalias(checker.getExportsOfModule(namespace).find(symbol => symbol.name === expression.name.text))
  }
  const receiverOrigins = (expression: ts.Expression, possible: boolean, seen = new Set<ts.Node>()): Set<ReceiverOrigin> => {
    if (seen.has(expression)) return new Set()
    if (seen.size >= 8) { writeOriginsComplete = false; receipt.bounded = true; return new Set() }
    seen.add(expression)
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return receiverOrigins(expression.expression, possible, seen)
    }
    if (ts.isNewExpression(expression)) return new Set([expression])
    if (ts.isClassExpression(expression)) {
      const symbol = checker.getTypeAtLocation(expression).symbol
      return symbol?.declarations?.length === 1 && symbol.declarations[0] === expression
        ? new Set([symbol]) : new Set()
    }
    const prototypeReceiver = ts.isPropertyAccessExpression(expression) && expression.name.text === 'prototype'
      ? expression.expression
      : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) && expression.argumentExpression.text === 'prototype'
        ? expression.expression : undefined
    if (prototypeReceiver) {
      // Keep a prototype distinct from the constructor's static member slots.
      // The declaration is also stable through an ordinary const prototype alias.
      const origins = new Set<ReceiverOrigin>()
      for (const origin of receiverOrigins(prototypeReceiver, possible, seen)) {
        const declarations = (origin as ts.Symbol).declarations?.filter(node => ts.isClassDeclaration(node) || ts.isClassExpression(node)) ?? []
        if (declarations.length === 1) origins.add(declarations[0]!)
      }
      // A namespace may export an ordinary value named `prototype`; preserve
      // its existing export-value origin path unless this is a class prototype.
      if (origins.size) return origins
    }
    // Writes through a value-selecting alias may affect any source alternative.
    // This is a may-alias union, never authority to choose a callable target.
    const alternatives = possible && ts.isConditionalExpression(expression)
      ? [expression.whenTrue, expression.whenFalse]
      : possible && ts.isBinaryExpression(expression)
        && (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        ? [expression.left, expression.right] : []
    if (alternatives.length) {
      const origins = new Set<ReceiverOrigin>()
      for (const alternative of alternatives) {
        for (const origin of receiverOrigins(alternative, true, new Set(seen))) {
          origins.add(origin)
          if (origins.size > MAX_MUTATION_ORIGINS) { writeOriginsComplete = false; receipt.bounded = true; return new Set() }
        }
      }
      return origins
    }
    const symbol = originSymbol(expression)
    if (!symbol || (!possible && bindingWrites.has(symbol))) return new Set()
    const declaration = symbol.valueDeclaration
    const values: ts.Expression[] = []
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (!possible && (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const))) return new Set()
      values.push(declaration.initializer)
    }
    if (possible) values.push(...(assignedValues.get(symbol) ?? []))
    const origins = new Set<ReceiverOrigin>()
    if ((symbol.flags & ts.SymbolFlags.Module) || symbol.declarations?.some(node => ts.isClassDeclaration(node) || ts.isClassExpression(node))) origins.add(symbol)
    for (const value of values) {
      for (const origin of receiverOrigins(value, possible, new Set(seen))) {
        origins.add(origin)
        if (origins.size > MAX_MUTATION_ORIGINS) { writeOriginsComplete = false; receipt.bounded = true; return new Set() }
      }
    }
    return origins
  }
  for (const target of memberTargets) {
    const key = ts.isPropertyAccessExpression(target) ? target.name.text
      : target.argumentExpression && (ts.isStringLiteralLike(target.argumentExpression) || ts.isNumericLiteral(target.argumentExpression))
        ? target.argumentExpression.text : '*'
    for (const origin of receiverOrigins(target.expression, true)) {
      const keys = memberWrites.get(origin) ?? new Set<string>()
      keys.add(key); memberWrites.set(origin, keys)
    }
  }
  // Query-time value routes must retain export slots before alias resolution
  // collapses them to a local declaration. Keep mutation-time unalias above
  // unchanged: collecting possible write origins cannot depend on these maps.
  const stableExportDepths = new Map<ts.Symbol, Map<string, number>>()
  const stableRuntimeExportDepth = (module: ts.Symbol, name: string, seen = new Set<ts.Symbol>()): number | undefined => {
    if (!mutationScanComplete || !writeOriginsComplete || seen.has(module) || seen.size >= 8) return undefined
    // Cache complete successes only. Their maximum route depth includes this
    // module, so reuse cannot bypass the same eight-module ancestry bound.
    const cachedDepth = stableExportDepths.get(module)?.get(name)
    if (cachedDepth !== undefined && seen.size + cachedDepth <= 8) return cachedDepth
    const writes = memberWrites.get(module)
    if (writes?.has('*') || writes?.has(name) || !runtimeExport(module, name)) return undefined
    seen.add(module)
    const exported = checker.getExportsOfModule(module).find(symbol => symbol.name === name)
    const source = module.valueDeclaration
    if (!exported || !source || !ts.isSourceFile(source)) return undefined
    const remember = (depth: number): number => {
      const depths = stableExportDepths.get(module) ?? new Map<string, number>()
      depths.set(name, depth); stableExportDepths.set(module, depths)
      return depth
    }
    if (exported.declarations?.some(declaration => declaration.getSourceFile() === source)) return remember(1)
    // Export-star often has no per-name alias in the checker chain. Retain its
    // actual value route rather than bypassing a written slot through a barrel.
    let found = false
    let depth = 1
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.exportClause || !statement.moduleSpecifier) continue
      const next = checker.getSymbolAtLocation(statement.moduleSpecifier)
      const candidate = next ? checker.getExportsOfModule(next).find(symbol => symbol.name === name) : undefined
      if (!next || !candidate || identity(candidate) !== identity(exported) || !runtimeExport(next, name)) continue
      found = true
      const nextDepth = stableRuntimeExportDepth(next, name, new Set(seen))
      if (nextDepth === undefined) return undefined
      depth = Math.max(depth, 1 + nextDepth)
    }
    return found ? remember(depth) : undefined
  }
  const queryUnalias = (initial: ts.Symbol | undefined): ts.Symbol | undefined => {
    let symbol = initial
    const seen = new Set<ts.Symbol>()
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      if (seen.has(symbol) || seen.size >= 8 || symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return undefined
      seen.add(symbol)
      for (const declaration of symbol.declarations ?? []) {
        let module: ts.Expression | undefined
        let name: string | undefined
        if (ts.isImportSpecifier(declaration)) { module = declaration.parent.parent.parent.moduleSpecifier; name = (declaration.propertyName ?? declaration.name).text }
        else if (ts.isImportClause(declaration) && declaration.name) { module = declaration.parent.moduleSpecifier; name = 'default' }
        else if (ts.isExportSpecifier(declaration)) { module = declaration.parent.parent.moduleSpecifier; name = (declaration.propertyName ?? declaration.name).text }
        const target = module ? checker.getSymbolAtLocation(module) : undefined
        if (target && name && stableRuntimeExportDepth(target, name) === undefined) return undefined
      }
      symbol = checker.getImmediateAliasedSymbol(symbol)
    }
    return symbol
  }
  const receiverType = (expression: ts.Expression, seen: Set<ts.Node>): ts.Type | undefined => {
    if (seen.has(expression) || seen.size >= 8) return undefined
    seen.add(expression)
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return receiverType(expression.expression, seen)
    }
    if (ts.isNewExpression(expression)) {
      const declaration = callableDeclaration(expression.expression, seen, true)
      if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return undefined
      const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : checker.getTypeAtLocation(declaration).symbol
      // Use the actual constructor's instance type, not a wider annotation on
      // the variable receiving it. That annotation can hide an override.
      return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined
    }
    if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined
    const symbol = ts.isPropertyAccessExpression(expression)
      ? memberSymbol(expression, seen)
      : queryUnalias(checker.getSymbolAtLocation(expression))
    if (!mutationScanComplete || (symbol && bindingWrites.has(symbol))) return undefined
    const declaration = symbol?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined
      return receiverType(declaration.initializer, seen)
    }
    // Imported namespaces and named classes are bound values. A parameter,
    // factory return, this receiver, or mutable variable is only a type hint.
    if (symbol && ((symbol.flags & ts.SymbolFlags.Module) || symbol.declarations?.some(node => ts.isClassDeclaration(node) || ts.isClassExpression(node)))) {
      return checker.getTypeOfSymbolAtLocation(symbol, expression)
    }
    return undefined
  }
  const memberSymbol = (expression: ts.PropertyAccessExpression, seen: Set<ts.Node>): ts.Symbol | undefined => {
    // ECMAScript private methods have lexical identity; subclasses cannot
    // override the same private name. Public `this.method` remains virtual.
    if (ts.isPrivateIdentifier(expression.name)) return checker.getSymbolAtLocation(expression.name)
    if (!mutationScanComplete || !writeOriginsComplete) return undefined
    const origins = receiverOrigins(expression.expression, false)
    if (!writeOriginsComplete || [...origins].some(origin => {
      const writes = memberWrites.get(origin)
      return writes?.has('*') || writes?.has(expression.name.text)
    })) return undefined
    const type = receiverType(expression.expression, seen)
    if (type?.symbol && (type.symbol.flags & ts.SymbolFlags.Module) && stableRuntimeExportDepth(type.symbol, expression.name.text) === undefined) return undefined
    if (type && type.getConstructSignatures().length === 0) {
      // A stable `new` receiver does not make its prototype immutable. Refuse
      // a written inherited slot; this does not resolve the replacement value.
      const pending = [type], inspected = new Set<ts.Type>()
      while (pending.length) {
        const current = pending.pop()!
        if (inspected.has(current)) continue
        if (inspected.size >= 8) { receipt.bounded = true; return undefined }
        inspected.add(current)
        const symbol = current.symbol
        const declarations = symbol?.declarations?.filter(node => ts.isClassDeclaration(node) || ts.isClassExpression(node)) ?? []
        if (!declarations.length) continue
        const constructorWrites = memberWrites.get(symbol)
        if (constructorWrites?.has('*') || constructorWrites?.has('prototype')) return undefined
        if (declarations.some(declaration => {
          const writes = memberWrites.get(declaration)
          return writes?.has('*') || writes?.has(expression.name.text)
        })) return undefined
        pending.push(...(checker.getBaseTypes(current as ts.InterfaceType) ?? []))
      }
    }
    return type ? queryUnalias(checker.getPropertyOfType(type, expression.name.text)) : undefined
  }
  const callableDeclaration = (expression: ts.Expression, seen = new Set<ts.Node>(), construct = false): ts.Node | undefined => {
    if (seen.has(expression) || seen.size >= 8) return undefined
    seen.add(expression)
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return callableDeclaration(expression.expression, seen, construct)
    }
    if (!construct && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) return expression
    if (construct && ts.isClassExpression(expression)) return expression
    // Require an actual callable value. An ordinary configuration argument or a
    // same-name function elsewhere in the graph is not a source dependency.
    const type = checker.getTypeAtLocation(expression)
    const signatures = construct ? type.getConstructSignatures() : type.getCallSignatures()
    if (!signatures.length) return undefined
    const symbol = ts.isPropertyAccessExpression(expression)
      ? memberSymbol(expression, seen)
      : queryUnalias(checker.getSymbolAtLocation(expression))
    if (!mutationScanComplete || (symbol && bindingWrites.has(symbol))) return undefined
    const declaration = symbol?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined
      return callableDeclaration(declaration.initializer, seen, construct)
    }
    // Structural signature compatibility is not binding identity. Conditional,
    // returned and parameter values remain unresolved rather than guessing.
    // For overloads, find the implementation on the same bound symbol.
    return symbol?.declarations?.find(candidate => {
      if (construct && (ts.isClassDeclaration(candidate) || ts.isClassExpression(candidate))) return true
      return (ts.isFunctionDeclaration(candidate) || ts.isFunctionExpression(candidate)
        || (!construct && (ts.isMethodDeclaration(candidate) || ts.isArrowFunction(candidate)))) && !!candidate.body
    })
  }
  const localCallableCache = new Map<ts.Symbol, ts.FunctionExpression | null>()
  const localDirectCallable = (call: ts.CallExpression): ts.FunctionExpression | undefined => {
    const source = call.getSourceFile()
    if (call.questionDotToken || !mutationScanComplete || !identityScanComplete
      || provenance.scans.program !== 'complete' || unsafeLocalBindingFiles.has(source)
      || !(/\.[cm][jt]s$/i.test(nativeSourcePath(source)) || ts.isExternalModule(source))) return undefined
    const callee = transparentLocalExpression(call.expression)
    if (!callee || !ts.isIdentifier(callee)) return undefined
    // CommonJS wrapper parameters can also be written through mapped arguments,
    // which is not an ordinary lexical assignment in the inspected module AST.
    if (['exports', 'require', 'module', '__filename', '__dirname', 'arguments'].includes(callee.text)
      || blockFunctionNames.get(source)?.has(callee.text)
      || unresolvedLocalWriteNames.get(source)?.has(callee.text)) return undefined
    // No alias unwrapping: this fallback only proves the direct lexical binding
    // in this module, never imported values, members, callbacks or constructors.
    const symbol = checker.getSymbolAtLocation(callee)
    if (!symbol || symbol.flags & ts.SymbolFlags.Alias || localBindingWrites.has(symbol)
      || bindingWrites.has(symbol)) return undefined
    if (localCallableCache.has(symbol)) return localCallableCache.get(symbol) ?? undefined
    localCallableCache.set(symbol, null)
    const declaration = symbol.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
      || declaration.getSourceFile() !== source || symbol.declarations?.length !== 1
      || symbol.declarations[0] !== declaration || !ts.isVariableDeclarationList(declaration.parent)
      || declaration.parent.declarations.length !== 1) return undefined
    const list = declaration.parent, statement = list.parent, initializer = declaration.initializer
    const kind = list.flags & ts.NodeFlags.BlockScoped
    if ((kind !== ts.NodeFlags.None && kind !== ts.NodeFlags.Let)
      || !ts.isVariableStatement(statement) || statement.parent !== source
      || ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient
      || !initializer || !ts.isFunctionExpression(initializer) || initializer.asteriskToken
      || ts.getCombinedModifierFlags(initializer) & ts.ModifierFlags.Async
      || !declarationOwner(declaration)) return undefined
    // As for existing const targets, this is conditional static identity: if the
    // call reaches an initialized callable binding, this is its sole initializer.
    // It does not establish initialization order or prove that the call executes.
    localCallableCache.set(symbol, initializer)
    return initializer
  }
  const dataDeclaration = (node: ts.Identifier | ts.PropertyAccessExpression): ts.VariableDeclaration | undefined => {
    // Type annotations and declaration names do not read a runtime value.
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isImportEqualsDeclaration(parent)
        || ts.isExportDeclaration(parent)) return undefined
      if (ts.isStatement(parent)) break
    }
    if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return undefined
    const symbol = ts.isPropertyAccessExpression(node)
      ? memberSymbol(node, new Set())
      : ts.isShorthandPropertyAssignment(node.parent)
        ? queryUnalias(checker.getShorthandAssignmentValueSymbol(node.parent))
        : queryUnalias(checker.getSymbolAtLocation(node))
    const declaration = symbol?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
      || declaration.name === node || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined
    const type = checker.getTypeAtLocation(declaration.name)
    // Callable/constructor bindings already have the stricter binding path
    // above. A data reference proves use of a declaration, not a constant value
    // or the absence of later mutations to an object stored in a const binding.
    if (type.getCallSignatures().length || type.getConstructSignatures().length) return undefined
    return declaration
  }
  const visit = (node: ts.Node): void => {
    if (calls.length + unattributedCalls >= MAX_CALLS) { callScanComplete = false; dataScanComplete = false; note('shared_call_visitor_limit'); receipt.bounded = true; return }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const classOwner = declarationOwner(node)
      if (classOwner) for (const member of node.members) {
        const memberOwner = declarationOwner(member)
        if (memberOwner && memberOwner.id !== classOwner.id) {
          const anchors = classAnchors.get(memberOwner.id) ?? new Set<string>()
          anchors.add(classOwner.id); classAnchors.set(memberOwner.id, anchors)
        }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const caller = callerOwner(node)
      if (caller) {
        const source = node.getSourceFile()
        const call: Call = { from: caller.id, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, file: nativeSourcePath(source), callee: node.expression.getText(source).slice(0, 120), relation: 'calls' }
        const declaration = callableDeclaration(node.expression, new Set(), ts.isNewExpression(node))
          ?? (ts.isCallExpression(node) ? localDirectCallable(node) : undefined)
        if (declaration && executable(declaration)) {
          const target = declarationOwner(declaration)
          if (target) {
            call.to = target.id
            call.observed = { start_offset: node.getStart(source), end_offset: node.getEnd() }
            const site = callsite(node, caller)
            if (site) call.site = site
          }
          else call.reason = 'outside_index'
        } else {
          const signatureDeclaration = checker.getResolvedSignature(node)?.declaration
          call.reason = signatureDeclaration && !executable(signatureDeclaration) ? 'no_implementation' : 'unresolved'
        }
        calls.push(call)
        for (const argument of node.arguments ?? []) {
          if (calls.length + unattributedCalls >= MAX_CALLS) { callScanComplete = false; dataScanComplete = false; note('call_argument_limit'); receipt.bounded = true; break }
          const declaration = callableDeclaration(argument)
          const target = declaration ? declarationOwner(declaration) : undefined
          if (!target || target.file) {
            if (checker.getTypeAtLocation(argument).getCallSignatures().length) {
              calls.push({ from: caller.id, line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1,
                file: nativeSourcePath(source), callee: argument.getText(source).slice(0, 120), relation: 'depends_on', reason: 'unresolved' })
            }
            continue
          }
          if (target.id === caller.id) continue
          // Passing a function proves a dependency on its value, not that this
          // particular callee invokes it. Keep that distinction on the wire.
          calls.push({ from: caller.id, to: target.id, line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1,
            file: nativeSourcePath(source), callee: argument.getText(source).slice(0, 120), relation: 'depends_on',
            observed: { start_offset: argument.getStart(source), end_offset: argument.getEnd() } })
        }
      } else {
        unattributedCalls += 1; receipt.bounded = true
      }
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const declaration = dataDeclaration(node)
      const caller = declaration ? callerOwner(node) : undefined
      const target = declaration ? declarationOwner(declaration) : undefined
      if (caller && !caller.file && caller.id !== target?.id) {
        const source = node.getSourceFile()
        // Keep individual positive value-use occurrences before owner-pair
        // deduplication. This optional sidecar never changes scan completeness.
        if (target && !target.file && observedDataReferences.length < MAX_CALLS) observedDataReferences.push({
          from: caller.id, to: target.id, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          file: nativeSourcePath(source), callee: node.getText(source).slice(0, 120), relation: 'depends_on', dataReference: true,
          observed: { start_offset: node.getStart(source), end_offset: node.getEnd() },
        })
        const identity = JSON.stringify([caller.id, nativeSourcePath(declaration!.getSourceFile()), declaration!.pos])
        if (!dataReferences.has(identity)) {
          if (dataReferences.size >= MAX_CALLS) { receipt.bounded = true; dataScanComplete = false; note('data_reference_limit') }
          else dataReferences.set(identity, { from: caller.id, ...(target && !target.file ? { to: target.id } : { reason: 'outside_index' as const }),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            file: nativeSourcePath(source), callee: node.getText(source).slice(0, 120), relation: 'depends_on', dataReference: true })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const source of selectedFiles.values()) visit(source)
  if (unattributedCalls) receipt.unattributed_calls = unattributedCalls
  result.source_resolved_call_pairs = calls.flatMap(call => call.to && call.relation === 'calls'
    ? [{ from_id: call.from, to_id: call.to }] : [])
  if (callScanComplete && identityScanComplete) {
    const sourceDependencies = [...selectedFiles.values()].map(source => ({
      source_file: nativeSourcePath(source), source_sha256: createHash('sha256').update(source.text).digest('hex'),
    }))
    const digests = new Map(sourceDependencies.map(source => [source.source_file, source.source_sha256]))
    const pairs = new Map<string, Call[]>()
    for (const call of calls) if (call.to && call.from !== call.to && call.relation === 'calls') {
      const key = JSON.stringify([call.from, call.to])
      const sites = pairs.get(key) ?? []
      sites.push(call); pairs.set(key, sites)
    }
    result.source_callsite_bundles = [...pairs.values()].flatMap(sites => {
      const first = sites[0]!
      // Do not silently complete only the first/easiest occurrence of a pair.
      if (sites.some(site => !site.site || site.file !== first.file)) return []
      const ranges: Array<{ start_line: number; end_line: number }> = []
      for (const range of sites.flatMap(call => call.site!.ranges).sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line)) {
        const last = ranges.at(-1)
        if (last && range.start_line <= last.end_line + 1) last.end_line = Math.max(last.end_line, range.end_line)
        else ranges.push({ ...range })
      }
      const alternatives: CallsiteRange[][] = []
      if (sites.every(call => call.site!.alternatives)) for (const index of [0, 1]) {
        const compact: CallsiteRange[] = []
        for (const range of sites.flatMap(call => call.site!.alternatives![index]!)
          .sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line)) {
          const last = compact.at(-1)
          if (last && range.start_line <= last.end_line + 1) last.end_line = Math.max(last.end_line, range.end_line)
          else compact.push({ ...range })
        }
        if (compact.length <= MAX_CALLS && JSON.stringify(compact) !== JSON.stringify(ranges)
          && compact.every(part => ranges.some(range => range.start_line <= part.start_line && range.end_line >= part.end_line))
          && !alternatives.some(prior => JSON.stringify(prior) === JSON.stringify(compact))) alternatives.push(compact)
      }
      return [{ from_id: first.from, to_id: first.to!, source_file: first.file,
        source_sha256: digests.get(first.file)!, ranges,
        ...(alternatives.length ? { range_alternatives: alternatives } : {}),
        sites: sites.map(call => ({ start_offset: call.site!.start_offset, end_offset: call.site!.end_offset })),
        source_dependencies: sourceDependencies }]
    })
    const targetIds = new Set(result.source_callsite_bundles.map(bundle => bundle.to_id))
    result.source_flow_callees = [...ownerDeclarations].flatMap(([id, declaration]) => {
      if (!targetIds.has(id)) return []
      const owner = declarationOwner(declaration), source = declaration.getSourceFile()
      if (!owner || owner.file) return []
      return [{ node_id: id, label: owner.label, source_file: nativeSourcePath(source),
        range: { start_line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
          end_line: source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line + 1 } }]
    })
  }

  const selected = new Set(seedIds)
  const additions: string[] = []
  const observedRoles = new Map<string, Set<SourceAdmissionRole>>()
  const observe = (id: string, role: SourceAdmissionRole): void => {
    const roles = observedRoles.get(id) ?? new Set<SourceAdmissionRole>()
    roles.add(role); observedRoles.set(id, roles)
  }
  const add = (id: string, role: SourceAdmissionRole, depth: number): void => {
    if (selected.has(id)) return
    if (additions.length >= MAX_ADDITIONS) { receipt.bounded = true; provenance.addition_limit_hit = true; return }
    selected.add(id); additions.push(id)
    provenance.admissions.push({ node_id: id, role, depth })
  }
  const clientForwardGroup = (): Array<{ id: string; role: SourceAdmissionRole; depth: number }> => {
    const preference = options.clientPriority
    if (!preference || !clientHint || !rootPath || !identityScanComplete || !callScanComplete
      || !dataScanComplete || !mutationScanComplete || !writeOriginsComplete) return []
    const leader = ownerDeclarations.get(preference.seedId)
    if (!leader || !ts.isFunctionDeclaration(leader) || !leader.body || !leader.name || !ts.isSourceFile(leader.parent)) return []
    const source = leader.getSourceFile(), targetSource = selectedFiles.get(clientHint.file)
    if (!targetSource || !sourceHasDirective(source, 'use client') || unsafeLocalBindingFiles.has(source)) return []
    const configuration = getSourceModuleConfigurationSnapshot(receipt)
    const currentInputs = (): boolean => {
      try {
        return !!configuration?.cacheable && sourceModuleConfigurationSnapshotIsFresh(configuration, rootPath, options.readPolicy)
          && [...selectedFiles.values()].every(input => {
            const file = nativeSourcePath(input), canonical = sourceCanonicalInputs.get(file)
            return !!canonical && sourcePathForEvidence(file, rootPath) === canonical
              && (!options.readPolicy || options.readPolicy(file) && options.readPolicy(file, canonical))
              && readEvidenceLines(file, rootPath)?.join('\n') === input.text
          })
      } catch { return false }
    }
    if (!currentInputs() || !preference.allowedOwner(nativeSourcePath(source), declarationOwner(leader)!.label, leader.getText(source))) return []
    const group: Array<{ id: string; role: SourceAdmissionRole; depth: number }> = []
    const seen = new Set<string>([preference.seedId])
    let retainedLines = 0, retainedChars = 0
    const append = (id: string, role: SourceAdmissionRole, depth: number): boolean => {
      if (seen.has(id)) return true
      const declaration = ownerDeclarations.get(id), owner = declaration && declarationOwner(declaration)
      if (!declaration || owner?.id !== id || owner.file || group.length >= 8) return false
      const input = declaration.getSourceFile(), file = nativeSourcePath(input)
      const start = input.getLineAndCharacterOfPosition(declaration.getStart(input)).line + 1
      const end = input.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line + 1
      const text = input.text.split('\n').slice(start - 1, end).join('\n')
      if (sourceHasDirective(input, 'use server') || unsafeLocalBindingFiles.has(input)
        || retainedLines + end - start + 1 > 80 || retainedChars + text.length > 12_000
        || !preference.allowedOwner(file, owner.label, text)) return false
      retainedLines += end - start + 1; retainedChars += text.length
      seen.add(id); group.push({ id, role, depth }); return true
    }
    const imports = source.statements.filter(ts.isImportDeclaration).filter(statement =>
      ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === clientHint.group.specifier)
    if (imports.length !== 1) return []
    const bindings = imports[0]!.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return []
    for (const name of clientHint.group.names) {
      const binding = bindings.elements.find(entry => entry.name.text === name)
      if (!binding || binding.propertyName || binding.isTypeOnly) return []
      const alias = checker.getSymbolAtLocation(binding.name)
      const symbol = alias && (alias.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(alias) : undefined
      const declaration = symbol?.valueDeclaration, owner = declaration && declarationOwner(declaration)
      if (!alias || alias.declarations?.length !== 1 || !symbol || symbol.declarations?.length !== 1
        || !declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body || declaration.parent !== targetSource
        || !owner || bindingWrites.has(symbol) || localBindingWrites.has(alias) || bindingWrites.has(alias)
        || !calls.some(call => call.from === preference.seedId && call.to === owner.id && call.relation === 'calls' && call.observed)
        || !append(owner.id, 'outgoing', 0)) return []
    }
    if (group.length < 2) return []
    const direct = new Set(group.map(entry => entry.id))
    for (const call of calls) if (call.to && call.observed && call.relation === 'calls' && direct.has(call.from)) {
      const declaration = ownerDeclarations.get(call.to)
      if (declaration && executable(declaration)) append(call.to, 'outgoing', 1)
    }
    let frontier = new Set(group.map(entry => entry.id))
    for (let depth = 0; depth < 2 && frontier.size; depth++) {
      const next = new Set<string>()
      for (const reference of dataReferences.values()) if (reference.to && frontier.has(reference.from) && !seen.has(reference.to)) {
        if (append(reference.to, 'data_reference', depth)) next.add(reference.to)
      }
      frontier = next
    }
    return currentInputs() ? group : []
  }
  const clientReserved = clientForwardGroup()
  for (const entry of clientReserved) { observe(entry.id, entry.role); add(entry.id, entry.role, entry.depth) }
  if (clientReserved.length) result[sourceClientPriorityKey] = [options.clientPriority!.seedId, ...clientReserved.map(entry => entry.id)]
  // A small local calculation needs both its callable and scalar policy input.
  // Reserve their existing positive bindings before reverse fanout uses all
  // slots. Pure helper fanout keeps the independent-body ordering unchanged.
  const localGroup = (): Array<{ id: string; role: SourceAdmissionRole }> => {
    const preference = options.localPriority
    if (!preference || !rootPath || options.callerPriority || options.inspectionOnly
      || !seedIds.includes(preference.seedId) || !identityScanComplete || !mutationScanComplete
      || !writeOriginsComplete || !callScanComplete || !dataScanComplete) return []
    const leader = ownerDeclarations.get(preference.seedId)
    if (!leader || !ts.isFunctionDeclaration(leader) || !leader.body || !leader.name
      || !ts.isSourceFile(leader.parent)) return []
    const source = leader.getSourceFile(), file = nativeSourcePath(source)
    if (unsafeLocalBindingFiles.has(source)) return []
    const canonical = sourceCanonicalInputs.get(file)
    const current = readEvidenceLines(file, rootPath)
    if (!canonical || sourcePathForEvidence(file, rootPath) !== canonical
      || !current || current.join('\n') !== source.text) return []
    const complete = (id: string, declaration: ts.Node): number => {
      const owner = declarationOwner(declaration)
      const start = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1
      const end = source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line + 1
      if (owner?.id !== id || declaration.getSourceFile() !== source
        || !preference.allowedOwner(file, owner.label, current.slice(start - 1, end).join('\n'))
        || coherentSourceSnippet(current, { start, end }, '', 'symbol')?.omittedRanges.length !== 0) return 0
      return end - start + 1
    }
    let lines = complete(preference.seedId, leader)
    if (!lines || lines > 80) return []
    const sites = new Map<string, ts.Node>()
    const visitLocal = (node: ts.Node): void => {
      if (node !== leader && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return
      if (ts.isCallExpression(node) || ts.isIdentifier(node)) sites.set(`${node.getStart(source)}:${node.getEnd()}`, node)
      ts.forEachChild(node, visitLocal)
    }
    visitLocal(leader)
    const group: Array<{ id: string; role: SourceAdmissionRole }> = []
    const seen = new Set<string>([preference.seedId])
    const references = [...calls, ...observedDataReferences].filter(call => call.from === preference.seedId && call.to && call.observed)
      .sort((left, right) => left.observed!.start_offset - right.observed!.start_offset)
    for (const reference of references) {
      if (seen.has(reference.to!)) continue
      const declaration = ownerDeclarations.get(reference.to!)
      const node = sites.get(`${reference.observed!.start_offset}:${reference.observed!.end_offset}`)
      const expression = node && ts.isCallExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression)
        ? node.expression : reference.dataReference && node && ts.isIdentifier(node) ? node : undefined
      if (!declaration || !expression || declaration.getSourceFile() !== source) continue
      const symbol = checker.getSymbolAtLocation(expression)
      if (!symbol || symbol.flags & ts.SymbolFlags.Alias || symbol.valueDeclaration !== declaration
        || symbol.declarations?.length !== 1 || bindingWrites.has(symbol) || localBindingWrites.has(symbol)
        || unresolvedLocalWriteNames.get(source)?.has(expression.text) || blockFunctionNames.get(source)?.has(expression.text)) continue
      const callable = reference.relation === 'calls' && !reference.dataReference
        && ts.isFunctionDeclaration(declaration) && !!declaration.body && ts.isSourceFile(declaration.parent)
      const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined
      const scalar = !!initializer && (ts.isStringLiteralLike(initializer) || ts.isNumericLiteral(initializer) || ts.isBigIntLiteral(initializer)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(initializer.kind))
      const value = reference.dataReference && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
        && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent) && scalar
      if (!callable && !value) continue
      const size = complete(reference.to!, declaration)
      if (!size || lines + size > 80 || group.length >= 3) continue
      lines += size; seen.add(reference.to!)
      group.push({ id: reference.to!, role: value ? 'data_reference' : 'outgoing' })
    }
    return group.some(entry => entry.role === 'outgoing') && group.some(entry => entry.role === 'data_reference')
      && sourcePathForEvidence(file, rootPath) === canonical && readEvidenceLines(file, rootPath)?.join('\n') === source.text ? group : []
  }
  const reserved = localGroup()
  for (const entry of reserved) { observe(entry.id, entry.role); add(entry.id, entry.role, 0) }
  if (reserved.length) result[sourceLocalPriorityKey] = [options.localPriority!.seedId, ...reserved.map(entry => entry.id)]
  // A separately requested entry may share a callee and scalar binding with
  // the subject. Reserve one observed incoming owner before ordinary fanout,
  // without inventing a forward edge or expanding the inspected program.
  const subjectGroup = (): { id: string; prefix: string[] } | undefined => {
    const preference = options.subjectPriority
    if (!preference || !rootPath || !includeCallers || options.callerPriority || options.inspectionOnly
      || !seedIds.includes(preference.seedId) || !identityScanComplete || !callScanComplete
      || !dataScanComplete || !mutationScanComplete || !writeOriginsComplete) return undefined
    const queries = sourceSubjectQueries(preference.question).map(sourceBodyQueryTerms)
    if (!queries.length) return undefined
    const leader = ownerDeclarations.get(preference.seedId)
    if (!leader || !ts.isFunctionDeclaration(leader) || !leader.body || !leader.name || !ts.isSourceFile(leader.parent)) return undefined
    const configuration = getSourceModuleConfigurationSnapshot(receipt)
    const allowedPath = (file: string, canonical?: string): boolean =>
      preference.allowedPath(file, canonical)
      && (!options.readPolicy || options.readPolicy(file, canonical))
    const currentInputs = (): boolean => {
      try {
        return !!configuration?.cacheable && realpathSync(rootPath) === configuration.real_root
          && sourceModuleConfigurationSnapshotIsFresh(configuration, rootPath, allowedPath)
          && [...selectedFiles.values()].every(source => {
            const file = nativeSourcePath(source), canonical = sourceCanonicalInputs.get(file)
            return !!canonical && sourcePathForEvidence(file, rootPath) === canonical && allowedPath(file, canonical)
              && readEvidenceLines(file, rootPath)?.join('\n') === source.text
          })
      } catch { return false }
    }
    const ownerText = (id: string, small = false): string | undefined => {
      const declaration = ownerDeclarations.get(id), owner = declaration && declarationOwner(declaration)
      if (!declaration || owner?.id !== id || owner.file) return undefined
      const source = declaration.getSourceFile(), file = nativeSourcePath(source)
      const canonical = sourceCanonicalInputs.get(file)
      const start = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1
      const end = source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line + 1
      const lines = source.text.split('\n'), text = lines.slice(start - 1, end).join('\n')
      if (!canonical || unsafeLocalBindingFiles.has(source) || !allowedPath(file, canonical)
        || !preference.allowedOwner(file, owner.label, text) || !preference.allowedOwner(canonical, owner.label, text)
        || small && (end - start + 1 > 80 || text.length > 12_000
          || coherentSourceSnippet(lines, { start, end }, '', 'symbol')?.omittedRanges.length !== 0)) return undefined
      return text
    }
    // Attached documentation is navigation context only. The authenticated
    // owner and its emitted source remain the complete declaration body.
    const subjectDocumentation = (declaration: ts.FunctionDeclaration, text: string): string => {
      const comment = ts.getJSDocCommentsAndTags(declaration).find((node): node is ts.JSDoc =>
        ts.isJSDoc(node) && node.parent === declaration)
      if (!comment) return ''
      const source = declaration.getSourceFile(), owner = declarationOwner(declaration)
      const file = nativeSourcePath(source), canonical = sourceCanonicalInputs.get(file)
      if (!owner || !canonical || comment.pos < 0 || comment.end <= comment.pos
        || comment.end > declaration.getStart(source)) return ''
      const start = source.getLineAndCharacterOfPosition(comment.pos).line
      const end = source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line
      if (end - start + 1 > 80 || comment.end - comment.pos + 1 + text.length > 12_000) return ''
      const documentation = source.text.slice(comment.pos, comment.end)
      const lexicalText = `${documentation}\n${text}`
      return preference.allowedOwner(file, owner.label, lexicalText)
        && preference.allowedOwner(canonical, owner.label, lexicalText) ? documentation : ''
    }
    if (!currentInputs() || ownerText(preference.seedId) === undefined) return undefined
    const positiveCalls = calls.filter(call => call.to && call.relation === 'calls' && call.observed)
    const direct = new Set(positiveCalls.filter(call => call.from === preference.seedId).map(call => call.to!))
    const forward = new Map<string, Set<string>>()
    for (const pair of [...calls, ...dataReferences.values()]) if (pair.to) {
      const targets = forward.get(pair.from) ?? new Set<string>()
      targets.add(pair.to); forward.set(pair.from, targets)
    }
    const reachable = new Set(seedIds), queue = [...reachable]
    for (let index = 0; index < queue.length; index++) for (const id of forward.get(queue[index]!) ?? []) {
      if (!reachable.has(id)) { reachable.add(id); queue.push(id) }
    }
    const scalarIds = new Set<string>()
    for (const reference of observedDataReferences) if (reference.to && !scalarIds.has(reference.to)) {
      const declaration = ownerDeclarations.get(reference.to)
      if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
        || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)
        || !ts.isVariableStatement(declaration.parent.parent) || !ts.isSourceFile(declaration.parent.parent.parent)) continue
      const initializer = declaration.initializer, symbol = checker.getSymbolAtLocation(declaration.name)
      if (!initializer || !(ts.isStringLiteralLike(initializer) || ts.isNumericLiteral(initializer) || ts.isBigIntLiteral(initializer)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(initializer.kind))
        || !symbol || symbol.valueDeclaration !== declaration || symbol.declarations?.length !== 1
        || bindingWrites.has(symbol) || localBindingWrites.has(symbol)
        || unresolvedLocalWriteNames.get(declaration.getSourceFile())?.has(declaration.name.text)
        || ownerText(reference.to, true) === undefined) continue
      scalarIds.add(reference.to)
    }
    const reads = new Map<string, Set<string>>()
    for (const reference of observedDataReferences) if (reference.to && reference.observed && scalarIds.has(reference.to)) {
      const values = reads.get(reference.from) ?? new Set<string>()
      values.add(reference.to); reads.set(reference.from, values)
    }
    const originalTerms = new Set(sourceBodyQueryTerms(preference.question))
    const matches: Array<{ id: string; score: number; ordinal: number }> = []
    const considered = new Set<string>()
    for (const call of positiveCalls) {
      if (!direct.has(call.to!) || reachable.has(call.from) || selected.has(call.from) || considered.has(call.from)) continue
      const declaration = ownerDeclarations.get(call.from)
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body || !declaration.name
        || !ts.isSourceFile(declaration.parent) || ownerText(call.to!) === undefined
        || ![...(reads.get(call.from) ?? [])].some(id => reads.get(call.to!)?.has(id))) continue
      const text = ownerText(call.from, true)
      if (text === undefined) continue
      considered.add(call.from)
      const bodyWords = new Set(sourceBodyWords(text))
      const documentation = subjectDocumentation(declaration, text)
      const words = documentation ? new Set([...bodyWords, ...sourceBodyWords(documentation)]) : bodyWords
      queries.forEach((terms, ordinal) => {
        const matched = terms.filter(term => words.has(term))
        if (matched.length >= 2 && matched.some(term => bodyWords.has(term))
          && matched.some(term => !originalTerms.has(term))) matches.push({ id: call.from, score: matched.length, ordinal })
      })
    }
    const winner = matches.sort((left, right) => right.score - left.score || left.ordinal - right.ordinal || left.id.localeCompare(right.id))[0]
    if (!winner) return undefined
    // Preserve small current local callees, including nested named helpers,
    // before the alternate entry. This prefix never admits extra owners.
    const prefix = [...direct].filter(id => ownerDeclarations.get(id)?.getSourceFile() === leader.getSourceFile()
      && ownerText(id, true) !== undefined).slice(0, 2)
    return currentInputs() ? { id: winner.id, prefix: [preference.seedId, ...prefix] } : undefined
  }
  const subjectReserved = subjectGroup()
  if (subjectReserved) { observe(subjectReserved.id, 'incoming'); add(subjectReserved.id, 'incoming', 1) }
  // Share the bounded closure between both call directions. An incoming
  // composition body still goes first; incidental caller fanout cannot consume
  // every slot before an actual callee. Explicit caller requests keep priority.
  let frontier = new Set(seedIds)
  for (let depth = 0; !options.inspectionOnly && depth < 2 && frontier.size; depth += 1) {
    const targets = new Set([...frontier, ...[...frontier].flatMap(id => [...(classAnchors.get(id) ?? [])])])
    const next = new Set<string>(depth === 0 ? [...reserved,
      ...clientReserved.filter(entry => entry.depth === 0)].filter(entry => entry.role === 'outgoing' && !seedIds.includes(entry.id)).map(entry => entry.id) : [])
    for (const call of calls) if (call.to) {
      if (includeCallers && targets.has(call.to)) observe(call.from, 'incoming')
      if (frontier.has(call.from)) observe(call.to, 'outgoing')
    }
    const incoming = !includeCallers ? [] : [...new Set(calls.flatMap(call =>
      call.to && targets.has(call.to) && !selected.has(call.from) ? [call.from] : []))]
    const outgoing = [...new Set(calls.flatMap(call =>
      call.to && frontier.has(call.from) && !selected.has(call.to) ? [call.to] : []))]
    const queues = options.callerPriority ? [[...incoming, ...outgoing]] : [incoming, outgoing]
    const positions = queues.map(() => 0)
    while (queues.some((queue, index) => positions[index]! < queue.length)) {
      for (let index = 0; index < queues.length; index += 1) {
        const queue = queues[index]!
        while (positions[index]! < queue.length && selected.has(queue[positions[index]!]!)) positions[index]! += 1
        if (positions[index]! >= queue.length) continue
        const id = queue[positions[index]!]!
        positions[index]! += 1
        add(id, options.callerPriority ? (incoming.includes(id) ? 'incoming' : 'outgoing') : index === 0 ? 'incoming' : 'outgoing', depth)
        if (selected.has(id)) next.add(id)
      }
    }
    frontier = next
  }
  // Reserve the existing two-depth callable closure before using spare slots
  // for policy tables and values. Reading a shared table never adds its other
  // readers. Repeated reads of the same declaration count as one dependency.
  frontier = new Set(selected)
  for (let depth = 0; !options.inspectionOnly && depth < 2 && frontier.size; depth += 1) {
    const next = new Set<string>()
    for (const reference of dataReferences.values()) {
      if (reference.to && frontier.has(reference.from)) observe(reference.to, 'data_reference')
      if (reference.to && frontier.has(reference.from) && !selected.has(reference.to)) {
        add(reference.to, 'data_reference', depth); if (selected.has(reference.to)) next.add(reference.to)
      }
    }
    frontier = next
  }
  const relevantCalls = [...calls, ...dataReferences.values()].filter(call => selected.has(call.from))
  if (subjectReserved && selected.has(subjectReserved.id)) result[sourceSubjectPriorityKey] = [
    ...subjectReserved.prefix.filter(id => selected.has(id)), subjectReserved.id,
  ]
  receipt.resolved_calls = relevantCalls.filter(call => call.to && call.relation === 'calls').length
  const references = relevantCalls.filter(call => call.to && call.relation === 'depends_on').length
  if (references) receipt.resolved_references = references
  const unresolvedReferences = relevantCalls.filter(call => !call.to && call.relation === 'depends_on').length
  if (unresolvedReferences) receipt.unresolved_references = unresolvedReferences
  if (relevantCalls.some(call => call.dataReference && !call.to)) receipt.bounded = true
  const unresolved = relevantCalls.filter(call => !call.to && call.relation === 'calls')
  receipt.unresolved_calls = unresolved.length
  if (unresolved.length) receipt.unresolved = unresolved.slice(0, 8).map(call => ({ source_file: call.file, line_number: call.line, callee: call.callee, reason: call.reason ?? 'unresolved' }))
  if (relevantCalls.some(call => call.to && !selected.has(call.to))) receipt.bounded = true
  result.node_ids = additions
  result.relationships = relevantCalls.flatMap(call => call.to && selected.has(call.to) && call.from !== call.to ? [{ from_id: call.from, to_id: call.to, relation: call.relation }] : [])
  // Capture the main dependency pass before the optional function-value pass,
  // which deliberately restores its own temporary mutation/completeness flags.
  provenance.selected_ids = [...selected]
  provenance.observed_roles = [...observedRoles].map(([node_id, roles]) => ({ node_id, roles: [...roles] }))
  Object.assign(provenance.scans, { identity: identityScanComplete ? 'complete' : 'incomplete',
    calls: callScanComplete ? 'complete' : 'incomplete', data_references: dataScanComplete ? 'complete' : 'incomplete',
    mutation: mutationScanComplete ? 'complete' : 'incomplete', write_origins: mutationScanComplete && writeOriginsComplete ? 'complete' : 'incomplete' })
  if (!identityScanComplete) note('identity_node_limit')
  if (!mutationScanComplete) note('mutation_node_limit')
  if (!writeOriginsComplete) note('write_origin_limit')
  const pairs = new Map<string, SourceSelectionProvenance['resolved_pairs'][number]>()
  // Preserve individual positive observations without changing all-sites completion gates.
  if (identityScanComplete && mutationScanComplete && writeOriginsComplete) {
    const hashes = new Map([...selectedFiles.values()].map(source => [nativeSourcePath(source), createHash('sha256').update(source.text).digest('hex')]))
    provenance.observed_sites = [...calls, ...observedDataReferences].flatMap(call => call.to && call.observed && hashes.has(call.file)
      ? [{ from_id: call.from, to_id: call.to, kind: call.dataReference ? 'data_reference' as const
        : call.relation === 'calls' ? 'call' as const : 'function_value_argument' as const,
        source_file: call.file, source_sha256: hashes.get(call.file)!, ...call.observed }] : []).slice(0, MAX_CALLS)
  }
  for (const call of [...calls, ...dataReferences.values()]) {
    if (call.to) {
      const pair = { from_id: call.from, to_id: call.to, relation: call.relation,
        kind: call.dataReference ? 'data_reference' as const : call.relation === 'calls' ? 'call' as const : 'function_value_argument' as const }
      pairs.set(JSON.stringify(pair), pair)
    } else provenance.unresolved.push({ from_id: call.from, source_file: call.file, line_number: call.line,
      callee: call.callee, relation: call.relation, reason: call.reason ?? 'unresolved' })
  }
  provenance.resolved_pairs = [...pairs.values()]
  provenance.unattributed_calls = unattributedCalls
  if (unattributedCalls) note('unattributed_calls')
  if (provenance.unresolved.length) note('unresolved_dependencies')
  snapshotInputs()
  recordKnownForwardReachability(provenance)
  // This retention sidecar has its own bounded scan and never competes with the
  // callable closure. Restrict callers before spending its occurrence allowance.
  const valueCallers = new Set(options.functionValueCallerIds ?? [])
  if (valueCallers.size && valueCallers.size <= 32 && identityScanComplete && mutationScanComplete) {
    const originalBounded = receipt.bounded, originalOriginsComplete = writeOriginsComplete
    const references: Omit<SourceFunctionValueReference, 'source_dependencies'>[] = []
    let referenceNodes = 0, referencesComplete = true
    const rangeOf = (node: ts.Node): { start_line: number; end_line: number } => ({
      start_line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
      end_line: node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
    })
    const valueRead = (node: ts.Identifier | ts.PropertyAccessExpression): boolean => {
      const parent = node.parent
      if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.name === node) return false
      if ('name' in parent && parent.name === node) return false
      let expression: ts.Node = node
      while (ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)
        || ts.isNonNullExpression(expression.parent)) expression = expression.parent
      if ((ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent))
        && expression.parent.expression === expression) return false
      for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) {
        if (ts.isTypeNode(ancestor) || ts.isImportDeclaration(ancestor) || ts.isImportEqualsDeclaration(ancestor)
          || ts.isExportDeclaration(ancestor)) return false
        if (ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && ancestor.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          && node.pos >= ancestor.left.pos && node.end <= ancestor.left.end) return false
        if (ts.isDeleteExpression(ancestor) || (ts.isPrefixUnaryExpression(ancestor) || ts.isPostfixUnaryExpression(ancestor))
          && (ancestor.operator === ts.SyntaxKind.PlusPlusToken || ancestor.operator === ts.SyntaxKind.MinusMinusToken)) return false
        if (ts.isStatement(ancestor)) break
      }
      return true
    }
    const inspectReference = (node: ts.Node): void => {
      if (!referencesComplete) return
      if (++referenceNodes > MAX_MUTATION_NODES) { referencesComplete = false; return }
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && valueRead(node)) {
        const caller = callerOwner(node)
        if (caller && !caller.file && valueCallers.has(caller.id)) {
          const declaration = callableDeclaration(node), target = declaration ? declarationOwner(declaration) : undefined
          const callerDeclaration = ownerDeclarations.get(caller.id)
          if (declaration && target && !target.file && callerDeclaration && target.id !== caller.id) {
            if (references.length >= MAX_CALLS) { referencesComplete = false; return }
            const targetDeclaration = canonicalDeclaration(declaration)
            references.push({ caller: { node_id: caller.id, label: caller.label, source_file: nativeSourcePath(node.getSourceFile()),
              range: rangeOf(callerDeclaration) },
            target: { node_id: target.id, label: target.label, source_file: nativeSourcePath(targetDeclaration.getSourceFile()),
              range: rangeOf(targetDeclaration) }, read: { start_offset: node.getStart(), end_offset: node.getEnd() } })
          }
        }
      }
      ts.forEachChild(node, inspectReference)
    }
    for (const source of selectedFiles.values()) inspectReference(source)
    if (referencesComplete && references.length && receipt.bounded === originalBounded && writeOriginsComplete === originalOriginsComplete) {
      const sourceDependencies = [...selectedFiles.values()].map(source => ({ source_file: nativeSourcePath(source),
        source_sha256: createHash('sha256').update(source.text).digest('hex') }))
      result.source_function_value_references = references.map(reference => ({ ...reference, source_dependencies: sourceDependencies }))
    }
    receipt.bounded = originalBounded; writeOriginsComplete = originalOriginsComplete
  }
  return result
}

/** Withhold unsupported call claims for inspected owners; other graph relations keep their existing meaning. */
export function reconcileSourceCalls<T extends { from_id?: string; to_id?: string; relation: string }>(
  graphRelationships: readonly T[],
  source: SourceDependencySelection | undefined,
): T[] {
  if (source) delete source.receipt.withheld_graph_calls
  if (!source?.source_call_authority_owner_ids?.length) return [...graphRelationships]
  const authority = new Set(source.source_call_authority_owner_ids)
  const confirmed = new Set((source.source_resolved_call_pairs
    ?? source.relationships.filter(edge => edge.relation === 'calls'))
    .map(edge => JSON.stringify([edge.from_id, edge.to_id])))
  let withheld = 0
  const relationships = graphRelationships.filter(edge => {
    if (edge.relation !== 'calls' || !edge.from_id || !authority.has(edge.from_id)
      || confirmed.has(JSON.stringify([edge.from_id, edge.to_id]))) return true
    withheld += 1
    return false
  })
  if (withheld) source.receipt.withheld_graph_calls = withheld
  return relationships
}
