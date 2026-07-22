import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateIndex, type GenerateIndexResult } from '../../src/application/generate-index.js'
import { SourceChangedDuringBuildError } from '../../src/application/generate-index.js'
import { updateIndex } from '../../src/application/update-index.js'
import {
  acquireIndexLease,
  loadAcceptedIndex,
  readMatchingDiagnostics,
  readMatchingReport,
} from '../../src/adapters/filesystem/index-store.js'
import { IndexLeaseContentionError } from '../../src/domain/index/build-state.js'
import { startWatchIndex } from '../../src/infrastructure/watch-index.js'

const roots: string[] = []

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-watch-index-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
}

function updateResult(sequence: number): GenerateIndexResult {
  const buildId = sequence.toString(16).padStart(64, '0')
  return {
    mode: 'update',
    rootPath: '/fixture',
    outputDir: '/fixture/out',
    graphPath: '/fixture/out/graph.json',
    reportPath: '/fixture/out/GRAPH_REPORT.md',
    totalFiles: 1,
    indexedFiles: 1,
    totalWords: 3,
    nodeCount: 1,
    edgeCount: 0,
    communityCount: 1,
    semanticAnomalyCount: 0,
    warning: null,
    notes: [],
    discoverySafety: { version: 1, summary: { total: 0, sensitive: 0, unreadable: 0, reasons: {} }, exclusions: [] },
    indexingManifestPath: '/fixture/out/indexing-manifest.json',
    indexing: {
      state: 'complete',
      candidates: 1,
      counts: { indexed: 1, indexed_with_warnings: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 },
      reason_buckets: { indexed: 1 },
      capability_buckets: { 'builtin:index:typescript': 1 },
    },
    buildId,
    updateReceipt: {
      mode: sequence === 1 ? 'cold_noop' : 'cold_reconcile',
      scanned_files: 1,
      parsed_files: sequence === 1 ? 0 : 1,
      reused_files: sequence === 1 ? 1 : 0,
      invalidated_files: sequence === 1 ? 0 : 1,
      dependency_closure_size: 0,
      fallback_reason: null,
      previous_build_id: sequence === 1 ? buildId : (sequence - 1).toString(16).padStart(64, '0'),
      accepted_build_id: buildId,
      publication_advanced: sequence > 1,
    },
  }
}

function wait(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
}

