import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { startGraphAutoRefreshInBackground } from '../../src/infrastructure/background-auto-refresh.js'
import { readWatcherStateForGraph } from '../../src/infrastructure/watcher-state.js'
import { serveGraphStdio } from '../../src/runtime/stdio-server.js'

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

describe('background auto-refresh', () => {
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

  it('completes MCP discovery and fails graph reads closed during slow startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-background-mcp-'))
    const graphPath = join(root, 'out', 'graph.json')
    const watchModulePath = join(root, 'slow-watch.mjs')
    const completionMarker = join(root, 'slow-watch-finished')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })
    writeFileSync(watchModulePath, SLOW_WATCH_MODULE, 'utf8')

    input.end([
      JSON.stringify({ id: 1, method: 'initialize' }),
      JSON.stringify({ id: 2, method: 'prompts/list' }),
      JSON.stringify({ id: 3, method: 'resources/list' }),
      JSON.stringify({ id: 4, method: 'tools/list' }),
      JSON.stringify({ id: 5, method: 'stats' }),
    ].join('\n'))

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
      await waitFor(() => outputText.includes('"id":5'))
      expect(existsSync(completionMarker)).toBe(false)

      const responses = outputText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          id?: number
          result?: Record<string, unknown>
          error?: { message?: string }
        })

      expect(responses.find((response) => response.id === 1)?.result).toMatchObject({
        serverInfo: { name: 'madar' },
      })
      expect(responses.find((response) => response.id === 2)?.result).toMatchObject({ prompts: expect.any(Array) })
      expect(responses.find((response) => response.id === 3)?.result).toEqual({ resources: [] })
      expect(responses.find((response) => response.id === 4)?.result).toMatchObject({ tools: expect.any(Array) })
      expect(responses.find((response) => response.id === 5)?.error?.message).toContain(
        'auto-refresh cannot guarantee a fresh graph',
      )

      await serverPromise
      expect(readFileSync(watchModulePath, 'utf8')).toContain('Deliberately block only the worker thread')
    } finally {
      input.destroy()
      await serverPromise.catch(() => {})
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
})
