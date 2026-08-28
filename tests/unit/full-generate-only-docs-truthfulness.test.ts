import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

/**
 * #722 FULL_GENERATE_ONLY_V1 — documentation truthfulness.
 *
 * Docs are a product surface. "Deprecated" would be untrue: the paths are not
 * discouraged-but-working, they are withdrawn. These assertions are scoped to
 * the forward-looking surfaces; dated CHANGELOG release notes and README
 * per-version notes are historical records of shipped behaviour and are
 * deliberately not rewritten.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const POSITION = 'automatic semantic refresh is not supported in the stable profile'
const REMEDY = 'run ordinary full generation to refresh repository semantics'

const FORWARD_LOOKING = [
  'docs/auto-refresh.md',
  'docs/reference/cli-and-mcp.md',
  'docs/mcp-registry/server.json',
  'README.md',
]

describe('FULL-GENERATE-ONLY documentation truthfulness', () => {
  test('the withdrawal is stated, not softened to "deprecated"', () => {
    for (const path of FORWARD_LOOKING) {
      expect(read(path), `${path} must not call a withdrawn path deprecated`)
        .not.toMatch(/deprecat/i)
    }
  })

  test('the stable-profile position and its remedy are stated where a reader looks first', () => {
    const doc = read('docs/auto-refresh.md').toLowerCase()
    expect(doc, 'DOC_POSITION_MISSING').toContain(POSITION)
    expect(doc, 'DOC_REMEDY_MISSING').toContain(REMEDY.toLowerCase())
    // The remedy must be actionable, not just prose.
    expect(read('docs/auto-refresh.md')).toContain('madar generate .')
  })

  test('no forward-looking surface still claims the graph is refreshed automatically', () => {
    const claims = [
      /installed MCP profiles use automatic refresh/i,
      /refreshes (?:it|that workspace's|the) (?:graph|artifact)? ?after local changes/i,
      /automatic refresh (?:runs|reuses|reconciles|validates)/i,
    ]
    for (const path of FORWARD_LOOKING) {
      const text = read(path)
      for (const claim of claims) {
        expect(text, `${path} still claims automatic refresh works: ${claim}`).not.toMatch(claim)
      }
    }
  })

  test('the CLI help for --auto-refresh does not promise a refresh', () => {
    const help = read('src/cli/main.ts')
    const line = help.split('\n').find((l) => l.includes('--auto-refresh '))
    expect(line, 'CLI help for --auto-refresh is missing').toBeDefined()
    expect(line, 'CLI_HELP_PROMISES_REFRESH').not.toMatch(/reconcile|watch the active workspace/i)
    expect(help).toContain('automatic semantic refresh is not')
  })

  test('the withdrawal is recorded in the changelog for the release that ships it', () => {
    const changelog = read('CHANGELOG.md')
    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('## [0.32.1]'),
    )
    expect(unreleased.toLowerCase(), 'CHANGELOG_WITHDRAWAL_UNRECORDED').toContain(POSITION)
    expect(unreleased).toContain('UNSUPPORTED_GENERATION_MODE')
  })
})
