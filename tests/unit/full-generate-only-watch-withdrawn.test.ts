import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'

/**
 * vi.resetModules() gives the re-imported handler a different class identity, so
 * `instanceof` compares two distinct constructors. The typed contract - code and
 * mode - is identity-independent and is what callers actually depend on.
 */
const expectUnsupportedMode = (error: unknown, mode: string): void => {
  const typed = error as { code?: string, mode?: string }
  expect(typed.code).toBe('UNSUPPORTED_GENERATION_MODE')
  expect(typed.mode).toBe(mode)
}
import { readStoredGenerationPolicy } from '../../src/infrastructure/generation-policy.js'
import { resolveMadarOutputDirectory } from '../../src/shared/workspace.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — watch / auto-refresh withdrawal.
 *
 * Automatic semantic refresh is not part of the stable profile. The refusal must
 * happen before the stored generation policy is read, before a watcher or worker
 * starts, and before anything is published.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-watch-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  return dir
}

describe('FULL-GENERATE-ONLY watch withdrawal', () => {
  test('precondition: the real stored-policy reader accepts the seeded policy at the production path', () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const outputDir = resolveMadarOutputDirectory(dir)

    // The policy the old auto-refresh path reconstructed its inputs from.
    const policy = readStoredGenerationPolicy(first.graphPath, join(outputDir, 'manifest.json'))
    expect(policy).not.toBeNull()
    expect(typeof policy?.fingerprint).toBe('string')
  })

  test('watch refuses before reading the stored generation policy or starting anything', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const before = readFileSync(first.graphPath)
    const outputDirBefore = readdirSync(resolveMadarOutputDirectory(dir)).sort()

    vi.resetModules()
    const actualPolicy = await vi.importActual<typeof import('../../src/infrastructure/generation-policy.js')>(
      '../../src/infrastructure/generation-policy.js',
    )
    let policyReads = 0
    vi.doMock('../../src/infrastructure/generation-policy.js', () => ({
      ...actualPolicy,
      readStoredGenerationPolicy: (...args: Parameters<typeof actualPolicy.readStoredGenerationPolicy>) => {
        policyReads += 1
        return actualPolicy.readStoredGenerationPolicy(...args)
      },
      readGraphGenerationPolicy: (...args: Parameters<typeof actualPolicy.readGraphGenerationPolicy>) => {
        policyReads += 1
        return actualPolicy.readGraphGenerationPolicy(...args)
      },
    }))

    try {
      const watchModule = await import('../../src/infrastructure/watch.js')
      await watchModule.watch(dir, 0, {}).then(
        () => { throw new Error('expected a refusal') },
        (error: unknown) => expectUnsupportedMode(error, 'watch'),
      )

      expect(policyReads, 'WATCH_POLICY_READ_BEFORE_REFUSAL').toBe(0)
      expect(readFileSync(first.graphPath).equals(before)).toBe(true)
      expect(readdirSync(resolveMadarOutputDirectory(dir)).sort()).toStrictEqual(outputDirBefore)
    } finally {
      vi.doUnmock('../../src/infrastructure/generation-policy.js')
      vi.resetModules()
    }
  })

  test('auto-refresh refuses without registering a watcher or spawning a worker', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const before = readFileSync(first.graphPath)

    const watchModule = await import('../../src/infrastructure/watch.js')
    try { watchModule.startGraphAutoRefresh(dir, 0, {}); throw new Error('expected a refusal') }
    catch (error) { expectUnsupportedMode(error, 'auto-refresh') }

    const background = await import('../../src/infrastructure/background-auto-refresh.js')
    try { background.startGraphAutoRefreshInBackground(dir, 0, {}); throw new Error('expected a refusal') }
    catch (error) { expectUnsupportedMode(error, 'auto-refresh') }

    expect(readFileSync(first.graphPath).equals(before)).toBe(true)
  })

  test('rebuildCode refuses rather than continuing from persisted state', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const before = readFileSync(first.graphPath)

    const watchModule = await import('../../src/infrastructure/watch.js')
    try { watchModule.rebuildCode(dir, {}); throw new Error('expected a refusal') }
    catch (error) { expectUnsupportedMode(error, 'auto-refresh') }

    expect(readFileSync(first.graphPath).equals(before)).toBe(true)
  })
  test('serve --stdio --auto-refresh is accepted, states the stable-profile position, and refreshes nothing', async () => {
    const dir = fixture()
    const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const before = readFileSync(first.graphPath)
    const outputDirBefore = readdirSync(resolveMadarOutputDirectory(dir)).sort()

    vi.resetModules()
    // Counting real calls is the control. A refusal that fires only because the
    // starter throws would still mean the continuation had been attempted.
    let starterCalls = 0
    vi.doMock('../../src/infrastructure/background-auto-refresh.js', () => ({
      startGraphAutoRefreshInBackground: () => {
        starterCalls += 1
        throw new Error('the stdio server must never reach the auto-refresh starter')
      },
    }))

    try {
      const { serveGraphStdio } = await import('../../src/runtime/stdio-server.js')
      const input = new PassThrough()
      const output = new PassThrough()
      const errorOutput = new PassThrough()
      let outputText = ''
      let errorText = ''
      output.on('data', (chunk) => { outputText += chunk.toString('utf8') })
      errorOutput.on('data', (chunk) => { errorText += chunk.toString('utf8') })

      input.end(`${JSON.stringify({ id: 1, method: 'ping' })}\n`)
      await serveGraphStdio({ graphPath: first.graphPath, autoRefresh: true, input, output, errorOutput })

      // Accepted, not refused: the supported stdio server still answers.
      const messages = outputText.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line))
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ jsonrpc: '2.0', id: 1 })]))

      // Exactly one machine-readable diagnostic, not a prose line and not silence.
      const diagnostics = errorText.split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
        .filter((d): d is Record<string, unknown> => d?.code === 'UNSUPPORTED_GENERATION_MODE')
      expect(diagnostics, 'LEGACY_AUTO_REFRESH_FLAG_SILENTLY_IGNORED').toHaveLength(1)
      expect(diagnostics[0]).toStrictEqual({
        code: 'UNSUPPORTED_GENERATION_MODE',
        mode: 'auto-refresh',
        compatibility_action: 'ignored',
        message: 'automatic semantic refresh is unsupported; run ordinary full generation to refresh repository semantics',
      })
      expect(errorText).not.toMatch(/deprecated/i)

      expect(starterCalls, 'WATCH_WORKER_STARTED_BEFORE_REFUSAL').toBe(0)
      expect(readFileSync(first.graphPath).equals(before)).toBe(true)
      expect(readdirSync(resolveMadarOutputDirectory(dir)).sort()).toStrictEqual(outputDirBefore)
    } finally {
      vi.doUnmock('../../src/infrastructure/background-auto-refresh.js')
      vi.resetModules()
    }
  })
})
