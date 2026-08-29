import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { formatHelp } from '../../src/cli/main.js'
import { MCP_TOOLS, MCP_PROMPTS } from '../../src/runtime/stdio/definitions.js'

/**
 * #722 — the public support matrix must be true on every active surface.
 *
 * This is an INVENTORY, not a phrase check. It enumerates every declared public
 * surface, renders the ones that are generated rather than written (CLI help,
 * MCP tool and prompt descriptions), and requires the whole corpus to be free of
 * claims the stable profile does not support.
 *
 * Dated records are deliberately excluded and listed explicitly: per-version
 * README release notes, dated CHANGELOG sections and dated benchmark receipts
 * describe what shipped on a date and were true when written. Rewriting them
 * would be the other kind of dishonesty.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** Written surfaces. Every file here must exist, so the inventory cannot silently shrink. */
const WRITTEN_SURFACES = [
  'README.md',
  'docs/auto-refresh.md',
  'docs/reference/cli-and-mcp.md',
  'docs/claims-and-evidence.md',
  'docs/mcp-registry/server.json',
]

/** Surfaces that are generated at runtime and must be rendered, not read. */
function renderedSurfaces(): Record<string, string> {
  return {
    'cli:help': formatHelp(),
    'mcp:tools': MCP_TOOLS.map((t) => `${t.name}\n${t.description ?? ''}`).join('\n\n'),
    'mcp:prompts': MCP_PROMPTS.map((p) => `${p.name}\n${p.description ?? ''}`).join('\n\n'),
  }
}

/**
 * Forward-looking claim families the stable profile does not support. These are
 * families, not one phrasing each: every listed capability gets several
 * spellings, because a single exact phrase is what let the last false README
 * line survive two rounds.
 */
const UNSUPPORTED_CLAIMS: [string, RegExp][] = [
  ['automatic reconciliation', /\b(initial |background |during )?reconcil(e|es|ing|iation)\b/i],
  ['background semantic regeneration', /background (worker|regenerat|rebuild|refresh)/i],
  ['automatic refresh is active', /(automatic|automatically) (refresh|refreshes|refreshed|regenerat)/i],
  ['watch keeps the graph current', /watch(es|ing)? (the |your |that )?(workspace|repo|graph).{0,40}(current|fresh|up to date)/i],
  ['readiness gate / retry protocol', /madar_graph_not_ready|retry_after_ms|retryable/i],
  ['watcher states as live behaviour', /watcher (is |reaches |reports )?(idle|starting|pending|reconciling)/i],
  ['stored-policy reconstruction', /(reuses?|reconstruct(s|ed)?|replay(s|ed)?) .{0,30}(stored |generation )polic/i],
  ['warm incremental reuse', /(warm|incremental) (cache |semantic )?(reuse|hit)|reused the existing graph/i],
  ['changed-file-only extraction', /only (the )?changed files (were |are )?(re-?)?extract/i],
  ['semantic snapshot continuation', /snapshot .{0,30}(continu|reused as current|marked current)/i],
  ['persisted-source federation', /federat(e|es|ed|ion) .{0,40}(graphs?|repos?)\b(?!.*not supported)/i],
]

/** Dated records: true when written, deliberately not rewritten. */
const DATED_RECORD_LINE = /^(`?\d+\.\d+\.\d+`?|## \[\d|\|.*\d{4}-\d{2}-\d{2})/

const DESCRIBES_WITHDRAWAL = /not supported|unsupported|no longer|is withdrawn|withdrawn[.:]|^withdrawn/i

function offendingLines(text: string): { line: string; claim: string }[] {
  const out: { line: string; claim: string }[] = []
  // A list introduced by "Withdrawn:" is naming what was removed. Its items are
  // descriptions, so the introducing line's context carries down the list --
  // otherwise the document that states the withdrawal most plainly is the one
  // this control flags hardest.
  let listContextDescribesWithdrawal = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const isListItem = /^[-*]\s/.test(line)
    // A blank line separates "Withdrawn:" from its list; it must not clear the
    // context, or the introducing line would never reach the items it governs.
    if (!isListItem && line.length > 0) listContextDescribesWithdrawal = DESCRIBES_WITHDRAWAL.test(line)
    if (!line || DATED_RECORD_LINE.test(line)) continue
    // A line that states the withdrawal is describing it, not claiming it.
    if (DESCRIBES_WITHDRAWAL.test(line)) continue
    if (isListItem && listContextDescribesWithdrawal) continue
    for (const [claim, pattern] of UNSUPPORTED_CLAIMS) {
      if (pattern.test(line)) out.push({ line: line.slice(0, 160), claim })
    }
  }
  return out
}

describe('FULL-GENERATE-ONLY public support matrix', () => {
  test('the inventory covers every declared surface', () => {
    for (const surface of WRITTEN_SURFACES) {
      expect(existsSync(join(ROOT, surface)), `DECLARED_SURFACE_MISSING: ${surface}`).toBe(true)
    }
    const rendered = renderedSurfaces()
    for (const [name, text] of Object.entries(rendered)) {
      expect(text.length, `RENDERED_SURFACE_EMPTY: ${name}`).toBeGreaterThan(0)
    }
    // The rendered surfaces must be the real ones, not stubs.
    expect(MCP_TOOLS.length, 'MCP_TOOL_INVENTORY_EMPTY').toBeGreaterThan(10)
    expect(rendered['cli:help'], 'CLI_HELP_NOT_RENDERED').toContain('generate')
  })

  test('no active public surface makes an unsupported claim', () => {
    const surfaces: Record<string, string> = { ...renderedSurfaces() }
    for (const s of WRITTEN_SURFACES) surfaces[s] = read(s)

    const violations: string[] = []
    for (const [name, text] of Object.entries(surfaces)) {
      for (const { line, claim } of offendingLines(text)) {
        violations.push(`${name} [${claim}]: ${line}`)
      }
    }
    expect(violations, `PUBLIC_SUPPORT_MATRIX_FALSE:\n${violations.join('\n')}`).toStrictEqual([])
  })

  test('the supported operations are stated where a reader looks', () => {
    const doc = read('docs/auto-refresh.md').toLowerCase()
    expect(doc, 'POSITION_MISSING').toContain('automatic semantic refresh is not supported in the stable profile')
    expect(doc, 'REMEDY_MISSING').toContain('run ordinary full generation to refresh repository semantics')

    const reference = read('docs/reference/cli-and-mcp.md')
    expect(reference, 'UPDATE_ALIAS_UNDOCUMENTED').toMatch(/--update/)
  })

  test('dated records are preserved rather than rewritten', () => {
    // The withdrawal must be recorded as a change, not applied retroactively.
    const changelog = read('CHANGELOG.md')
    expect(changelog, 'DATED_RELEASE_SECTIONS_REMOVED').toMatch(/## \[0\.32\.1\]/)
    expect(readdirSync(resolve(ROOT, 'docs/benchmarks')).length, 'DATED_RECEIPTS_REMOVED').toBeGreaterThan(0)
  })
})
