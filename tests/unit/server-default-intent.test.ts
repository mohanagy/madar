import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { startGraphServer } from '../../src/runtime/http-server.js'

/**
 * The server boundary must not turn an omitted path into an explicit one.
 *
 * `startGraphServer` and `serveGraph` substituted `out/graph.madar` for an
 * omitted option and handed that to `validateGraphPath`, which treats a
 * base-less request as explicit. Every server start therefore looked explicit,
 * and a server launched with no `--graph` in an ambiguous workspace loaded the
 * canonical artifact instead of failing closed the way every other default load
 * does.
 */

const SILENT = { log: () => undefined, error: () => undefined }
const STALE_V1 = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'stale', label: 'stale', file_type: 'code', source_file: 'stale.ts' }],
  links: [],
})

describe('the server preserves default-vs-explicit intent', () => {
  let root: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    root = mkdtempSync(join(tmpdir(), 'server-intent-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
    generateGraph(root, { noHtml: true })
    writeFileSync(join(root, 'out', 'graph.json'), STALE_V1)
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('starts from a genuinely mixed workspace', () => {
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('mixed_v2_and_live_v1')
  })

  it('refuses to start with no graph option in a mixed workspace', async () => {
    let message = ''
    let handle: Awaited<ReturnType<typeof startGraphServer>> | null = null
    try {
      handle = await startGraphServer({ port: 0, logger: SILENT })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    if (handle) await handle.close()

    // Serving here would answer from one of two artifacts without being able to
    // say which is current.
    expect(message).toMatch(/graph\.madar/)
    expect(message).toMatch(/madar generate \./)
  }, 120_000)

  it('still starts when the canonical artifact is named explicitly', async () => {
    // Explicit selection stays available for diagnostics; the refusal above is
    // about an ambiguous default, not about the artifact being unusable.
    const handle = await startGraphServer({
      graphPath: join(root, 'out', 'graph.madar'),
      port: 0,
      logger: SILENT,
    })
    try {
      expect(handle.url).toMatch(/^http/)
    } finally {
      await handle.close()
    }
  }, 120_000)

  it('starts with no graph option once the workspace is unambiguous', async () => {
    generateGraph(root, { noHtml: true })
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

    // The paired control: the refusal is about ambiguity, not about defaults.
    const handle = await startGraphServer({ port: 0, logger: SILENT })
    try {
      expect(handle.url).toMatch(/^http/)
    } finally {
      await handle.close()
    }
  }, 180_000)
})
