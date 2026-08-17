import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'

/**
 * The benchmark directories mix two kinds of thing, and the cutover made the
 * difference matter.
 *
 * A dated directory is frozen evidence: its numbers belong to the artifact
 * contract in force when they were taken. Rerunning its scripts today would not
 * fail -- `wc -c` on out/graph.json returns the tombstone's size -- it would
 * quietly record a graph three orders of magnitude too small. So the archived
 * runners must refuse, and the maintained tool must read the canonical artifact
 * and refuse anything that is not one.
 */

const HISTORICAL = resolve('docs/benchmarks/2026-05-11-spi-vs-legacy')
const MAINTAINED = resolve('docs/benchmarks/tools/real-workspace')

function runScript(script: string, args: string[], env: Record<string, string>): { status: number | null, output: string } {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('the archived v1-era runners refuse to pose as a current measurement', () => {
  it.each([
    ['run.sh'],
    ['run-real-workspace.sh'],
  ])('%s refuses without MADAR_BENCH_MODE=historical', (script) => {
    const { status, output } = runScript(join(HISTORICAL, script), [], { MADAR_BENCH_MODE: '' })

    expect(status).toBe(2)
    expect(output).toMatch(/MADAR_BENCH_MODE=historical/)
    // The refusal has to say where to go, or the next person edits the archive.
    expect(output).toMatch(/tools\/real-workspace/)
  })

  it('run.sh aborts when the binary under test publishes a v2 artifact', () => {
    const results = mkdtempSync(join(tmpdir(), 'historical-run-'))
    try {
      const { status, output } = runScript(join(HISTORICAL, 'run.sh'), [], {
        MADAR_BENCH_MODE: 'historical',
        MADAR_BENCH_RESULTS_DIR: results,
      })

      // Acknowledging the archive is not enough: the v1 schema cannot hold a v2
      // measurement, so a current binary must stop it.
      expect(status).not.toBe(0)
      expect(output).toMatch(/v2 canonical artifact/)
      expect(output).toMatch(/tools\/real-workspace/)
    } finally {
      rmSync(results, { recursive: true, force: true })
    }
    // Runs a real generate through a subprocess, which exceeds the default
    // budget when the worker pool is saturated.
  }, 120_000)

  it('keeps its recorded numbers and says which contract they belong to', () => {
    const readme = readFileSync(join(HISTORICAL, 'README.md'), 'utf8')

    // The measurements stay exactly as taken; only the framing is added.
    expect(readme).toContain('| `graph.json` size | 62.8 KB | 42.9 KB | **−31.6%** |')
    expect(readme).toMatch(/v1 artifact contract/)
    expect(readme).toMatch(/tools\/real-workspace/)
  })
})

describe('the maintained runner measures the canonical artifact', () => {
  it('only accepts the current mode', () => {
    const { status, output } = runScript(join(MAINTAINED, 'run.sh'), [], { MADAR_BENCH_MODE: 'historical' })

    expect(status).toBe(2)
    expect(output).toMatch(/MADAR_BENCH_MODE=current/)
  })

  it('refuses a fixture directory that does not exist', () => {
    const { status, output } = runScript(join(MAINTAINED, 'run.sh'), [], {
      MADAR_BENCH_FIXTURE: join(MAINTAINED, 'no-such-fixture'),
    })

    expect(status).toBe(2)
    expect(output).toMatch(/MADAR_BENCH_FIXTURE/)
  })

  it('refuses a prompts file that does not exist', () => {
    const { status, output } = runScript(join(MAINTAINED, 'run.sh'), [], {
      MADAR_BENCH_PROMPTS: join(MAINTAINED, 'no-such-prompts.json'),
    })

    expect(status).toBe(2)
    expect(output).toMatch(/MADAR_BENCH_PROMPTS/)
  })

  it('reads out/graph.madar and verifies the tombstone by content', () => {
    const script = readFileSync(join(MAINTAINED, 'run.sh'), 'utf8')

    expect(script).toContain('out/graph.madar')
    // `test -s` on either path would pass on a tombstone, so the check has to be
    // a byte comparison against the exact marker.
    expect(script).toMatch(/cmp -s "\$fixture_copy\/out\/graph\.json"/)
    expect(script).toContain('"schema_version": 2')
  })

  it('does not reuse v1-era field names for v2 numbers', () => {
    const script = readFileSync(join(MAINTAINED, 'run.sh'), 'utf8')

    // graph_size_bytes meant the v1 JSON file and pack_token_count could be a
    // silent zero. Reusing either as an emitted key would invite an invalid
    // comparison -- naming them in a comment that explains why is the point.
    expect(script).not.toContain('"graph_size_bytes"')
    expect(script).not.toContain('\\"pack_token_count\\"')
    expect(script).toContain('\\"serialized_token_count\\"')
  })
})

describe('graph-stats reads a v2 artifact and refuses anything else', () => {
  const statsScript = join(MAINTAINED, 'graph-stats.mjs')

  function stats(artifactPath: string): { status: number | null, output: string } {
    const result = spawnSync(process.execPath, [statsScript, artifactPath], { encoding: 'utf8' })
    if (result.error) throw result.error
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  it('counts nodes and facts from a real generated artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'stats-current-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
      generateGraph(root, { noHtml: true })

      const { status, output } = stats(join(root, 'out', 'graph.madar'))
      const parsed = JSON.parse(output) as Record<string, number | string>

      expect(status).toBe(0)
      expect(parsed.artifact_header).toBe('MADAR_GRAPH_ARTIFACT/2')
      expect(Number(parsed.node_count)).toBeGreaterThan(0)
      expect(Number(parsed.artifact_bytes)).toBeGreaterThan(0)
      // fact_count, not edge_count: a v1 link and a v2 fact are not the same
      // unit, so the name has to make the difference visible.
      expect(parsed).toHaveProperty('fact_count')
      expect(parsed).not.toHaveProperty('edge_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // Generation plus a subprocess; see the note above.
  }, 120_000)

  it('refuses the tombstone instead of measuring the marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'stats-tombstone-'))
    try {
      const tombstone = join(root, 'graph.json')
      writeFileSync(tombstone, GRAPH_ARTIFACT_V2_TOMBSTONE)

      const { status, output } = stats(tombstone)

      expect(status).toBe(1)
      expect(output).toMatch(/moved marker/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a live v1 graph rather than reporting zero facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'stats-v1-'))
    try {
      const legacy = join(root, 'graph.json')
      writeFileSync(legacy, JSON.stringify({ schema_version: 1, nodes: [{ id: 'a' }], links: [] }))

      // A v1 graph parses as JSON and has a nodes array, so a lenient reader
      // would report node_count with fact_count: 0 and look successful.
      const { status, output } = stats(legacy)

      expect(status).toBe(1)
      expect(output).toMatch(/MADAR_GRAPH_ARTIFACT\/2/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pack metrics never turn a missing field into a zero', () => {
  const metricsScript = join(MAINTAINED, 'pack-metrics.mjs')

  function metrics(response: unknown): { status: number | null, output: string } {
    const result = spawnSync(process.execPath, [metricsScript], {
      encoding: 'utf8',
      input: JSON.stringify(response),
    })
    if (result.error) throw result.error
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  it('reads the serialized token count and matched nodes', () => {
    const { status, output } = metrics({
      serialized_budget: { token_count: 1780 },
      pack: { matched_nodes: [{ label: 'debounce()' }, { label: 'utils.ts' }] },
    })

    expect(status).toBe(0)
    expect(JSON.parse(output)).toEqual({
      serialized_token_count: 1780,
      matched_node_count: 2,
      top_labels: ['debounce()', 'utils.ts'],
    })
  })

  it('fails on the response shape that used to record zero tokens', () => {
    // The real shape that caused it: pack.token_count absent while the prompt
    // packed a full context. `?? 0` filed that as zero tokens.
    const { status, output } = metrics({
      pack: { matched_nodes: [{ label: 'debounce()' }] },
    })

    expect(status).toBe(1)
    expect(output).toMatch(/refusing to record a zero/)
  })
})
