#!/usr/bin/env node
/*
 * Three-arm generation measurement on B1's own fixture.
 *
 * Arms: base ee2115a2, B1 candidate c11ea269, and this branch. Reproducing B1's
 * input and command is the point -- its receipt records base 36.43 s and
 * candidate 77.69 s, and a number measured on a different corpus cannot be
 * compared with that.
 *
 * Every run gets its own copy of the fixture with no out/ directory, and the run
 * is discarded unless generation reports reason=no-cache. B1 invalidated three of
 * its own attempts for warm SPI cache, so cache state is attributed rather than
 * assumed.
 *
 * Run order is counterbalanced so thermal drift does not land on one arm.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const FIXTURE = process.env.PERF_FIXTURE
const WORK = process.env.PERF_WORK
const ROUNDS = Number(process.env.PERF_ROUNDS ?? '3')

const ARMS = {
  base: process.env.ARM_BASE,
  b1: process.env.ARM_B1,
  head: process.env.ARM_HEAD,
}

if (!FIXTURE || !WORK || Object.values(ARMS).some((v) => !v)) {
  console.error('PERF_FIXTURE, PERF_WORK, ARM_BASE, ARM_B1, ARM_HEAD are required')
  process.exit(2)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function runOnce(armName, cli, index) {
  const workspace = join(WORK, `${armName}-${index}`)
  rmSync(workspace, { recursive: true, force: true })
  // Copy without the root .git directory so the arm cannot resolve a
  // linked-worktree artifact directory belonging to the real repository.
  //
  // The exclusion is anchored to that one path. A substring test for '/.git'
  // also matched .gitignore, .github and .gitattributes -- and generation
  // respects Git-ignore, so dropping .gitignore silently enlarged the indexed
  // corpus and inflated both artifact size and wall time for every arm.
  const gitDir = join(FIXTURE, '.git')
  cpSync(FIXTURE, workspace, {
    recursive: true,
    filter: (src) => src !== gitDir && !src.startsWith(`${gitDir}/`),
  })
  rmSync(join(workspace, 'out'), { recursive: true, force: true })

  // /usr/bin/time -l reports peak RSS on stderr, which is B1's RSS gate metric.
  const started = process.hrtime.bigint()
  let output = ''
  let timing = ''
  try {
    output = execFileSync('/bin/sh', [
      '-c',
      `/usr/bin/time -l ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} generate ${JSON.stringify(workspace)} --no-html 2>&1`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`generate failed for ${armName}: ${String(error).slice(0, 300)}`)
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6

  // Attribution: a warm cache invalidates the run.
  const coldCache = /reason=no-cache/.test(output)
  const canonical = join(workspace, 'out', 'graph.madar')
  const legacy = join(workspace, 'out', 'graph.json')
  const producedCanonical = existsSync(canonical)
  const artifactPath = producedCanonical ? canonical : legacy
  const legacyBytes = existsSync(legacy) ? statSync(legacy).size : 0

  const rssMatch = /(\d+)\s+maximum resident set size/.exec(output)
  const peakRssBytes = rssMatch ? Number(rssMatch[1]) : null

  return {
    wallMs,
    peakRssBytes,
    coldCache,
    producedCanonical,
    artifactBytes: statSync(artifactPath).size,
    legacyBytes,
    outputDirBytes: dirSize(join(workspace, 'out')),
    workspace,
  }
}

function dirSize(directory) {
  const output = execFileSync('du', ['-sk', directory], { encoding: 'utf8' })
  return Number(output.trim().split(/\s+/)[0]) * 1024
}

const results = {}
for (const name of Object.keys(ARMS)) results[name] = []

// Counterbalanced: base, b1, head, then head, b1, base, alternating per round.
const order = []
for (let round = 0; round < ROUNDS; round += 1) {
  const names = ['base', 'b1', 'head']
  order.push(...(round % 2 === 0 ? names : [...names].reverse()).map((n) => [n, round]))
}

mkdirSync(WORK, { recursive: true })
for (const [name, round] of order) {
  const run = runOnce(name, ARMS[name], round)
  results[name].push(run)
  process.stderr.write(
    `${name} round ${round}: ${Math.round(run.wallMs)}ms cold=${run.coldCache} canonical=${run.producedCanonical}\n`,
  )
  rmSync(run.workspace, { recursive: true, force: true })
}

const report = { fixture: FIXTURE, rounds: ROUNDS, arms: {} }
for (const [name, runs] of Object.entries(results)) {
  const valid = runs.filter((r) => r.coldCache)
  report.arms[name] = {
    runs: runs.length,
    cold_runs: valid.length,
    discarded_warm_cache: runs.length - valid.length,
    wall_median_ms: valid.length > 0 ? Math.round(median(valid.map((r) => r.wallMs))) : null,
    wall_runs_ms: runs.map((r) => Math.round(r.wallMs)),
    peak_rss_median_bytes: valid.length > 0 && valid.every((r) => r.peakRssBytes !== null)
      ? Math.round(median(valid.map((r) => r.peakRssBytes)))
      : null,
    peak_rss_runs_bytes: runs.map((r) => r.peakRssBytes),
    produced_canonical: runs.every((r) => r.producedCanonical),
    artifact_bytes: valid[0]?.artifactBytes ?? null,
    legacy_bytes: valid[0]?.legacyBytes ?? null,
    output_dir_bytes: valid[0]?.outputDirBytes ?? null,
  }
}

const ratio = (a, b) => (a === null || b === null || b === 0 ? null : Number((a / b).toFixed(3)))
report.ratios_vs_base = {
  b1_wall: ratio(report.arms.b1.wall_median_ms, report.arms.base.wall_median_ms),
  head_wall: ratio(report.arms.head.wall_median_ms, report.arms.base.wall_median_ms),
  b1_artifact: ratio(report.arms.b1.artifact_bytes, report.arms.base.artifact_bytes),
  head_artifact: ratio(report.arms.head.artifact_bytes, report.arms.base.artifact_bytes),
  b1_output_dir: ratio(report.arms.b1.output_dir_bytes, report.arms.base.output_dir_bytes),
  head_output_dir: ratio(report.arms.head.output_dir_bytes, report.arms.base.output_dir_bytes),
  b1_peak_rss: ratio(report.arms.b1.peak_rss_median_bytes, report.arms.base.peak_rss_median_bytes),
  head_peak_rss: ratio(report.arms.head.peak_rss_median_bytes, report.arms.base.peak_rss_median_bytes),
}
report.ratios_head_vs_b1 = {
  wall: ratio(report.arms.head.wall_median_ms, report.arms.b1.wall_median_ms),
  artifact: ratio(report.arms.head.artifact_bytes, report.arms.b1.artifact_bytes),
  output_dir: ratio(report.arms.head.output_dir_bytes, report.arms.b1.output_dir_bytes),
}
// A base arm producing graph.madar would mean the wrong binary ran; B1
// invalidated two attempts on exactly that.
report.attribution = {
  base_produced_no_canonical: report.arms.base.produced_canonical === false,
  b1_produced_canonical: report.arms.b1.produced_canonical === true,
  head_produced_canonical: report.arms.head.produced_canonical === true,
  all_runs_cold: Object.values(report.arms).every((a) => a.discarded_warm_cache === 0),
}

console.log(JSON.stringify(report, null, 2))
