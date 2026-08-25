import { execFileSync, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  OWNED_TREE_PROOFS,
  ownedTimerCount,
  ownedTreeState,
  runChild,
  terminateChildTree,
} from '../../scripts/lib/child-runner.mjs'
import { ResourceRegistryShuttingDownError } from '../../scripts/lib/shutdown-error.mjs'

/**
 * The child runner's platform contract, stated once for every lane.
 *
 * Two defects lived here and both were invisible on POSIX.
 *
 * `ownedTreeState` returned a flat `'unprovable'` for every call on win32,
 * and `reapOwnedTree` settles only on `'empty'`. Every Windows child therefore
 * waited out the full reap deadline and rejected with
 * `OwnedProcessTreeUnprovableError` -- including a child that exited cleanly
 * with no descendants at all. Normal completion, timeout, descendant and
 * cleanup controls all failed that way, on both Windows lanes.
 *
 * Separately, the two shutdown-race exits deferred their rejection to
 * `child.once('close', ...)` alone. This module documents that a descendant
 * holding inherited stdio keeps `close` from firing, so in that case `runChild`
 * never settled -- and neither path registers the child, so the coordinator
 * could not reap it either.
 *
 * The assertions below are platform-independent by construction: they name
 * semantic outcomes and proof kinds rather than signals and group probes.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOLDER = resolve(REPO, 'tests/fixtures/descendant-holds-stdio.mjs')

/** A registry stub, so the race can be provoked without a real shutdown. */
function registryThatFails(how: 'reservation' | 'registration') {
  return {
    reserveAdmission: () => ({ valid: () => how !== 'reservation' }),
    registerChild: () => {
      if (how === 'registration') throw new ResourceRegistryShuttingDownError('registry refused')
      return 'token'
    },
    releaseChild: () => undefined,
  }
}

describe('CR-01 — the owned-tree probe answers on every platform', () => {
  it('reports a dead or impossible pid as empty rather than unprovable', () => {
    // The exact shape of the Windows defect: a flat `'unprovable'` for input
    // the probe can in fact decide. `reapOwnedTree` settles only on `'empty'`,
    // so an unprovable answer here is a guaranteed deadline failure later.
    expect(ownedTreeState(0)).toBe('empty')
    expect(ownedTreeState(1)).toBe('empty')
    expect(ownedTreeState(undefined as unknown as number)).toBe('empty')
  })

  it('reports a live owned tree as populated', async () => {
    // The positive half: a probe that answered `empty` for everything would
    // satisfy the assertion above while proving nothing.
    //
    // The subject has to be a tree this runner OWNS. On POSIX the probe asks
    // about the process GROUP a pid leads, and a Vitest worker leads no group,
    // so probing `process.pid` correctly reports empty and would make this a
    // false negative. `detached` is exactly what makes the child a leader.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    try {
      await new Promise((ready) => setTimeout(ready, 250))
      expect(ownedTreeState(child.pid)).toBe('populated')
    } finally {
      terminateChildTree(child, 'SIGKILL')
    }
  }, 30_000)

  it('names how emptiness was proven, with POSIX and Windows kept distinct', () => {
    // A Windows result must never be read as carrying process-group evidence.
    const kinds = new Set(Object.values(OWNED_TREE_PROOFS))
    expect(kinds.has('process_group_probe')).toBe(true)
    expect(kinds.has('leader_exit_and_tree_kill')).toBe(true)
    expect(OWNED_TREE_PROOFS.processGroupProbe).not.toBe(OWNED_TREE_PROOFS.leaderExitAndTreeKill)
  })
})