async function advance(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('watch index', () => {
  it('settles without reconciling when its signal is already aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    let calls = 0
    let eventSources = 0
    const controller = startWatchIndex('.', 0, {
      signal: abort.signal,
      update: () => { calls += 1; return updateResult(calls) },
      eventSource: () => { eventSources += 1; return { close() {} } },
      logger: { log() {}, error() {} },
    })

    await Promise.all([controller.startupSettled, controller.completed])
    expect(controller.state()).toBe('stopped')
    expect(calls).toBe(0)
    expect(eventSources).toBe(0)
  })

  it('cancels startup reconciliation when stopped before its microtask runs', async () => {
    let calls = 0
    const controller = startWatchIndex('.', 0, {
      update: () => { calls += 1; return updateResult(calls) },
      eventSource: () => ({ close() {} }),
      logger: { log() {}, error() {} },
    })
    controller.stop()

    await controller.completed
    expect(calls).toBe(0)
  })

  it('coalesces a burst into one following reconciliation', async () => {
    useFakeClock()
    let changed: (() => void) | null = null
    let calls = 0
    const update = () => updateResult(++calls)
    const controller = startWatchIndex('.', 0.01, {
      update,
      pollIntervalMs: 60_000,
      eventSource: (_root, notify) => {
        changed = notify
        return { close() {} }
      },
      logger: { log() {}, error() {} },
    })
    await controller.startupSettled
    expect(calls).toBe(1)

    for (let index = 0; index < 10; index += 1) (changed as (() => void) | null)?.()
    await advance(9)
    expect(calls).toBe(1)
    await advance(1)

    expect(calls).toBe(2)
    expect(controller.state()).toBe('idle')
    controller.stop()
    await controller.completed
  })

  it('schedules exactly one follow-up when an edit arrives during a build', async () => {
    useFakeClock()
    let changed: (() => void) | null = null
    let calls = 0
    let finishFirst: (() => void) | null = null
    const update = (): GenerateIndexResult | Promise<GenerateIndexResult> => {
      calls += 1
      if (calls === 1) return new Promise((resolvePromise) => {
        finishFirst = () => resolvePromise(updateResult(1))
      })
      return updateResult(calls)
    }
    const controller = startWatchIndex('.', 0, {
      update,
      pollIntervalMs: 60_000,
      eventSource: (_root, notify) => {
        changed = notify
        return { close() {} }
      },
      logger: { log() {}, error() {} },
    })
    await Promise.resolve()
    expect(calls).toBe(1)
    for (let index = 0; index < 5; index += 1) (changed as (() => void) | null)?.()
    expect(calls).toBe(1)
    ;(finishFirst as (() => void) | null)?.()
    await controller.startupSettled
    await advance()

    expect(calls).toBe(2)
    expect(controller.acceptedBuildId()).toBe(updateResult(2).buildId)
    controller.stop()
    await controller.completed
  })

  it('immediately retries a source-change race without starting parallel builders', async () => {
    useFakeClock()
    let calls = 0
    let active = 0
    let maximumActive = 0
    const update = () => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      try {
        if (calls === 1) throw new SourceChangedDuringBuildError()
        return updateResult(calls)
      } finally {
        active -= 1
      }
    }
    const controller = startWatchIndex('.', 0, {
      update,
      pollIntervalMs: 60_000,
      eventSource: () => ({ close() {} }),
      logger: { log() {}, error() {} },
    })
    await controller.startupSettled
    await advance()

    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
    expect(controller.failureReason()).toBeNull()
    expect(controller.state()).toBe('idle')
    controller.stop()
    await controller.completed
  })

  it('recovers from a failed reconciliation on the next event', async () => {
    useFakeClock()
    let changed: (() => void) | null = null
    let calls = 0
    const update = () => {
      calls += 1
      if (calls === 1) throw new Error('injected failure')
      return updateResult(calls)
    }
    const controller = startWatchIndex('.', 0, {
      update,
      pollIntervalMs: 60_000,
      eventSource: (_root, notify) => {
        changed = notify
        return { close() {} }
      },
      logger: { log() {}, error() {} },
    })
    await controller.startupSettled
    expect(controller.state()).toBe('failed')
    expect(controller.failureReason()).toContain('injected failure')

    ;(changed as (() => void) | null)?.()
    await advance()
    expect(calls).toBe(2)
    expect(controller.state()).toBe('idle')
    expect(controller.failureReason()).toBeNull()
    controller.stop()
    await controller.completed
  })

  it('keeps lease contention pending and retries without an external event', async () => {
    useFakeClock()
    let calls = 0
    const errors: string[] = []
    const update = () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('worker-shaped contention')
        error.name = 'IndexLeaseContentionError'
        throw error
      }
      return updateResult(calls)
    }
    const controller = startWatchIndex('.', 0, {
      update,
      pollIntervalMs: 60_000,
      eventSource: () => ({ close() {} }),
      logger: { log() {}, error(message) { errors.push(message ?? '') } },
    })

    await controller.startupSettled
    expect(calls).toBe(1)
    expect(controller.state()).toBe('pending')
    expect(controller.failureReason()).toBeNull()

    await advance(49)
    expect(calls).toBe(1)
    await advance(1)
    expect(calls).toBe(2)
    expect(controller.state()).toBe('idle')
    expect(controller.failureReason()).toBeNull()
    expect(errors).toEqual([])
    controller.stop()
    await controller.completed
  })

  it('retries a real competing owner of the same output lease', async () => {
    useFakeClock()
    const root = sandbox()
    write(root, 'src/main.ts', 'export const value = 1\n')
    const generated = generateIndex(root)
    const release = acquireIndexLease(generated.outputDir)
    const controller = startWatchIndex(root, 0, {
      seed: generated,
      pollIntervalMs: 60_000,
      eventSource: () => ({ close() {} }),
      logger: { log() {}, error() {} },
    })
    try {
      await controller.startupSettled
      expect(controller.state()).toBe('pending')
      expect(controller.failureReason()).toBeNull()
      release()
      await advance(50)
      expect(controller.state()).toBe('idle')
      expect(controller.acceptedBuildId()).toBe(generated.buildId)
    } finally {
      release()
      controller.stop()
      await controller.completed
    }
  })

  it('serializes two controllers publishing to the same output', async () => {
    useFakeClock()
    const root = sandbox()
    const source = write(root, 'src/main.ts', 'export const value = 1\n')
    const generated = generateIndex(root)
    const changed: Array<() => void> = []
    const commits: string[] = []
    const reconciliations: Array<{ buildId: string; mode: string | undefined }> = []
    let active = 0
    let maximumActive = 0
    const observedUpdate = (owner: string): typeof updateIndex => (path = '.', options = {}) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      try {
        const result = updateIndex(path, {
          ...options,
          storeDependencies: {
            ...options.storeDependencies,
            hook(step) {
              options.storeDependencies?.hook?.(step)
              if (step === 'before_graph_commit') commits.push(owner)
            },
          },
        })
        reconciliations.push({ buildId: result.buildId, mode: result.updateReceipt?.mode })
        return result
      } finally {
        active -= 1
      }
    }
    const controllerOptions = (owner: string) => ({
      seed: generated,
      update: observedUpdate(owner),
      pollIntervalMs: 60_000,
      eventSource: (_root: string, notify: () => void) => {
        changed.push(notify)
        return { close() {} }
      },
      logger: { log() {}, error() {} },
    })
    const first = startWatchIndex(root, 0, controllerOptions('first'))
    const second = startWatchIndex(root, 0, controllerOptions('second'))
    await Promise.all([first.startupSettled, second.startupSettled])
    reconciliations.length = 0

    writeFileSync(source, 'export const value = 2\n', 'utf8')
    changed.forEach((notify) => notify())
    await advance()

    const accepted = loadAcceptedIndex(generated.graphPath)
    expect(maximumActive).toBe(1)
    expect(commits).toHaveLength(1)
    expect(reconciliations.map(({ mode }) => mode).sort()).toEqual(['cold_noop', 'cold_reconcile'])
    expect(new Set(reconciliations.map(({ buildId }) => buildId))).toEqual(new Set([accepted?.state.build_id]))
    expect(first.acceptedBuildId()).toBe(accepted?.state.build_id)
    expect(second.acceptedBuildId()).toBe(accepted?.state.build_id)
    expect(readMatchingDiagnostics(generated.graphPath)?.build_id).toBe(accepted?.state.build_id)
    expect(readMatchingReport(generated.graphPath)).toContain(accepted?.state.build_id)
    first.stop()
    second.stop()
    await Promise.all([first.completed, second.completed])
  })

  it('bounds repeated lease retries before reporting a terminal failure', async () => {
    useFakeClock()
    let calls = 0
    const update = (): GenerateIndexResult => {
      calls += 1
      throw new IndexLeaseContentionError('/fixture/out')
    }
    const controller = startWatchIndex('.', 0, {
      update,
      pollIntervalMs: 1_000_000,
      eventSource: () => ({ close() {} }),
      logger: { log() {}, error() {} },
    })

    await controller.startupSettled
    expect(controller.state()).toBe('pending')
    expect(controller.failureReason()).toBeNull()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(13)
    expect(controller.state()).toBe('failed')
    expect(controller.failureReason()).toContain('already running')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(13)
    controller.stop()
    await controller.completed
  })

  it('observes a real filesystem edit through watch or polling', async () => {
    const root = sandbox()
    const source = write(root, 'src/main.ts', 'export const value = 1\n')
    const generated = generateIndex(root)
    const controller = startWatchIndex(root, 0.01, {
      seed: generated,
      pollIntervalMs: 1_000,
      logger: { log() {}, error() {} },
    })
    await controller.startupSettled
    const before = controller.acceptedBuildId()
    writeFileSync(source, 'export const value = 2\n', 'utf8')

    const deadline = Date.now() + 5_000
    while ((controller.acceptedBuildId() === before || controller.state() !== 'idle') && Date.now() < deadline) await wait(25)

    expect(controller.acceptedBuildId()).not.toBe(before)
    expect(controller.state()).toBe('idle')
    controller.stop()
    await controller.completed
  }, 10_000)
})
