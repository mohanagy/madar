import { basename, dirname, extname, relative, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { _makeId, addNode, addUniqueEdge, createEdge, createNode } from './core.js'

export interface ResolveGoSemanticsOptions {
  contextNodes?: readonly ExtractionNode[]
}

interface GoImportBinding {
  localName: string
  importPath: string
  packagePath: string
  isLocal: boolean
}

interface GoQualifiedType {
  packagePath: string
  ownerName: string
}

interface GoModuleInfo {
  rootDir: string | null
  modulePath: string | null
}

interface GoFileInfo {
  filePath: string
  packageName: string
  packagePath: string
  imports: Map<string, GoImportBinding>
}

interface GoRouterBinding {
  framework: 'net/http' | 'gin' | 'chi'
  frameworkRole: 'net_http_mux' | 'gin_router' | 'gin_group' | 'chi_router'
  routePrefix: string
  nodeId: string
}

interface GoNodeIndex {
  fileNodeIds: Map<string, string>
  functionIds: Map<string, string>
  methodIds: Map<string, string>
}

const GO_HTTP_ROUTE_METHOD = 'ALL'
const GO_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])
const GO_KEYWORDS = new Set(['if', 'for', 'switch', 'select', 'go', 'defer', 'return', 'func', 'type', 'var', 'const', 'make', 'new'])
const GO_HTTP_METHOD_PATTERN = '(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head)'

