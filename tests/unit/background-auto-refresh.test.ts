import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { startGraphAutoRefreshInBackground } from '../../src/infrastructure/background-auto-refresh.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { readStoredGenerationPolicy } from '../../src/infrastructure/generation-policy.js'
import { createWatcherState, readWatcherStateForGraph, writeWatcherState } from '../../src/infrastructure/watcher-state.js'
import { serveGraphStdio } from '../../src/runtime/stdio-server.js'
import type { GraphAutoRefreshController } from '../../src/infrastructure/watch.js'

const SLOW_WATCH_MODULE = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function startGraphAutoRefresh(watchPath) {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    // Deliberately block only the worker thread to model a cold large-repo build.
  }
  writeFileSync(join(watchPath, 'slow-watch-finished'), '1')
  let resolveCompleted
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve
  })
  return {
    initialRebuilt: true,
    stop() {
      resolveCompleted()
    },
    completed,
  }
}
`

const FAILING_WATCH_MODULE = `
export function startGraphAutoRefresh() {
  throw new Error('synthetic initial reconciliation failure')
}
`

const DELAYED_FAILING_WATCH_MODULE = `
export function startGraphAutoRefresh() {
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    // Give the parent time to make watcher-state persistence unavailable.
  }
  throw new Error('synthetic failure with unavailable watcher state')
}
`

const DELAYED_IMPORT_WAITING_WATCH_MODULE = `
await new Promise((resolve) => setTimeout(resolve, 250))