describe('CR-02 — an ordinary child settles promptly and says how', () => {
  it('resolves a clean run as an ordinary exit', async () => {
    const started = Date.now()
    const result = await runChild(process.execPath, ['-e', 'process.exit(0)'], { cwd: REPO, timeoutMs: 20_000 })

    expect(result.code).toBe(0)
    expect(result.outcome).toBe('exited')
    expect(result.timedOut).toBe(false)
    // The whole Windows failure mode was a clean child waiting out a 10s reap
    // deadline before rejecting, so promptness is the assertion.
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 30_000)

  it('proves the tree empty rather than merely assuming it', async () => {
    const result = await runChild(process.execPath, ['-e', 'process.exit(0)'], { cwd: REPO, timeoutMs: 20_000 })
    expect(result.ownedTreeState).toBe('empty')
    expect(result.ownedTreeProof).not.toBe(OWNED_TREE_PROOFS.none)
  }, 30_000)

  it('classifies a non-zero exit as an exit, not a termination', async () => {
    const result = await runChild(process.execPath, ['-e', 'process.exit(3)'], { cwd: REPO, timeoutMs: 20_000 })
    expect(result.code).toBe(3)
    expect(result.outcome).toBe('exited')
  }, 30_000)

  it('classifies a timeout as a timeout on every platform', async () => {
    const result = await runChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: REPO, timeoutMs: 1_500, graceMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(result.outcome).toBe('timed_out')
  }, 40_000)
})

describe('CR-03 — a refused registration settles, bounded, with its own error', () => {
  it('rejects with the registry’s typed error rather than a kill-timeout error', async () => {
    await expect(runChild(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: REPO, registry: registryThatFails('registration') as never, graceMs: 200,
    })).rejects.toBeInstanceOf(ResourceRegistryShuttingDownError)
  }, 30_000)

  it('rejects when the reservation was invalidated during spawn', async () => {
    await expect(runChild(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: REPO, registry: registryThatFails('reservation') as never, graceMs: 200,
    })).rejects.toBeInstanceOf(ResourceRegistryShuttingDownError)
  }, 30_000)

  it('settles even when a descendant holds the inherited pipes open', async () => {
    // The reproduction. `close` cannot fire while the descendant holds the
    // pipes, so waiting only on `close` never settled at all -- and because
    // registration failed, the child was never registered and the coordinator
    // could not reap it either.
    const started = Date.now()
    await expect(runChild(process.execPath, [HOLDER], {
      cwd: REPO,
      registry: registryThatFails('registration') as never,
      graceMs: 500,
      env: { ...process.env, MADAR_STDIO_HOLD_MS: '30000', MADAR_RESULT_MODE: 'none' },
    })).rejects.toBeInstanceOf(ResourceRegistryShuttingDownError)
    // Bounded by the grace policy, not by the descendant's 30s lifetime.
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it('leaves no runner-owned timer behind on the race path', async () => {
    await expect(runChild(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: REPO, registry: registryThatFails('registration') as never, graceMs: 200,
    })).rejects.toBeInstanceOf(ResourceRegistryShuttingDownError)
    // A settled run that keeps a timer holds the event loop open and can fire
    // against a child that is already gone.
    expect(ownedTimerCount()).toBe(0)
  }, 30_000)
})

describe('CR-04 — the tree-kill command’s outcome is observed, not discarded', () => {
  it.runIf(process.platform === 'win32')('uses taskkill scoped to the pid and reads its exit code', () => {
    // On Windows this command IS the termination guarantee, so a failed kill
    // must not be indistinguishable from a successful one. Asserted here
    // through the code path's own vocabulary; the six-lane run is what
    // exercises it against a real process tree.
    const source = execFileSync('node', ['-e',
      "process.stdout.write(require('fs').readFileSync('scripts/lib/child-runner.mjs','utf8'))"],
    { cwd: REPO, encoding: 'utf8' })
    expect(source).toContain('taskkill')
    expect(source).toContain('onTreeKillOutcome')
  })

  it('keeps a tree-kill failure from ever reading as an empty tree', () => {
    // Stated as a vocabulary invariant so it holds on every lane: the proof
    // that a tree is empty is never the mere fact that a kill was attempted.
    expect(OWNED_TREE_PROOFS.none).toBe('none')
    expect(Object.values(OWNED_TREE_PROOFS)).not.toContain('tree_kill_attempted')
  })
})