function readGoFileInfo(filePath: string, cache: Map<string, GoFileInfo>): GoFileInfo {
  const resolvedPath = resolve(filePath)
  const cached = cache.get(resolvedPath)
  if (cached) {
    return cached
  }

  const sourceText = readFileSync(resolvedPath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const packageName = lines
    .map((line) => line.trim().match(/^package\s+([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? null)
    .find((name): name is string => Boolean(name))
    ?? basename(dirname(resolvedPath))

  const moduleInfo = findGoModuleInfo(resolvedPath)
  const packagePath = goPackagePath(resolvedPath, packageName, moduleInfo)
  const imports = parseGoImports(lines, moduleInfo)
  const info = { filePath: resolvedPath, packageName, packagePath, imports }
  cache.set(resolvedPath, info)
  return info
}

function findGoModuleInfo(filePath: string): GoModuleInfo {
  let currentDir = dirname(resolve(filePath))
  while (true) {
    const goModPath = resolve(currentDir, 'go.mod')
    if (existsSync(goModPath)) {
      const modulePath = readFileSync(goModPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim().match(/^module\s+(.+)$/)?.[1]?.trim() ?? null)
        .find((value): value is string => Boolean(value))
        ?? null
      return {
        rootDir: currentDir,
        modulePath,
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return { rootDir: null, modulePath: null }
    }
    currentDir = parentDir
  }
}

function goPackagePath(filePath: string, packageName: string, moduleInfo: GoModuleInfo): string {
  if (!moduleInfo.rootDir || !moduleInfo.modulePath) {
    return `local/${packageName}/${basename(dirname(filePath))}`
  }

  const relativeDir = relative(moduleInfo.rootDir, dirname(filePath)).replaceAll('\\', '/')
  return relativeDir ? `${moduleInfo.modulePath}/${relativeDir}` : moduleInfo.modulePath
}

function parseGoImports(lines: readonly string[], moduleInfo: GoModuleInfo): Map<string, GoImportBinding> {
  const imports = new Map<string, GoImportBinding>()
  let inImportBlock = false

  const recordImport = (rawLine: string): void => {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed === '(' || trimmed === ')') {
      return
    }

    const match = trimmed.match(/^(?:(\.|_|\w+)\s+)?"([^"]+)"$/)
    if (!match?.[2]) {
      return
    }

    const localName = match[1] ?? defaultImportName(match[2])
    const importPath = match[2]
    imports.set(localName, {
      localName,
      importPath,
      packagePath: importPath,
      isLocal: Boolean(moduleInfo.modulePath && (importPath === moduleInfo.modulePath || importPath.startsWith(`${moduleInfo.modulePath}/`))),
    })
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    if (trimmed === 'import(' || trimmed === 'import (') {
      inImportBlock = true
      continue
    }

    if (inImportBlock) {
      if (trimmed === ')') {
        inImportBlock = false
        continue
      }

      recordImport(trimmed)
      continue
    }

    const singleImport = trimmed.match(/^import\s+(.+)$/)?.[1]
    if (singleImport) {
      recordImport(singleImport)
    }
  }

  return imports
}

function defaultImportName(importPath: string): string {
  const segments = importPath.split('/').filter(Boolean)
  const lastSegment = segments.at(-1)
  if (lastSegment && /^v\d+$/.test(lastSegment)) {
    return segments.at(-2) ?? lastSegment
  }
  return lastSegment ?? importPath
}

function normalizeGoTypeReference(rawType: string): string {
  return rawType
    .replace(/\/\/.*$/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/^chan\s+/, '')
    .replace(/^<-chan\s+/, '')
    .replace(/^map\[[^\]]+\]/, '')
    .replace(/^func\s*\(.*$/, '')
    .replace(/^\*+/, '')
    .replace(/^\[\]+/, '')
    .trim()
}

function resolveGoQualifiedType(rawType: string, fileInfo: GoFileInfo): GoQualifiedType | null {
  const normalized = normalizeGoTypeReference(rawType)
  if (!normalized || /[\s\{\}\(\)]/.test(normalized)) {
    return null
  }

  const scopedMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/)
  if (scopedMatch?.[1] && scopedMatch[2]) {
    const binding = fileInfo.imports.get(scopedMatch[1])
    if (!binding) {
      return null
    }

    return {
      packagePath: binding.packagePath,
      ownerName: scopedMatch[2],
    }
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    return null
  }

  return {
    packagePath: fileInfo.packagePath,
    ownerName: normalized,
  }
}

function buildGoNodeIndex(
  extraction: ExtractionData,
  searchableNodes: readonly ExtractionNode[],
  fileInfoCache: Map<string, GoFileInfo>,
): GoNodeIndex {
  const fileNodeIds = new Map<string, string>()
  const functionIds = new Map<string, string>()
  const methodIds = new Map<string, string>()
  const nodeById = new Map(searchableNodes.map((node) => [node.id, node]))
  const ownerNamesByMethodId = new Map<string, string>()

  for (const edge of extraction.edges) {
    if (edge.relation !== 'method') {
      continue
    }
    const ownerName = nodeById.get(edge.source)?.label
    if (ownerName) {
      ownerNamesByMethodId.set(edge.target, ownerName)
    }
  }

  for (const node of searchableNodes) {
    if (extname(node.source_file).toLowerCase() !== '.go') {
      continue
    }

    const fileInfo = readGoFileInfo(node.source_file, fileInfoCache)
    if (node.label === basename(node.source_file)) {
      fileNodeIds.set(resolve(node.source_file), node.id)
      continue
    }

    const methodOwner = ownerNamesByMethodId.get(node.id)
    if (methodOwner && node.label.startsWith('.') && node.label.endsWith('()')) {
      const methodName = node.label.slice(1, -2)
      methodIds.set(goMethodKey(fileInfo.packagePath, methodOwner, methodName), node.id)
      continue
    }

    if (node.label.endsWith('()') && !node.label.startsWith('.')) {
      functionIds.set(goFunctionKey(fileInfo.packagePath, node.label.slice(0, -2)), node.id)
    }
  }

  return { fileNodeIds, functionIds, methodIds }
}

function goFunctionKey(packagePath: string, functionName: string): string {
  return `${packagePath}:${functionName.toLowerCase()}`
}

function goMethodKey(packagePath: string, ownerName: string, methodName: string): string {
  return `${packagePath}:${ownerName.toLowerCase()}:${methodName.toLowerCase()}`
}

function parseGoCallArguments(rawArgs: string): string[] {
  const args: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  for (let index = 0; index < rawArgs.length; index += 1) {
    const character = rawArgs[index]
    if (!character) {
      continue
    }

    if (escaped) {
      current += character
      escaped = false
      continue
    }

    if (inString) {
      current += character
      if (character === '\\' && quote !== '`') {
        escaped = true
      } else if (character === quote) {
        inString = false
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'" || character === '`') {
      current += character
      inString = true
      quote = character
      continue
    }

    if (character === '(' || character === '{' || character === '[') {
      depth += 1
      current += character
      continue
    }

    if (character === ')' || character === '}' || character === ']') {
      depth -= 1
      current += character
      continue
    }

    if (character === ',' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) {
        args.push(trimmed)
      }
      current = ''
      continue
    }

    current += character
  }

  const trimmed = current.trim()
  if (trimmed) {
    args.push(trimmed)
  }

  return args
}

function trimGoStringLiteral(rawValue: string): string | null {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return null
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
    return trimmed.slice(1, -1)
  }

  return null
}

function joinGoRoutePath(prefix: string, path: string): string {
  const normalizedPrefix = prefix === '/' ? '' : prefix.replace(/\/+$/g, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const joined = `${normalizedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
  return joined || '/'
}

function normalizeGoHttpMethod(rawMethod: string): string {
  const normalized = rawMethod.toUpperCase()
  return GO_HTTP_METHODS.has(normalized) ? normalized : rawMethod
}

function parseGoVarTypeFromCompositeLiteral(expression: string, fileInfo: GoFileInfo): GoQualifiedType | null {
  const trimmed = expression.trim()
  const compositeMatch = trimmed.match(/^&?\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\{/)
  if (!compositeMatch?.[1]) {
    return null
  }

  return resolveGoQualifiedType(compositeMatch[1], fileInfo)
}

function resolveGoCallableReference(
  rawReference: string,
  fileInfo: GoFileInfo,
  index: GoNodeIndex,
  localVarTypes: Map<string, GoQualifiedType>,
  currentReceiverType?: GoQualifiedType,
): string | null {
  const trimmed = rawReference.trim().replace(/&/g, '')
  if (!trimmed) {
    return null
  }

  const directReference = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
  if (directReference) {
    if (currentReceiverType) {
      const preferredMethodId = index.methodIds.get(goMethodKey(currentReceiverType.packagePath, currentReceiverType.ownerName, directReference))
      if (preferredMethodId) {
        return preferredMethodId
      }
    }
    return index.functionIds.get(goFunctionKey(fileInfo.packagePath, directReference)) ?? null
  }

  const segments = trimmed.split('.').filter(Boolean)
  if (segments.length < 2) {
    return null
  }

  const methodName = segments.at(-1)
  const targetName = segments[0]
  if (!methodName || !targetName) {
    return null
  }

  const importBinding = fileInfo.imports.get(targetName)
  if (importBinding?.isLocal) {
    return index.functionIds.get(goFunctionKey(importBinding.packagePath, methodName)) ?? null
  }

  const receiverType = localVarTypes.get(targetName)
  if (receiverType) {
    return index.methodIds.get(goMethodKey(receiverType.packagePath, receiverType.ownerName, methodName)) ?? null
  }

  if (currentReceiverType && targetName === currentReceiverType.ownerName.toLowerCase()) {
    return index.methodIds.get(goMethodKey(currentReceiverType.packagePath, currentReceiverType.ownerName, methodName)) ?? null
  }

  return null
}

function maybeTagNode(node: ExtractionNode, attrs: Partial<ExtractionNode>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue
    }
    if (node[key] === undefined) {
      node[key] = value
    }
  }
}

function analyzeGoFunctions(
  fileInfo: GoFileInfo,
  lines: readonly string[],
  extractionNodes: ExtractionNode[],
  edges: ExtractionEdge[],
  existingEdges: Set<string>,
  searchableNodeIds: ReadonlySet<string>,
  index: GoNodeIndex,
): void {
  const seenNodeIds = new Set(extractionNodes.map((node) => node.id))
  const fileNodesById = new Map(extractionNodes.map((node) => [node.id, node]))
  const fileNodeId = index.fileNodeIds.get(fileInfo.filePath) ?? _makeId(basename(fileInfo.filePath, extname(fileInfo.filePath)))
  const routeIdsByRouterId = new Map<string, string[]>()
  const chiImportAliases = new Set(
    [...fileInfo.imports.entries()]
      .filter(([, binding]) => binding.importPath.startsWith('github.com/go-chi/chi'))
      .map(([alias]) => alias),
  )

  const ensureRouterNode = (bindingName: string, binding: GoRouterBinding, lineNumber: number): void => {
    const node: ExtractionNode = {
      ...createNode(binding.nodeId, bindingName, fileInfo.filePath, lineNumber),
      node_kind: 'router',
      framework: binding.framework,
      framework_role: binding.frameworkRole,
      route_path: binding.routePrefix || '/',
    }
    addNode(extractionNodes, seenNodeIds, node)
    fileNodesById.set(node.id, node)
    addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, binding.nodeId, 'declares', fileInfo.filePath, lineNumber))
  }

  for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
    const signature = lines[indexLine]?.trim() ?? ''
    const functionMatch = signature.match(/^func\s*(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (!functionMatch?.[3]) {
      continue
    }

    const receiverName = functionMatch[1]
    const ownerName = functionMatch[2]
    const functionName = functionMatch[3]
    const lineNumber = indexLine + 1
    const currentReceiverType = ownerName ? { packagePath: fileInfo.packagePath, ownerName } : undefined
    const currentFunctionId = ownerName
      ? index.methodIds.get(goMethodKey(fileInfo.packagePath, ownerName, functionName)) ?? null
      : index.functionIds.get(goFunctionKey(fileInfo.packagePath, functionName)) ?? null

    if (currentFunctionId) {
      const currentNode = fileNodesById.get(currentFunctionId)
      if (currentNode) {
        maybeTagNode(currentNode, { node_kind: ownerName ? 'method' : 'function' })
      }
    }

    let braceDepth = braceDelta(signature)
    let cursor = indexLine + 1
    while (cursor < lines.length && braceDepth > 0) {
      braceDepth += braceDelta(lines[cursor] ?? '')
      cursor += 1
    }

    const blockLines = lines.slice(indexLine, Math.max(cursor, indexLine + 1))
    const localVarTypes = new Map<string, GoQualifiedType>()
    if (receiverName && currentReceiverType) {
      localVarTypes.set(receiverName, currentReceiverType)
    }

    const routerBindings = new Map<string, GoRouterBinding>()

    for (let blockOffset = 0; blockOffset < blockLines.length; blockOffset += 1) {
      const rawLine = blockLines[blockOffset] ?? ''
      const trimmed = rawLine.trim()
      const absoluteLineNumber = lineNumber + blockOffset
      if (!trimmed || trimmed.startsWith('//')) {
        continue
      }

      const explicitVarType = trimmed.match(/^var\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^=]+?)(?:\s*=\s*(.+))?$/)
      if (explicitVarType?.[1] && explicitVarType[2]) {
        const resolvedType = resolveGoQualifiedType(explicitVarType[2].trim(), fileInfo)
        if (resolvedType) {
          localVarTypes.set(explicitVarType[1], resolvedType)
        }
        if (explicitVarType[3]) {
          const literalType = parseGoVarTypeFromCompositeLiteral(explicitVarType[3], fileInfo)
          if (literalType) {
            localVarTypes.set(explicitVarType[1], literalType)
          }
        }
      }

      const assignmentMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=)\s*(.+)$/)
      if (assignmentMatch?.[1] && assignmentMatch[2]) {
        const assignedType = parseGoVarTypeFromCompositeLiteral(assignmentMatch[2], fileInfo)
        if (assignedType) {
          localVarTypes.set(assignmentMatch[1], assignedType)
        }
      }

      const netHttpRouterMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.NewServeMux\(\)$/)
      if (netHttpRouterMatch?.[1] && netHttpRouterMatch[2] && fileInfo.imports.get(netHttpRouterMatch[2])?.importPath === 'net/http') {
        const routerBinding: GoRouterBinding = {
          framework: 'net/http',
          frameworkRole: 'net_http_mux',
          routePrefix: '',
          nodeId: _makeId(fileInfo.packagePath, netHttpRouterMatch[1], 'net_http_mux'),
        }
        routerBindings.set(netHttpRouterMatch[1], routerBinding)
        ensureRouterNode(netHttpRouterMatch[1], routerBinding, absoluteLineNumber)
      }

      const ginRouterMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.(Default|New)\(\)$/)
      if (ginRouterMatch?.[1] && ginRouterMatch[2] && fileInfo.imports.get(ginRouterMatch[2])?.importPath === 'github.com/gin-gonic/gin') {
        const routerBinding: GoRouterBinding = {
          framework: 'gin',
          frameworkRole: 'gin_router',
          routePrefix: '',
          nodeId: _makeId(fileInfo.packagePath, ginRouterMatch[1], 'gin_router'),
        }
        routerBindings.set(ginRouterMatch[1], routerBinding)
        ensureRouterNode(ginRouterMatch[1], routerBinding, absoluteLineNumber)
      }

      const ginGroupMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.Group\((.+)\)$/)
      if (ginGroupMatch?.[1] && ginGroupMatch[2] && ginGroupMatch[3]) {
        const parentBinding = routerBindings.get(ginGroupMatch[2])
        const groupArgs = parseGoCallArguments(ginGroupMatch[3])
        const routePath = trimGoStringLiteral(groupArgs[0] ?? '')
        if (parentBinding?.framework === 'gin' && routePath) {
          const routerBinding: GoRouterBinding = {
            framework: 'gin',
            frameworkRole: 'gin_group',
            routePrefix: joinGoRoutePath(parentBinding.routePrefix, routePath),
            nodeId: _makeId(fileInfo.packagePath, ginGroupMatch[1], 'gin_group', routePath),
          }
          routerBindings.set(ginGroupMatch[1], routerBinding)
          ensureRouterNode(ginGroupMatch[1], routerBinding, absoluteLineNumber)
          addUniqueEdge(edges, existingEdges, createEdge(parentBinding.nodeId, routerBinding.nodeId, 'contains', fileInfo.filePath, absoluteLineNumber))
        }
      }

      const chiRouteGroupMatch = trimmed.match(
        new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\.Route\\((.+),\\s*func\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\.Router`),
      )
      if (chiRouteGroupMatch?.[1] && chiRouteGroupMatch[2] && chiRouteGroupMatch[3] && chiRouteGroupMatch[4]) {
        const parentBinding = routerBindings.get(chiRouteGroupMatch[1])
        const routeArgs = parseGoCallArguments(chiRouteGroupMatch[2])
        const routePath = trimGoStringLiteral(routeArgs[0] ?? '')
        const chiAlias = chiRouteGroupMatch[4]
        if (parentBinding?.framework === 'chi' && routePath && chiImportAliases.has(chiAlias)) {
          const groupBinding: GoRouterBinding = {
            framework: 'chi',
            frameworkRole: 'chi_router',
            routePrefix: joinGoRoutePath(parentBinding.routePrefix, routePath),
            nodeId: _makeId(fileInfo.packagePath, chiRouteGroupMatch[3], 'chi_router', routePath, String(absoluteLineNumber)),
          }
          routerBindings.set(chiRouteGroupMatch[3], groupBinding)
          ensureRouterNode(chiRouteGroupMatch[3], groupBinding, absoluteLineNumber)
          addUniqueEdge(edges, existingEdges, createEdge(parentBinding.nodeId, groupBinding.nodeId, 'contains', fileInfo.filePath, absoluteLineNumber))
        }
      }

      const chiRouterMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.NewRouter\(\)$/)
      if (chiRouterMatch?.[1] && chiRouterMatch[2] && fileInfo.imports.get(chiRouterMatch[2])?.importPath.startsWith('github.com/go-chi/chi')) {
        const routerBinding: GoRouterBinding = {
          framework: 'chi',
          frameworkRole: 'chi_router',
          routePrefix: '',
          nodeId: _makeId(fileInfo.packagePath, chiRouterMatch[1], 'chi_router'),
        }
        routerBindings.set(chiRouterMatch[1], routerBinding)
        ensureRouterNode(chiRouterMatch[1], routerBinding, absoluteLineNumber)
      }

      const chiMountMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\.Mount\((.+)\)$/)
      if (chiMountMatch?.[1] && chiMountMatch[2]) {
        const parentBinding = routerBindings.get(chiMountMatch[1])
        const args = parseGoCallArguments(chiMountMatch[2])
        const mountPath = trimGoStringLiteral(args[0] ?? '')
        const childBindingName = args[1]?.trim()
        if (parentBinding?.framework === 'chi' && mountPath && childBindingName) {
          const childBinding = routerBindings.get(childBindingName)
          if (childBinding) {
            childBinding.routePrefix = joinGoRoutePath(parentBinding.routePrefix, mountPath)
            const childNode = fileNodesById.get(childBinding.nodeId)
            if (childNode) {
              childNode.route_path = childBinding.routePrefix
            }
            for (const routeId of routeIdsByRouterId.get(childBinding.nodeId) ?? []) {
              const routeNode = fileNodesById.get(routeId)
              if (!routeNode || typeof routeNode.route_path !== 'string' || typeof routeNode.http_method !== 'string') {
                continue
              }
              const previousPath = routeNode.route_path
              const nextPath = joinGoRoutePath(childBinding.routePrefix, previousPath)
              routeNode.route_path = nextPath
              routeNode.label = `${routeNode.http_method} ${nextPath}`
            }
            addUniqueEdge(edges, existingEdges, createEdge(parentBinding.nodeId, childBinding.nodeId, 'contains', fileInfo.filePath, absoluteLineNumber))
          }
        }
      }

      const netHttpRouteMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(HandleFunc|Handle)\((.+)\)$/)
      if (netHttpRouteMatch?.[1] && netHttpRouteMatch[3]) {
        const receiverName = netHttpRouteMatch[1]
        const receiverImport = fileInfo.imports.get(receiverName)
        const routerBinding = routerBindings.get(receiverName)
        const args = parseGoCallArguments(netHttpRouteMatch[3])
        const routePath = trimGoStringLiteral(args[0] ?? '')
        const handlerReference = args[1]?.trim()
        if ((routerBinding?.framework === 'net/http' || receiverImport?.importPath === 'net/http') && routePath) {
          const routeId = _makeId(fileInfo.packagePath, 'net_http_route', routePath, String(absoluteLineNumber))
          const routeNode = {
            ...createNode(routeId, `${GO_HTTP_ROUTE_METHOD} ${routePath}`, fileInfo.filePath, absoluteLineNumber),
            framework: 'net/http',
            framework_role: 'net_http_route',
            node_kind: 'route',
            route_path: routePath,
            http_method: GO_HTTP_ROUTE_METHOD,
          } satisfies ExtractionNode
          addNode(extractionNodes, seenNodeIds, routeNode)
          fileNodesById.set(routeId, routeNode)
          addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, routeId, 'declares', fileInfo.filePath, absoluteLineNumber))
          if (routerBinding) {
            addUniqueEdge(edges, existingEdges, createEdge(routerBinding.nodeId, routeId, 'registers_route', fileInfo.filePath, absoluteLineNumber))
          }
          if (handlerReference) {
            const handlerId = resolveGoCallableReference(handlerReference, fileInfo, index, localVarTypes, currentReceiverType)
            if (handlerId && searchableNodeIds.has(handlerId)) {
              const handlerNode = fileNodesById.get(handlerId)
              if (handlerNode) {
                maybeTagNode(handlerNode, {
                  framework: 'net/http',
                  framework_role: 'net_http_handler',
                  node_kind: 'method',
                })
              }
              addUniqueEdge(edges, existingEdges, createEdge(handlerId, routeId, 'handles_route', fileInfo.filePath, absoluteLineNumber))
              addUniqueEdge(edges, existingEdges, createEdge(routeId, handlerId, 'depends_on', fileInfo.filePath, absoluteLineNumber))
            }
          }
        }
      }

      const frameworkRouteMatch = trimmed.match(new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\.(${GO_HTTP_METHOD_PATTERN})\\((.+)\\)$`))
      if (frameworkRouteMatch?.[1] && frameworkRouteMatch[2] && frameworkRouteMatch[3]) {
        const receiverBinding = routerBindings.get(frameworkRouteMatch[1])
        const httpMethod = normalizeGoHttpMethod(frameworkRouteMatch[2])
        if (!receiverBinding || !GO_HTTP_METHODS.has(httpMethod)) {
          continue
        }

        const args = parseGoCallArguments(frameworkRouteMatch[3])
        const routePath = trimGoStringLiteral(args[0] ?? '')
        if (!routePath) {
          continue
        }

        const fullRoutePath = joinGoRoutePath(receiverBinding.routePrefix, routePath)
        const routeId = _makeId(fileInfo.packagePath, receiverBinding.frameworkRole, httpMethod, fullRoutePath, String(absoluteLineNumber))
        const frameworkRole = receiverBinding.framework === 'gin' ? 'gin_route' : 'chi_route'
        const routeNode: ExtractionNode = {
          ...createNode(routeId, `${httpMethod} ${fullRoutePath}`, fileInfo.filePath, absoluteLineNumber),
          framework: receiverBinding.framework,
          framework_role: frameworkRole,
          node_kind: 'route',
          route_path: fullRoutePath,
          http_method: httpMethod,
        }
        addNode(extractionNodes, seenNodeIds, routeNode)
        fileNodesById.set(routeId, routeNode)
        routeIdsByRouterId.set(receiverBinding.nodeId, [...(routeIdsByRouterId.get(receiverBinding.nodeId) ?? []), routeId])
        addUniqueEdge(edges, existingEdges, createEdge(fileNodeId, routeId, 'declares', fileInfo.filePath, absoluteLineNumber))
        addUniqueEdge(edges, existingEdges, createEdge(receiverBinding.nodeId, routeId, 'registers_route', fileInfo.filePath, absoluteLineNumber))

        for (const handlerReference of args.slice(1)) {
          const handlerId = resolveGoCallableReference(handlerReference, fileInfo, index, localVarTypes, currentReceiverType)
          if (!handlerId || !searchableNodeIds.has(handlerId)) {
            continue
          }

          const handlerNode = fileNodesById.get(handlerId)
          if (handlerNode) {
            maybeTagNode(handlerNode, {
              framework: receiverBinding.framework,
              framework_role: receiverBinding.framework === 'gin' ? 'gin_handler' : 'chi_handler',
              node_kind: 'method',
            })
          }
          addUniqueEdge(edges, existingEdges, createEdge(handlerId, routeId, 'handles_route', fileInfo.filePath, absoluteLineNumber))
          addUniqueEdge(edges, existingEdges, createEdge(routeId, handlerId, 'depends_on', fileInfo.filePath, absoluteLineNumber))
        }
      }

      if (!currentFunctionId) {
        continue
      }

      for (const callMatch of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/g)) {
        const reference = callMatch[1]
        if (!reference || GO_KEYWORDS.has(reference)) {
          continue
        }
        if (reference.endsWith('.HandleFunc') || reference.endsWith('.Handle') || /\.Group$/.test(reference) || /\.Mount$/.test(reference)) {
          continue
        }

        const targetId = resolveGoCallableReference(reference, fileInfo, index, localVarTypes, currentReceiverType)
        if (!targetId || targetId === currentFunctionId || !searchableNodeIds.has(targetId)) {
          continue
        }
        addUniqueEdge(edges, existingEdges, createEdge(currentFunctionId, targetId, 'calls', fileInfo.filePath, absoluteLineNumber))
      }
    }

    indexLine = Math.max(indexLine, cursor - 1)
  }
}

function braceDelta(line: string): number {
  return [...line].reduce((total, character) => total + (character === '{' ? 1 : character === '}' ? -1 : 0), 0)
}

export function resolveGoSemantics(
  files: readonly string[],
  extraction: ExtractionData,
  options: ResolveGoSemanticsOptions = {},
): ExtractionData {
  const goFiles = files.map((filePath) => resolve(filePath)).filter((filePath) => extname(filePath).toLowerCase() === '.go')
  if (goFiles.length === 0) {
    return extraction
  }

  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const searchableNodeIds = new Set(searchableNodes.map((node) => node.id))
  const nodes = [...extraction.nodes]
  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))
  const fileInfoCache = new Map<string, GoFileInfo>()
  const index = buildGoNodeIndex(extraction, searchableNodes, fileInfoCache)

  for (const goFile of goFiles) {
    const fileInfo = readGoFileInfo(goFile, fileInfoCache)
    const lines = readFileSync(goFile, 'utf8').split(/\r?\n/)
    analyzeGoFunctions(fileInfo, lines, nodes, edges, existingEdges, searchableNodeIds, index)
  }

  return {
    ...extraction,
    nodes,
    edges,
  }
}
