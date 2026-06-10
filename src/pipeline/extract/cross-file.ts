import { readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

import ts from 'typescript'

import type { ExtractionData, ExtractionNode } from '../../contracts/types.js'
import {
  _makeId,
  addNode,
  addUniqueEdge,
  createEdge,
  createNode,
  fileNodeIdForPath,
  fileStemForPath,
  normalizeLabel,
  stripHashComment,
} from './core.js'
import { unparenthesizeExpression } from './typescript-utils.js'

export interface ResolveCrossFilePythonImportsOptions {
  contextNodes?: readonly ExtractionNode[]
}

interface ImportedPythonSymbol {
  localName: string
  targetId: string
  callable: boolean
}

interface PythonImportableSymbolIndex {
  nodeIdsByModuleAndName: Map<string, string>
  callableNodeIds: Set<string>
}

interface FastApiOwnerRecord {
  moduleStem: string
  ownerName: string
  id: string
  prefix: string
  dependencies: string[]
  frameworkRole: 'fastapi_router' | 'fastapi_app'
}

interface FastApiIncludeRecord {
  parentId: string
  childId: string
  prefix: string
  dependencies: string[]
}

interface FastApiOwnerContext {
  ancestorPrefix: string
  ancestorDependencies: string[]
  registerOwnerIds: string[]
}

interface JsExportDefinition {
  localBindings: Map<string, string>
  importedBindings: Map<string, { importedName: string; targetFilePath: string }>
  namedReexports: Array<{ exportName: string; importedName: string; targetFilePath: string }>
  starReexports: string[]
}

const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const
const FASTAPI_ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head'])
const JS_TS_EXTENSION_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.js', '.ts', '.tsx', '.jsx'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts'],
  '.cjs': ['.cjs', '.cts'],
  '.ts': ['.ts'],
  '.tsx': ['.tsx'],
  '.mts': ['.mts'],
  '.cts': ['.cts'],
}

function isJsTsFile(filePath: string): boolean {
  return JS_TS_EXTENSIONS.includes(extname(filePath).toLowerCase() as (typeof JS_TS_EXTENSIONS)[number])
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  switch (extname(filePath).toLowerCase()) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
    default:
      return ts.ScriptKind.JS
  }
}

function relativeImportTargetCandidates(specifier: string, sourceFile: string): string[] {
  const baseTarget = resolve(dirname(sourceFile), specifier)
  const parsedExtension = extname(baseTarget).toLowerCase()
  const candidates: string[] = [baseTarget]

  if (parsedExtension) {
    const withoutExtension = baseTarget.slice(0, -parsedExtension.length)
    for (const extension of JS_TS_EXTENSION_FALLBACKS[parsedExtension] ?? [parsedExtension]) {
      candidates.push(`${withoutExtension}${extension}`)
    }
    return [...new Set(candidates)]
  }

  for (const extension of JS_TS_EXTENSIONS) {
    candidates.push(`${baseTarget}${extension}`)
  }
  for (const extension of JS_TS_EXTENSIONS) {
    candidates.push(resolve(baseTarget, `index${extension}`))
  }

  return [...new Set(candidates)]
}

function resolveRelativeJsImportTarget(specifier: string, sourceFile: string, knownFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  for (const candidate of relativeImportTargetCandidates(specifier, sourceFile)) {
    if (knownFiles.has(candidate)) {
      return candidate
    }
  }

  return null
}

function defaultJsTsCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    esModuleInterop: true,
    isolatedModules: true,
  }
}

function loadJsTsCompilerOptions(
  sourceFile: string,
  cache: Map<string, ts.CompilerOptions | null>,
): ts.CompilerOptions {
  const configPath = ts.findConfigFile(dirname(sourceFile), ts.sys.fileExists, 'tsconfig.json')
    ?? ts.findConfigFile(dirname(sourceFile), ts.sys.fileExists, 'jsconfig.json')
  if (!configPath) {
    return defaultJsTsCompilerOptions()
  }

  const cached = cache.get(configPath)
  if (cached !== undefined) {
    return cached ?? defaultJsTsCompilerOptions()
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const parsed = ts.parseConfigFileTextToJson(configPath, content)
    if (parsed.config) {
      const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(configPath))
      const compilerOptions = {
        ...defaultJsTsCompilerOptions(),
        ...config.options,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
      }
      cache.set(configPath, compilerOptions)
      return compilerOptions
    }
  } catch {
    // Fall back to defaults when the project config is malformed or unreadable.
  }

  cache.set(configPath, null)
  return defaultJsTsCompilerOptions()
}

function resolveJsImportTarget(
  specifier: string,
  sourceFile: string,
  knownFiles: ReadonlySet<string>,
  compilerOptionsCache: Map<string, ts.CompilerOptions | null>,
): string | null {
  const relativeTarget = resolveRelativeJsImportTarget(specifier, sourceFile, knownFiles)
  if (relativeTarget) {
    return relativeTarget
  }

  const compilerOptions = loadJsTsCompilerOptions(sourceFile, compilerOptionsCache)
  const resolved = ts.resolveModuleName(specifier, sourceFile, compilerOptions, ts.sys).resolvedModule
  if (!resolved?.resolvedFileName) {
    return null
  }

  const resolvedFilePath = resolve(resolved.resolvedFileName)
  return knownFiles.has(resolvedFilePath) ? resolvedFilePath : null
}

