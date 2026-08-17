#!/usr/bin/env node
/*
 * Process-isolated load-latency driver.
 *
 * One fresh process per sample, arms interleaved so page-cache and ordering
 * effects land on every arm equally. Two independent sessions with different
 * starting arms; a result that only holds in one ordering is not a result.
 *
 * Host load is recorded per sample. This host is not quiescent -- other agents'
 * work runs concurrently -- so the load average is captured rather than assumed,
 * and reported alongside the samples.
 */
import { execFileSync } from 'node:child_process'
import { loadavg } from 'node:os'

const SAMPLER = process.env.LOAD_SAMPLER
const SESSION = process.env.LOAD_SESSION ?? '1'
const SAMPLES = Number(process.env.LOAD_SAMPLES ?? '9')

const ARMS = JSON.parse(process.env.LOAD_ARMS ?? '[]')
if (!SAMPLER || ARMS.length === 0) {
  console.error('LOAD_SAMPLER and LOAD_ARMS are required')
  process.exit(2)
}

function sample(arm) {
  const output = execFileSync(process.execPath, [SAMPLER, arm.dist, arm.artifact, arm.mode ?? 'explicit'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { ...JSON.parse(output.trim()), load1: Number(loadavg()[0].toFixed(2)) }
}

// Session 1 runs the arms in listed order; session 2 reverses it.
const ordered = SESSION === '2' ? [...ARMS].reverse() : ARMS

// One unrecorded warm-up per arm, as B1 did: the first load in a fresh shell
// pays for page-cache population that no later sample repeats.
for (const arm of ordered) sample(arm)

const results = {}
for (const arm of ordered) results[arm.name] = []

for (let index = 0; index < SAMPLES; index += 1) {
  for (const arm of ordered) {
    const measured = sample(arm)
    results[arm.name].push(measured)
    process.stderr.write(`s${SESSION} ${arm.name} #${index + 1}: ${measured.elapsed_ms}ms load1=${measured.load1}\n`)
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const report = { session: SESSION, samples: SAMPLES, arms: {} }
for (const [name, runs] of Object.entries(results)) {
  const times = runs.map((r) => r.elapsed_ms)
  report.arms[name] = {
    median_ms: Number(median(times).toFixed(2)),
    min_ms: Math.min(...times),
    max_ms: Math.max(...times),
    spread_pct: Number((((Math.max(...times) - Math.min(...times)) / Math.min(...times)) * 100).toFixed(1)),
    samples_ms: times,
    artifact_bytes: runs[0].artifact_bytes,
    artifact_sha256: runs[0].artifact_sha256,
    node_count: runs[0].node_count,
    relationship_count: runs[0].relationship_count,
    rss_bytes_median: Math.round(median(runs.map((r) => r.rss_bytes))),
    load1_median: Number(median(runs.map((r) => r.load1)).toFixed(2)),
  }
}

console.log(JSON.stringify(report, null, 2))
