#!/usr/bin/env node
/**
 * Emits a complete result, spawns a descendant that inherits stdout/stderr, and
 * exits immediately.
 *
 * This is the shape an independent reviewer hit: the measurement child finished
 * and its JSON was complete, but the wrapper waited on `close`, which cannot
 * fire while a descendant holds the pipes, and reported a timeout instead.
 *
 * Env:
 *   MADAR_STDIO_HOLD_MS   how long the descendant keeps the pipes open
 *   MADAR_RESULT_FILE     when set, the result is written there atomically
 *   MADAR_RESULT_MODE     complete | partial | none
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, renameSync, writeFileSync, writeSync, fsyncSync } from 'node:fs'

const holdMs = Number(process.env['MADAR_STDIO_HOLD_MS'] ?? 60_000)
const resultFile = process.env['MADAR_RESULT_FILE'] ?? null
const mode = process.env['MADAR_RESULT_MODE'] ?? 'complete'

const payload = { scope: 'src-only', samples: [1, 2, 3], medianMs: 2, inputChecksum: 'abc', emittedCandidates: 7 }
const text = mode === 'partial' ? JSON.stringify(payload).slice(0, 20) : JSON.stringify(payload)

if (mode !== 'none') {
  if (resultFile !== null) {
    // Temp file, fsync, atomic rename: a reader can never observe a partial file.
    const temporary = `${resultFile}.tmp-${process.pid}`
    const fd = openSync(temporary, 'w')
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    if (mode !== 'partial') renameSync(temporary, resultFile)
    else writeFileSync(resultFile, text)
  }
  process.stdout.write(text)
}

// The descendant inherits this process's stdout/stderr and outlives it.
spawn(process.execPath, ['-e', `setTimeout(() => {}, ${holdMs})`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: false,
})

process.exit(Number(process.env['MADAR_EXIT_CODE'] ?? 0))
