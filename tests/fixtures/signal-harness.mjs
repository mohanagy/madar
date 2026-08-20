#!/usr/bin/env node
/**
 * A real process that installs the real signal coordinator, holds a real live
 * child, and sends itself a real signal.
 *
 * Emitting a signal inside a vitest worker is not a faithful test: vitest
 * installs its own SIGINT/SIGTERM handlers, so `process.emit` runs those too and
 * the harness ends up asserting on vitest's behaviour rather than ours. It also
 * leaks across test files sharing a worker. Running the scenario in its own
 * process removes both problems and exercises the actual signal wiring rather
 * than a simulation of it.
 *
 * Usage:
 *   node signal-harness.mjs --repo <dir> --worktree <dir> --signal SIGTERM
 *                           [--child stubborn|cooperative] [--repeat]
 *
 * Prints one JSON line describing what happened, then exits with the
 * coordinator's chosen code.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { runChild } = await import(join(here, '../../scripts/lib/child-runner.mjs'))
const { createResourceRegistry, installSignalCoordinator, worktreeCleanup } =
  await import(join(here, '../../scripts/lib/resource-registry.mjs'))

const args = process.argv.slice(2)
const argOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}

const repo = argOf('--repo')
const worktree = argOf('--worktree')
const signal = argOf('--signal') ?? 'SIGTERM'
const childKind = argOf('--child') ?? 'cooperative'
const repeat = args.includes('--repeat')
const readyPath = argOf('--ready')

const warnings = []
const registry = createResourceRegistry({ onWarning: (message) => warnings.push(message) })

registry.register(`worktree ${worktree}`, worktreeCleanup(repo, worktree))
execFileSync('git', ['worktree', 'add', '--detach', '--quiet', worktree, 'HEAD'], { cwd: repo })

const childSource = childKind === 'stubborn'
  ? `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setTimeout(() => {}, 60000)`
  : `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setTimeout(() => {}, 60000)`

const running = runChild(process.execPath, ['-e', childSource], {
  registry,
  description: `${childKind} child`,
})

// Deterministic readiness: the handler, where there is one, exists by now.
for (let attempt = 0; attempt < 400 && !existsSync(readyPath); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
const childPid = registry.liveChildren.length

installSignalCoordinator(registry, {
  graceMs: 800,
  onWarning: (message) => warnings.push(message),
  exit: (code) => {
    const worktreesAfter = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo, encoding: 'utf8',
    }).split('\n').filter((line) => line.startsWith('worktree ')).length
    writeFileSync(argOf('--out'), `${JSON.stringify({
      exitCode: code,
      liveChildrenAfter: registry.liveChildren.length,
      liveChildrenBefore: childPid,
      worktreeDirExists: existsSync(worktree),
      worktreeEntriesAfter: worktreesAfter,
      outstandingResources: registry.outstanding,
      warnings,
      interrupted: registry.interrupted,
    })}\n`)
    process.exit(code)
  },
})

process.kill(process.pid, signal)
if (repeat) {
  process.kill(process.pid, signal)
  process.kill(process.pid, 'SIGINT')
}

// Keep the loop alive so the coordinator can finish; it exits the process.
await running
await new Promise((resolve) => setTimeout(resolve, 30_000))