function collectTopLevelExportedJsBindings(
  filePath: string,
  knownFiles: ReadonlySet<string>,
  cache: Map<string, Map<string, string>>,
  compilerOptionsCache: Map<string, ts.CompilerOptions | null>,
): Map<string, string> {
  const resolvedFilePath = resolve(filePath)
  const cached = cache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const definitions = new Map<string, JsExportDefinition>()
  const visitOrder: string[] = []

  const getOrCreateDefinition = (targetFilePath: string): JsExportDefinition => {
    const resolvedTargetPath = resolve(targetFilePath)
    const existing = definitions.get(resolvedTargetPath)
    if (existing) {
      return existing
    }

    const definition: JsExportDefinition = {
      localBindings: new Map<string, string>(),
      importedBindings: new Map<string, { importedName: string; targetFilePath: string }>(),
      namedReexports: [],
      starReexports: [],
    }
    definitions.set(resolvedTargetPath, definition)
    visitOrder.push(resolvedTargetPath)

    let sourceText: string
    try {
      sourceText = readFileSync(resolvedTargetPath, 'utf8')
    } catch {
      return definition
    }

    const sourceFile = ts.createSourceFile(
      resolvedTargetPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(resolvedTargetPath),
    )
    const fileStem = fileStemForPath(resolvedTargetPath)
    const record = (exportName: string | undefined, targetName: string | undefined = exportName): void => {
      if (exportName && targetName) {
        definition.localBindings.set(exportName, _makeId(fileStem, targetName))
      }
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
        continue
      }

      const importTargetPath = resolveJsImportTarget(
        statement.moduleSpecifier.text,
        resolvedTargetPath,
        knownFiles,
        compilerOptionsCache,
      )
      if (!importTargetPath) {
        continue
      }

      getOrCreateDefinition(importTargetPath)
      if (statement.importClause.name) {
        definition.importedBindings.set(statement.importClause.name.text, {
          importedName: 'default',
          targetFilePath: importTargetPath,
        })
      }

      const namedBindings = statement.importClause.namedBindings
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          definition.importedBindings.set(element.name.text, {
            importedName: element.propertyName?.text ?? element.name.text,
            targetFilePath: importTargetPath,
          })
        }
      }
    }

    for (const statement of sourceFile.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
      const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false

      if (isExported) {
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
          statement.name
        ) {
          record(statement.name.text)
          if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
            record('default', statement.name.text)
          }
          continue
        }

        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          record('default', 'default')
          continue
        }

        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              record(declaration.name.text)
            }
          }
        }
      }

      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const exportExpression = unparenthesizeExpression(statement.expression)
        if (ts.isIdentifier(exportExpression)) {
          const importedBinding = definition.importedBindings.get(exportExpression.text)
          if (importedBinding) {
            definition.namedReexports.push({
              exportName: 'default',
              importedName: importedBinding.importedName,
              targetFilePath: importedBinding.targetFilePath,
            })
          } else {
            record('default', exportExpression.text)
          }
        } else if (
          ts.isArrowFunction(exportExpression) ||
          ts.isFunctionExpression(exportExpression) ||
          ts.isClassExpression(exportExpression)
        ) {
          record('default', 'default')
        }
      }

      if (!ts.isExportDeclaration(statement)) {
        continue
      }

      if (!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text
          const importedBinding = definition.importedBindings.get(localName)
          if (importedBinding) {
            definition.namedReexports.push({
              exportName: element.name.text,
              importedName: importedBinding.importedName,
              targetFilePath: importedBinding.targetFilePath,
            })
            continue
          }

          record(element.name.text, localName)
        }
        continue
      }

      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
        continue
      }

      const reexportTargetPath = resolveJsImportTarget(
        statement.moduleSpecifier.text,
        resolvedTargetPath,
        knownFiles,
        compilerOptionsCache,
      )
      if (!reexportTargetPath) {
        continue
      }

      if (!statement.exportClause) {
        definition.starReexports.push(reexportTargetPath)
        getOrCreateDefinition(reexportTargetPath)
        continue
      }

      if (!ts.isNamedExports(statement.exportClause)) {
        continue
      }

      getOrCreateDefinition(reexportTargetPath)
      for (const element of statement.exportClause.elements) {
        definition.namedReexports.push({
          exportName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          targetFilePath: reexportTargetPath,
        })
      }
    }

    return definition
  }

  getOrCreateDefinition(resolvedFilePath)
  const resolvedBindings = new Map<string, Map<string, string>>()
  for (const definitionPath of visitOrder) {
    const cachedBindings = cache.get(definitionPath)
    const definition = definitions.get(definitionPath)
    resolvedBindings.set(definitionPath, cachedBindings ? new Map(cachedBindings) : new Map(definition?.localBindings ?? []))
  }

  const mapsEqual = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean => {
    if (left.size !== right.size) {
      return false
    }
    for (const [key, value] of left) {
      if (right.get(key) !== value) {
        return false
      }
    }
    return true
  }

  const maxIterations = Math.max(1, visitOrder.length * visitOrder.length)
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false

    for (const definitionPath of visitOrder) {
      const definition = definitions.get(definitionPath)
      if (!definition) {
        continue
      }

      const nextBindings = new Map(definition.localBindings)
      const reservedExplicitNames = new Set([
        ...definition.localBindings.keys(),
        ...definition.namedReexports.map((reexport) => reexport.exportName),
      ])
      for (const reexport of definition.namedReexports) {
        const targetBindings = resolvedBindings.get(reexport.targetFilePath)
        const targetId = targetBindings?.get(reexport.importedName)
        if (targetId) {
          nextBindings.set(reexport.exportName, targetId)
        }
      }

      const starCandidates = new Map<string, string>()
      const ambiguousStarExports = new Set<string>()
      for (const reexportTargetPath of definition.starReexports) {
        const targetBindings = resolvedBindings.get(reexportTargetPath)
        if (!targetBindings) {
          continue
        }

        for (const [exportName, targetId] of targetBindings) {
          if (exportName === 'default' || reservedExplicitNames.has(exportName) || nextBindings.has(exportName) || ambiguousStarExports.has(exportName)) {
            continue
          }

          const existingTargetId = starCandidates.get(exportName)
          if (!existingTargetId) {
            starCandidates.set(exportName, targetId)
            continue
          }

          if (existingTargetId !== targetId) {
            starCandidates.delete(exportName)
            ambiguousStarExports.add(exportName)
          }
        }
      }

      for (const [exportName, targetId] of starCandidates) {
        nextBindings.set(exportName, targetId)
      }

      const priorBindings = resolvedBindings.get(definitionPath)
      if (!priorBindings || !mapsEqual(priorBindings, nextBindings)) {
        resolvedBindings.set(definitionPath, nextBindings)
        changed = true
      }
    }

    if (!changed) {
      break
    }
  }

  for (const definitionPath of visitOrder) {
    const finalBindings = resolvedBindings.get(definitionPath) ?? new Map<string, string>()
    cache.set(definitionPath, finalBindings)
  }

  return cache.get(resolvedFilePath) ?? new Map<string, string>()
}

function isPythonClassNode(node: ExtractionNode): boolean {
  return extname(node.source_file).toLowerCase() === '.py' && node.file_type === 'code' && node.label !== basename(node.source_file) && !node.label.includes('(')
}

function pythonImportableSymbolName(node: ExtractionNode): string | null {
  if (extname(node.source_file).toLowerCase() !== '.py' || node.file_type !== 'code') {
    return null
  }

  if (node.label === basename(node.source_file) || node.label.startsWith('.')) {
    return null
  }

  return node.label.endsWith('()') ? node.label.slice(0, -2) : node.label
}

function isPythonCallableNode(node: ExtractionNode): boolean {
  return extname(node.source_file).toLowerCase() === '.py' && node.file_type === 'code' && node.label.endsWith('()') && !node.label.startsWith('.')
}

function buildPythonImportableSymbolIndex(searchableNodes: readonly ExtractionNode[]): PythonImportableSymbolIndex {
  const nodeIdsByModuleAndName = new Map<string, string>()
  const callableNodeIds = new Set<string>()

  for (const node of searchableNodes) {
    const symbolName = pythonImportableSymbolName(node)
    if (!symbolName) {
      continue
    }

    const moduleStem = basename(node.source_file, extname(node.source_file))
    nodeIdsByModuleAndName.set(`${normalizeLabel(moduleStem)}:${normalizeLabel(symbolName)}`, node.id)
    if (isPythonCallableNode(node)) {
      callableNodeIds.add(node.id)
    }
  }

  return { nodeIdsByModuleAndName, callableNodeIds }
}

function resolveImportedPythonTarget(moduleSpecifier: string, importedName: string, nodeIdsByModuleAndName: ReadonlyMap<string, string>): string | null {
  const moduleStem = moduleSpecifier.replace(/^\.+/, '').split('.').filter(Boolean).at(-1)
  if (!moduleStem) {
    return null
  }

  return nodeIdsByModuleAndName.get(`${normalizeLabel(moduleStem)}:${normalizeLabel(importedName)}`) ?? null
}

function resolvePythonLocalOrImportedTarget(
  moduleStem: string,
  localName: string,
  importedTargets: ReadonlyMap<string, string>,
  nodeIdsByModuleAndName: ReadonlyMap<string, string>,
): string | null {
  return importedTargets.get(localName) ?? nodeIdsByModuleAndName.get(`${normalizeLabel(moduleStem)}:${normalizeLabel(localName)}`) ?? null
}

function escapedRegExpText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pythonDelimiterBalance(value: string): number {
  let balance = 0
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '(' || character === '[' || character === '{') {
      balance += 1
    } else if (character === ')' || character === ']' || character === '}') {
      balance -= 1
    }
  }

  return balance
}

function collectPythonStatement(lines: readonly string[], startIndex: number): { text: string; endIndex: number } {
  const firstLine = stripHashComment(lines[startIndex] ?? '').trim()
  if (!firstLine) {
    return { text: '', endIndex: startIndex }
  }

  const parts = [firstLine]
  let balance = pythonDelimiterBalance(firstLine)
  let endIndex = startIndex
  const needsColon = /^(?:async\s+)?def\b|^class\b/.test(firstLine)

  while (endIndex + 1 < lines.length) {
    const current = parts[parts.length - 1] ?? ''
    const currentComplete = needsColon ? balance <= 0 && current.endsWith(':') : balance <= 0
    if (currentComplete) {
      break
    }

    endIndex += 1
    const nextLine = stripHashComment(lines[endIndex] ?? '').trim()
    if (!nextLine) {
      continue
    }

    parts.push(nextLine)
    balance += pythonDelimiterBalance(nextLine)
  }

  return { text: parts.join(' '), endIndex }
}

function splitTopLevelPythonArguments(argumentText: string): string[] {
  const values: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let balance = 0

  for (const character of argumentText) {
    if (quote) {
      current += character
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }

    if (character === '(' || character === '[' || character === '{') {
      balance += 1
      current += character
      continue
    }

    if (character === ')' || character === ']' || character === '}') {
      balance -= 1
      current += character
      continue
    }

    if (character === ',' && balance === 0) {
      const trimmed = current.trim()
      if (trimmed) {
        values.push(trimmed)
      }
      current = ''
      continue
    }

    current += character
  }

  const trimmed = current.trim()
  if (trimmed) {
    values.push(trimmed)
  }

  return values
}

function normalizeFastApiPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

function joinFastApiRoutePath(prefix: string, path: string): string {
  const normalizedPath = normalizeFastApiPath(path)
  const normalizedPrefix = prefix ? normalizeFastApiPath(prefix) : ''
  if (!normalizedPrefix || normalizedPrefix === '/') {
    return normalizedPath
  }
  if (normalizedPath === '/') {
    return normalizedPrefix
  }
  return normalizeFastApiPath(`${normalizedPrefix}/${normalizedPath.replace(/^\//, '')}`)
}

