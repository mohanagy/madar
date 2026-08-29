import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { LEGACY_AUTO_REFRESH_DIAGNOSTIC } from '../../src/runtime/stdio-server.js'
import { LEGACY_AUTO_REFRESH_PROFILE_NOTE } from '../../src/infrastructure/doctor.js'
import { runDoctorCommand } from '../../src/infrastructure/doctor.js'
import { resolveMadarOutputDirectory } from '../../src/shared/workspace.js'

/**
 * #722 — legacy `--auto-refresh` startup compatibility.
 *
 * Installers written before this release put the flag into managed MCP
 * profiles. Those profiles must keep starting, the flag must enable nothing,
 * and it must not be silently ignored: exactly one machine-readable diagnostic
 * is emitted and doctor explains the situation.
 */

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-legacy-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\n')
  return dir
}

function treeOf(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      out.push(`${rel}:${readFileSync(join(dir, entry.name)).length}`)
    }
  }
  walk(root, '')
  return out.sort()
}

describe('FULL-GENERATE-ONLY legacy auto-refresh compatibility', () => {
  afterEach(() => { vi.resetModules() })

  test('a legacy profile still starts, answers, and emits exactly one diagnostic', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const before = readFileSync(first.graphPath)
    const outputDir = resolveMadarOutputDirectory(dir)
    const treeBefore = treeOf(outputDir)

    const { serveGraphStdio } = await import('../../src/runtime/stdio-server.js')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outText = ''
    let errText = ''
    output.on('data', (c) => { outText += c.toString('utf8') })
    errorOutput.on('data', (c) => { errText += c.toString('utf8') })

    input.end(`${JSON.stringify({ id: 1, method: 'ping' })}\n${JSON.stringify({ id: 2, method: 'tools/list' })}\n`)
    await serveGraphStdio({ graphPath: first.graphPath, autoRefresh: true, input, output, errorOutput })

    // Read-only MCP requests remain functional.
    const answers = outText.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l) as { id?: number })
    expect(answers.some((a) => a.id === 1), 'READ_ONLY_MCP_BROKEN').toBe(true)
    expect(answers.some((a) => a.id === 2), 'READ_ONLY_MCP_BROKEN').toBe(true)

    const diagnostics = errText.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } })
      .filter((d): d is Record<string, unknown> => d?.code === 'UNSUPPORTED_GENERATION_MODE')
    expect(diagnostics, 'LEGACY_AUTO_REFRESH_FLAG_SILENTLY_IGNORED').toHaveLength(1)
    expect(diagnostics[0]).toStrictEqual({ ...LEGACY_AUTO_REFRESH_DIAGNOSTIC })

    // Nothing refreshed.
    expect(readFileSync(first.graphPath).equals(before), 'LEGACY_AUTO_REFRESH_STARTED_REFRESH').toBe(true)
    expect(treeOf(outputDir), 'LEGACY_AUTO_REFRESH_STARTED_REFRESH').toStrictEqual(treeBefore)
  })

  test('the flag reaches no watcher, worker, timer, policy read or generation', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const counts = { worker: 0, watcher: 0, timers: 0, policy: 0, generate: 0 }

    vi.resetModules()
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.doMock('node:fs', () => ({ ...fs, default: fs,
      watch: (...a: Parameters<typeof fs.watch>) => { counts.watcher += 1; return fs.watch(...a) } }))
    const wt = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
    class CountingWorker extends wt.Worker {
      constructor(...a: ConstructorParameters<typeof wt.Worker>) { counts.worker += 1; super(...a) }
    }
    vi.doMock('node:worker_threads', () => ({ ...wt, default: wt, Worker: CountingWorker }))
    const pol = await vi.importActual<typeof import('../../src/infrastructure/generation-policy.js')>('../../src/infrastructure/generation-policy.js')
    vi.doMock('../../src/infrastructure/generation-policy.js', () => ({ ...pol,
      readStoredGenerationPolicy: (...a: Parameters<typeof pol.readStoredGenerationPolicy>) => { counts.policy += 1; return pol.readStoredGenerationPolicy(...a) },
      readGraphGenerationPolicy: (...a: Parameters<typeof pol.readGraphGenerationPolicy>) => { counts.policy += 1; return pol.readGraphGenerationPolicy(...a) } }))
    const gen = await vi.importActual<typeof import('../../src/infrastructure/generate.js')>('../../src/infrastructure/generate.js')
    vi.doMock('../../src/infrastructure/generate.js', () => ({ ...gen,
      generateGraph: (...a: Parameters<typeof gen.generateGraph>) => { counts.generate += 1; return gen.generateGraph(...a) } }))

    const realSetTimeout = globalThis.setTimeout
    const realSetInterval = globalThis.setInterval
    globalThis.setTimeout = ((...a: Parameters<typeof realSetTimeout>) => { counts.timers += 1; return realSetTimeout(...a) }) as typeof realSetTimeout
    globalThis.setInterval = ((...a: Parameters<typeof realSetInterval>) => { counts.timers += 1; return realSetInterval(...a) }) as typeof realSetInterval

    try {
      const { serveGraphStdio } = await import('../../src/runtime/stdio-server.js')
      const input = new PassThrough()
      const output = new PassThrough()
      const errorOutput = new PassThrough()
      input.end(`${JSON.stringify({ id: 1, method: 'ping' })}\n`)
      await serveGraphStdio({ graphPath: first.graphPath, autoRefresh: true, input, output, errorOutput })

      expect(counts.watcher, 'LEGACY_AUTO_REFRESH_STARTED_REFRESH (watcher)').toBe(0)
      expect(counts.worker, 'LEGACY_AUTO_REFRESH_STARTED_REFRESH (worker)').toBe(0)
      expect(counts.timers, 'LEGACY_AUTO_REFRESH_STARTED_REFRESH (timer)').toBe(0)
      expect(counts.policy, 'LEGACY_AUTO_REFRESH_STARTED_REFRESH (policy)').toBe(0)
      expect(counts.generate, 'LEGACY_AUTO_REFRESH_STARTED_REFRESH (generation)').toBe(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.setInterval = realSetInterval
      for (const m of ['node:fs', 'node:worker_threads', '../../src/infrastructure/generation-policy.js',
                       '../../src/infrastructure/generate.js']) vi.doUnmock(m)
      vi.resetModules()
    }
  })

  test('doctor explains a legacy profile rather than calling it healthy in silence', () => {
    const dir = fixture()
    generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '## madar\n')
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { madar: { command: 'madar', args: ['serve', '--stdio', '--auto-refresh'] } },
    }))

    const output = runDoctorCommand({ projectDir: dir, now: Date.now() })
    expect(output, 'LEGACY_PROFILE_REPORTED_UNHEALTHY').toContain('mcp=ok')
    expect(output, 'LEGACY_PROFILE_NOT_EXPLAINED').toContain(LEGACY_AUTO_REFRESH_PROFILE_NOTE.slice(0, 60))
  })

  test('newly generated profiles omit the flag', () => {
    const installSource = readFileSync(resolve('src/infrastructure/install.ts'), 'utf8')
    // Rendered launcher arguments, not prose: no generator may emit the flag.
    for (const emitted of [
      "['serve', '--stdio', '--auto-refresh']",
      '"serve", "--stdio", "--auto-refresh"',
      "'serve', '--stdio', '--auto-refresh'",
    ]) {
      expect(installSource, 'NEW_PROFILE_STILL_EMITS_THE_FLAG').not.toContain(emitted)
    }
  })
})
