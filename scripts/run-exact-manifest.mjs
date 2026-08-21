#!/usr/bin/env node
/**
 * Runs a checked-in manifest of test files and PROVES which ones executed.
 *
 * Handing a list of files to Vitest does not guarantee they all run. The same
 * 21-file set produced 12 executed via the CLI, 17 via the CLI on a later
 * attempt, and 15 through the programmatic API -- each time silently, with a
 * green summary over a different subset. A total produced that way is not
 * evidence, because nothing in it says which files it covers.
 *
 * So this runner never asks Vitest to run a set. It runs ONE manifest entry per
 * process, through the repository's canonical guarded path, and proves for each
 * entry that exactly the requested module was discovered, executed and
 * reported. Aggregates are computed only after every entry has passed, so a
 * number can never describe a file set it did not cover.
 *
 * This is automated, not manual batching: the committed manifest is the input,
 * the runner owns the whole loop, and set equality is asserted rather than
 * eyeballed.
 *
 * Usage:
 *   node scripts/run-exact-manifest.mjs <manifest.json> [--out <dir>]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { WORKER_FAILURE_SIGNATURES } from '../.github/scripts/assert-clean-vitest-log.mjs'

const ROOT = process.cwd()
const [manifestArg, ...rest] = process.argv.slice(2)
const outIndex = rest.indexOf('--out')
const OUT_DIR = outIndex >= 0
  ? resolve(ROOT, rest[outIndex + 1])
  : resolve(ROOT, 'node_modules/.cache/exact-manifest')

function fail(message, detail = null) {
  console.error(`\nEXACT MANIFEST FAILURE: ${message}`)
  if (detail !== null) console.error(detail)
  process.exit(1)
}

// --- manifest validation, before anything is executed ----------------------
if (manifestArg === undefined) fail('no manifest supplied')
const manifestPath = resolve(ROOT, manifestArg)
if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestArg}`)

const manifestRaw = readFileSync(manifestPath, 'utf8')
const manifestChecksum = createHash('sha256').update(manifestRaw).digest('hex')

let entries
try {
  const parsed = JSON.parse(manifestRaw)
  entries = Array.isArray(parsed) ? parsed : parsed.files
} catch (error) {
  fail(`manifest is not valid JSON: ${error.message}`)
}
if (!Array.isArray(entries) || entries.length === 0) fail('manifest lists no files')

const requested = []
const seen = new Set()
for (const entry of entries) {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    fail(`manifest entry is not a path: ${JSON.stringify(entry)}`)
  }
  const absolute = resolve(ROOT, entry)
  const inside = relative(ROOT, absolute)
  if (inside.startsWith('..') || isAbsolute(inside)) fail(`manifest entry escapes the repository: ${entry}`)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`manifest entry does not exist: ${entry}`)
  if (seen.has(absolute)) fail(`manifest entry is duplicated: ${entry}`)
  seen.add(absolute)
  requested.push({ relative: inside, absolute })
}

mkdirSync(OUT_DIR, { recursive: true })

/** One entry, one process, through the repository's guarded path. */
function runEntry(entry, index) {
  const dir = resolve(OUT_DIR, `${String(index).padStart(3, '0')}-${entry.relative.replace(/[^A-Za-z0-9]+/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  const reportPath = join(dir, 'report.json')
  rmSync(reportPath, { force: true })

  const args = [
    resolve(ROOT, 'scripts/run-guarded-vitest.mjs'), 'run', entry.relative,
    '--reporter=json', `--outputFile=${reportPath}`,
  ]

  return new Promise((settle) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code, signal) => {
      writeFileSync(join(dir, 'stdout.txt'), stdout)
      writeFileSync(join(dir, 'stderr.txt'), stderr)
      writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
        requested: entry.relative,
        command: `${process.execPath} ${args.join(' ')}`,
        exitCode: code,
        signal,
        reportPath: relative(ROOT, reportPath),
      }, null, 2)}\n`)
      settle({ dir, reportPath, stdout, stderr, code, signal })
    })
  })
}

