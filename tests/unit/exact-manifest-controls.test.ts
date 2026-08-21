import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * Removes one produced artifact and re-runs validation over the same directory,
 * proving the runner requires each witness rather than reconstructing it.
 */
function runWithArtifactRemoved(file: string, artifact: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-manifest-artifact-'))
  scratch.push(dir)
  const manifestPath = join(dir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify([file]))
  const artifacts = join(dir, 'artifacts')

  // First pass populates the artifact directory.
  try {
    execFileSync(process.execPath, [RUNNER, manifestPath, '--out', artifacts], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
      env: { ...process.env, VITEST_GUARD_EXEC_OVERRIDE: FAKE_VITEST, MADAR_FAKE_VITEST_MODE: 'ok' },
    })
  } catch {
    // A failure here would be reported by the assertions below.
  }

  // Remove the witness, then run again against the same directory.
  const entryDir = readdirSync(artifacts).find((name) => name !== 'ledger.json')
  if (entryDir !== undefined) rmSync(join(artifacts, entryDir, artifact), { force: true })

  try {
    const stdout = execFileSync(process.execPath, [RUNNER, manifestPath, '--out', artifacts, '--validate-only'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function run(options: {
  manifest?: unknown
  manifestPath?: string
  mode?: string
  rawManifest?: boolean
}): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-manifest-control-'))
  scratch.push(dir)
  let manifestPath = options.manifestPath ?? join(dir, 'manifest.json')
  if (options.rawManifest === true) {
    // Already written by the caller; do not overwrite it.
  } else if (options.manifest !== undefined) {
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
    expect(output).toContain('manifest_missing')
  })

  it('rejects a duplicate manifest entry', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_A] })
    expect(status).not.toBe(0)
    expect(output).toContain('duplicate_manifest_entry')
  })

  it('rejects an entry that does not exist', () => {
    const { status, output } = run({ manifest: ['tests/unit/no-such-file.test.ts'] })
    expect(status).not.toBe(0)
    expect(output).toContain('manifest_entry_missing')
  })

  it('rejects an entry outside the repository', () => {
    const { status, output } = run({ manifest: ['../outside.test.ts'] })
    expect(status).not.toBe(0)
    expect(output).toContain('outside_repository')
  })

  it('rejects an empty manifest', () => {
    const { status, output } = run({ manifest: [] })
    expect(status).not.toBe(0)
    expect(output).toContain('empty_manifest')
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
    expect(output).toContain('report_unavailable')
    expect(output).not.toContain('EXACT MANIFEST RUN PASS')
  })

  it('fails when the report is unreadable', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'unreadable' })
    expect(status).not.toBe(0)
    expect(output).toContain('report_unavailable')
  })

  it('fails when a module discovers zero tests unexpectedly', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'empty' })
    expect(status).not.toBe(0)
    expect(output).toContain('zero_tests_discovered')
  })

  it('fails when the report names a different module', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'wrong-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('unexpected_module_reported')
    expect(output).toContain('requested_module_not_reported')
  })

  it('fails when an unexpected module is injected alongside the requested one', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'extra-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('unexpected_module_reported')
    expect(output).toContain('injected-extra')
  })

  it('fails when a process exits 0 without executing its requested module', () => {
    // The exact shape of the defect this runner exists for: success, no module,
    // no complaint.
    const { status, output } = run({ manifest: [REAL_A], mode: 'exit0-no-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('requested_module_not_reported')
    expect(output).toContain('requested_module_not_reported')
  })

  it('fails on a worker-start signature even when the report looks clean', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'worker-start' })
    expect(status).not.toBe(0)
    expect(output).toContain('worker_start_signature')
  })

  it('fails on a handshake signature even when the report looks clean', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'handshake' })
    expect(status).not.toBe(0)
    expect(output).toContain('handshake_signature')
  })

  it('fails when a report is written and then deleted', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'delete-after-write' })
    expect(status).not.toBe(0)
    expect(output).toContain('report_unavailable')
  })

  it('fails when a process exits 0 despite reported failures', () => {
    const { status, output } = run({ manifest: [REAL_A], mode: 'failed-but-exit0' })
    expect(status).not.toBe(0)
    expect(output).toContain('exit_disagrees_with_report')
  })

  it('fails when a process exits non-zero despite a clean report', () => {
    // The mirror case. Accepting it would let a crashed run pass on the
    // strength of a report written before the crash.
    const { status, output } = run({ manifest: [REAL_A], mode: 'clean-report-nonzero-exit' })
    expect(status).not.toBe(0)
    expect(output).toContain('exit_disagrees_with_report')
  })
})

