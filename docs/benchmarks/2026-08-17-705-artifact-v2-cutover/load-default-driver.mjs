#!/usr/bin/env node
/* Default-path load driver: fresh process per sample, cwd set to the workspace. */
import { execFileSync } from 'node:child_process'
import { loadavg } from 'node:os'

const SAMPLER = process.env.LOAD_SAMPLER
const SAMPLES = Number(process.env.LOAD_SAMPLES ?? '9')
// 0, negatives, fractions and NaN each produce an empty or inconsistent report
// and then fail on runs[0], which reads as a harness crash rather than bad
// input. Reject them before any sampling happens.
if (!Number.isSafeInteger(SAMPLES) || SAMPLES < 1) {
  console.error(`LOAD_SAMPLES must be a positive safe integer, received ${JSON.stringify(process.env.LOAD_SAMPLES)}`)
  process.exit(2)
}
const SESSION = process.env.LOAD_SESSION ?? '1'
const ARMS = JSON.parse(process.env.LOAD_ARMS ?? '[]')

function sample(arm) {
  const out = execFileSync(process.execPath, [SAMPLER, arm.dist, '.'], {
    cwd: arm.workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { ...JSON.parse(out.trim()), load1: Number(loadavg()[0].toFixed(2)) }
}

const ordered = SESSION === '2' ? [...ARMS].reverse() : ARMS
for (const arm of ordered) sample(arm)

const results = {}
for (const arm of ordered) results[arm.name] = []
for (let i = 0; i < SAMPLES; i += 1) {
  for (const arm of ordered) {
    const m = sample(arm)
    results[arm.name].push(m)
    process.stderr.write(`s${SESSION} ${arm.name} #${i + 1}: ${m.elapsed_ms}ms -> ${m.selected_logical_path ?? m.selected_workspace_relative_path}\n`)
  }
}

const median = (v) => { const s=[...v].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const report = { session: SESSION, samples: SAMPLES, arms: {} }
for (const [name, runs] of Object.entries(results)) {
  const t = runs.map((r) => r.elapsed_ms)
  report.arms[name] = {
    median_ms: Number(median(t).toFixed(2)), min_ms: Math.min(...t), max_ms: Math.max(...t),
    spread_pct: Number((((Math.max(...t)-Math.min(...t))/Math.min(...t))*100).toFixed(1)),
    samples_ms: t,
    selected_workspace_relative_path: runs[0].selected_workspace_relative_path,
    selected_logical_path: runs[0].selected_logical_path,
    artifact_bytes: runs[0].artifact_bytes,
    node_count: runs[0].node_count, relationship_count: runs[0].relationship_count,
    load1_median: Number(median(runs.map((r)=>r.load1)).toFixed(2)),
  }
}
console.log(JSON.stringify(report, null, 2))
