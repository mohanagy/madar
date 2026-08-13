import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Invoked as a subprocess throughout, the same way the workflow calls it and the same way this
// test file's sibling (release-pipeline.test.ts) exercises the other `.github/scripts/*.mjs`
// tools -- the repo's tsconfig has no `allowJs`, so these plain ESM scripts are deliberately
// treated as opaque CLIs rather than statically imported into typechecked test code.
const scannerPath = resolve('.github/scripts/assert-clean-vitest-log.mjs')

function runScanner(paths: string[]) {
  return spawnSync(process.execPath, [scannerPath, ...paths], { encoding: 'utf8', stdio: 'pipe' })
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-log-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CLEAN_LOG = [
  ' RUN  v4.1.5 /repo',
  '',
  ' ✓ tests/unit/example.test.ts (3 tests) 12ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)',
  '',
].join('\n')

const GREEN_SUMMARY_WITH_SIGNATURE = [
  ' RUN  v4.1.5 /repo',
  '[vitest-pool-workers] Failed to start forks worker for tests/unit/flaky.test.ts, respawning',
  '',
  ' ✓ tests/unit/flaky.test.ts (2 tests) 9ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  2 passed (2)',
  '',
].join('\n')

const SIMILAR_BUT_UNRELATED_LOG = [
  'Failed to start the dev server worker pool warmup',
  'Worker responded after a short delay, no timeout occurred',
  'forks worker started successfully',
].join('\n')

describe('assert-clean-vitest-log CLI', () => {
  it('exits 0 for a clean log on disk', () => {
    withTempDir((dir) => {
      const logPath = join(dir, 'clean.log')
      writeFileSync(logPath, CLEAN_LOG)

      const result = runScanner([logPath])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('vitest log scan passed')
    })
  })

  it('does not false-positive on similar-but-unrelated text', () => {
    withTempDir((dir) => {
      const logPath = join(dir, 'unrelated.log')
      writeFileSync(logPath, SIMILAR_BUT_UNRELATED_LOG)

      const result = runScanner([logPath])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('vitest log scan passed')
    })
  })

  it('exits non-zero and reports file/signature/count for a green-summary log with the injected signature', () => {
    withTempDir((dir) => {
      const logPath = join(dir, 'signature.log')
      writeFileSync(logPath, GREEN_SUMMARY_WITH_SIGNATURE)

      const result = runScanner([logPath])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(logPath)
      expect(result.stderr).toContain('Failed to start forks worker')
      expect(result.stderr).toContain('1 occurrence')
    })
  })

  it.each([
    'Failed to start forks worker',
    'Timeout waiting for worker to respond',
  ])('exits non-zero for the signature "%s" individually', (signature) => {
    withTempDir((dir) => {
      const logPath = join(dir, 'each.log')
      writeFileSync(logPath, `clean line\n${signature} for tests/unit/x.test.ts\nclean line\n`)

      const result = runScanner([logPath])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(signature)
    })
  })

  it('exits non-zero and reports both signatures with independent counts when both are present', () => {
    withTempDir((dir) => {
      const logPath = join(dir, 'both.log')
      writeFileSync(
        logPath,
        [
          'Failed to start forks worker (1)',
          'Failed to start forks worker (2)',
          'Timeout waiting for worker to respond (1)',
        ].join('\n'),
      )

      const result = runScanner([logPath])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Failed to start forks worker" (2 occurrences)')
      expect(result.stderr).toContain('Timeout waiting for worker to respond" (1 occurrence)')
    })
  })

  it('fails closed when the log file does not exist, rather than treating it as clean', () => {
    withTempDir((dir) => {
      const result = runScanner([join(dir, 'does-not-exist.log')])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Log file not found')
    })
  })

  it('fails closed when given an unreadable input (a directory) instead of a file', () => {
    withTempDir((dir) => {
      const subdir = join(dir, 'not-a-file')
      mkdirSync(subdir)

      const result = runScanner([subdir])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('directory, not a file')
    })
  })

  it('requires at least one log path', () => {
    const result = runScanner([])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Usage:')
  })

  it('scans every path given and fails if any one of them contains a signature', () => {
    withTempDir((dir) => {
      const cleanPath = join(dir, 'test-run.log')
      const dirtyPath = join(dir, 'test-coverage.log')
      writeFileSync(cleanPath, CLEAN_LOG)
      writeFileSync(dirtyPath, GREEN_SUMMARY_WITH_SIGNATURE)

      const result = runScanner([cleanPath, dirtyPath])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(dirtyPath)
    })
  })

  it('passes when every given path is clean', () => {
    withTempDir((dir) => {
      const runPath = join(dir, 'test-run.log')
      const coveragePath = join(dir, 'test-coverage.log')
      writeFileSync(runPath, CLEAN_LOG)
      writeFileSync(coveragePath, CLEAN_LOG)

      const result = runScanner([runPath, coveragePath])
      expect(result.status).toBe(0)
    })
  })

  it('control: proves the scanner keys on the exact signature text, not incidental log noise', () => {
    withTempDir((dir) => {
      const controlPath = join(dir, 'control.log')
      // Injected verbatim, the same way vitest's forks pool itself emits it into captured
      // output. If this test ever stops failing, the scanner's detection logic is broken, not
      // just its wiring.
      writeFileSync(
        controlPath,
        'stdout | tests/unit/some.test.ts\nFailed to start forks worker, retrying with a fresh pool\n',
      )

      const result = runScanner([controlPath])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Failed to start forks worker')
    })
  })
})