/** Every per-entry rule, applied to one completed process. */
function validateEntry(entry, run) {
  const problems = []
  const combined = `${run.stdout}${run.stderr}`

  // The guarded path exists to catch these. A signature here means the result
  // says nothing about the tests, whatever the exit code claims.
  const signatures = WORKER_FAILURE_SIGNATURES
    .map((signature) => ({ signature, count: combined.split(signature).length - 1 }))
    .filter((hit) => hit.count > 0)
  for (const hit of signatures) problems.push(`worker signature "${hit.signature}" x${hit.count}`)

  if (!existsSync(run.reportPath)) {
    problems.push('no report produced')
    return { problems, signatures, counts: null, executed: [] }
  }

  let report
  try {
    report = JSON.parse(readFileSync(run.reportPath, 'utf8'))
  } catch (error) {
    problems.push(`report unreadable: ${error.message}`)
    return { problems, signatures, counts: null, executed: [] }
  }

  const executed = (report.testResults ?? []).map((result) => result.name)
  if (executed.length === 0) problems.push('report names no executed module')
  const unexpected = executed.filter((name) => resolve(ROOT, name) !== entry.absolute)
  if (unexpected.length > 0) problems.push(`unexpected module(s) executed: ${unexpected.join(', ')}`)
  if (!executed.some((name) => resolve(ROOT, name) === entry.absolute)) {
    problems.push('the requested module did not execute')
  }

  const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? [])
  if (assertions.length === 0) problems.push('zero tests discovered')

  const counts = {
    passed: assertions.filter((a) => a.status === 'passed').length,
    failed: assertions.filter((a) => a.status === 'failed').length,
    skipped: assertions.filter((a) => a.status !== 'passed' && a.status !== 'failed').length,
  }

  // A process exiting 0 while its report shows failures -- or exiting non-zero
  // while its report shows none -- means one of the two is lying.
  if (counts.failed === 0 && run.code !== 0) problems.push(`exit ${run.code} despite a clean report`)
  if (counts.failed > 0 && run.code === 0) problems.push('exit 0 despite reported failures')

  return { problems, signatures, counts, executed }
}

console.log(`manifest            ${relative(ROOT, manifestPath)}`)
console.log(`manifest checksum   ${manifestChecksum}`)
console.log(`requested files     ${requested.length}`)
console.log(`artifacts           ${relative(ROOT, OUT_DIR)}\n`)

const ledger = []
let failures = 0
for (const [index, entry] of requested.entries()) {
  const run = await runEntry(entry, index + 1)
  const verdict = validateEntry(entry, run)
  ledger.push({
    file: entry.relative,
    exitCode: run.code,
    signal: run.signal,
    executed: verdict.executed,
    counts: verdict.counts,
    workerSignatures: verdict.signatures,
    problems: verdict.problems,
    artifacts: relative(ROOT, run.dir),
  })
  const status = verdict.problems.length === 0 ? 'ok    ' : 'FAILED'
  const detail = verdict.counts === null
    ? verdict.problems.join('; ')
    : `${verdict.counts.passed} passed, ${verdict.counts.failed} failed, ${verdict.counts.skipped} skipped`
  console.log(`  ${status} ${entry.relative.padEnd(56)} ${detail}`)
  if (verdict.problems.length > 0) {
    failures += 1
    for (const problem of verdict.problems) console.log(`         ! ${problem}`)
  }
}

const verified = new Set(ledger.filter((row) => row.problems.length === 0).map((row) => row.file))
const missing = requested.map((entry) => entry.relative).filter((file) => !verified.has(file))

const summary = {
  manifest: relative(ROOT, manifestPath),
  manifestChecksum,
  requestedCount: requested.length,
  verifiedCount: verified.size,
  missing,
  setsEqual: missing.length === 0,
  ledger,
}
writeFileSync(resolve(OUT_DIR, 'ledger.json'), `${JSON.stringify(summary, null, 2)}\n`)

console.log(`\nrequested           ${requested.length}`)
console.log(`executed & verified ${verified.size}`)
console.log(`ledger              ${relative(ROOT, resolve(OUT_DIR, 'ledger.json'))}`)

if (!summary.setsEqual || failures > 0) {
  fail(`${missing.length} requested file(s) did not execute and verify`, missing.join('\n'))
}

// Only now, with set equality proven, is an aggregate meaningful.
const totals = ledger.reduce((acc, row) => ({
  passed: acc.passed + (row.counts?.passed ?? 0),
  failed: acc.failed + (row.counts?.failed ?? 0),
  skipped: acc.skipped + (row.counts?.skipped ?? 0),
}), { passed: 0, failed: 0, skipped: 0 })

console.log(`\ntotals              ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`)
console.log(totals.failed === 0 ? 'EXACT MANIFEST RUN PASS' : 'EXACT MANIFEST RUN FAIL')
process.exit(totals.failed === 0 ? 0 : 1)
