import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { readGeneratedGraphJson } from './helpers/generated-graph.js'

/**
 * The cutover must change which artifact is read, not what the product answers.
 *
 * Most behaviour tests in this suite still describe a v1 `graph.json`, because
 * that is what generation used to write and those assertions remain valid for a
 * workspace that never cut over. The risk that leaves is a silent divergence: if
 * canonical reading returned subtly different content, the legacy-shaped
 * majority of the suite would stay green.
 *
 * So this pins the two against each other -- one source tree, one generated
 * graph, one directory, presented twice: once as the canonical v2 artifact and
 * once as a v1 graph.json derived from that same artifact. The workspace path is
 * identical across both phases on purpose. An earlier version derived the v1
 * copy in a second directory and every command "diverged", but only because a
 * graph records the absolute paths it was built from, so the comparison was
 * measuring the fixture rather than the product.
 */

const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['src/auth.ts', [
    "import { findUser } from './users.js'",
    '',
    'export function login(name: string) {',
    '  const user = findUser(name)',
    '  return authorize(user)',
    '}',
    '',
    'export function authorize(user: unknown) {',
    '  return Boolean(user)',
    '}',
    '',
  ].join('\n')],
  ['src/users.ts', [
    'export function findUser(name: string) {',
    '  return { name }',
    '}',
    '',
    'export function listUsers() {',
    '  return [findUser("a")]',
    '}',
    '',
  ].join('\n')],
]

/** Commands whose answers must not depend on which artifact carries the graph. */
const COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ['summary', ['summary']],
  ['query', ['query', 'login']],
  ['explain', ['explain', 'login']],
  ['path', ['path', 'login', 'findUser']],
  ['pack', ['pack', 'how does login work?']],
  ['prompt', ['prompt', 'how does login work?', '--provider', 'claude']],
]

interface Answer {
  readonly exitCode: number
  readonly text: string
}

/**
 * Removes only what cannot be identical: identifiers derived from the artifact
 * bytes, which genuinely differ between a v2 artifact and a v1 file describing
 * the same graph, plus wall-clock values. Paths are NOT normalized -- both
 * phases run in the same directory, so a path difference would be a real one.
 */
