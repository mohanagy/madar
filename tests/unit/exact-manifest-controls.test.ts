import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * Fail-closed controls for the exact-manifest runner.
 *
 * A runner that reports green over a silently chosen subset is worse than no
 * runner, because it manufactures confidence. Each control drives one way a run
 * can look successful while proving nothing, and asserts the runner refuses it
 * FOR THE RIGHT REASON -- a non-zero exit alone would pass even if the runner
 * failed for some unrelated cause.
 */
const ROOT = process.cwd()
const RUNNER = resolve(ROOT, 'scripts/run-exact-manifest.mjs')
const FAKE_VITEST = resolve(ROOT, 'tests/fixtures/fake-vitest.mjs')
// Real repository files, so manifest validation passes and the fake decides
// what the "run" reports.
const REAL_A = 'tests/unit/detail-retention-shape.test.ts'
const REAL_B = 'tests/unit/integrity-record-identity.test.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(options: {
  manifest?: unknown
  manifestPath?: string
  mode?: string
}): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-manifest-control-'))
  scratch.push(dir)
  let manifestPath = options.manifestPath ?? join(dir, 'manifest.json')
  if (options.manifest !== undefined) {
    writeFileSync(manifestPath, JSON.stringify(options.manifest, null, 2))
  } else if (options.manifestPath === undefined) {
    manifestPath = join(dir, 'does-not-exist.json')
  }

  try {
    const stdout = execFileSync(process.execPath, [RUNNER, manifestPath, '--out', join(dir, 'artifacts')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      env: {
        ...process.env,
        ...(options.mode === undefined ? {} : {
          VITEST_GUARD_EXEC_OVERRIDE: FAKE_VITEST,
          MADAR_FAKE_VITEST_MODE: options.mode,
        }),
      },
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

describe('manifest validation refuses bad input before running anything', () => {
  it('rejects a missing manifest file', () => {
    const { status, output } = run({})
    expect(status).not.toBe(0)
    expect(output).toContain('manifest not found')
  })

  it('rejects a duplicate manifest entry', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_A] })
    expect(status).not.toBe(0)
    expect(output).toContain('manifest entry is duplicated')
  })

  it('rejects an entry that does not exist', () => {
    const { status, output } = run({ manifest: ['tests/unit/no-such-file.test.ts'] })
    expect(status).not.toBe(0)
    expect(output).toContain('manifest entry does not exist')
  })

  it('rejects an entry outside the repository', () => {
    const { status, output } = run({ manifest: ['../outside.test.ts'] })
    expect(status).not.toBe(0)
    expect(output).toMatch(/escapes the repository|does not exist/)
  })

  it('rejects an empty manifest', () => {
    const { status, output } = run({ manifest: [] })
    expect(status).not.toBe(0)
    expect(output).toContain('manifest lists no files')
  })
})

describe('per-entry execution proof is fail-closed', () => {
  it('accepts a well-behaved run, so the failures below mean something', () => {
    // The positive control. Without it, every assertion under this describe
    // could pass because the runner always fails.
    const { status, output } = run({ manifest: [REAL_A], mode: 'ok' })
    expect(status).toBe(0)
    expect(output).toContain('EXACT MANIFEST RUN PASS')
    expect(output).toContain('executed & verified 1')
  })

  it('fails when a requested file produces no report', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'no-report' })
    expect(status).not.toBe(0)
    expect(output).toContain('no report produced')
    expect(output).not.toContain('EXACT MANIFEST RUN PASS')
  })

  it('fails when the report is unreadable', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'unreadable' })
    expect(status).not.toBe(0)
    expect(output).toContain('report unreadable')
  })

  it('fails when a module discovers zero tests unexpectedly', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'empty' })
    expect(status).not.toBe(0)
    expect(output).toContain('zero tests discovered')
  })

  it('fails when the report names a different module', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'wrong-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('unexpected module(s) executed')
    expect(output).toContain('the requested module did not execute')
  })

  it('fails when an unexpected module is injected alongside the requested one', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'extra-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('unexpected module(s) executed')
    expect(output).toContain('injected-extra')
  })

  it('fails when a process exits 0 without executing its requested module', () => {
    // The exact shape of the defect this runner exists for: success, no module,
    // no complaint.
    const { status, output } = run({ manifest: [REAL_A], mode: 'exit0-no-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('report names no executed module')
    expect(output).toContain('the requested module did not execute')
  })

  it('fails on a worker-start signature even when the report looks clean', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'worker-start' })
    expect(status).not.toBe(0)
    expect(output).toContain('Failed to start forks worker')
  })

  it('fails on a handshake signature even when the report looks clean', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'handshake' })
    expect(status).not.toBe(0)
    expect(output).toContain('Timeout waiting for worker to respond')
  })

  it('fails when a report is written and then deleted', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'delete-after-write' })
    expect(status).not.toBe(0)
    expect(output).toContain('no report produced')
  })

  it('fails when a process exits 0 despite reported failures', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'failed-but-exit0' })
    expect(status).not.toBe(0)
    expect(output).toContain('exit 0 despite reported failures')
  })

  it('fails when a process exits non-zero despite a clean report', () => {
    // The mirror case. Accepting it would let a crashed run pass on the
    // strength of a report written before the crash.
    const { status, output } = run({ manifest: [REAL_A], mode: 'clean-report-nonzero-exit' })
    expect(status).not.toBe(0)
    expect(output).toContain('despite a clean report')
  })
})

describe('set equality is proven before any aggregate is printed', () => {
  it('never prints a total when a requested file did not verify', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_B], mode: 'no-report' })
    expect(status).not.toBe(0)
    // The ordering guarantee: a number must never describe a set it did not cover.
    expect(output).not.toContain('totals')
    expect(output).toContain('did not execute and verify')
  })

  it('names every file that failed to verify', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_B], mode: 'no-report' })
    expect(status).not.toBe(0)
    expect(output).toContain(REAL_A)
    expect(output).toContain(REAL_B)
  })
})
