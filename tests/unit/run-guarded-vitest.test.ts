import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const runnerPath = resolve('scripts/run-guarded-vitest.mjs')
const controlledChildPath = resolve('tests/fixtures/vitest-guard/controlled-child.mjs')
const delayedOutputChildPath = resolve('tests/fixtures/vitest-guard/delayed-output.mjs')
const echoArgsChildPath = resolve('tests/fixtures/vitest-guard/echo-args.mjs')
const signalCounterChildPath = resolve('tests/fixtures/vitest-guard/signal-counter.mjs')
const exerciseSignalForwarderPath = resolve('tests/fixtures/vitest-guard/exercise-signal-forwarder.mjs')

const CLEAN_OUTPUT = [
  ' RUN  v4.1.5 /repo',
  ' ✓ tests/unit/example.test.ts (1 test)',
  ' Test Files  1 passed (1)',
  ' Tests  1 passed (1)',
  '',
].join('\n')

function runGuard(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITEST_GUARD_EXEC_OVERRIDE: controlledChildPath,
    ...overrides,
  }
  delete env.VITEST_GUARD_LOG_PATH
  if (overrides.VITEST_GUARD_LOG_PATH !== undefined) {
    env.VITEST_GUARD_LOG_PATH = overrides.VITEST_GUARD_LOG_PATH
  }

  return spawnSync(process.execPath, [runnerPath, ...args], {
    encoding: 'utf8',
    env,
    stdio: 'pipe',
  })
}

