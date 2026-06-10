import { basename, extname } from 'node:path'
import { readFileSync } from 'node:fs'

import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { addPendingCall, addResolvedCalls, braceDelta, normalizeImportTarget, type PendingCall } from './call-resolution.js'
import { _makeId, addEdge, addNode, createEdge, createNode, fileNodeIdForPath, fileStemForPath, stripHashComment } from './core.js'

const GENERIC_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'throw', 'sizeof', 'case', 'do', 'else'])
const MAX_GENERIC_BASE_TARGETS = 10

function stripGenericSegments(value: string): string {
  let depth = 0
  let result = ''

  for (const character of value) {
    if (character === '<') {
      depth += 1
      continue
    }
    if (character === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) {
      result += character
    }
  }

  return result
}

export function normalizeTypeName(raw: string): string | null {
  const withoutGenerics = stripGenericSegments(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bwhere\b[\s\S]*$/, ' ')
    .replace(/[{}]/g, ' ')
    .replace(
      /\b(?:public|private|protected|internal|open|sealed|abstract|final|static|virtual|override|implements|extends|with|class|interface|struct|enum|trait|protocol|object|extension|partial|readonly|required|unsafe|new)\b/g,
      ' ',
    )
    .trim()
  if (!withoutGenerics) {
    return null
  }

  const token = withoutGenerics.split(/\s+/).at(-1) ?? withoutGenerics
  const parts = token.split(/::|\.|:/).filter(Boolean)
  return parts.at(-1) ?? null
}

function parseBaseTypeList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => normalizeTypeName(value))
    .filter((value): value is string => Boolean(value))
}

function genericBaseNamesFromLine(line: string): string[] {
  const trimmed = stripHashComment(line)
    .replace(/\{.*$/, '')
    .replace(/\bwhere\b[\s\S]*$/, '')
    .trim()
  const bases: string[] = []
  const extendsMatch = trimmed.match(/\bextends\s+(.+)$/)

  if (extendsMatch?.[1]) {
    const afterExtends = extendsMatch[1]
    const [primaryBase] = afterExtends.split(/\b(?:implements|with)\b/, 1)
    if (primaryBase) {
      bases.push(...parseBaseTypeList(primaryBase))
    }

    const implementsMatch = afterExtends.match(/\bimplements\s+(.+)$/)
    if (implementsMatch?.[1]) {
      bases.push(...parseBaseTypeList(implementsMatch[1]))
    }

    for (const withSegment of afterExtends.split(/\bwith\b/).slice(1)) {
      bases.push(...parseBaseTypeList(withSegment))
    }
  } else {
    const colonMatch = trimmed.match(/\b(?:class|interface|struct|enum|trait|protocol|object|extension)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>]+>)?\s*:\s*(.+)$/)
    if (colonMatch?.[1]) {
      bases.push(...parseBaseTypeList(colonMatch[1]))
    }

    const implementsMatch = trimmed.match(/\bimplements\s+(.+)$/)
    if (implementsMatch?.[1]) {
      bases.push(...parseBaseTypeList(implementsMatch[1]))
    }
  }

  return [...new Set(bases)].slice(0, MAX_GENERIC_BASE_TARGETS)
}

function genericContinuationBaseNamesFromLine(line: string): string[] {
  const trimmed = stripHashComment(line)
    .replace(/\{.*$/, '')
    .replace(/\bwhere\b[\s\S]*$/, '')
    .trim()

  if (!trimmed) {
    return []
  }

  if (/^with\b/.test(trimmed)) {
    return parseBaseTypeList(trimmed.replace(/^with\b/, ' '))
  }

  if (/^implements\b/.test(trimmed)) {
    return parseBaseTypeList(trimmed.replace(/^implements\b/, ' '))
  }

  if (trimmed.startsWith(',')) {
    return parseBaseTypeList(trimmed.slice(1))
  }

  return []
}

function inlineBodyTextFromSignature(line: string): string | undefined {
  const equalsIndex = line.indexOf('=')
  if (equalsIndex >= 0) {
    const inlineBodyText = line.slice(equalsIndex + 1).trim()
    return inlineBodyText || undefined
  }

  const openBraceIndex = line.indexOf('{')
  if (openBraceIndex >= 0) {
    const inlineBodyText = line
      .slice(openBraceIndex + 1)
      .replace(/\}\s*$/, '')
      .trim()
    return inlineBodyText || undefined
  }

  return undefined
}

