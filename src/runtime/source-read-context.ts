import ts from 'typescript'

import { readEvidenceLines } from './retrieve/source-evidence.js'

type SourceNode = Record<string, unknown>
export interface CompleteSourceFile {
  source_file: string
  owner_index: number
  snippet: string
  end_line: number
}

/** Complete already delivered small files by filling only imports and whitespace.
 * No ranking expansion, sibling declarations, or inferred dependency bodies.
 */
export function completeSourceFileCandidates(nodes: readonly SourceNode[], rootPath: string): CompleteSourceFile[] {
  const files = [...new Set(nodes.map(node => node.source_file).filter((file): file is string => typeof file === 'string'))].slice(0, 16)
  const result: CompleteSourceFile[] = []
  for (const sourceFile of files) {
    if (!/\.[cm]?[jt]sx?$/i.test(sourceFile)) continue
    const lines = readEvidenceLines(sourceFile, rootPath)
    if (!lines || lines.length > 80) continue
    const text = lines.join('\n')
    if (text.length > 12_000) continue
    const selected = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.source_file === sourceFile)
    const covered = new Uint8Array(text.length)
    const offsets = [0]
    for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
    let valid = true
    for (const { node } of selected) {
      const range = node.snippet_line_range as { start_line?: unknown; end_line?: unknown } | undefined
      const start = Number(range?.start_line), end = Number(range?.end_line)
      if (typeof node.snippet !== 'string' || node.snippet_source === 'derived' || node.snippet_unverified === true || node.snippet_truncated === true
        || (Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0)
        || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length
        || lines.slice(start - 1, end).join('\n') !== node.snippet) { valid = false; break }
      covered.fill(1, offsets[start - 1]!, Math.min(text.length, offsets[end]!))
    }
    if (!valid) continue
    const source = ts.createSourceFile(sourceFile, text, ts.ScriptTarget.Latest, true)
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) continue
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
        covered.fill(1, statement.getStart(source), statement.getEnd())
      }
    }
    // Character positions prevent an import from admitting unrelated same-line code.
    for (let index = 0; index < text.length; index++) {
      if (!covered[index] && /\S/.test(text[index]!)) { valid = false; break }
    }
    if (valid) result.push({ source_file: sourceFile, owner_index: selected[0]!.index, snippet: text, end_line: lines.length })
  }
  return result
}