describe('guarded vitest CLI', () => {
  it('succeeds for clean output and removes its automatically-created log directory', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-test-root-'))

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: CLEAN_OUTPUT,
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Test Files  1 passed (1)')
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails and retains the raw log when a green run absorbs a worker-start failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-signature-'))
    const logPath = join(dir, 'green-with-worker-failure.log')
    const signature = 'Failed to start forks worker'

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: `${signature}\n${CLEAN_OUTPUT}`,
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('ABSORBED WORKER-START SIGNATURE DETECTED')
      expect(result.stderr).toContain(signature)
      expect(existsSync(logPath)).toBe(true)
      expect(readFileSync(logPath, 'utf8')).toContain(signature)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails for an absorbed forks-worker handshake timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-timeout-'))
    const logPath = join(dir, 'handshake-timeout.log')
    const signature = 'Timeout waiting for worker to respond'

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDERR: `${signature}\n${CLEAN_OUTPUT}`,
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('ABSORBED WORKER-START SIGNATURE DETECTED')
      expect(result.stderr).toContain(signature)
      expect(readFileSync(logPath, 'utf8')).toContain(signature)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves a clean child process failure exit code without claiming a signature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-child-failure-'))
    const logPath = join(dir, 'child-exit-3.log')

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: 'ordinary assertion failure\n',
        VITEST_GUARD_FIXTURE_EXIT_CODE: '3',
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).toBe(3)
      expect(result.stderr).toContain('CHILD PROCESS FAILURE (exit code 3)')
      expect(result.stderr).not.toContain('ABSORBED WORKER-START SIGNATURE DETECTED')
      expect(existsSync(logPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the child exit and absorbed signature as separate failure causes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-double-failure-'))
    const logPath = join(dir, 'child-and-signature.log')
    const signature = 'Failed to start forks worker'

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: `${signature}\n`,
        VITEST_GUARD_FIXTURE_EXIT_CODE: '4',
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).toBe(4)
      expect(result.stderr).toContain('CHILD PROCESS FAILURE (exit code 4)')
      expect(result.stderr).toContain('ABSORBED WORKER-START SIGNATURE DETECTED')
      expect(result.stderr).toContain(signature)
      expect(existsSync(logPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports when the child process is terminated by a signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-signal-'))
    const logPath = join(dir, 'signal.log')

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: 'child is about to terminate\n',
        VITEST_GUARD_FIXTURE_SIGNAL: 'SIGTERM',
        VITEST_GUARD_LOG_PATH: logPath,
      })

      // Windows has no POSIX signals: `child.kill('SIGTERM')` there terminates the process via
      // TerminateProcess, so Node reports `signal: null` with a numeric exit code instead of a
      // signal name. The wrapper's signal-reporting branch is never reached in that case, and it
      // correctly falls through to its exit-code failure branch instead -- that is the wrapper
      // behaving correctly, not a defect. Assert the platform-correct observable behavior on each
      // OS rather than one POSIX-shaped assertion for both: termination must still be reported as
      // a failure with the retained log path printed on every platform. Do not collapse this back
      // into a single unconditional assertion -- that already hid this exact platform gap once.
      expect(result.status).not.toBe(0)
      if (process.platform === 'win32') {
        expect(result.stderr).toMatch(/CHILD PROCESS FAILURE \(exit code \d+\)/)
      } else {
        expect(result.stderr).toContain('CHILD PROCESS FAILURE (signal SIGTERM)')
      }
      expect(result.stderr).toContain('Retained vitest log path:')
      expect(existsSync(logPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards a signal to the child at most once, even when called twice before exitCode/signalCode could update', () => {
    // Deterministic, no real OS signals or timing involved: exercises createSignalForwarder
    // directly against a fake child via a subprocess, matching this file's established pattern
    // of treating scripts/*.mjs as opaque CLIs rather than statically importing them into
    // typechecked test code (see the sibling assert-clean-vitest-log.test.ts for the same
    // rationale -- the repo's tsconfig has no allowJs).
    const result = spawnSync(process.execPath, [exerciseSignalForwarderPath], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('FIRST_FORWARD_RESULT=true')
    expect(result.stdout).toContain('SECOND_FORWARD_RESULT=false')
    expect(result.stdout).toContain('KILL_CALL_COUNT=1')
    expect(result.stdout).toContain('KILL_CALLS=["SIGTERM"]')
    expect(result.stdout).toContain('EXITED_CHILD_FORWARD_RESULT=false')
    expect(result.stdout).toContain('EXITED_CHILD_KILL_CALL_COUNT=0')
  })

  it('delivers exactly one real signal to a still-alive child when the wrapper itself is signaled', async () => {
    // End-to-end proof, with a real OS signal, of the exact scenario CodeRabbit flagged: signal
    // the wrapper process itself (as an external supervisor or an interactive `kill <pid>` would)
    // while its child is still running, and confirm the child receives that signal exactly once
    // -- not zero (forwarding must work) and not two (the shared-process-group double-delivery
    // bug). The child fixture stays alive across a delivery window instead of dying from the
    // first signal, so any accidental second delivery would be observable.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VITEST_GUARD_EXEC_OVERRIDE: signalCounterChildPath,
    }
    delete env.VITEST_GUARD_LOG_PATH

    const wrapper = spawn(process.execPath, [runnerPath, 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    const ready = new Promise<void>((resolveReady) => {
      wrapper.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.includes('SIGNAL_COUNTER_READY')) {
          resolveReady()
        }
      })
    })
    await ready

    wrapper.kill('SIGTERM')

    await new Promise<void>((resolveClose) => {
      wrapper.once('close', () => resolveClose())
    })

    const deliveries = stdout.match(/SIGNAL_RECEIVED SIGTERM/g) ?? []
    expect(deliveries.length).toBe(1)
  })

  it('fails closed when the retained log disappears before scanning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-missing-log-'))
    const logPath = join(dir, 'deleted-before-scan.log')

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_DELETE_LOG: '1',
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('VITEST LOG SCAN FAILURE')
      expect(result.stderr).toContain('Log file not found')
      expect(result.stderr).toContain(logPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not false-positive on similar worker lifecycle wording', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-unrelated-'))
    const logPath = join(dir, 'unrelated.log')

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: [
          'restart a worker process gracefully',
          'Worker responded after a short delay',
          CLEAN_OUTPUT,
        ].join('\n'),
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('ABSORBED WORKER-START SIGNATURE DETECTED')
      expect(existsSync(logPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards every argument verbatim without shell reinterpretation', () => {
    const forwardedArgs = [
      'run',
      'tests/unit/path with spaces.test.ts',
      '--reporter=verbose output',
      '--',
      'literal-$()-and-*',
    ]
    const result = runGuard(forwardedArgs, {
      VITEST_GUARD_EXEC_OVERRIDE: echoArgsChildPath,
    })

    expect(result.status).toBe(0)
    const encodedArgs = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('FORWARDED_ARGS='))
      ?.slice('FORWARDED_ARGS='.length)
    expect(encodedArgs).toBeDefined()
    expect(JSON.parse(encodedArgs ?? 'null')).toEqual(forwardedArgs)
  })

  it('detects and retains a failure at a log path containing spaces and Unicode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-unicode-'))
    const logPath = join(dir, 'sub dir 名前', 'raw output α.log')
    const signature = 'Failed to start forks worker'

    try {
      const result = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: `${signature}\n`,
        VITEST_GUARD_LOG_PATH: logPath,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(signature)
      expect(result.stderr).toContain(logPath)
      expect(readFileSync(logPath, 'utf8')).toContain(signature)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deletes successful logs and retains failed logs under explicit paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-retention-'))
    const successfulLogPath = join(dir, 'successful.log')
    const failedLogPath = join(dir, 'failed.log')

    try {
      const successful = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: CLEAN_OUTPUT,
        VITEST_GUARD_LOG_PATH: successfulLogPath,
      })
      const failed = runGuard(['run'], {
        VITEST_GUARD_FIXTURE_STDOUT: 'Failed to start forks worker\n',
        VITEST_GUARD_LOG_PATH: failedLogPath,
      })

      expect(successful.status).toBe(0)
      expect(existsSync(successfulLogPath)).toBe(false)
      expect(failed.status).not.toBe(0)
      expect(existsSync(failedLogPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('streams child output as it arrives instead of buffering until exit', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VITEST_GUARD_EXEC_OVERRIDE: delayedOutputChildPath,
    }
    delete env.VITEST_GUARD_LOG_PATH

    const child = spawn(process.execPath, [runnerPath, 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutEvents: Array<{ at: number; text: string }> = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutEvents.push({ at: Date.now(), text: chunk.toString('utf8') })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const exitCode = await new Promise<number | null>((resolveExit, rejectSpawn) => {
      child.once('error', rejectSpawn)
      child.once('close', resolveExit)
    })

    expect(exitCode, stderr).toBe(0)
    const first = stdoutEvents.find((event) => event.text.includes('STREAMED_LINE_ONE'))
    const second = stdoutEvents.find((event) => event.text.includes('STREAMED_LINE_TWO'))
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(stdoutEvents.length).toBeGreaterThanOrEqual(2)
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(50)
  })
})