function lightweightFunctionSignature(line: string): { functionName: string; inlineBodyText?: string } | null {
  const kotlinMatch = line.match(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^={]+)?(?:\s*[={].*)?$/)
  if (kotlinMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: kotlinMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  const scalaMatch = line.match(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*\([^)]*\)\s*(?::\s*[^={]+)?(?:\s*[={].*)?$/)
  if (scalaMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: scalaMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  const swiftMatch = line.match(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?:->\s*[^={]+)?(?:\s*[={].*)?$/)
  if (swiftMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: swiftMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  return null
}

function genericImportTarget(line: string): string | null {
  const includeMatch = line.match(/^#include\s+[<"]([^>"]+)[>"]/)
  if (includeMatch?.[1]) {
    return includeMatch[1]
  }

  const zigImportMatch = line.match(/@import\(["']([^"']+)["']\)/)
  if (zigImportMatch?.[1]) {
    return zigImportMatch[1]
  }

  const useMatch = line.match(/^(?:import|use)\s+([^;]+);?$/)
  if (useMatch?.[1]) {
    return useMatch[1].replace(/^static\s+/, '').trim()
  }

  return null
}

function classNameFromLine(line: string): string | null {
  const goStructMatch = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/)
  if (goStructMatch?.[1]) {
    return goStructMatch[1]
  }

  const zigStructMatch = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*struct\b/)
  if (zigStructMatch?.[1]) {
    return zigStructMatch[1]
  }

  const implForMatch = line.match(/^impl(?:\s*<[^>]+>)?\s+[A-Za-z_][A-Za-z0-9_:<>]*\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (implForMatch?.[1]) {
    return implForMatch[1]
  }

  const implMatch = line.match(/^(?:impl|extension)\s+(?:<[^>]+>\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (implMatch?.[1]) {
    return implMatch[1]
  }

  const genericMatch = line.match(/\b(class|interface|struct|enum|trait|protocol|object)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
  return genericMatch?.[2] ?? null
}

function qualifiedMethodDefinition(line: string): { ownerName: string; functionName: string } | null {
  const match = line.match(/(?:^|[\s*&<>,:])(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\b)?\s*(?:\{|=>)/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  return {
    ownerName: match[1],
    functionName: match[2],
  }
}

function ownerIdFromName(stem: string, ownerName: string | undefined): string | undefined {
  return ownerName ? _makeId(stem, ownerName) : undefined
}

function addGenericCallsFromText(
  text: string,
  callerId: string,
  lineNumber: number,
  pendingCalls: PendingCall[],
  preferredClassId: string | undefined,
  stem: string,
): void {
  for (const match of text.matchAll(/\b(?:self|this)\s*(?:\.|->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    if (!calleeName) {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber, preferredClassId })
  }

  for (const match of text.matchAll(/\b(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const ownerName = match[1]
    const calleeName = match[2]
    if (!ownerName || !calleeName) {
      continue
    }

    addPendingCall(pendingCalls, {
      callerId,
      calleeName,
      line: lineNumber,
      preferredClassId: ownerIdFromName(stem, ownerName),
    })
  }

  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    const matchIndex = match.index ?? -1
    const previousCharacter = matchIndex > 0 ? text[matchIndex - 1] : ''
    if (!calleeName || GENERIC_CONTROL_KEYWORDS.has(calleeName) || previousCharacter === '.' || previousCharacter === ':' || previousCharacter === '>') {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber, preferredClassId })
  }

  for (const match of text.matchAll(/(?:\.|::|->)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    if (!calleeName) {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber })
  }
}

function ensureGenericOwnerNode(
  className: string,
  stem: string,
  filePath: string,
  lineNumber: number,
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
): string {
  const classId = _makeId(stem, className)
  addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
  addEdge(edges, createEdge(_makeId(stem), classId, 'contains', filePath, lineNumber))
  return classId
}

export function extractGenericCode(filePath: string): ExtractionData {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let braceDepth = 0
  const classStack: Array<{ braceDepth: number; id: string; name: string }> = []
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []
  let pendingClassDeclaration: { id: string; name: string } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && braceDepth < (classStack[classStack.length - 1]?.braceDepth ?? 0)) {
      classStack.pop()
    }

    const importTarget = genericImportTarget(trimmed)
    if (importTarget) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importTarget)), 'imports_from', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    const className = classNameFromLine(trimmed)
    const continuationBaseNames = pendingClassDeclaration && !className ? genericContinuationBaseNamesFromLine(trimmed) : []
    if (pendingClassDeclaration && !className) {
      for (const baseName of continuationBaseNames) {
        const baseId = _makeId(stem, baseName)
        addNode(nodes, seenIds, createNode(baseId, baseName, filePath, lineNumber))
        addEdge(edges, createEdge(pendingClassDeclaration.id, baseId, 'inherits', filePath, lineNumber))
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      const opensPendingClassBody = trimmed === '{' || (continuationBaseNames.length > 0 && trimmed.includes('{'))
      if (opensPendingClassBody) {
        classStack.push({
          braceDepth: Math.max(nextBraceDepth, braceDepth + 1),
          id: pendingClassDeclaration.id,
          name: pendingClassDeclaration.name,
        })
        pendingClassDeclaration = null
        braceDepth = nextBraceDepth
        continue
      }

      if (continuationBaseNames.length > 0) {
        braceDepth = nextBraceDepth
        continue
      }
    }

    if (className) {
      const classId = _makeId(stem, className)
      const parentOwnerId = classStack[classStack.length - 1]?.id ?? fileNodeId
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(parentOwnerId, classId, 'contains', filePath, lineNumber))

      for (const baseName of genericBaseNamesFromLine(trimmed)) {
        const baseId = _makeId(stem, baseName)
        addNode(nodes, seenIds, createNode(baseId, baseName, filePath, lineNumber))
        addEdge(edges, createEdge(classId, baseId, 'inherits', filePath, lineNumber))
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{') || /\bstruct\b/.test(trimmed)) {
        classStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: classId, name: className })
      } else {
        pendingClassDeclaration = { id: classId, name: className }
      }

      braceDepth = nextBraceDepth
      continue
    }

    let functionName: string | null = null
    let ownerClassId: string | undefined
    let inlineBodyText: string | undefined
    const currentClass = classStack[classStack.length - 1]

    const goMethodMatch = trimmed.match(/^func\s*\([^)]*\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (goMethodMatch?.[1] && goMethodMatch[2]) {
      const ownerName = goMethodMatch[1]
      functionName = goMethodMatch[2]
      ownerClassId = ensureGenericOwnerNode(ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
    } else {
      const qualifiedMethod = qualifiedMethodDefinition(trimmed)
      const constructorMatch = currentClass
        ? trimmed.match(new RegExp(`^(?:public|private|protected|internal|static|final|open|override|virtual|abstract|\\s)*${currentClass.name}\\s*\\(`))
        : null
      const specialSignature = lightweightFunctionSignature(trimmed)
      if (qualifiedMethod) {
        functionName = qualifiedMethod.functionName
        ownerClassId = ensureGenericOwnerNode(qualifiedMethod.ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
      } else if (specialSignature) {
        functionName = specialSignature.functionName
        ownerClassId = currentClass?.id
        inlineBodyText = specialSignature.inlineBodyText
      } else if (constructorMatch && currentClass) {
        functionName = currentClass.name
        ownerClassId = currentClass.id
      } else {
        const zigFunctionMatch = trimmed.match(/^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
        if (zigFunctionMatch?.[1] && trimmed.includes('{')) {
          functionName = zigFunctionMatch[1]
          ownerClassId = currentClass?.id
        } else {
          const genericFunctionMatch = trimmed.match(/([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\b)?\s*(?:\{|=>)/)
          if (genericFunctionMatch?.[1]) {
            const candidate = genericFunctionMatch[1]
            if (!GENERIC_CONTROL_KEYWORDS.has(candidate) && candidate !== 'import' && candidate !== 'use') {
              functionName = candidate
              ownerClassId = currentClass?.id
            }
          }
        }
      }
    }

    if (functionName) {
      const effectiveOwnerClassId = ownerClassId ?? pendingClassDeclaration?.id
      const functionId = effectiveOwnerClassId ? _makeId(effectiveOwnerClassId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${effectiveOwnerClassId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(effectiveOwnerClassId ?? fileNodeId, functionId, effectiveOwnerClassId ? 'method' : 'contains', filePath, lineNumber))
      if (effectiveOwnerClassId) {
        methodIdsByClass.set(`${effectiveOwnerClassId}:${functionName.toLowerCase()}`, functionId)
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        functionStack.push({
          braceDepth: Math.max(nextBraceDepth, braceDepth + 1),
          id: functionId,
          ...(effectiveOwnerClassId ? { classId: effectiveOwnerClassId } : {}),
        })
      }

      if (inlineBodyText && inlineBodyText.trim()) {
        addGenericCallsFromText(inlineBodyText, functionId, lineNumber, pendingCalls, effectiveOwnerClassId, stem)
      } else {
        const inlineBodyIndex = trimmed.indexOf('=>') >= 0 ? trimmed.indexOf('=>') + 2 : trimmed.indexOf('{') >= 0 ? trimmed.indexOf('{') + 1 : -1
        if (inlineBodyIndex >= 0) {
          addGenericCallsFromText(trimmed.slice(inlineBodyIndex), functionId, lineNumber, pendingCalls, effectiveOwnerClassId, stem)
        }
      }

      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      addGenericCallsFromText(trimmed, currentFunction.id, lineNumber, pendingCalls, currentFunction.classId, stem)
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}
