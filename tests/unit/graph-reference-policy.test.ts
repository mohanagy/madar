import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Production code may mention graph.json; it may not still default to it.
 *
 * A raw grep cannot tell those apart, and after the cutover the distinction is
 * the whole point: the tombstone, the legacy compatibility surfaces and the
 * old-reader contract all need the literal, while a current default that still
 * names it is a bug. This allowlist records every intentional mention with its
 * reason, so a new one has to be argued for rather than merged quietly.
 */

const SOURCE_ROOT = join(process.cwd(), 'src')

/** Files that legitimately name the legacy artifact, and why. */
const INTENTIONAL: ReadonlyMap<string, string> = new Map([
  ['contracts/graph-artifact-selection.ts', 'classifies workspaces, so it names every artifact'],
  ['contracts/graph-artifact.ts', 'legacy v1 loader and the moved-artifact error'],
  ['infrastructure/graph-artifact-activation.ts', 'writes the tombstone over the legacy path'],
  ['infrastructure/generate.ts', 'reads a pre-cutover workspace before publishing the tombstone'],
  ['infrastructure/compare.ts', 'isolates every published artifact during native agent runs'],
  ['infrastructure/install.ts', 'generated host discovery classifies both artifacts'],
  ['infrastructure/proof-report.ts', 'accepts an explicitly named legacy artifact'],
  ['infrastructure/time-travel.ts', 'removes any v1 mirror from a snapshot'],
  ['infrastructure/watch.ts', 'watches both artifact paths for change'],
  ['pipeline/export.ts', 'writes the v1 export format on request'],
  ['runtime/freshness.ts', 'resolves a legacy request to the measured artifact'],
  ['runtime/serve.ts', 'resolves a legacy request and follows the moved marker'],
  ['runtime/task-applicability.ts', 'recognises a legacy graph path'],
  ['cli/parser.ts', 'accepts an explicitly named legacy artifact'],
  ['cli/main.ts', 'help text and the legacy path users may still type'],
  ['infrastructure/doctor.ts', 'reports on a workspace holding either artifact'],
  ['infrastructure/install-skill-templates.ts', 'generated guidance names both artifacts'],
  ['pipeline/spi/index.ts', 'legacy extraction output shape'],
  ['pipeline/spi/projector.ts', 'legacy extraction output shape'],
  ['runtime/mcp-response-evidence.ts', 'evidence may cite a legacy artifact path'],
  ['runtime/stdio-server.ts', 'resolves and refreshes either artifact'],
  ['runtime/stdio/definitions.ts', 'tool schema documents the legacy path'],
  ['runtime/stdio/resources.ts', 'legacy-only resource and the moved-URI error'],
  ['shared/discovery-safety.ts', 'reads safety metadata from either artifact'],
  ['shared/graph-source-root.ts', 'resolves a legacy request to its source root'],
  ['shared/workspace.ts', 'names every artifact the workspace can hold'],
  ['shared/generated-graph-discovery.ts', 'generates host code that classifies both artifacts'],
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('production code does not default to the legacy artifact', () => {
  const offenders = sourceFiles(SOURCE_ROOT)
    .map((file) => ({ file: relative(SOURCE_ROOT, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => text.includes('graph.json'))

  it('finds the legacy literal only where it is recorded as intentional', () => {
    const unexplained = offenders
      .map(({ file }) => file)
      .filter((file) => !INTENTIONAL.has(file))

    // Not a ban on the string. A new file naming graph.json has to say why.
    expect(unexplained).toEqual([])
  })

  it('keeps the allowlist honest by dropping entries that no longer apply', () => {
    const stale = [...INTENTIONAL.keys()].filter((file) => !offenders.some((entry) => entry.file === file))

    expect(stale).toEqual([])
  })

  it.each([
    ["let graphPath = 'out/graph.json'", 'a command default'],
    ["graphPath = 'out/graph.json'", 'a command default'],
    ["?? 'out/graph.json'", 'a fallback default'],
    ["= 'out/graph.json'\n", 'an initialiser default'],
    // Help text is the surface users read before anything else, and the
    // allowlist above cannot see the difference between a file that mentions
    // the legacy name and one that advertises it as the default. Every
    // `--graph` line in the CLI help said `(default out/graph.json)` after the
    // cutover, which told every reader to name the tombstone.
    ['(default out/graph.json)', 'a documented default'],
    ['[graph.json]', 'a command-line placeholder'],
    ['path to graph.json', 'help text describing the legacy artifact'],
  ])('has no %s (%s)', (pattern) => {
    // The distinction the allowlist cannot make: mentioning the legacy name is
    // fine, defaulting to it is not.
    const defaulting = offenders
      .filter(({ text }) => text.includes(pattern))
      .map(({ file }) => file)

    expect(defaulting).toEqual([])
  })
})