export function startGraphAutoRefresh() {
  let resolveStartup
  const startupSettled = new Promise((resolve) => {
    resolveStartup = resolve
  })
  let resolveCompleted
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve
  })
  return {
    initialRebuilt: false,
    startupSettled,
    stop() {
      resolveStartup()
      resolveCompleted()
    },
    completed,
  }
}
`

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await delay(10)
  }
  throw new Error('Timed out waiting for expected condition')
}

function publishReadyWatcherState(root: string, graphPath: string): void {
  const outputDir = join(root, 'out')
  const policy = readStoredGenerationPolicy(graphPath, join(outputDir, 'manifest.json'))
  if (!policy) {
    throw new Error('Expected generated graph and manifest policy')
  }
  writeWatcherState(outputDir, {
    ...createWatcherState('polling', 0),
    status: 'idle',
    coverage: 'complete',
    stored_policy_fingerprint: policy.fingerprint,
    current_policy_fingerprint: policy.fingerprint,
    policy_match: true,
  })
}

describe('background auto-refresh', () => {
  it('honors shutdown requested before the worker finishes importing its watcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-early-stop-'))
    const watchModulePath = join(root, 'delayed-import-watch.mjs')
    writeFileSync(watchModulePath, DELAYED_IMPORT_WAITING_WATCH_MODULE, 'utf8')

    try {
      const refresh = startGraphAutoRefreshInBackground(
        root,
        0.02,
        { noHtml: true, logger: { log() {}, error() {} } },
        { watchModuleUrl: pathToFileURL(watchModulePath) },
      )
      refresh.stop()

      await Promise.race([
        refresh.completed,
        delay(2_000).then(() => {
          throw new Error('Background auto-refresh did not stop during startup')
        }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns immediately while a slow initial reconciliation runs in a worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-refresh-'))
    const graphPath = join(root, 'out', 'graph.json')
    const watchModulePath = join(root, 'slow-watch.mjs')
    const completionMarker = join(root, 'slow-watch-finished')
    writeFileSync(watchModulePath, SLOW_WATCH_MODULE, 'utf8')

    try {
      const refresh = startGraphAutoRefreshInBackground(
        root,
        0.02,
        { noHtml: true, logger: { log() {}, error() {} } },
        { watchModuleUrl: pathToFileURL(watchModulePath) },
      )

      expect(existsSync(completionMarker)).toBe(false)
      expect(refresh.startupComplete?.()).toBe(false)
      expect(readWatcherStateForGraph(graphPath)).toMatchObject({
        status: 'starting',
        coverage: 'unknown',
      })

      let mainThreadTimerRan = false
      setTimeout(() => {
        mainThreadTimerRan = true
      }, 20)
      await delay(60)
      expect(mainThreadTimerRan).toBe(true)

      refresh.stop()
      await refresh.completed
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps MCP discovery responsive while one graph request waits for slow startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-mcp-'))
    const graphPath = join(root, 'out', 'graph.json')
    const watchModulePath = join(root, 'slow-watch.mjs')
    const completionMarker = join(root, 'slow-watch-finished')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    let refreshController: GraphAutoRefreshController | null = null
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
    generateGraph(root, { noHtml: true })
    writeFileSync(watchModulePath, SLOW_WATCH_MODULE, 'utf8')

    input.write(`${[
      JSON.stringify({ id: 1, method: 'initialize' }),
      JSON.stringify({ id: 2, method: 'prompts/list' }),
      JSON.stringify({ id: 3, method: 'resources/list' }),
      JSON.stringify({ id: 4, method: 'tools/list' }),
      JSON.stringify({ id: 5, method: 'stats' }),
      JSON.stringify({ id: 6, method: 'ping' }),
    ].join('\n')}\n`)

    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      input,
      output,
      errorOutput,
      autoRefreshRequestWaitMs: 2_500,
      autoRefreshStarter: (watchPath, debounceSeconds, options) => {
        refreshController = startGraphAutoRefreshInBackground(
          watchPath,
          debounceSeconds,
          options,
          { watchModuleUrl: pathToFileURL(watchModulePath) },
        )
        return refreshController
      },
    })

    try {
      await waitFor(() => outputText.includes('"id":6'))
      expect(existsSync(completionMarker)).toBe(false)
      expect(outputText).not.toContain('"id":5')

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          id?: number
          result?: Record<string, unknown>
          error?: { message?: string; data?: Record<string, unknown> }
        })

      expect(responses.find((response) => response.id === 1)?.result).toMatchObject({
        serverInfo: { name: 'madar' },
      })
      expect(responses.find((response) => response.id === 2)?.result).toMatchObject({ prompts: expect.any(Array) })
      expect(responses.find((response) => response.id === 3)?.result).toEqual({ resources: [] })
      expect(responses.find((response) => response.id === 4)?.result).toMatchObject({ tools: expect.any(Array) })
      expect(responses.find((response) => response.id === 6)?.result).toEqual({ ok: true })

      await waitFor(() => refreshController?.startupComplete?.() === true)
      expect(existsSync(completionMarker)).toBe(true)
      publishReadyWatcherState(root, graphPath)
      await waitFor(() => outputText.includes('"id":5'))
      input.end()
      await serverPromise
      const readyResponses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: string; error?: unknown })
      expect(readyResponses.find((response) => response.id === 5)?.result).toContain('Nodes:')
      expect(readyResponses.find((response) => response.id === 5)?.error).toBeUndefined()
      expect(readFileSync(watchModulePath, 'utf8')).toContain('Deliberately block only the worker thread')
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds a queued graph request timeout and still shuts down cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-timeout-'))
    const graphPath = join(root, 'out', 'graph.json')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    let stopped = false
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
    generateGraph(root, { noHtml: true })
    const policy = readStoredGenerationPolicy(graphPath, join(root, 'out', 'manifest.json'))
    if (!policy) {
      throw new Error('Expected generated policy metadata')
    }
    writeWatcherState(join(root, 'out'), {
      ...createWatcherState('polling', 0),
      status: 'reconciling',
      coverage: 'complete',
      stored_policy_fingerprint: policy.fingerprint,
      current_policy_fingerprint: policy.fingerprint,
      policy_match: true,
    })
    input.end([
      JSON.stringify({ id: 31, method: 'stats' }),
      JSON.stringify({ id: 32, method: 'ping' }),
    ].join('\n'))
    const startedAt = Date.now()

    try {
      await serveGraphStdio({
        graphPath,
        autoRefresh: true,
        workspaceRoot: root,
        autoRefreshRequestWaitMs: 75,
        input,
        output,
        errorOutput,
        autoRefreshStarter: () => ({
          initialRebuilt: false,
          startupComplete: () => true,
          failureReason: () => null,
          stop() { stopped = true },
          completed: Promise.resolve(),
        }),
      })

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          id?: number
          result?: unknown
          error?: { data?: { state?: string; retryable?: boolean; waited_ms?: number } }
        })
      expect(responses.findIndex((response) => response.id === 32)).toBeLessThan(
        responses.findIndex((response) => response.id === 31),
      )
      expect(responses.find((response) => response.id === 32)?.result).toEqual({ ok: true })
      expect(responses.find((response) => response.id === 31)?.error?.data).toMatchObject({
        state: 'reconciling',
        retryable: true,
        waited_ms: expect.any(Number),
      })
      expect(responses.find((response) => response.id === 31)?.error?.data?.waited_ms).toBeGreaterThanOrEqual(50)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(stopped).toBe(true)
    } finally {
      input.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps MCP connected and exposes a background startup failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-failure-'))
    const graphPath = join(root, 'out', 'graph.json')
    const watchModulePath = join(root, 'failing-watch.mjs')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    let errorText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    errorOutput.on('data', (chunk) => {
      errorText += chunk.toString('utf8')
    })
    writeFileSync(watchModulePath, FAILING_WATCH_MODULE, 'utf8')

    const serverPromise = serveGraphStdio({
      graphPath,
      autoRefresh: true,
      workspaceRoot: root,
      input,
      output,
      errorOutput,
      autoRefreshStarter: (watchPath, debounceSeconds, options) => startGraphAutoRefreshInBackground(
        watchPath,
        debounceSeconds,
        options,
        { watchModuleUrl: pathToFileURL(watchModulePath) },
      ),
    })

    try {
      input.write(`${JSON.stringify({ id: 11, method: 'initialize' })}\n`)
      await waitFor(() => outputText.includes('"id":11'))
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'failed')
      input.end(`${JSON.stringify({ id: 12, method: 'stats' })}\n`)
      await serverPromise

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } })
      expect(responses.find((response) => response.id === 11)?.result).toBeDefined()
      expect(responses.find((response) => response.id === 12)?.error?.message).toContain(
        'synthetic initial reconciliation failure',
      )
      expect(errorText).toContain('synthetic initial reconciliation failure')
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let a controller failure reuse stale ready watcher state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-stale-state-'))
    const graphPath = join(root, 'out', 'graph.json')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
    generateGraph(root, { noHtml: true })
    publishReadyWatcherState(root, graphPath)
    input.end([
      JSON.stringify({ id: 21, method: 'initialize' }),
      JSON.stringify({ id: 22, method: 'stats' }),
    ].join('\n'))

    try {
      await serveGraphStdio({
        graphPath,
        autoRefresh: true,
        workspaceRoot: root,
        input,
        output,
        errorOutput,
        autoRefreshStarter: () => ({
          initialRebuilt: false,
          startupComplete: () => true,
          failureReason: () => 'synthetic startup persistence failure',
          stop() {},
          completed: Promise.resolve(),
        }),
      })
      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } })
      expect(responses.find((response) => response.id === 21)?.result).toBeDefined()
      expect(responses.find((response) => response.id === 22)?.error?.message).toContain(
        'synthetic startup persistence failure',
      )
    } finally {
      input.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps controller and stderr failure reporting when watcher-state persistence disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-persistence-'))
    const outputDir = join(root, 'out')
    const watchModulePath = join(root, 'delayed-failure.mjs')
    const errors: string[] = []
    writeFileSync(watchModulePath, DELAYED_FAILING_WATCH_MODULE, 'utf8')

    try {
      const refresh = startGraphAutoRefreshInBackground(
        root,
        0.02,
        { noHtml: true, logger: { log() {}, error(message) { errors.push(String(message)) } } },
        { watchModuleUrl: pathToFileURL(watchModulePath) },
      )
      rmSync(outputDir, { recursive: true, force: true })
      writeFileSync(outputDir, 'watcher state cannot be persisted here', 'utf8')

      await waitFor(() => typeof refresh.failureReason?.() === 'string', 5_000)
      await refresh.completed
      expect(refresh.failureReason?.()).toContain('synthetic failure with unavailable watcher state')
      expect(errors.join('\n')).toContain('synthetic failure with unavailable watcher state')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