describe('one child reports exactly one requested module', () => {
  it('fails when the same requested module is reported twice', () => {
    // The reviewer's reproduction. Set equality passed it: every requested
    // module executed, nothing unexpected executed, and the module ran twice.
    // Only cardinality catches it.
    const { status, output } = run({ manifest: [REAL_A], mode: 'duplicate-module' })
    expect(status).not.toBe(0)
    expect(output).toContain('duplicate_module_report')
    expect(output).not.toContain('EXACT MANIFEST RUN PASS')
  })

  it('never aggregates a duplicated result into the totals', () => {
    const { output } = run({ manifest: [REAL_A], mode: 'duplicate-module' })
    expect(output).not.toContain('totals')
  })
})

describe('raw evidence must exist independently of the report', () => {
  it('fails when raw stdout is unavailable', () => {
    const { status, output } = runWithArtifactRemoved(REAL_A, 'stdout.txt')
    expect(status).not.toBe(0)
    expect(output).toContain('raw_output_unavailable')
  })

  it('fails when raw stderr is unavailable', () => {
    const { status, output } = runWithArtifactRemoved(REAL_A, 'stderr.txt')
    expect(status).not.toBe(0)
    expect(output).toContain('raw_output_unavailable')
  })

  it('fails when the normalized display log is unavailable', () => {
    const { status, output } = runWithArtifactRemoved(REAL_A, 'display.log')
    expect(status).not.toBe(0)
    expect(output).toContain('display_output_unavailable')
  })
})

describe('manifest parsing distinguishes malformed from missing', () => {
  it('fails malformed JSON as malformed, not as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-manifest-malformed-'))
    scratch.push(dir)
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, '{ not valid json')
    const { status, output } = run({ manifestPath, rawManifest: true })
    expect(status).not.toBe(0)
    expect(output).toContain('malformed_manifest')
    expect(output).not.toContain('manifest_missing')
  })

  it('fails a manifest with no entries array as a schema error', () => {
    const { status, output } = run({ manifest: { notFiles: [] } })
    expect(status).not.toBe(0)
    expect(output).toContain('manifest_schema_invalid')
  })

  it('fails an absolute path outside the repository', () => {
    const { status, output } = run({ manifest: ['/etc/hosts'] })
    expect(status).not.toBe(0)
    expect(output).toContain('outside_repository')
  })

  it('fails a symlink that resolves outside the repository', () => {
    // A path check alone cannot see this: the link sits inside the tree.
    const dir = mkdtempSync(join(tmpdir(), 'madar-manifest-symlink-'))
    scratch.push(dir)
    const outside = join(dir, 'outside.test.ts')
    writeFileSync(outside, 'export {}\n')
    const linkName = 'tests/unit/__control-symlink.test.ts'
    const linkPath = resolve(ROOT, linkName)
    symlinkSync(outside, linkPath)
    try {
      const { status, output } = run({ manifest: [linkName] })
      expect(status).not.toBe(0)
      expect(output).toContain('outside_repository')
    } finally {
      rmSync(linkPath, { force: true })
    }
  })
})

describe('set equality is proven before any aggregate is printed', () => {
  it('never prints a total when a requested file did not verify', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_B], mode: 'no-report' })
    expect(status).not.toBe(0)
    // The ordering guarantee: a number must never describe a set it did not cover.
    expect(output).not.toContain('totals')
    expect(output).toContain('requested_executed_sets_differ')
  })

  it('names every file that failed to verify', () => {
    const { status, output } = run({ manifest: [REAL_A, REAL_B], mode: 'no-report' })
    expect(status).not.toBe(0)
    expect(output).toContain(REAL_A)
    expect(output).toContain(REAL_B)
  })
})
