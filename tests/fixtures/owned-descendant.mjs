#!/usr/bin/env node
/**
 * Spawns a descendant whose stdio is CLOSED, prints its PID, and exits.
 *
 * Distinct from descendant-holds-stdio.mjs: because the descendant inherits
 * nothing, the leader's `close` fires immediately, so a runner that keys success
 * off stdio closure settles while the descendant is still alive.
 *
 * Env:
 *   MADAR_DESC_LIFE_MS      how long the descendant lives
 *   MADAR_DESC_IGNORE_TERM  when '1', the descendant ignores SIGTERM
 */
import { spawn } from 'node:child_process'

const life = Number(process.env['MADAR_DESC_LIFE_MS'] ?? 60_000)
const ignoreTerm = process.env['MADAR_DESC_IGNORE_TERM'] === '1'
const body = ignoreTerm
  ? `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${life})`
  : `setTimeout(() => {}, ${life})`

const child = spawn(process.execPath, ['-e', body], { stdio: 'ignore', detached: false })
process.stdout.write(JSON.stringify({ descendantPid: child.pid }))
process.exit(0)
