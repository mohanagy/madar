import { lstatSync, opendirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { readPackageManifest } from '../../shared/package-manifest.js'
import { maskPromptRegions, scanPromptRegions } from '../../shared/prompt-regions.js'
import { lineRangeFromSourceLocation } from '../../shared/source-location.js'
import { retrievalDirectivePrompt, retrievalSearchPrompt } from '../retrieval-gate.js'
import { readVerifiedSourceSnapshot } from '../source-continuation.js'
import { tokenizeLabel } from './pipeline.js'
import { resolveSourceSymbolRange, sourceDeclarationKind, sourceDeclarationQualifiedName, sourceSyntaxTree } from './source-evidence.js'

type Candidate = { id: string; label: string; sourceFile: string; sourceLocation?: string | null }
type Snapshot = ReturnType<typeof readVerifiedSourceSnapshot>
type Parsed = { snapshot: Snapshot; source: ts.SourceFile; unsafeFetch: boolean; functions: ts.FunctionDeclaration[]; calls: ts.CallExpression[] }
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const MAX_FILES = 32
const MAX_BYTES = 1024 * 1024
const MAX_AST_NODES = 100_000

/** An authored navigation focus, not inferred subject identity or relevance proof. */
function authoredFlowFocus(question: string): readonly string[] | undefined {
  const prompt = retrievalSearchPrompt(question).trim(), regions = scanPromptRegions(prompt)
  const match = /^Trace\s+(.+?)\s+(?:from|through|across)\b/i.exec(prompt)
  if (!match || regions.some(region => region.start < match[0].length)
    || !/^[A-Za-z]+(?:[ -][A-Za-z]+)*$/.test(match[1]!)
    || /\b(?:and|or|versus|vs)\b/i.test(match[1]!)) return undefined
  const words = match[1]!.toLowerCase().split(/[ -]+/)
  if (words.length < 2 || words.length > 6 || new Set(words).size < 2) return undefined
  const remaining = maskPromptRegions(prompt, regions).slice(match[0].length)
  if (/\b(?:trace|separately|independently|additionally|also)\b/i.test(remaining)
    || /(?:^|[.!?;\r\n]\s*|\band\s+)(?:compare|contrast)\b/i.test(remaining)) return undefined
  return [...new Set(words)]
}

function appDirectory(root: string): string | undefined {
  const found = ['app', 'src/app'].filter(path => {
    try {
      const stat = lstatSync(resolve(root, path))
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsupported app root')
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  })
  return found.length === 1 ? found[0] : undefined
}

function routePath(path: string, app: string): string | undefined {
  if (!path.startsWith(`${app}/`) || !/\/route\.(?:ts|js)$/.test(path)) return undefined
  const parts = path.slice(app.length + 1).split('/').slice(0, -1)
  if (parts.some(part => !/^[A-Za-z0-9_.~-]+$/.test(part) || part === '.' || part === '..')) return undefined
  return `/${parts.join('/')}`
}

function localPath(argument: ts.Expression): string | undefined {
  if (argument.getText().includes('\\')) return undefined
  let value: string
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) value = argument.text
  else if (ts.isTemplateExpression(argument) && argument.head.text.includes('?')) value = argument.head.text
  else return undefined
  const path = value.split('?')[0]!
  if (!path.startsWith('/') || path.startsWith('//') || /[\\%#]/.test(path)
    || path.slice(1).split('/').some(part => !/^[A-Za-z0-9_.~-]+$/.test(part) || part === '.' || part === '..')) return undefined
  return path
}

function requestMethod(call: ts.CallExpression): string | undefined {
  if (call.arguments.length === 1) return 'GET'
  const options = call.arguments[1]
  if (call.arguments.length !== 2 || !options || !ts.isObjectLiteralExpression(options)) return undefined
  let method = 'GET', count = 0
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return undefined
    const name = property.name.text
    if (name === '__proto__') return undefined
    if (name !== 'method') continue
    if (++count > 1 || !(ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer))) return undefined
    method = property.initializer.text.toUpperCase()
    if (!METHODS.has(method)) return undefined
  }
  return method
}

function namesFetch(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'fetch'
  if (ts.isStringLiteral(node)) return node.text === 'fetch'
  return ts.forEachChild(node, namesFetch) === true
}