function normalize(text: string): string {
  return text
    .replaceAll('graph.madar', '<artifact>')
    .replaceAll('graph.json', '<artifact>')
    .replace(/\b[0-9a-f]{12,64}\b/g, '<digest>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<timestamp>')
    // HTTP-date too. The two phases run a moment apart, so an artifact mtime
    // rendered as `Mon, 17 Aug 2026 20:14:18 GMT` differs by a second between
    // them -- a clock reading, not an answer.
    .replace(/[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/g, '<http-date>')
    .replace(/\b\d+ ?ms\b/g, '<duration>')
    // A serialized payload carries the artifact path inside it, and
    // `graph.madar` is one character longer than `graph.json`, so its own token
    // count cannot be equal. The counts are compared separately below with a
    // bound, rather than dropped.
    .replace(/"token_count":\d+/g, '"token_count":<count>')
}

/** Every token count in a response, in order. */
function tokenCounts(text: string): number[] {
  return [...text.matchAll(/"token_count":(\d+)/g)].map((match) => Number(match[1]))
}

describe('answers do not depend on which artifact carries the graph', () => {
  let root: string
  let canonicalAnswers: Map<string, Answer>
  let legacyAnswers: Map<string, Answer>
  let canonicalState: string
  let legacyState: string
  let nodeCounts: { canonical: number, legacy: number }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'artifact-differential-'))
    for (const [relativePath, contents] of SOURCE_FILES) {
      const target = join(root, relativePath)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, contents)
    }
    generateGraph(root, { noHtml: true })

    const outputDir = join(root, 'out')
    const canonicalBytes = readFileSync(join(outputDir, 'graph.madar'))
    // Derived from the artifact just generated, so the two describe the same
    // graph by construction. Generating twice could differ for unrelated
    // reasons and would reduce the comparison to a coincidence.
    const derivedV1 = readGeneratedGraphJson(outputDir)

    const originalCwd = process.cwd()
    const collect = async (): Promise<Map<string, Answer>> => {
      const answers = new Map<string, Answer>()
      process.chdir(root)
      try {
        for (const [name, argv] of COMMANDS) {
          const lines: string[] = []
          const io = {
            log: (message: string) => lines.push(String(message)),
            error: (message: string) => lines.push(String(message)),
          }
          answers.set(name, { exitCode: await executeCli([...argv], io), text: lines.join('\n') })
        }
      } finally {
        process.chdir(originalCwd)
      }
      return answers
    }

    canonicalState = classifyWorkspaceGraph(outputDir).state
    canonicalAnswers = await collect()
    nodeCounts = { canonical: derivedV1.nodes.length, legacy: 0 }

    // Same directory, same source, only the artifact changes.
    unlinkSync(join(outputDir, 'graph.madar'))
    // A v1 graph.json written by an older binary records root_path; the v2
    // artifact keeps it in the machine-local sidecar instead, so the helper does
    // not carry it over. Without it the legacy reader resolves source paths
    // differently and the comparison measures the fixture, not the product.
    writeFileSync(join(outputDir, 'graph.json'), JSON.stringify({ ...derivedV1, root_path: root }))
    legacyState = classifyWorkspaceGraph(outputDir).state
    legacyAnswers = await collect()
    nodeCounts = {
      ...nodeCounts,
      legacy: (JSON.parse(readFileSync(join(outputDir, 'graph.json'), 'utf8')) as { nodes: unknown[] }).nodes.length,
    }

    // Leave the workspace cut over again so nothing downstream inherits the
    // legacy state from this fixture.
    writeFileSync(join(outputDir, 'graph.madar'), canonicalBytes)
    writeFileSync(join(outputDir, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
    // One generation plus every command twice. That exceeds the default budget
    // when the worker pool is saturated, and a timeout here is reported against
    // whichever test the hook was blocking.
  }, 180_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('compares a cut-over workspace against one that never cut over', () => {
    expect(canonicalState).toBe('current_v2')
    expect(legacyState).toBe('legacy_v1_only')
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

    // Both phases must describe the same graph, or every comparison is vacuous.
    expect(nodeCounts.canonical).toBeGreaterThan(0)
    expect(nodeCounts.legacy).toBe(nodeCounts.canonical)
  })

  it.each(COMMANDS)('%s answers identically from either artifact', (name) => {
    const fromCanonical = canonicalAnswers.get(name)
    const fromLegacy = legacyAnswers.get(name)

    // A shared failure would make the texts match while proving nothing.
    expect(fromCanonical?.exitCode).toBe(0)
    expect(fromLegacy?.exitCode).toBe(0)
    expect(fromCanonical?.text.length ?? 0).toBeGreaterThan(0)

    const canonicalText = normalize(fromCanonical?.text ?? '')
    const legacyText = normalize(fromLegacy?.text ?? '')
    if (canonicalText !== legacyText && process.env.ARTIFACT_DIFF_OUT !== undefined) {
      const a = canonicalText.split('\n')
      const b = legacyText.split('\n')
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) {
          appendFileSync(
            process.env.ARTIFACT_DIFF_OUT,
            `\n[${name} L${index}]\n  v2: ${String(a[index])}\n  v1: ${String(b[index])}\n`,
          )
        }
      }
    }

    expect(canonicalText).toBe(legacyText)
  })

  it.each(COMMANDS)('%s token counts differ only by the artifact filename length', (name) => {
    const fromCanonical = tokenCounts(canonicalAnswers.get(name)?.text ?? '')
    const fromLegacy = tokenCounts(legacyAnswers.get(name)?.text ?? '')

    expect(fromLegacy.length).toBe(fromCanonical.length)
    for (const [index, count] of fromCanonical.entries()) {
      // `graph.madar` is one character longer than `graph.json`. Anything beyond
      // a couple of tokens would mean the two artifacts produced different
      // context, not differently spelled paths.
      expect(Math.abs(count - (fromLegacy[index] ?? 0))).toBeLessThanOrEqual(2)
    }
  })

  it('proves the comparison can fail', () => {
    // Control for the normalizer: if it flattened enough to make any two
    // answers look alike, the assertions above would pass on a broken cutover.
    expect(normalize(canonicalAnswers.get('query')?.text ?? ''))
      .not.toBe(normalize(canonicalAnswers.get('explain')?.text ?? ''))
  })
})