function joinPythonRoutePrefixes(...segments: readonly string[]): string {
  let combined = ''
  for (const segment of segments) {
    if (!segment) {
      continue
    }
    combined = combined ? joinFastApiRoutePath(combined, segment) : normalizeFastApiPath(segment)
  }
  return combined
}

function quotedPythonArgumentValue(argumentText: string, key?: string): string | null {
  const tripleQuotedPattern = key
    ? new RegExp(`\\b${escapedRegExpText(key)}\\s*=\\s*("""|''')([\\s\\S]*?)\\1`)
    : /("""|''')([\s\S]*?)\1/
  const tripleQuotedMatch = argumentText.match(tripleQuotedPattern)
  if (tripleQuotedMatch) {
    return tripleQuotedMatch[2] ?? null
  }

  const pattern = key
    ? new RegExp(`\\b${escapedRegExpText(key)}\\s*=\\s*(['"])(.*?)\\1`)
    : /(['"])(.*?)\1/
  const match = argumentText.match(pattern)
  return match?.[2] ?? null
}

function fastApiDependencyNames(sourceText: string, dependsBindings: ReadonlySet<string>, moduleAliases: ReadonlySet<string>): string[] {
  const dependencyNames = new Set<string>()
  for (const binding of dependsBindings) {
    const pattern = new RegExp(`\\b${escapedRegExpText(binding)}\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'g')
    for (const match of sourceText.matchAll(pattern)) {
      if (match[1]) {
        dependencyNames.add(match[1])
      }
    }
  }

  for (const moduleAlias of moduleAliases) {
    const pattern = new RegExp(`\\b${escapedRegExpText(moduleAlias)}\\.Depends\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'g')
    for (const match of sourceText.matchAll(pattern)) {
      if (match[1]) {
        dependencyNames.add(match[1])
      }
    }
  }

  return [...dependencyNames]
}

function fastApiOwnerAssignment(
  trimmed: string,
  routerFactoryBindings: ReadonlySet<string>,
  appFactoryBindings: ReadonlySet<string>,
  fastApiModuleAliases: ReadonlySet<string>,
  dependsBindings: ReadonlySet<string>,
): { ownerName: string; prefix: string; dependencies: string[]; frameworkRole: FastApiOwnerRecord['frameworkRole'] } | null {
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/)
  if (!match?.[1] || !match[3]) {
    return null
  }

  const ownerName = match[1]
  const moduleAlias = match[2]
  const calleeName = match[3]
  const argumentText = match[4] ?? ''
  const matchesQualifiedBinding = Boolean(moduleAlias && fastApiModuleAliases.has(moduleAlias) && (calleeName === 'APIRouter' || calleeName === 'FastAPI'))
  const matchesLocalBinding = routerFactoryBindings.has(calleeName) || appFactoryBindings.has(calleeName)
  if (!matchesQualifiedBinding && !matchesLocalBinding) {
    return null
  }

  if (calleeName === 'FastAPI' || appFactoryBindings.has(calleeName)) {
    return { ownerName, prefix: '', dependencies: [], frameworkRole: 'fastapi_app' }
  }

  return {
    ownerName,
    prefix: quotedPythonArgumentValue(argumentText, 'prefix') ?? '',
    dependencies: fastApiDependencyNames(argumentText, dependsBindings, fastApiModuleAliases),
    frameworkRole: 'fastapi_router',
  }
}

function fastApiIncludeRouterCall(
  statementText: string,
  localOwners: ReadonlyMap<string, FastApiOwnerRecord>,
  importedOwners: ReadonlyMap<string, FastApiOwnerRecord>,
  dependsBindings: ReadonlySet<string>,
  fastApiModuleAliases: ReadonlySet<string>,
): FastApiIncludeRecord | null {
  const match = statementText.match(/^([A-Za-z_][A-Za-z0-9_]*)\.include_router\((.*)\)$/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  const parent = localOwners.get(match[1]) ?? importedOwners.get(match[1])
  if (!parent) {
    return null
  }

  const argumentsText = match[2]
  const [firstArgument] = splitTopLevelPythonArguments(argumentsText)
  if (!firstArgument) {
    return null
  }

  const child = localOwners.get(firstArgument) ?? importedOwners.get(firstArgument)
  if (!child) {
    return null
  }

  return {
    parentId: parent.id,
    childId: child.id,
    prefix: quotedPythonArgumentValue(argumentsText, 'prefix') ?? '',
    dependencies: fastApiDependencyNames(argumentsText, dependsBindings, fastApiModuleAliases),
  }
}

function buildFastApiOwnerIndex(pythonFiles: readonly string[]): Map<string, FastApiOwnerRecord> {
  const owners = new Map<string, FastApiOwnerRecord>()

  for (const filePath of pythonFiles) {
    const moduleStem = basename(filePath, extname(filePath))
    const fileStem = fileStemForPath(filePath)
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      continue
    }

    const fastApiModuleAliases = new Set<string>()
    const routerFactoryBindings = new Set<string>()
    const appFactoryBindings = new Set<string>()
    const dependsBindings = new Set<string>()

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const { text: statementText, endIndex } = collectPythonStatement(lines, index)
      index = endIndex
      if (!statementText) {
        continue
      }

      const fromFastApiMatch = statementText.match(/^from\s+fastapi\s+import\s+(.+)$/)
      if (fromFastApiMatch?.[1]) {
        for (const entry of splitTopLevelPythonArguments(fromFastApiMatch[1].replace(/[()]/g, ''))) {
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }
          if (importedName === 'APIRouter') {
            routerFactoryBindings.add(localName)
          } else if (importedName === 'FastAPI') {
            appFactoryBindings.add(localName)
          } else if (importedName === 'Depends') {
            dependsBindings.add(localName)
          }
        }
        continue
      }

      const importFastApiMatch = statementText.match(/^import\s+fastapi(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
      if (importFastApiMatch) {
        fastApiModuleAliases.add(importFastApiMatch[1] ?? 'fastapi')
        continue
      }

      const ownerAssignment = fastApiOwnerAssignment(statementText, routerFactoryBindings, appFactoryBindings, fastApiModuleAliases, dependsBindings)
      if (!ownerAssignment) {
        continue
      }

      const ownerId = _makeId(fileStem, ownerAssignment.ownerName, ownerAssignment.frameworkRole)
      owners.set(ownerId, {
        moduleStem,
        ownerName: ownerAssignment.ownerName,
        id: ownerId,
        prefix: ownerAssignment.prefix,
        dependencies: ownerAssignment.dependencies,
        frameworkRole: ownerAssignment.frameworkRole,
      })
    }
  }

  return owners
}

function buildFastApiIncludeRecords(
  pythonFiles: readonly string[],
  ownerIndex: ReadonlyMap<string, FastApiOwnerRecord>,
): FastApiIncludeRecord[] {
  const includes: FastApiIncludeRecord[] = []
  const ownerByModuleAndName = new Map<string, FastApiOwnerRecord>()
  for (const owner of ownerIndex.values()) {
    ownerByModuleAndName.set(`${normalizeLabel(owner.moduleStem)}:${normalizeLabel(owner.ownerName)}`, owner)
  }

  for (const filePath of pythonFiles) {
    const moduleStem = basename(filePath, extname(filePath))
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      continue
    }

    const fastApiModuleAliases = new Set<string>()
    const routerFactoryBindings = new Set<string>()
    const appFactoryBindings = new Set<string>()
    const dependsBindings = new Set<string>()
    const localOwners = new Map<string, FastApiOwnerRecord>()
    const importedOwners = new Map<string, FastApiOwnerRecord>()

    for (const owner of ownerIndex.values()) {
      if (owner.moduleStem === moduleStem) {
        localOwners.set(owner.ownerName, owner)
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const { text: statementText, endIndex } = collectPythonStatement(lines, index)
      index = endIndex
      if (!statementText) {
        continue
      }

      const fromFastApiMatch = statementText.match(/^from\s+fastapi\s+import\s+(.+)$/)
      if (fromFastApiMatch?.[1]) {
        for (const entry of splitTopLevelPythonArguments(fromFastApiMatch[1].replace(/[()]/g, ''))) {
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }
          if (importedName === 'APIRouter') {
            routerFactoryBindings.add(localName)
          } else if (importedName === 'FastAPI') {
            appFactoryBindings.add(localName)
          } else if (importedName === 'Depends') {
            dependsBindings.add(localName)
          }
        }
        continue
      }

      const importFastApiMatch = statementText.match(/^import\s+fastapi(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
      if (importFastApiMatch) {
        fastApiModuleAliases.add(importFastApiMatch[1] ?? 'fastapi')
        continue
      }

      const importFromMatch = statementText.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        const moduleStem = moduleSpecifier.replace(/^\.+/, '').split('.').filter(Boolean).at(-1)
        if (!moduleStem) {
          continue
        }

        for (const entry of splitTopLevelPythonArguments(importFromMatch[2].replace(/[()]/g, ''))) {
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }

          const owner = ownerByModuleAndName.get(`${normalizeLabel(moduleStem)}:${normalizeLabel(importedName)}`)
          if (owner) {
            importedOwners.set(localName, owner)
          }
        }
        continue
      }

      const includeRecord = fastApiIncludeRouterCall(statementText, localOwners, importedOwners, dependsBindings, fastApiModuleAliases)
      if (includeRecord) {
        includes.push(includeRecord)
      }
    }
  }

  return includes
}

function buildFastApiOwnerContexts(
  ownerIndex: ReadonlyMap<string, FastApiOwnerRecord>,
  includeRecords: readonly FastApiIncludeRecord[],
): Map<string, FastApiOwnerContext[]> {
  const contexts = new Map<string, FastApiOwnerContext[]>()
  const incomingChildren = new Set(includeRecords.map((record) => record.childId))
  const includesByParent = new Map<string, FastApiIncludeRecord[]>()
  for (const record of includeRecords) {
    const bucket = includesByParent.get(record.parentId)
    if (bucket) {
      bucket.push(record)
    } else {
      includesByParent.set(record.parentId, [record])
    }
  }

  const enqueue = (ownerId: string, context: FastApiOwnerContext, lineage: readonly string[] = []): void => {
    if (lineage.includes(ownerId)) {
      return
    }

    const serialized = JSON.stringify(context)
    const existing = contexts.get(ownerId) ?? []
    if (existing.some((entry) => JSON.stringify(entry) === serialized)) {
      return
    }
    contexts.set(ownerId, [...existing, context])
    const owner = ownerIndex.get(ownerId)
    if (!owner) {
      return
    }

    const nextLineage = [...lineage, ownerId]
    const propagatedPrefix = joinPythonRoutePrefixes(context.ancestorPrefix, owner.prefix)
    const propagatedDependencies = [...new Set([...context.ancestorDependencies, ...owner.dependencies])]
    const children = includesByParent.get(ownerId) ?? []
    for (const includeRecord of children) {
      if (nextLineage.includes(includeRecord.childId)) {
        continue
      }
      enqueue(includeRecord.childId, {
        ancestorPrefix: joinPythonRoutePrefixes(propagatedPrefix, includeRecord.prefix),
        ancestorDependencies: [...new Set([...propagatedDependencies, ...includeRecord.dependencies])],
        registerOwnerIds: [...new Set([...context.registerOwnerIds, includeRecord.childId])],
      }, nextLineage)
    }
  }

  const roots = [...ownerIndex.values()].filter((owner) => !incomingChildren.has(owner.id))
  for (const owner of roots) {
    enqueue(owner.id, {
      ancestorPrefix: '',
      ancestorDependencies: [],
      registerOwnerIds: [owner.id],
    })
  }

  for (const owner of ownerIndex.values()) {
    if (!contexts.has(owner.id)) {
      enqueue(owner.id, {
        ancestorPrefix: '',
        ancestorDependencies: [],
        registerOwnerIds: [owner.id],
      })
    }
  }

  return contexts
}

function normalizeDjangoPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/')
  if (!normalized) {
    return '/'
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function djangoRouteDefinition(
  statementText: string,
  pathBindings: ReadonlySet<string>,
): { routePath: string; viewExpression: string } | null {
  const trimmed = statementText.replace(/,$/, '')
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/)
  if (!match?.[1] || !match[2] || !pathBindings.has(match[1])) {
    return null
  }

  const argumentsList = splitTopLevelPythonArguments(match[2])
  const routePath = quotedPythonArgumentValue(argumentsList[0] ?? '')
  const viewExpression = argumentsList[1]?.trim()
  if (!routePath || !viewExpression) {
    return null
  }

  return { routePath: normalizeDjangoPath(routePath), viewExpression }
}

function resolveDjangoViewTarget(
  moduleStem: string,
  viewExpression: string,
  importedTargets: ReadonlyMap<string, string>,
  nodeIdsByModuleAndName: ReadonlyMap<string, string>,
): string | null {
  const directMatch = viewExpression.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)
  if (directMatch?.[1]) {
    return resolvePythonLocalOrImportedTarget(moduleStem, directMatch[1], importedTargets, nodeIdsByModuleAndName)
  }

  const asViewMatch = viewExpression.match(/^([A-Za-z_][A-Za-z0-9_]*)\.as_view\(\)$/)
  if (asViewMatch?.[1]) {
    return resolvePythonLocalOrImportedTarget(moduleStem, asViewMatch[1], importedTargets, nodeIdsByModuleAndName)
  }

  return null
}

function fastApiRouteDecorator(
  decoratorText: string,
  routerOwners: ReadonlyMap<string, FastApiOwnerRecord>,
): { ownerName: string; method: string; routePath: string } | null {
  const match = decoratorText.match(/^@([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|patch|delete|options|head)\((.*)\)$/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  const ownerName = match[1]
  const method = match[2].toLowerCase()
  if (!FASTAPI_ROUTE_METHODS.has(method) || !routerOwners.has(ownerName)) {
    return null
  }

  const argumentText = match[3] ?? ''
  const routePath = quotedPythonArgumentValue(argumentText, 'path') ?? quotedPythonArgumentValue(argumentText)
  if (!routePath) {
    return null
  }

  return { ownerName, method: method.toUpperCase(), routePath }
}

export function resolveCrossFilePythonImports(files: readonly string[], extraction: ExtractionData, options: ResolveCrossFilePythonImportsOptions = {}): ExtractionData {
  const pythonFiles = files.filter((filePath) => extname(filePath).toLowerCase() === '.py')
  if (pythonFiles.length < 2) {
    return extraction
  }

  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const searchableNodeIds = new Set(searchableNodes.map((node) => node.id))
  const { nodeIdsByModuleAndName, callableNodeIds } = buildPythonImportableSymbolIndex(searchableNodes)

  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  for (const filePath of pythonFiles) {
    const fileStem = fileStemForPath(filePath)
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      if (process.env.DEBUG) {
        console.warn(`[madar extract] Skipping unreadable Python file during cross-file linking: ${filePath}`)
      }
      continue
    }

    const classStack: Array<{ indent: number; id: string }> = []
    const functionStack: Array<{ indent: number; id: string }> = []
    const importedSymbols: ImportedPythonSymbol[] = []

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const lineNumber = index + 1
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const indent = line.length - line.trimStart().length
      while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? -1)) {
        classStack.pop()
      }
      while (functionStack.length > 0 && indent <= (functionStack[functionStack.length - 1]?.indent ?? -1)) {
        functionStack.pop()
      }

      const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        const importedList = importFromMatch[2].replace(/[()]/g, '')
        for (const rawEntry of importedList.split(',')) {
          const entry = rawEntry.trim()
          if (!entry) {
            continue
          }

          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          if (!importedName) {
            continue
          }

          const targetId = resolveImportedPythonTarget(moduleSpecifier, importedName, nodeIdsByModuleAndName)
          if (!targetId) {
            continue
          }

          importedSymbols.push({
            localName: aliasPart?.trim() || importedName,
            targetId,
            callable: callableNodeIds.has(targetId),
          })
        }
        continue
      }

      const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
      if (classMatch?.[1]) {
        const classId = _makeId(fileStem, classMatch[1])
        classStack.push({ indent, id: classId })

        const baseList =
          classMatch[2]
            ?.split(',')
            .map((value) => value.trim())
            .filter(Boolean) ?? []
        for (const baseName of baseList) {
          const importedBase = importedSymbols.find((symbol) => symbol.localName === baseName)
          if (!importedBase) {
            continue
          }

          addUniqueEdge(edges, existingEdges, createEdge(classId, importedBase.targetId, 'inherits', filePath, lineNumber, 'INFERRED'))
        }
        continue
      }

      const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
      if (functionMatch?.[1]) {
        const currentClass = classStack[classStack.length - 1]
        const functionId = currentClass ? _makeId(currentClass.id, functionMatch[1]) : _makeId(fileStem, functionMatch[1])
        functionStack.push({ indent, id: functionId })
        continue
      }

      const currentClass = classStack[classStack.length - 1]
      const currentFunction = functionStack[functionStack.length - 1]
      if (!currentClass && !currentFunction) {
        continue
        }

      for (const importedSymbol of importedSymbols) {
        const symbolPattern = new RegExp(`\\b${escapedRegExpText(importedSymbol.localName)}\\b`)
        if (!symbolPattern.test(trimmed)) {
          continue
        }

        if (currentFunction && searchableNodeIds.has(currentFunction.id) && importedSymbol.callable) {
          const callPattern = new RegExp(`\\b${escapedRegExpText(importedSymbol.localName)}\\s*\\(`)
          if (callPattern.test(trimmed)) {
            addUniqueEdge(edges, existingEdges, createEdge(currentFunction.id, importedSymbol.targetId, 'calls', filePath, lineNumber, 'INFERRED'))
          }
        }

        if (currentClass) {
          addUniqueEdge(edges, existingEdges, createEdge(currentClass.id, importedSymbol.targetId, 'uses', filePath, lineNumber, 'INFERRED'))
        }
      }
    }
  }

  return {
    ...extraction,
    nodes: [...extraction.nodes],
    edges,
  }
}

export function resolvePythonFastApiSemantics(
  files: readonly string[],
  extraction: ExtractionData,
  options: ResolveCrossFilePythonImportsOptions = {},
): ExtractionData {
  const pythonFiles = files.filter((filePath) => extname(filePath).toLowerCase() === '.py')
  if (pythonFiles.length === 0) {
    return extraction
  }

  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const searchableNodeIds = new Set(searchableNodes.map((node) => node.id))
  const { nodeIdsByModuleAndName } = buildPythonImportableSymbolIndex(searchableNodes)
  const fastApiOwnerIndex = buildFastApiOwnerIndex(pythonFiles)
  const fastApiOwnerContexts = buildFastApiOwnerContexts(fastApiOwnerIndex, buildFastApiIncludeRecords(pythonFiles, fastApiOwnerIndex))
  const nodes = extraction.nodes.map((node) => ({ ...node }))
  const nodeIndicesById = new Map(nodes.map((node, index) => [node.id, index] as const))
  const seenNodeIds = new Set(nodes.map((node) => node.id))
  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  const setNodeAttributes = (nodeId: string, attributes: Partial<ExtractionNode>): void => {
    const nodeIndex = nodeIndicesById.get(nodeId)
    if (nodeIndex === undefined) {
      return
    }

    nodes[nodeIndex] = {
      ...nodes[nodeIndex]!,
      ...attributes,
      id: nodes[nodeIndex]!.id,
    }
  }

  const addDerivedNode = (node: ExtractionNode): void => {
    if (seenNodeIds.has(node.id)) {
      return
    }
    addNode(nodes, seenNodeIds, node)
    nodeIndicesById.set(node.id, nodes.length - 1)
  }

  for (const filePath of pythonFiles) {
    const moduleStem = basename(filePath, extname(filePath))
    const fileStem = fileStemForPath(filePath)
    const fileNodeId = fileNodeIdForPath(filePath)
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      if (process.env.DEBUG) {
        console.warn(`[madar extract] Skipping unreadable Python file during FastAPI linking: ${filePath}`)
      }
      continue
    }

    const importedTargets = new Map<string, string>()
    const importedOwnerTargets = new Map<string, FastApiOwnerRecord>()
    const fastApiModuleAliases = new Set<string>()
    const routerFactoryBindings = new Set<string>()
    const appFactoryBindings = new Set<string>()
    const dependsBindings = new Set<string>()
    const routerOwners = new Map<string, FastApiOwnerRecord>()
    const classStack: Array<{ indent: number; id: string }> = []
    const pendingDecorators: Array<{ text: string; line: number }> = []

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const shouldCollectBlock = !/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[$/.test(trimmed) && pythonDelimiterBalance(trimmed) > 0
      const { text: statementText, endIndex } = shouldCollectBlock
        ? collectPythonStatement(lines, index)
        : { text: trimmed, endIndex: index }
      const lineNumber = index + 1
      index = endIndex
      if (!statementText) {
        continue
      }

      const indent = line.length - line.trimStart().length
      while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? -1)) {
        classStack.pop()
      }

      const fromFastApiMatch = statementText.match(/^from\s+fastapi\s+import\s+(.+)$/)
      if (fromFastApiMatch?.[1]) {
        for (const entry of splitTopLevelPythonArguments(fromFastApiMatch[1].replace(/[()]/g, ''))) {
          if (!entry) {
            continue
          }
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }
          if (importedName === 'APIRouter') {
            routerFactoryBindings.add(localName)
          } else if (importedName === 'FastAPI') {
            appFactoryBindings.add(localName)
          } else if (importedName === 'Depends') {
            dependsBindings.add(localName)
          }
        }
        continue
      }

      const importFastApiMatch = statementText.match(/^import\s+fastapi(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
      if (importFastApiMatch) {
        fastApiModuleAliases.add(importFastApiMatch[1] ?? 'fastapi')
        continue
      }

      const importFromMatch = statementText.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        const importedList = importFromMatch[2].replace(/[()]/g, '')
        for (const entry of splitTopLevelPythonArguments(importedList)) {
          if (!entry) {
            continue
          }
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }

          const targetId = resolveImportedPythonTarget(moduleSpecifier, importedName, nodeIdsByModuleAndName)
          if (targetId) {
            importedTargets.set(localName, targetId)
          }

          const moduleStem = moduleSpecifier.replace(/^\.+/, '').split('.').filter(Boolean).at(-1)
          const owner = moduleStem
            ? [...fastApiOwnerIndex.values()].find(
                (candidate) =>
                  normalizeLabel(candidate.moduleStem) === normalizeLabel(moduleStem) &&
                  normalizeLabel(candidate.ownerName) === normalizeLabel(importedName),
              )
            : null
          if (owner) {
            importedOwnerTargets.set(localName, owner)
          }
        }
        continue
      }

      const classMatch = statementText.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
      if (classMatch?.[1]) {
        classStack.push({ indent, id: _makeId(fileStem, classMatch[1]) })
        pendingDecorators.length = 0
        continue
      }

      const ownerAssignment = fastApiOwnerAssignment(statementText, routerFactoryBindings, appFactoryBindings, fastApiModuleAliases, dependsBindings)
      if (ownerAssignment) {
        const ownerId = _makeId(fileStem, ownerAssignment.ownerName, ownerAssignment.frameworkRole)
        const ownerRecord = fastApiOwnerIndex.get(ownerId) ?? {
          moduleStem,
          ownerName: ownerAssignment.ownerName,
          id: ownerId,
          prefix: ownerAssignment.prefix,
          dependencies: ownerAssignment.dependencies,
          frameworkRole: ownerAssignment.frameworkRole,
        }
        routerOwners.set(ownerAssignment.ownerName, {
          ...ownerRecord,
        })
        addDerivedNode({
          ...createNode(ownerId, ownerAssignment.ownerName, filePath, lineNumber),
          node_kind: 'router',
          framework: 'fastapi',
          framework_role: ownerAssignment.frameworkRole,
          route_path: ownerAssignment.prefix || undefined,
        })
        addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, ownerId, 'declares', filePath, lineNumber))
        pendingDecorators.length = 0
        continue
      }

      if (statementText.startsWith('@')) {
        pendingDecorators.push({ text: statementText, line: lineNumber })
        continue
      }

      const functionMatch = statementText.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
      if (functionMatch?.[1]) {
        const currentClass = classStack[classStack.length - 1]
        const functionId = currentClass ? _makeId(currentClass.id, functionMatch[1]) : _makeId(fileStem, functionMatch[1])
        const routeDecorator = pendingDecorators
          .map((decorator) => ({ ...decorator, parsed: fastApiRouteDecorator(decorator.text, routerOwners) }))
          .find((decorator): decorator is { text: string; line: number; parsed: { ownerName: string; method: string; routePath: string } } => Boolean(decorator.parsed))
        pendingDecorators.length = 0
        if (!routeDecorator || !searchableNodeIds.has(functionId)) {
          continue
        }

        const owner = routerOwners.get(routeDecorator.parsed.ownerName)
        if (!owner) {
          continue
        }

        const ownerContexts = fastApiOwnerContexts.get(owner.id) ?? [{
          ancestorPrefix: '',
          ancestorDependencies: [],
          registerOwnerIds: [owner.id],
        }]
        setNodeAttributes(functionId, {
          framework: 'fastapi',
          framework_role: 'fastapi_endpoint',
        })

        for (const ownerContext of ownerContexts) {
          const fullRoutePath = joinPythonRoutePrefixes(ownerContext.ancestorPrefix, owner.prefix, routeDecorator.parsed.routePath)
          const routeId = _makeId(fileStem, routeDecorator.parsed.ownerName, routeDecorator.parsed.method, fullRoutePath, 'fastapi_route')
          addDerivedNode({
            ...createNode(routeId, `${routeDecorator.parsed.method} ${fullRoutePath}`, filePath, routeDecorator.line),
            node_kind: 'route',
            framework: 'fastapi',
            framework_role: 'fastapi_route',
            http_method: routeDecorator.parsed.method,
            route_path: fullRoutePath,
          })
          addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, routeId, 'declares', filePath, routeDecorator.line))
          for (const registerOwnerId of ownerContext.registerOwnerIds) {
            addUniqueEdge(edges, existingEdges, createEdge(registerOwnerId, routeId, 'registers_route', filePath, routeDecorator.line))
          }
          addUniqueEdge(edges, existingEdges, createEdge(functionId, routeId, 'handles_route', filePath, routeDecorator.line))
          addUniqueEdge(edges, existingEdges, createEdge(routeId, functionId, 'depends_on', filePath, routeDecorator.line))

          const dependencyNames = new Set([
            ...ownerContext.ancestorDependencies,
            ...owner.dependencies,
            ...fastApiDependencyNames(routeDecorator.text, dependsBindings, fastApiModuleAliases),
            ...fastApiDependencyNames(statementText, dependsBindings, fastApiModuleAliases),
          ])
          for (const dependencyName of dependencyNames) {
            const dependencyId = resolvePythonLocalOrImportedTarget(moduleStem, dependencyName, importedTargets, nodeIdsByModuleAndName)
            if (!dependencyId || !searchableNodeIds.has(dependencyId)) {
              continue
            }

            setNodeAttributes(dependencyId, {
              framework: 'fastapi',
              framework_role: 'fastapi_dependency',
            })
            addUniqueEdge(edges, existingEdges, createEdge(functionId, dependencyId, 'depends_on', filePath, routeDecorator.line))
          }
        }
        continue
      }

      pendingDecorators.length = 0
    }
  }

  return {
    ...extraction,
    nodes,
    edges,
  }
}

export function resolvePythonDjangoSemantics(
  files: readonly string[],
  extraction: ExtractionData,
  options: ResolveCrossFilePythonImportsOptions = {},
): ExtractionData {
  const pythonFiles = files.filter((filePath) => extname(filePath).toLowerCase() === '.py')
  if (pythonFiles.length === 0) {
    return extraction
  }

  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const searchableNodeIds = new Set(searchableNodes.map((node) => node.id))
  const { nodeIdsByModuleAndName } = buildPythonImportableSymbolIndex(searchableNodes)
  const nodes = extraction.nodes.map((node) => ({ ...node }))
  const nodeIndicesById = new Map(nodes.map((node, index) => [node.id, index] as const))
  const seenNodeIds = new Set(nodes.map((node) => node.id))
  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  const setNodeAttributes = (nodeId: string, attributes: Partial<ExtractionNode>): void => {
    const nodeIndex = nodeIndicesById.get(nodeId)
    if (nodeIndex === undefined) {
      return
    }

    nodes[nodeIndex] = {
      ...nodes[nodeIndex]!,
      ...attributes,
      id: nodes[nodeIndex]!.id,
    }
  }

  const addDerivedNode = (node: ExtractionNode): void => {
    if (seenNodeIds.has(node.id)) {
      return
    }
    addNode(nodes, seenNodeIds, node)
    nodeIndicesById.set(node.id, nodes.length - 1)
  }

  for (const filePath of pythonFiles) {
    const moduleStem = basename(filePath, extname(filePath))
    const fileStem = fileStemForPath(filePath)
    const fileNodeId = fileNodeIdForPath(filePath)
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      continue
    }

    const importedTargets = new Map<string, string>()
    const djangoPathBindings = new Set<string>()

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const shouldCollectBlock = !/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[$/.test(trimmed) && pythonDelimiterBalance(trimmed) > 0
      const { text: statementText, endIndex } = shouldCollectBlock
        ? collectPythonStatement(lines, index)
        : { text: trimmed, endIndex: index }
      const lineNumber = index + 1
      index = endIndex
      if (!statementText) {
        continue
      }

      const djangoUrlsMatch = statementText.match(/^from\s+django\.urls\s+import\s+(.+)$/)
      if (djangoUrlsMatch?.[1]) {
        for (const entry of splitTopLevelPythonArguments(djangoUrlsMatch[1].replace(/[()]/g, ''))) {
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if ((importedName === 'path' || importedName === 're_path') && localName) {
            djangoPathBindings.add(localName)
          }
        }
        continue
      }

      const importFromMatch = statementText.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        for (const entry of splitTopLevelPythonArguments(importFromMatch[2].replace(/[()]/g, ''))) {
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          const localName = aliasPart?.trim() || importedName
          if (!importedName || !localName) {
            continue
          }
          const targetId = resolveImportedPythonTarget(moduleSpecifier, importedName, nodeIdsByModuleAndName)
          if (targetId) {
            importedTargets.set(localName, targetId)
          }
        }
      }

      const routeDefinition = djangoRouteDefinition(statementText, djangoPathBindings)
      if (!routeDefinition) {
        continue
      }

      const viewId = resolveDjangoViewTarget(moduleStem, routeDefinition.viewExpression, importedTargets, nodeIdsByModuleAndName)
      if (!viewId || !searchableNodeIds.has(viewId)) {
        continue
      }

      const routeId = _makeId(fileStem, routeDefinition.routePath, 'django_route')
      addDerivedNode({
        ...createNode(routeId, `route ${routeDefinition.routePath}`, filePath, lineNumber),
        node_kind: 'route',
        framework: 'django',
        framework_role: 'django_route',
        route_path: routeDefinition.routePath,
      })
      setNodeAttributes(viewId, {
        framework: 'django',
        framework_role: 'django_view',
      })
      addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, routeId, 'declares', filePath, lineNumber))
      addUniqueEdge(edges, existingEdges, createEdge(viewId, routeId, 'handles_route', filePath, lineNumber))
      addUniqueEdge(edges, existingEdges, createEdge(routeId, viewId, 'depends_on', filePath, lineNumber))
    }
  }

  return {
    ...extraction,
    nodes,
    edges,
  }
}

export function resolveCrossFileRelativeJsImports(
  files: readonly string[],
  extraction: ExtractionData,
  options: ResolveCrossFilePythonImportsOptions = {},
): ExtractionData {
  const jsTsFiles = files.map((filePath) => resolve(filePath)).filter((filePath) => isJsTsFile(filePath))
  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const knownFiles = new Set([
    ...jsTsFiles,
    ...searchableNodes.map((node) => resolve(node.source_file)).filter((filePath) => isJsTsFile(filePath)),
  ])
  if (knownFiles.size < 2 || jsTsFiles.length === 0) {
    return extraction
  }
  const compilerOptionsCache = new Map<string, ts.CompilerOptions | null>()
  const searchableNodeIds = new Set(searchableNodes.map((node) => node.id))
  const nodes = [...extraction.nodes]
  const seenNodeIds = new Set(nodes.map((node) => node.id))
  const exportedBindingsByFile = new Map<string, Map<string, string>>()

  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  for (const filePath of knownFiles) {
    exportedBindingsByFile.set(
      filePath,
      collectTopLevelExportedJsBindings(filePath, knownFiles, exportedBindingsByFile, compilerOptionsCache),
    )
  }

  const resolveImportedTargetId = (targetFilePath: string, importedName: string): string | null => {
    const targetId = exportedBindingsByFile.get(targetFilePath)?.get(importedName)
    if (!targetId || !searchableNodeIds.has(targetId)) {
      return null
    }

    return targetId
  }

  for (const filePath of jsTsFiles) {
    const fileStem = fileStemForPath(filePath)
    const fileNodeId = fileNodeIdForPath(filePath)
    const defaultOwnerId = _makeId(fileStem, 'default')
    if (!searchableNodeIds.has(fileNodeId)) {
      continue
    }

    let sourceText: string
    try {
      sourceText = readFileSync(filePath, 'utf8')
    } catch {
      if (process.env.DEBUG) {
        console.warn(`[madar extract] Skipping unreadable JS/TS file during cross-file linking: ${filePath}`)
      }
      continue
    }

    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
    const importedTargets = new Map<string, string>()
    const namespaceTargets = new Map<string, { targetFilePath: string; line: number }>()
    const externalImportedBindings = new Map<string, { localName: string; line: number }>()
    const externalNamespaceBindings = new Map<string, { localName: string; line: number }>()
    type ScopeFrame = { bindings: Set<string>; functionScope: boolean }
    const declareBinding = (scopeChain: ScopeFrame[], name: string): void => {
      scopeChain[scopeChain.length - 1]?.bindings.add(name)
    }
    const declareInNearestFunctionScope = (scopeChain: ScopeFrame[], names: readonly string[]): void => {
      const nearestFunctionScope = [...scopeChain].reverse().find((scope) => scope.functionScope)
      if (!nearestFunctionScope) {
        return
      }

      for (const name of names) {
        nearestFunctionScope.bindings.add(name)
      }
    }
    const collectBindingNames = (name: ts.BindingName): string[] => {
      if (ts.isIdentifier(name)) {
        return [name.text]
      }

      const names: string[] = []
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          names.push(...collectBindingNames(element.name))
        }
      }
      return names
    }
    const parameterBindingNames = (parameters: readonly ts.ParameterDeclaration[]): string[] =>
      parameters.flatMap((parameter) => collectBindingNames(parameter.name))
    const declarationListBindingNames = (declarationList: ts.VariableDeclarationList): string[] =>
      declarationList.declarations.flatMap((declaration) => collectBindingNames(declaration.name))
    const functionScopedVarBindingsInBody = (body: ts.ConciseBody): string[] => {
      const bindings = new Set<string>()
      const collect = (node: ts.Node, isRoot = false): void => {
        if (
          !isRoot &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isClassExpression(node))
        ) {
          return
        }

        if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
          for (const declaration of node.declarationList.declarations) {
            for (const bindingName of collectBindingNames(declaration.name)) {
              bindings.add(bindingName)
            }
          }
        }

        const loopInitializer =
          ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
            ? node.initializer
            : null
        if (loopInitializer && ts.isVariableDeclarationList(loopInitializer) && (loopInitializer.flags & ts.NodeFlags.BlockScoped) === 0) {
          for (const bindingName of declarationListBindingNames(loopInitializer)) {
            bindings.add(bindingName)
          }
        }

        ts.forEachChild(node, (child) => collect(child))
      }

      collect(body, true)
      return [...bindings]
    }
    const statementBindingNames = (statement: ts.Statement): string[] => {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        return [statement.name.text]
      }

      if (ts.isVariableStatement(statement)) {
        return declarationListBindingNames(statement.declarationList)
      }

      return []
    }
    const classMemberName = (member: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.PropertyDeclaration): string | null => {
      if (ts.isConstructorDeclaration(member)) {
        return 'constructor'
      }

      if (!member.name) {
        return null
      }

      return ts.isIdentifier(member.name)
        ? member.name.text
        : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text
          : member.name.getText(sourceFile)
    }
    const isShadowed = (scopeChain: ScopeFrame[], name: string): boolean => {
      for (let index = scopeChain.length - 1; index >= 0; index -= 1) {
        if (scopeChain[index]?.bindings.has(name)) {
          return true
        }
      }
      return false
    }
    const declareFunctionScopedVarBindings = (scopeChain: ScopeFrame[], statements: readonly ts.Statement[]): void => {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
          continue
        }
        declareInNearestFunctionScope(scopeChain, declarationListBindingNames(statement.declarationList))
      }
    }
    const withScope = (scopeChain: ScopeFrame[], initialBindings: readonly string[], functionScope: boolean, callback: () => void): void => {
      scopeChain.push({ bindings: new Set(initialBindings), functionScope })
      try {
        callback()
      } finally {
        scopeChain.pop()
      }
    }
    const functionOwnerId = (ownerId: string | undefined, functionName: string): string => _makeId(ownerId ?? fileStem, functionName)
    const hasDefaultExportModifier = (node: ts.Node): boolean => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      return (
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false) &&
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
      )
    }

    const recordImportTargets = (declaration: ts.ImportDeclaration): void => {
      if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) {
        return
      }

      const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1
      const importClause = declaration.importClause
      if (!importClause) {
        return
      }

      const targetFilePath = resolveJsImportTarget(
        declaration.moduleSpecifier.text,
        filePath,
        knownFiles,
        compilerOptionsCache,
      )

      if (importClause.name) {
        if (targetFilePath) {
          const targetId = resolveImportedTargetId(targetFilePath, 'default')
          if (targetId) {
            importedTargets.set(importClause.name.text, targetId)
            addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, targetId, 'imports_from', filePath, line))
          }
        } else {
          externalImportedBindings.set(importClause.name.text, { localName: importClause.name.text, line })
        }
      }

      if (!importClause.namedBindings) {
        return
      }

      if (ts.isNamespaceImport(importClause.namedBindings)) {
        if (targetFilePath) {
          namespaceTargets.set(importClause.namedBindings.name.text, { targetFilePath, line })
        } else {
          externalNamespaceBindings.set(importClause.namedBindings.name.text, {
            localName: importClause.namedBindings.name.text,
            line,
          })
        }
        return
      }

      for (const element of importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const localName = element.name.text
        if (targetFilePath) {
          const targetId = resolveImportedTargetId(targetFilePath, importedName)
          if (!targetId) {
            continue
          }

          importedTargets.set(localName, targetId)
          addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, targetId, 'imports_from', filePath, line))
          continue
        }
        externalImportedBindings.set(localName, { localName, line })
      }
    }

    const ensureSyntheticExternalCallNode = (
      ownerId: string,
      label: string,
      line: number,
    ): string => {
      const nodeId = _makeId(ownerId, label, 'external_call')
      if (!seenNodeIds.has(nodeId)) {
        addNode(nodes, seenNodeIds, {
          ...createNode(nodeId, label, filePath, line),
          node_kind: 'method',
        })
      }
      return nodeId
    }

    const visitStatementList = (
      statements: readonly ts.Statement[],
      scopeChain: ScopeFrame[],
      currentOwnerId?: string,
      currentClassName?: string,
      functionScope = false,
    ): void => {
      const hoistedBindings = [...new Set(statements.flatMap((statement) => statementBindingNames(statement)))]
      declareFunctionScopedVarBindings(scopeChain, statements)

      withScope(scopeChain, hoistedBindings, functionScope, () => {
        for (const statement of statements) {
          visit(statement, scopeChain, currentOwnerId, currentClassName)
        }
      })
    }

    const visitFunctionLikeBody = (
      body: ts.ConciseBody,
      parameters: readonly ts.ParameterDeclaration[],
      scopeChain: ScopeFrame[],
      ownerId?: string,
      currentClassName?: string,
      extraBindings: readonly string[] = [],
    ): void => {
      const initialBindings = [...parameterBindingNames(parameters), ...functionScopedVarBindingsInBody(body), ...extraBindings]
      withScope(scopeChain, initialBindings, true, () => {
        if (ts.isBlock(body)) {
          visitStatementList(body.statements, scopeChain, ownerId, currentClassName)
          return
        }

        visit(body, scopeChain, ownerId, currentClassName)
      })
    }

    const visit = (node: ts.Node, scopeChain: ScopeFrame[], currentOwnerId?: string, currentClassName?: string): void => {
      if (ts.isSourceFile(node)) {
        visitStatementList(node.statements, scopeChain, currentOwnerId, currentClassName, true)
        return
      }

      if (ts.isBlock(node)) {
        visitStatementList(node.statements, scopeChain, currentOwnerId, currentClassName)
        return
      }

      if (ts.isImportDeclaration(node)) {
        recordImportTargets(node)
        return
      }

      if (ts.isClassDeclaration(node) && node.name) {
        declareBinding(scopeChain, node.name.text)
        const classId = _makeId(fileStem, node.name.text)
        for (const member of node.members) {
          visit(member, scopeChain, searchableNodeIds.has(classId) ? classId : undefined, node.name.text)
        }
        return
      }

      if (ts.isClassDeclaration(node) && hasDefaultExportModifier(node)) {
        for (const member of node.members) {
          visit(member, scopeChain, searchableNodeIds.has(defaultOwnerId) ? defaultOwnerId : undefined, 'default')
        }
        return
      }

      if ((ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && currentClassName) {
        const methodName = classMemberName(node)
        if (!methodName) {
          return
        }

        const methodId = _makeId(_makeId(fileStem, currentClassName), methodName)
        if (node.body) {
          visitFunctionLikeBody(
            node.body,
            node.parameters,
            scopeChain,
            searchableNodeIds.has(methodId) ? methodId : undefined,
            currentClassName,
          )
        }
        return
      }

      if (ts.isPropertyDeclaration(node) && currentClassName) {
        const methodName = classMemberName(node)
        if (!methodName) {
          return
        }

        if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          const methodId = _makeId(_makeId(fileStem, currentClassName), methodName)
          visitFunctionLikeBody(
            node.initializer.body,
            node.initializer.parameters,
            scopeChain,
            searchableNodeIds.has(methodId) ? methodId : undefined,
            currentClassName,
            [...(ts.isFunctionExpression(node.initializer) && node.initializer.name ? [node.initializer.name.text] : [])],
          )
        }
        return
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        declareBinding(scopeChain, node.name.text)
        const functionId = functionOwnerId(currentOwnerId, node.name.text)
        if (node.body) {
          visitFunctionLikeBody(
            node.body,
            node.parameters,
            scopeChain,
            searchableNodeIds.has(functionId) ? functionId : undefined,
            currentClassName,
            [node.name.text],
          )
        }
        return
      }

      if (ts.isFunctionDeclaration(node) && hasDefaultExportModifier(node)) {
        if (node.body) {
          visitFunctionLikeBody(
            node.body,
            node.parameters,
            scopeChain,
            searchableNodeIds.has(defaultOwnerId) ? defaultOwnerId : undefined,
            currentClassName,
          )
        }
        return
      }

      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const exportExpression = unparenthesizeExpression(node.expression)
        if (ts.isArrowFunction(exportExpression) || ts.isFunctionExpression(exportExpression)) {
          visitFunctionLikeBody(
            exportExpression.body,
            exportExpression.parameters,
            scopeChain,
            searchableNodeIds.has(defaultOwnerId) ? defaultOwnerId : undefined,
            currentClassName,
            [...(ts.isFunctionExpression(exportExpression) && exportExpression.name ? [exportExpression.name.text] : [])],
          )
          return
        }

        if (ts.isClassExpression(exportExpression)) {
          for (const member of exportExpression.members) {
            visit(member, scopeChain, searchableNodeIds.has(defaultOwnerId) ? defaultOwnerId : undefined, 'default')
          }
          return
        }
      }

      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        visitFunctionLikeBody(
          node.body,
          node.parameters,
          scopeChain,
          currentOwnerId,
          currentClassName,
          [...(ts.isFunctionExpression(node) && node.name ? [node.name.text] : [])],
        )
        return
      }

      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!declaration.initializer) {
            for (const bindingName of collectBindingNames(declaration.name)) {
              declareBinding(scopeChain, bindingName)
            }
            continue
          }

          if (ts.isIdentifier(declaration.name) && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            declareBinding(scopeChain, declaration.name.text)
            const functionId = functionOwnerId(currentOwnerId, declaration.name.text)
            visitFunctionLikeBody(
              declaration.initializer.body,
              declaration.initializer.parameters,
              scopeChain,
              searchableNodeIds.has(functionId) ? functionId : undefined,
              currentClassName,
              [declaration.name.text, ...(ts.isFunctionExpression(declaration.initializer) && declaration.initializer.name ? [declaration.initializer.name.text] : [])],
            )
            continue
          }

          visit(declaration.initializer, scopeChain, currentOwnerId, currentClassName)
          for (const bindingName of collectBindingNames(declaration.name)) {
            declareBinding(scopeChain, bindingName)
          }
        }
        return
      }

      if (ts.isForStatement(node)) {
        const initializer = node.initializer
        if (!initializer || !ts.isVariableDeclarationList(initializer)) {
          // fall through to the generic walk for non-declaration initializers
        } else {
          const bindingNames = declarationListBindingNames(initializer)
          const visitLoop = (): void => {
            for (const declaration of initializer.declarations) {
              if (declaration.initializer) {
                visit(declaration.initializer, scopeChain, currentOwnerId, currentClassName)
              }
            }
            if (node.condition) {
              visit(node.condition, scopeChain, currentOwnerId, currentClassName)
            }
            if (node.incrementor) {
              visit(node.incrementor, scopeChain, currentOwnerId, currentClassName)
            }
            visit(node.statement, scopeChain, currentOwnerId, currentClassName)
          }

          if ((initializer.flags & ts.NodeFlags.BlockScoped) !== 0) {
            withScope(scopeChain, bindingNames, false, visitLoop)
          } else {
            declareInNearestFunctionScope(scopeChain, bindingNames)
            visitLoop()
          }
          return
        }
      }

      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
        const bindingNames = declarationListBindingNames(node.initializer)
        const visitLoop = (): void => {
          visit(node.expression, scopeChain, currentOwnerId, currentClassName)
          visit(node.statement, scopeChain, currentOwnerId, currentClassName)
        }

        if ((node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0) {
          withScope(scopeChain, bindingNames, false, visitLoop)
        } else {
          declareInNearestFunctionScope(scopeChain, bindingNames)
          visitLoop()
        }
        return
      }

      if (ts.isCatchClause(node)) {
        const bindingNames = node.variableDeclaration ? collectBindingNames(node.variableDeclaration.name) : []
        withScope(scopeChain, bindingNames, false, () => {
          visit(node.block, scopeChain, currentOwnerId, currentClassName)
        })
        return
      }

      if (ts.isCallExpression(node) && currentOwnerId && ts.isIdentifier(node.expression)) {
        const targetId = importedTargets.get(node.expression.text)
        if (targetId && !isShadowed(scopeChain, node.expression.text)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          addUniqueEdge(edges, existingEdges, createEdge(currentOwnerId, targetId, 'calls', filePath, line))
        } else if (externalImportedBindings.has(node.expression.text) && !isShadowed(scopeChain, node.expression.text)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          const syntheticTargetId = ensureSyntheticExternalCallNode(currentOwnerId, `${node.expression.text}()`, line)
          addUniqueEdge(edges, existingEdges, createEdge(currentOwnerId, syntheticTargetId, 'calls', filePath, line, 'INFERRED'))
        }
      } else if (
        ts.isCallExpression(node) &&
        currentOwnerId &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const namespaceImport = namespaceTargets.get(node.expression.expression.text)
        const targetId = namespaceImport && !isShadowed(scopeChain, node.expression.expression.text)
          ? resolveImportedTargetId(namespaceImport.targetFilePath, node.expression.name.text)
          : null
        if (targetId) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, targetId, 'imports_from', filePath, namespaceImport?.line ?? line))
          addUniqueEdge(edges, existingEdges, createEdge(currentOwnerId, targetId, 'calls', filePath, line))
        } else if (
          !isShadowed(scopeChain, node.expression.expression.text)
          && (
            externalImportedBindings.has(node.expression.expression.text)
            || externalNamespaceBindings.has(node.expression.expression.text)
          )
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          const syntheticTargetId = ensureSyntheticExternalCallNode(
            currentOwnerId,
            `${node.expression.expression.text}.${node.expression.name.text}`,
            line,
          )
          addUniqueEdge(edges, existingEdges, createEdge(currentOwnerId, syntheticTargetId, 'calls', filePath, line, 'INFERRED'))
        }
      }

      ts.forEachChild(node, (child) => visit(child, scopeChain, currentOwnerId, currentClassName))
    }

    visit(sourceFile, [])
  }

  return {
    ...extraction,
    nodes,
    edges,
  }
}

export function resolveJsxRendersProxies(extraction: ExtractionData): ExtractionData {
  const proxyEdgeIndices: number[] = []
  for (let i = 0; i < extraction.edges.length; i++) {
    const edge = extraction.edges[i]
    if (edge !== undefined && edge.relation === 'renders' && typeof edge.target === 'string' && edge.target.endsWith('__jsx_proxy')) {
      proxyEdgeIndices.push(i)
    }
  }

  if (proxyEdgeIndices.length === 0) {
    return extraction
  }

  const edges: ExtractionData['edges'] = [...extraction.edges]

  for (const idx of proxyEdgeIndices) {
    const edge = edges[idx]
    if (edge === undefined) continue
    const proxyTarget = String(edge.target)
    const componentName = proxyTarget.slice(0, -'__jsx_proxy'.length)

    // Primary lookup: node with matching label and node_kind: 'component'
    let realNode = extraction.nodes.find((n) => n.label === `${componentName}()` && n.node_kind === 'component')

    // Fallback: any node whose id ends with /<componentName> and is a component
    if (!realNode) {
      realNode = extraction.nodes.find(
        (n) => n.node_kind === 'component' && typeof n.id === 'string' && (n.id === componentName || n.id.endsWith(`/${componentName}`)),
      )
    }

    if (realNode) {
      edges[idx] = {
        source: edge.source,
        target: realNode.id,
        relation: edge.relation,
        confidence: edge.confidence,
        source_file: edge.source_file,
        ...(edge.source_location !== undefined ? { source_location: edge.source_location } : {}),
        ...(edge.layer !== undefined ? { layer: edge.layer } : {}),
        ...(edge.provenance !== undefined ? { provenance: edge.provenance } : {}),
        ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
      }
    }
    // else: leave proxy edge as-is (best effort)
  }

  return {
    ...extraction,
    nodes: [...extraction.nodes],
    edges,
  }
}
