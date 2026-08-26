// SPI v1 — diff overlay (slice 3a of #72).
//
// Computed on demand against a base/head ref. Maps each changed line range
// from `git diff` onto the smallest containing SpiSymbol so PR-impact, the
// slicer's review mode (#73), and any future delta-only context-pack work
// (#81) can reason about "what changed" without re-deriving the mapping
// from scratch every call.
//
// Per the SPI v1 design (docs/designs/2026-05-10-spi-v1.md), the diff
// overlay is intentionally NOT part of the persisted SemanticProgramIndex —
// it varies with `git rev-parse`. Callers compute it explicitly when they
// need it.
//
// Uses execFileSync from node:child_process to run git, mirroring the same
// pattern the existing pipeline uses in src/runtime/pr-impact.ts and
// src/infrastructure/time-travel.ts. execFileSync with args-as-array is
// safe against shell injection by design.

import { execFileSync } from 'node:child_process'

import { compareUnicodeCodePoints } from '../../contracts/canonical-json.js'

import type {
  SemanticProgramIndex,
  SpiDiffOverlay,
  SpiEdge,
  SpiRange,
} from './types.js'

export type GitDiffRunner = (args: ReadonlyArray<string>, cwd: string) => string

export type ComputeSpiDiffOverlayOptions = {
  spi: SemanticProgramIndex
  root: string
  baseRef: string
  headRef?: string
  // Test-only injection point. Production callers pass nothing; the default
  // runs `git diff --unified=0 --no-color baseRef headRef` via execFileSync.
  runGitDiff?: GitDiffRunner
}

export function computeSpiDiffOverlay(opts: ComputeSpiDiffOverlayOptions): SpiDiffOverlay {
  const baseRef = opts.baseRef
  const headRef = opts.headRef ?? 'HEAD'
  const runner = opts.runGitDiff ?? defaultGitDiffRunner

  let diffText = ''
  try {
    diffText = runner(
      ['diff', '--unified=0', '--no-color', '--no-prefix', baseRef, headRef, '--'],
      opts.root,
    )
  } catch {
    // `git diff` may fail (uninitialized repo, unknown ref, etc.). Honest
    // empty overlay rather than throwing — callers can detect "nothing
    // changed" the same way as a clean working tree.
    return emptyOverlay(baseRef, headRef)
  }

  const fileChanges = parseUnifiedDiff(diffText)

  const fileById = new Map(opts.spi.files.map((f) => [f.path, f] as const))
  const symbolsByFileId = new Map<string, SemanticProgramIndex['symbols']>()
  for (const symbol of opts.spi.symbols) {
    const list = symbolsByFileId.get(symbol.file_id)
    if (list) list.push(symbol)
    else symbolsByFileId.set(symbol.file_id, [symbol])
  }

  const changedFiles = new Set<string>()
  const changedSymbols = new Set<string>()
  const edgesAdded: SpiEdge[] = []

  for (const change of fileChanges) {
    const file = fileById.get(change.path)
    if (!file) continue
    changedFiles.add(file.id)
    const fileSymbols = symbolsByFileId.get(file.id) ?? []
    for (const range of change.ranges) {
      for (const symbol of fileSymbols) {
        if (!lineOverlaps(symbol.range, range.startLine, range.endLine)) continue
        if (changedSymbols.has(symbol.id)) continue
        changedSymbols.add(symbol.id)
        edgesAdded.push({
          from: symbol.id,
          to: file.id,
          kind: 'changed_in',
          confidence: 'high',
          source: 'typescript-syntactic',
          evidence: { file_id: file.id, range: symbol.range },
        })
      }
    }
  }

  return {
    base_ref: baseRef,
    head_ref: headRef,
    changed_files: [...changedFiles].sort(),
    changed_symbols: [...changedSymbols].sort(),
    // Code point, not collation. The overlay is not persisted, but it sorts the
    // same `from|to|kind` key as the SPI's own edge ordering, and symbol ids
    // embed source identifiers -- so a host-dependent comparator here would make
    // one member of that key's family disagree with the rest for no reason.
    edges_added: edgesAdded.sort((a, b) => compareUnicodeCodePoints(
      `${a.from}|${a.to}|${a.kind}`,
      `${b.from}|${b.to}|${b.kind}`,
    )),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

type FileChange = {
  path: string
  ranges: Array<{ startLine: number; endLine: number }>
}

function defaultGitDiffRunner(args: ReadonlyArray<string>, cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    // 64 MB caps the worst-case "diff --unified=0" output size; well above
    // anything a normal PR produces and below the default Node heap limit.
    maxBuffer: 64 * 1024 * 1024,
  })
}

function emptyOverlay(baseRef: string, headRef: string): SpiDiffOverlay {
  return { base_ref: baseRef, head_ref: headRef, changed_files: [], changed_symbols: [], edges_added: [] }
}

function parseUnifiedDiff(diff: string): FileChange[] {
  const result: FileChange[] = []
  let current: FileChange | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim()
      if (raw === '/dev/null') {
        current = null
        continue
      }
      // With --no-prefix git emits paths verbatim; without it we strip the
      // conventional `b/` prefix. Handle both.
      const path = raw.startsWith('b/') ? raw.slice(2) : raw
      current = { path, ranges: [] }
      result.push(current)
    } else if (line.startsWith('@@') && current) {
      // Format: @@ -OLD_START[,OLD_COUNT] +NEW_START[,NEW_COUNT] @@ optional context
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) continue
      const start = Number.parseInt(match[1] ?? '0', 10)
      const count = match[2] ? Number.parseInt(match[2], 10) : 1
      // count === 0 means "lines were removed, no new content" — no head-side
      // range to map; skip.
      if (count > 0 && start > 0) {
        current.ranges.push({ startLine: start, endLine: start + count - 1 })
      }
    }
  }
  return result
}

function lineOverlaps(range: SpiRange, startLine: number, endLine: number): boolean {
  return range.start.line <= endLine && range.end.line >= startLine
}
