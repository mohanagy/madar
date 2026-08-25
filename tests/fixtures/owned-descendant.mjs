#!/usr/bin/env node
/**
 * Spawns a descendant whose stdio is CLOSED, prints its PID, and exits.
 *
 * Distinct from descendant-holds-stdio.mjs: because the descendant inherits
 * nothing, the leader's `close` fires immediately, so a runner that keys success
 * off stdio closure settles while the descendant is still alive.
 *
 * The marker is carried in the descendant's own argv, separately from its
 * lifetime, so a control can identify exactly the processes IT created. Keying
 * off the lifetime instead made every run of a control share one token: a
 * mutated runner leaked a descendant, and the next run counted that stray as its
 * own survivor.
 *
 * Env:
 *   MADAR_DESC_LIFE_MS      how long the descendant lives
 *   MADAR_DESC_IGNORE_TERM  when '1', the descendant ignores SIGTERM
 *   MADAR_DESC_MARKER       token embedded in the descendant's command line
 */
import { spawn } from 'node:child_process'

const life = Number(process.env['MADAR_DESC_LIFE_MS'] ?? 60_000)
const ignoreTerm = process.env['MADAR_DESC_IGNORE_TERM'] === '1'
const marker = process.env['MADAR_DESC_MARKER'] ?? ''
const body = [
  ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
  `const MADAR_DESC_MARKER = ${JSON.stringify(marker)}; void MADAR_DESC_MARKER;`,
  `setTimeout(() => {}, ${life})`,
].filter(Boolean).join(' ')

const child = spawn(process.execPath, ['-e', body], { stdio: 'ignore', detached: false })
process.stdout.write(JSON.stringify({ descendantPid: child.pid }))
process.exit(0)
