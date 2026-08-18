import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every committed benchmark harness must at least parse.
 *
 * `gen-run.sh` shipped in a state where bash refused the whole file: an
 * apostrophe inside `"${VAR:?...}"` opens a quote even within the double
 * quotes, so the parser ran off the end. Nothing caught it, because a receipt
 * harness is documentation until someone reruns it -- and the person rerunning
 * it is doing so precisely when the numbers are being challenged.
 *
 * This is a syntax check, not an execution: these scripts generate graphs and
 * measure them, which is not something a unit test should start.
 */
function shellHarnesses(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...shellHarnesses(path))
    } else if (entry.endsWith('.sh')) {
      found.push(path)
    }
  }
  return found
}

describe('committed benchmark harnesses parse', () => {
  const harnesses = shellHarnesses('docs/benchmarks')

  it('finds the harnesses to check', () => {
    // A path change that silently found nothing would make every case below
    // vacuous, so the count is asserted rather than assumed.
    expect(harnesses.length).toBeGreaterThan(5)
    expect(harnesses).toContain('docs/benchmarks/2026-08-17-705-artifact-v2-cutover/gen-run.sh')
  })

  it.each(harnesses)('%s is syntactically valid bash', (harness) => {
    expect(() => execFileSync('bash', ['-n', harness], {
      stdio: 'pipe',
      timeout: 30_000,
      windowsHide: true,
    })).not.toThrow()
  })
})
