import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { sanitizeLabel } from '../../shared/security.js'
import { _makeId, addNode, addUniqueEdge, createEdge, createNode, fileNodeIdForPath, fileStemForPath, indentationLevel } from './core.js'

const MAX_PYTHON_DOCSTRING_LINES = 100
const MAX_PYTHON_DOCSTRING_BYTES = 64 * 1024
const PYTHON_RATIONALE_COMMENT_PATTERN = /^#\s*(NOTE|WHY|IMPORTANT|HACK|RATIONALE|TODO|FIXME)\s*:?\s*(.+)$/i

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

function compactRationaleText(text: string): string {
  return sanitizeLabel(text.replace(/\s+/g, ' ').trim())
}

function pythonDocstringStart(trimmedLine: string): { delimiter: '"""' | "'''"; content: string } | null {
  const match = trimmedLine.match(/^(?:[rRuUbBfF]{0,3})("""|''')([\s\S]*)$/)
  if (!match?.[1]) {
    return null
  }

  const delimiter = match[1] === '"""' ? '"""' : "'''"
  return {
    delimiter,
    content: match[2] ?? '',
  }
}

function consumePythonDocstring(lines: string[], startIndex: number, minIndent: number): { text: string; startIndex: number; endIndex: number } | null {
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    if (indentationLevel(line) < minIndent) {
      return null
    }

    const start = pythonDocstringStart(trimmed)
    if (!start) {
      return null
    }

    const parts: string[] = []
    const singleLineCloseIndex = start.content.indexOf(start.delimiter)
    if (singleLineCloseIndex >= 0) {
      const text = compactRationaleText(start.content.slice(0, singleLineCloseIndex))
      if (!text) {
        return null
      }

      return {
        text,
        startIndex: index,
        endIndex: index,
      }
    }

    let totalDocstringBytes = 0
    if (start.content.length > 0) {
      totalDocstringBytes += Buffer.byteLength(start.content, 'utf8')
      if (totalDocstringBytes > MAX_PYTHON_DOCSTRING_BYTES) {
        return null
      }
      parts.push(start.content)
    }

    let endIndex = index
    for (let cursor = index + 1; cursor < lines.length && cursor - index <= MAX_PYTHON_DOCSTRING_LINES; cursor += 1) {
      const nextLine = lines[cursor] ?? ''
      totalDocstringBytes += Buffer.byteLength(nextLine, 'utf8')
      if (totalDocstringBytes > MAX_PYTHON_DOCSTRING_BYTES) {
        break
      }

      const closeIndex = nextLine.indexOf(start.delimiter)
      if (closeIndex >= 0) {
        parts.push(nextLine.slice(0, closeIndex))
        endIndex = cursor
        break
      }

      parts.push(nextLine)
    }

    if (endIndex === index) {
      return null
    }

    const text = compactRationaleText(parts.join(' '))
    if (!text) {
      return null
    }

    return {
      text,
      startIndex: index,
      endIndex,
    }
  }

  return null
}

function createRationaleNode(targetId: string, text: string, sourceFile: string, line: number, rationaleKind: 'docstring' | 'comment'): ExtractionNode {
  return {
    ...createNode(_makeId(targetId, 'rationale', String(line)), text, sourceFile, line, 'rationale'),
    rationale_kind: rationaleKind,
  }
}

export function extractPythonRationale(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenEdges = new Set<string>()
  const skippedLines = new Set<number>()
  const classStack: Array<{ indent: number; id: string }> = []
  const functionStack: Array<{ indent: number; id: string }> = []

  const addRationale = (targetId: string, text: string, line: number, rationaleKind: 'docstring' | 'comment'): void => {
    const cleaned = compactRationaleText(text)
    if (!cleaned) {
      return
    }

    const node = createRationaleNode(targetId, cleaned, filePath, line, rationaleKind)
    addNode(nodes, seenIds, node)
    addUniqueEdge(edges, seenEdges, createEdge(node.id, targetId, 'rationale_for', filePath, line))
  }

  const moduleDocstring = consumePythonDocstring(lines, 0, 0)
  if (moduleDocstring) {
    addRationale(fileNodeId, moduleDocstring.text, moduleDocstring.startIndex + 1, 'docstring')
    for (let index = moduleDocstring.startIndex; index <= moduleDocstring.endIndex; index += 1) {
      skippedLines.add(index)
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (skippedLines.has(index)) {
      continue
    }

    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const indent = indentationLevel(line)
    while (functionStack.length > 0 && indent <= (functionStack[functionStack.length - 1]?.indent ?? -1)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? -1)) {
      classStack.pop()
    }

    const commentMatch = trimmed.match(PYTHON_RATIONALE_COMMENT_PATTERN)
    if (commentMatch?.[1] && commentMatch[2]) {
      const prefix = commentMatch[1].toUpperCase()
      const targetId = functionStack[functionStack.length - 1]?.id ?? classStack[classStack.length - 1]?.id ?? fileNodeId
      addRationale(targetId, `${prefix}: ${commentMatch[2].trim()}`, index + 1, 'comment')
      continue
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
    if (classMatch?.[1]) {
      const classId = _makeId(stem, classMatch[1])
      classStack.push({ indent, id: classId })

      const docstring = consumePythonDocstring(lines, index + 1, indent + 1)
      if (docstring) {
        addRationale(classId, docstring.text, docstring.startIndex + 1, 'docstring')
        for (let cursor = docstring.startIndex; cursor <= docstring.endIndex; cursor += 1) {
          skippedLines.add(cursor)
        }
      }
      continue
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (functionMatch?.[1]) {
      const parentClassId = classStack[classStack.length - 1]?.id
      const functionId = parentClassId ? _makeId(parentClassId, functionMatch[1]) : _makeId(stem, functionMatch[1])
      functionStack.push({ indent, id: functionId })

      const docstring = consumePythonDocstring(lines, index + 1, indent + 1)
      if (docstring) {
        addRationale(functionId, docstring.text, docstring.startIndex + 1, 'docstring')
        for (let cursor = docstring.startIndex; cursor <= docstring.endIndex; cursor += 1) {
          skippedLines.add(cursor)
        }
      }
    }
  }

  return { nodes, edges }
}
