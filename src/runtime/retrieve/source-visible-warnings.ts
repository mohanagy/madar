import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { ContextPackSourceDependencies } from '../../contracts/context-pack.js'
import { classifySourceDomain } from '../../shared/source-discovery.js'
import { extractPromptExclusions } from '../retrieval-gate.js'
import { compileSourceExclusions } from '../source-exclusions.js'
import { readVerifiedSourceSnapshot } from '../source-continuation.js'
import { sourcePathForEvidence } from './source-evidence.js'
import { renderSourceFragment } from './source-fragments.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './source-modules.js'
import type { SourceSelectionProvenance } from './source-selection-provenance.js'

type Range = { start_line: number; end_line: number }
interface SourceNode {
  source_file: string
  label?: string
  snippet: string | null
  snippet_unverified?: boolean
  snippet_line_range?: Range
  snippet_omitted_ranges?: Range[]
}
const hash = (lines: readonly string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex')
const contains = (range: Range, line: number): boolean => range.start_line <= line && line <= range.end_line
const validRange = (range: Range): boolean => Number.isSafeInteger(range?.start_line) && Number.isSafeInteger(range?.end_line)
  && range.start_line > 0 && range.end_line >= range.start_line

/** A class/file excerpt can expose calls attributed to a contained method that
 * was never admitted to the dependency closure. Report its inspected warnings
 * only when the complete inspected owner is physically present in authenticated
 * source. A visible first line alone does not prove a multiline call is shown.
 * This changes diagnostics, never seeds, dependency membership or call edges. */
export function sourceVisibleWarnings(
  receipt: ContextPackSourceDependencies, provenance: SourceSelectionProvenance | undefined,
  nodes: readonly SourceNode[], rootPath: string | undefined, prompt: string,
): ContextPackSourceDependencies {
  if (!rootPath || !provenance || provenance.root_path !== resolve(rootPath) || nodes.length > 128
    || provenance.unresolved.length > 8192) return receipt
  const selected = new Set(provenance.selected_ids)
  const reasons = new Set(['unresolved', 'external', 'no_implementation', 'outside_index', 'limit'])
  const possible = provenance.unresolved.filter(call => call.relation === 'calls' && !selected.has(call.from_id)
    && reasons.has(call.reason) && Number.isSafeInteger(call.line_number) && call.line_number > 0
    && nodes.some(node => resolve(rootPath, node.source_file) === resolve(rootPath, call.source_file)
      && node.snippet_line_range && contains(node.snippet_line_range, call.line_number)))
  if (!possible.length) return receipt
  const exclusion = extractPromptExclusions(prompt)
  const policy = compileSourceExclusions(exclusion.excludedTerms, exclusion.excludedPathHints, rootPath)
  const allowed = (file: string, canonical?: string): boolean => policy.valid && [file, ...(canonical ? [canonical] : [])]
    .every(path => !policy.matchesPath(path, rootPath)
      && !exclusion.excludedDomains.includes(classifySourceDomain(path, rootPath) as never))
  // The resolver creates no configuration snapshot when it never sees an
  // import. Accept that case only with a complete program and an independently
  // checked absence of imports in every authenticated program input below.
  const configurationFresh = (): boolean => provenance.configuration
    ? sourceModuleConfigurationSnapshotIsFresh(provenance.configuration, rootPath, allowed)
    : provenance.scans.program === 'complete'
  if (!configurationFresh()) return receipt
  const inputs = provenance.sources.filter(source => source.in_program)
  if (!inputs.length || inputs.length > 32) return receipt
  const files = new Map<string, { snapshot: ReturnType<typeof readVerifiedSourceSnapshot>; lines: string[]; hash: string; starts: number[] }>()
  let bytes = 0
  for (const input of inputs) {
    if (!allowed(input.source_file)) return receipt
    const expectedCanonical = sourcePathForEvidence(input.source_file, rootPath)
    if (!expectedCanonical || expectedCanonical !== input.canonical_file || !allowed(input.source_file, expectedCanonical)) return receipt
    let snapshot: ReturnType<typeof readVerifiedSourceSnapshot>
    try { snapshot = readVerifiedSourceSnapshot(input.source_file, rootPath) } catch { return receipt }
    const { lines, canonical } = snapshot
    if (!allowed(input.source_file, canonical) || canonical !== expectedCanonical
      || (bytes += snapshot.readBytes) > 1024 * 1024 || hash(lines) !== input.source_sha256) return receipt
    if (!provenance.configuration && ts.preProcessFile(lines.join('\n'), true, true).importedFiles.length) return receipt
    let offset = 0
    const starts = lines.map(line => { const start = offset; offset += line.length + 1; return start })
    files.set(resolve(rootPath, input.source_file), { snapshot, lines, starts, hash: input.source_sha256 })
  }
  const visible = new Map<string, Range[]>()
  for (const node of nodes) {
    const file = resolve(rootPath, node.source_file), source = files.get(file), range = node.snippet_line_range
    if (!source || typeof node.snippet !== 'string' || node.snippet_unverified || !range || !validRange(range)
      || range.end_line > source.lines.length || policy.matchesText(node.snippet)
      || node.label !== undefined && policy.matchesLabel(node.label)) continue
    const gaps = node.snippet_omitted_ranges ?? []
    if (gaps.length > 4096 || gaps.some((gap, index) => !validRange(gap) || gap.start_line < range.start_line
      || gap.end_line > range.end_line || index > 0 && gap.start_line <= gaps[index - 1]!.end_line)) continue
    const retained: Range[] = []
    let cursor = range.start_line
    for (const gap of gaps) {
      if (cursor < gap.start_line) retained.push({ start_line: cursor, end_line: gap.start_line - 1 })
      cursor = gap.end_line + 1
    }
    if (cursor <= range.end_line) retained.push({ start_line: cursor, end_line: range.end_line })
    const owner = { start: range.start_line, end: range.end_line }
    const rendered = renderSourceFragment(source.lines, owner, { sourceHash: source.hash, range: owner, retained })
    if (!rendered || rendered.snippet !== node.snippet) continue
    visible.set(file, [...(visible.get(file) ?? []), ...retained])
  }
  const owners = new Map(provenance.owners.filter(owner => owner.status === 'unique').map(owner => [owner.node_id, owner]))
  const additional = possible.filter(call => {
    const file = resolve(rootPath, call.source_file), owner = owners.get(call.from_id), ranges = visible.get(file), source = files.get(file)
    if (!owner || !ranges || !source || resolve(rootPath, owner.source_file) !== file) return false
    const offsets = owner.declaration_offsets
    const length = source.starts.at(-1)! + source.lines.at(-1)!.length
    if (!offsets || !Number.isSafeInteger(offsets.start) || !Number.isSafeInteger(offsets.end)
      || offsets.start < 0 || offsets.end <= offsets.start || offsets.end > length) return false
    const lineAt = (offset: number): number => {
      let low = 0, high = source.starts.length - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (source.starts[middle]! <= offset) low = middle
        else high = middle - 1
      }
      return low + 1
    }
    // Indexed owners may be point locations. Only the inspected declaration
    // offsets establish the complete body that must be visible here.
    const range = { start_line: lineAt(offsets.start), end_line: lineAt(offsets.end - 1) }
    if (!validRange(range) || !contains(range, call.line_number)) return false
    let cursor = range.start_line
    for (const part of [...ranges].sort((a, b) => a.start_line - b.start_line)) {
      if (part.start_line > cursor) break
      if (part.end_line >= cursor) cursor = part.end_line + 1
      if (cursor > range.end_line) return true
    }
    return false
  })
  if (!additional.length) return receipt
  // Recheck all binding inputs, including undisplayed files, before exposing
  // observations from the earlier scan. A disagreement retains the old receipt.
  for (const input of inputs) {
    const source = files.get(resolve(rootPath, input.source_file))!
    const canonical = sourcePathForEvidence(input.source_file, rootPath)
    if (canonical !== source.snapshot.canonical || !allowed(input.source_file, canonical)) return receipt
    let current: ReturnType<typeof readVerifiedSourceSnapshot>
    try { current = readVerifiedSourceSnapshot(input.source_file, rootPath) } catch { return receipt }
    if (!allowed(input.source_file, current.canonical) || current.canonical !== source.snapshot.canonical
      || current.realRoot !== source.snapshot.realRoot || current.hash !== source.snapshot.hash
      || current.policyFingerprint !== source.snapshot.policyFingerprint || hash(current.lines) !== source.hash) return receipt
  }
  if (!configurationFresh()) return receipt
  const examples = additional.map(call => ({ source_file: call.source_file, line_number: call.line_number,
    callee: call.callee, reason: call.reason as NonNullable<ContextPackSourceDependencies['unresolved']>[number]['reason'] }))
  return { ...receipt, unresolved_calls: receipt.unresolved_calls + additional.length,
    // Prior closure observations remain counted. Prefer warnings tied to newly
    // displayed source, retaining the existing eight-example output bound.
    unresolved: [...examples, ...(receipt.unresolved ?? [])].slice(0, 8) }
}
