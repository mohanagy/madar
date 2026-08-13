import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const runnerPath = resolve('scripts/run-guarded-vitest.mjs')
const controlledChildPath = resolve('tests/fixtures/vitest-guard/controlled-child.mjs')
const delayedOutputChildPath = resolve('tests/fixtures/vitest-guard/delayed-output.mjs')
const echoArgsChildPath = resolve('tests/fixtures/vitest-guard/echo-args.mjs')

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

      // Windows signal delivery and numeric exit-code conventions differ from POSIX, so this
      // assertion verifies the portable contract: failure plus the named terminating cause.
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('CHILD PROCESS FAILURE (signal SIGTERM)')
      expect(existsSync(logPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
