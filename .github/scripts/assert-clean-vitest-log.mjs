// Vitest's forks pool can respawn a worker mid-run when one fails to start or stops
// responding. The run's own summary and exit code do not see that respawn -- they only see
// whatever the respawned worker eventually reported -- so a file that logged one of these
// signatures can still be tallied as passed. A green summary and exit code 0 are therefore not
// sufficient release evidence on their own; this script reads the raw log text and fails
// closed when either signature appears, independent of what vitest itself reported.
//
// Deliberately narrow: this is not a general log-scanning framework. It knows exactly two
// signatures and does nothing else.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKER_FAILURE_SIGNATURES = [
  'Failed to start forks worker',
  'Timeout waiting for worker to respond',
]

function fail(message) {
  throw new Error(message)
}

/**
 * Scans a single log's text for every known worker-start failure signature.
 * Returns one entry per signature that appears, each with its occurrence count and the
 * matching lines (1-indexed), so a failure can be reported precisely.
 */
export function scanLogText(path, content) {
  const lines = content.split(/\r?\n/)
  const matches = []

  for (const signature of WORKER_FAILURE_SIGNATURES) {
    const matchingLines = []
    lines.forEach((line, index) => {
      if (line.includes(signature)) {
        matchingLines.push({ lineNumber: index + 1, text: line })
      }
    })
    if (matchingLines.length > 0) {
      matches.push({ signature, count: matchingLines.length, lines: matchingLines })
    }
  }

  return { path, matches }
}

/**
 * Reads and scans every given log path. Fails closed: a missing or unreadable path is a
 * thrown error, never a silently "clean" result.
 */
export function assertCleanVitestLogs(paths, io = {}) {
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? existsSync
  const stat = io.stat ?? statSync

  if (!Array.isArray(paths) || paths.length === 0) {
    fail('At least one log path is required')
  }

  const results = []

  for (const path of paths) {
    if (!exists(path)) {
      fail(`Log file not found: ${path}`)
    }

    let isDirectory = false
    try {
      isDirectory = stat(path).isDirectory()
    } catch {
      // If stat itself fails, the read below will surface a precise error instead.
    }
    if (isDirectory) {
      fail(`Log path is a directory, not a file: ${path}`)
    }

    let content
    try {
      content = readFile(path)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fail(`Unable to read log file ${path}: ${reason}`)
    }

    results.push(scanLogText(path, content))
  }

  const hasFailure = results.some((result) => result.matches.length > 0)
  return { hasFailure, results }
}

export function formatReport({ hasFailure, results }) {
  const lines = []

  for (const result of results) {
    if (result.matches.length === 0) {
      lines.push(`clean: ${result.path}`)
      continue
    }
    for (const match of result.matches) {
      const occurrences = match.count === 1 ? 'occurrence' : 'occurrences'
      lines.push(`SIGNATURE DETECTED in ${result.path}: "${match.signature}" (${match.count} ${occurrences})`)
      for (const { lineNumber, text } of match.lines) {
        lines.push(`  ${result.path}:${lineNumber}: ${text}`)
      }
    }
  }

  lines.push(
    hasFailure
      ? 'vitest log scan FAILED: absorbed worker-start failure signature(s) detected'
      : 'vitest log scan passed: no absorbed worker-start failure signatures detected',
  )

  return lines.join('\n')
}

export function runCli(argv) {
  if (argv.length === 0) {
    fail('Usage: assert-clean-vitest-log.mjs <log-path> [log-path...]')
  }

  const outcome = assertCleanVitestLogs(argv)
  const report = formatReport(outcome)

  if (outcome.hasFailure) {
    console.error(report)
    process.exitCode = 1
    return
  }

  console.log(report)
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`assert-clean-vitest-log failed: ${message}`)
    process.exitCode = 1
  }
}