function changesFetch(node: ts.Node): boolean {
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
    || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
    || ts.isClassExpression(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)
    || ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)
    || ts.isImportEqualsDeclaration(node)) && node.name && namesFetch(node.name)) return true
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && namesFetch(node.left)) return true
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    && namesFetch(node.operand)) return true
  if (ts.isDeleteExpression(node) && namesFetch(node.expression)) return true
  return (ts.isForOfStatement(node) || ts.isForInStatement(node)) && namesFetch(node.initializer)
}

/** Static source-reference priority only: no admission, graph edge or dispatch claim. */
export function prioritizeNextRouteReferences<T extends Candidate>(
  candidates: readonly T[], question: string, rootPath?: string, fileCache?: Map<string, string[] | null>,
): readonly T[] {
  if (!rootPath || !isAbsolute(rootPath) || candidates.length < 2 || candidates.length > 128
    || new Set(candidates.map(node => node.id)).size !== candidates.length || question.length > 16_384) return candidates
  const explicitMethods = new Set(retrievalDirectivePrompt(question).match(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g) ?? [])
  if (!explicitMethods.size) return candidates
  const focus = authoredFlowFocus(question)
  try {
    const root = resolve(rootPath), realRoot = realpathSync(root)
    const manifest = readPackageManifest('package.json', root)
    if (!manifest) return candidates
    const pkg = JSON.parse(manifest.text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    if (typeof pkg.dependencies?.next !== 'string' && typeof pkg.devDependencies?.next !== 'string') return candidates
    const app = appDirectory(root)
    if (!app) return candidates
    const appRoot = resolve(root, app)
    let metadataEntries = 0
    const directoryProofs = new Map<string, { fingerprint: string; groups?: boolean }>()
    const fingerprint = (path: string): string => {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsupported route directory')
      return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
    }
    const inspectDirectory = (path: string, inspectGroups: boolean): boolean => {
      const current = fingerprint(path), previous = directoryProofs.get(path)
      if (previous && previous.fingerprint !== current) throw new Error('Route directory changed')
      const proof = previous ?? { fingerprint: current }
      directoryProofs.set(path, proof)
      if (inspectGroups && proof.groups === undefined) {
        proof.groups = false
        const directory = opendirSync(path)
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++metadataEntries > 256) throw new Error('Route directory metadata bound')
            if (/^[(@]/.test(entry.name)) proof.groups = true
          }
        } finally { directory.closeSync() }
        if (fingerprint(path) !== current) throw new Error('Route directory changed')
      }
      return !proof.groups
    }
    const scopeOwner = (sourceFile: string): boolean => {
      const path = relative(appRoot, resolve(root, sourceFile))
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false
      const parts = relative(appRoot, dirname(resolve(root, sourceFile))).split(sep).filter(Boolean)
      if (parts.length > 16) return false
      let directory = appRoot
      for (let index = 0; index <= parts.length; index += 1) {
        inspectDirectory(directory, false)
        try { lstatSync(resolve(directory, 'package.json')); return false }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (index < parts.length) directory = resolve(directory, parts[index]!)
      }
      return true
    }
    const unambiguousRoute = (path: string): boolean => {
      const parts = path.split('/').filter(Boolean)
      if (parts.length > 16) return false
      let directory = appRoot
      for (let index = 0; index <= parts.length; index += 1) {
        if (!inspectDirectory(directory, true)) return false
        if (index < parts.length) directory = resolve(directory, parts[index]!)
      }
      return true
    }
    let bytes = Buffer.byteLength(manifest.text), visited = 0
    const parsed = new Map<string, Parsed | null>()
    const used = new Set<Parsed>()
    const load = (file: string): Parsed | undefined => {
      const logical = resolve(root, file)
      if (parsed.has(logical)) return parsed.get(logical) ?? undefined
      if (parsed.size >= MAX_FILES || !/\.[cm]?[jt]sx?$/.test(logical)) return undefined
      parsed.set(logical, null)
      const snapshot = readVerifiedSourceSnapshot(logical, root)
      bytes += snapshot.readBytes
      if (bytes > MAX_BYTES / 2) throw new Error('Route reference read bound')
      if (snapshot.realRoot !== realRoot || relative(root, logical) !== relative(realRoot, snapshot.canonical)
        || fileCache?.has(snapshot.canonical) && fileCache.get(snapshot.canonical)?.join('\n') !== snapshot.lines.join('\n')) return undefined
      const source = sourceSyntaxTree(snapshot.lines, snapshot.canonical)
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined
      let unsafeFetch = false
      const functions: ts.FunctionDeclaration[] = [], calls: ts.CallExpression[] = []
      const visit = (node: ts.Node): void => {
        if (++visited > MAX_AST_NODES) throw new Error('Route reference AST bound')
        unsafeFetch ||= changesFetch(node)
        if (ts.isFunctionDeclaration(node)) functions.push(node)
        if (ts.isCallExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') calls.push(node)
        ts.forEachChild(node, visit)
      }
      visit(source)
      const value = { snapshot, source, unsafeFetch, functions, calls }
      parsed.set(logical, value)
      return value
    }
    const routes = new Map<string, T[]>()
    for (const node of candidates) {
      const path = relative(root, resolve(root, node.sourceFile)).replaceAll(sep, '/')
      const route = routePath(path, app), method = node.label.replace(/\(\)$/, '')
      if (route === undefined || !METHODS.has(method)) continue
      const key = `${method} ${route}`
      routes.set(key, [...(routes.get(key) ?? []), node])
    }
    const ownerRange = (node: T, file: Parsed) => {
      const indexed = lineRangeFromSourceLocation(node.sourceLocation)
      if (!indexed || sourceDeclarationKind(file.snapshot.lines, indexed, node.label, file.snapshot.canonical) !== 'function'
        || !sourceDeclarationQualifiedName(file.snapshot.lines, indexed, node.label, file.snapshot.canonical)) return undefined
      return resolveSourceSymbolRange(file.snapshot.lines, indexed, node.label, file.snapshot.canonical) ?? undefined
    }
    const ownerDeclaration = (node: T, file: Parsed) => {
      const range = ownerRange(node, file)
      if (!range) return undefined
      const name = node.label.replace(/\(\)$/, '').split('.').at(-1)
      const declarations = file.functions.filter(declaration => {
        if (++visited > MAX_AST_NODES) throw new Error('Route reference AST bound')
        return declaration.name?.text === name && declaration.body
          && file.source.getLineAndCharacterOfPosition(declaration.getStart(file.source)).line + 1 === range.start
          && file.source.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1 === range.end
      })
      return declarations.length === 1 ? declarations[0] : undefined
    }
    type VerifiedRoute = { node: T; file: Parsed; declaration: ts.FunctionDeclaration; method: string }
    const verifiedRoutes = new Map<string, VerifiedRoute | null>()
    const verifyRoute = (node: T, method: string, path: string): VerifiedRoute | undefined => {
      if (verifiedRoutes.has(node.id)) return verifiedRoutes.get(node.id) ?? undefined
      verifiedRoutes.set(node.id, null)
      if (routes.get(`${method} ${path}`)?.length !== 1 || !scopeOwner(node.sourceFile) || !unambiguousRoute(path)) return undefined
      const file = load(node.sourceFile), owner = file && ownerDeclaration(node, file)
      const logical = resolve(root, node.sourceFile), sibling = logical.replace(/\.(ts|js)$/, (_, ext: string) => ext === 'ts' ? '.js' : '.ts')
      try { lstatSync(sibling); return undefined }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const declarations = file?.source.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === method)
      const declaration = declarations?.length === 1 ? declarations[0] : undefined
      if (!file || owner !== declaration || !declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body
        || !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        || declaration.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return undefined
      const verified = { node, file, declaration, method }
      verifiedRoutes.set(node.id, verified)
      return verified
    }
    type Reference = { owner: T; target: T; method: string }
    const references: Reference[] = [], referencedIds = new Set<string>(), referencePairs = new Set<string>()
    for (const owner of candidates) {
      if (!scopeOwner(owner.sourceFile)) continue
      const file = load(owner.sourceFile)
      if (!file || file.unsafeFetch) continue
      const ownerNode = ownerDeclaration(owner, file)
      if (!ownerNode) continue
      for (const node of file.calls) {
        if (++visited > MAX_AST_NODES) throw new Error('Route reference AST bound')
        if (node.getStart(file.source) >= ownerNode.getStart(file.source) && node.getEnd() <= ownerNode.getEnd()) {
          const method = requestMethod(node), path = node.arguments[0] && localPath(node.arguments[0])
          const targets = method && explicitMethods.has(method) && path ? routes.get(`${method} ${path}`) : undefined
          const target = targets?.length === 1 ? targets[0] : undefined
          const pair = target && JSON.stringify([owner.id, target.id])
          if (target && pair && target.id !== owner.id && !referencePairs.has(pair)) {
            const verified = verifyRoute(target, method!, path!)
            if (verified) {
              references.push({ owner, target, method: method! }); referencedIds.add(target.id); referencePairs.add(pair)
              used.add(file); used.add(verified.file)
            }
          }
        }
      }
    }
    if (!references.length) return candidates
    const allocated = [...candidates]
    if (focus) {
      const slots = new Map<string, Array<{ index: number; route: VerifiedRoute; matches: boolean }>>()
      for (const [index, node] of candidates.entries()) {
        const method = node.label.replace(/\(\)$/, '')
        const path = routePath(relative(root, resolve(root, node.sourceFile)).replaceAll(sep, '/'), app)
        if (!explicitMethods.has(method) || path === undefined) continue
        const route = verifyRoute(node, method, path)
        if (!route) continue
        const missing = new Set(focus)
        const visit = (child: ts.Node): void => {
          if (++visited > MAX_AST_NODES) throw new Error('Route reference AST bound')
          if (!missing.size || ts.isTypeNode(child) || ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child)) return
          if (ts.isIdentifier(child)) for (const token of tokenizeLabel(child.text)) missing.delete(token)
          ts.forEachChild(child, visit)
        }
        visit(route.declaration.body!)
        const entries = slots.get(method) ?? []
        entries.push({ index, route, matches: missing.size === 0 }); slots.set(method, entries)
      }
      for (const entries of slots.values()) {
        const ranked = [...entries.filter(entry => entry.matches), ...entries.filter(entry => !entry.matches)]
        const advancing = ranked.filter((entry, index) => entry.matches && entry.index > entries[index]!.index)
        if (!advancing.length || advancing.some(entry => !referencedIds.has(entry.route.node.id))) continue
        // A bounded allocation preference: unknown linkage and nonmatching
        // bodies remain admitted; every other candidate position stays fixed.
        entries.forEach((entry, index) => { allocated[entry.index] = ranked[index]!.route.node; used.add(entry.route.file) })
      }
    }
    // Recheck only the source that authorizes a move; never replace a conflicting request cache.
    for (const file of used) {
      if (bytes + statSync(file.snapshot.canonical).size + 128 * 1024 > MAX_BYTES) return candidates
      const current = readVerifiedSourceSnapshot(file.snapshot.logical, root)
      bytes += current.readBytes
      if (bytes > MAX_BYTES || current.canonical !== file.snapshot.canonical || current.hash !== file.snapshot.hash
        || current.policyFingerprint !== file.snapshot.policyFingerprint) return candidates
    }
    if (appDirectory(root) !== app || readPackageManifest('package.json', root)?.text !== manifest.text) return candidates
    for (const [path, proof] of directoryProofs) if (fingerprint(path) !== proof.fingerprint) return candidates
    const positions = new Map(allocated.map((node, index) => [node.id, index]))
    const earliest = new Map<string, Reference>()
    for (const reference of references) {
      const previous = earliest.get(reference.target.id)
      if (!previous || positions.get(reference.owner.id)! < positions.get(previous.owner.id)!) earliest.set(reference.target.id, reference)
    }
    const before = new Map<string, Reference[]>()
    for (const reference of earliest.values()) if (positions.get(reference.target.id)! > positions.get(reference.owner.id)!) {
      before.set(reference.owner.id, [...(before.get(reference.owner.id) ?? []), reference])
    }
    for (const refs of before.values()) refs.sort((a, b) => positions.get(a.target.id)! - positions.get(b.target.id)!)
    const result: T[] = [], emitted = new Set<string>()
    const emit = (node: T): void => {
      if (emitted.has(node.id)) return
      // Every dependency points forward after allocation, so cycles cannot form.
      for (const reference of before.get(node.id) ?? []) emit(reference.target)
      emitted.add(node.id); result.push(node)
    }
    allocated.forEach(emit)
    return result.every((node, index) => node === candidates[index]) ? candidates : result
  } catch { return candidates }
}
