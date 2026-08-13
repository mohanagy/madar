import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { constants, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCleanVitestLogs,
  formatReport,
  WORKER_FAILURE_SIGNATURES,
} from '../.github/scripts/assert-clean-vitest-log.mjs'

const require = createRequire(import.meta.url)

export { WORKER_FAILURE_SIGNATURES }

export function resolveVitestEntry(env = process.env) {
  // Test-only injection seam: fixtures can stand in for Vitest without replacing its real
  // package or platform-specific bin shims. Repository npm scripts never set this variable.
  if (env.VITEST_GUARD_EXEC_OVERRIDE !== undefined) {
    if (!env.VITEST_GUARD_EXEC_OVERRIDE || !isAbsolute(env.VITEST_GUARD_EXEC_OVERRIDE)) {
      throw new Error('VITEST_GUARD_EXEC_OVERRIDE must be an absolute path')
    }
    return env.VITEST_GUARD_EXEC_OVERRIDE
  }

  const packagePath = require.resolve('vitest/package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.vitest
  if (typeof binPath !== 'string' || binPath.length === 0) {
    throw new Error(`Unable to resolve the vitest executable from ${packagePath}`)
  }
  return join(dirname(packagePath), binPath)
}

export function createLogTarget(env = process.env) {
  if (env.VITEST_GUARD_LOG_PATH !== undefined) {
    if (!env.VITEST_GUARD_LOG_PATH) {
      throw new Error('VITEST_GUARD_LOG_PATH must not be empty')
    }
    const logPath = env.VITEST_GUARD_LOG_PATH
    mkdirSync(dirname(logPath), { recursive: true })
    return { logPath, tempDirectory: undefined }
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), 'madar-vitest-guard-'))
  return { logPath: join(tempDirectory, 'output.log'), tempDirectory }
}

export function signalExitCode(signal) {
  const signalNumber = constants.signals[signal]
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1
}

function waitForReadable(stream) {
  return new Promise((resolveDone) => {
    if (stream.readableEnded || stream.destroyed) {
      resolveDone()
      return
    }
    stream.once('end', resolveDone)
    stream.once('close', resolveDone)
    stream.once('error', resolveDone)
  })
}

function waitForClose(stream) {
  return new Promise((resolveDone) => {
    if (stream.closed) {
      resolveDone()
      return
    }
    stream.once('close', resolveDone)
  })
}

async function openLog(logPath) {
  const stream = createWriteStream(logPath, { flags: 'w' })
  let writeError
  stream.on('error', (error) => {
    writeError ??= error
  })

  await new Promise((resolveOpen, rejectOpen) => {
    stream.once('open', resolveOpen)
    stream.once('error', rejectOpen)
  })

  return { stream, getWriteError: () => writeError }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function reportLogPath(logPath) {
  console.error(`Retained vitest log path: ${logPath}`)
}

function reportChildFailure(outcome) {
  if (outcome.signal !== null) {
    console.error(`=== CHILD PROCESS FAILURE (signal ${outcome.signal}) ===`)
  } else if (outcome.code !== 0 && outcome.code !== null) {
    console.error(`=== CHILD PROCESS FAILURE (exit code ${outcome.code}) ===`)
  }
}

function outcomeExitCode(outcome) {
  if (outcome.signal !== null) {
    return signalExitCode(outcome.signal)
  }
  return outcome.code && outcome.code > 0 ? outcome.code : 1
}

export async function runGuardedVitest(forwardedArgs, env = process.env) {
  let target
  try {
    target = createLogTarget(env)
  } catch (error) {
    console.error('=== VITEST LOG FAILURE (could not prepare the log path) ===')
    console.error(errorMessage(error))
    if (env.VITEST_GUARD_LOG_PATH !== undefined) {
      reportLogPath(env.VITEST_GUARD_LOG_PATH)
    } else {
      console.error('Retained vitest log path: unavailable because the temporary log directory could not be created')
    }
    return 1
  }

  let vitestEntryPath
  try {
    vitestEntryPath = resolveVitestEntry(env)
  } catch (error) {
    console.error('=== VITEST EXECUTABLE RESOLUTION FAILURE ===')
    console.error(errorMessage(error))
    reportLogPath(target.logPath)
    return 1
  }

  let log
  try {
    log = await openLog(target.logPath)
  } catch (error) {
    console.error('=== VITEST LOG FAILURE (could not create the log file) ===')
    console.error(errorMessage(error))
    reportLogPath(target.logPath)
    return 1
  }
  const { stream: logStream, getWriteError } = log

  let child
  try {
    child = spawn(process.execPath, [vitestEntryPath, ...forwardedArgs], {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    })
  } catch (error) {
    logStream.end()
    await waitForClose(logStream)
    console.error('=== VITEST CHILD SPAWN FAILURE ===')
    console.error(errorMessage(error))
    reportLogPath(target.logPath)
    return 1
  }

  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })

  const outputDone = Promise.all([waitForReadable(child.stdout), waitForReadable(child.stderr)])
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
    }
  }
  const forwardSigint = () => forwardSignal('SIGINT')
  const forwardSigterm = () => forwardSignal('SIGTERM')
  process.on('SIGINT', forwardSigint)
  process.on('SIGTERM', forwardSigterm)

  let outcome
  let spawnError
  try {
    outcome = await new Promise((resolveExit) => {
      child.once('error', (error) => {
        spawnError = error
        resolveExit(undefined)
      })
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
  } finally {
    process.off('SIGINT', forwardSigint)
    process.off('SIGTERM', forwardSigterm)
  }

  await outputDone
  if (!logStream.destroyed) {
    logStream.end()
  }
  await waitForClose(logStream)
  if (spawnError) {
    console.error('=== VITEST CHILD SPAWN FAILURE ===')
    console.error(errorMessage(spawnError))
    reportLogPath(target.logPath)
    return 1
  }

  const logWriteError = getWriteError()
  if (logWriteError) {
    console.error('=== VITEST LOG FAILURE (could not write the complete log) ===')
    console.error(errorMessage(logWriteError))
    reportLogPath(target.logPath)
    return 1
  }

  let scan
  try {
    scan = assertCleanVitestLogs([target.logPath])
  } catch (error) {
    reportChildFailure(outcome)
    console.error('=== VITEST LOG SCAN FAILURE ===')
    console.error(errorMessage(error))
    reportLogPath(target.logPath)
    return outcome.code === 0 && outcome.signal === null ? 1 : outcomeExitCode(outcome)
  }

  if (outcome.code === 0 && outcome.signal === null && !scan.hasFailure) {
    try {
      rmSync(target.logPath, { force: true })
      if (target.tempDirectory) {
        rmSync(target.tempDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      console.error('=== VITEST GUARD CLEANUP FAILURE ===')
      console.error(errorMessage(error))
      reportLogPath(target.logPath)
      return 1
    }
    return 0
  }

  reportChildFailure(outcome)
  if (scan.hasFailure) {
    console.error('=== ABSORBED WORKER-START SIGNATURE DETECTED ===')
    if (outcome.code === 0 && outcome.signal === null) {
      console.error('vitest exited 0 but the raw log contains a canonical worker-start failure signature.')
    }
    console.error(formatReport(scan))
  }
  reportLogPath(target.logPath)
  return outcomeExitCode(outcome)
}

export async function runCli(argv) {
  process.exitCode = await runGuardedVitest(argv)
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  try {
    await runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`vitest guard failed: ${message}`)
    process.exitCode = 1
  }
}
