#!/usr/bin/env node
/*
 * Process-tree peak-RSS sampler.
 *
 * Polls the spawned process and every descendant, summing resident set size and
 * keeping the maximum. Written because /usr/bin/time -l wrapping killed two
 * earlier measurement runs; this changes the measurement method, not the product
 * workload.
 *
 * The process-tree boundary is the spawned command plus all descendants, sampled
 * on a fixed interval. The same boundary and interval apply to every arm.
 */
import { spawn, execFileSync } from 'node:child_process'

const INTERVAL_MS = Number(process.env.RSS_INTERVAL_MS ?? '100')

function treeRssBytes(rootPid) {
  try {
    // One ps call for all processes; build the child map and sum the subtree.
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    const rows = out.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
    const children = new Map()
    const rss = new Map()
    for (const [pid, ppid, kb] of rows) {
      rss.set(pid, kb * 1024)
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(pid)
    }
    let total = 0
    const stack = [rootPid]
    const seen = new Set()
    while (stack.length > 0) {
      const pid = stack.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      total += rss.get(pid) ?? 0
      for (const child of children.get(pid) ?? []) stack.push(child)
    }
    return total
  } catch {
    return 0
  }
}

const [command, ...args] = process.argv.slice(2)
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

let peak = 0
let samples = 0
const timer = setInterval(() => {
  const now = treeRssBytes(child.pid)
  samples += 1
  if (now > peak) peak = now
}, INTERVAL_MS)

let stdout = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', () => {})

child.on('exit', (code) => {
  clearInterval(timer)
  console.log(JSON.stringify({
    peak_rss_bytes: peak,
    samples,
    interval_ms: INTERVAL_MS,
    exit_code: code,
    cold_cache: /reason=no-cache/.test(stdout),
    produced_canonical: /graph\.madar/.test(stdout),
  }))
})
