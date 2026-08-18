import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { serveGraphStdio } from '../../src/runtime/stdio-server.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

/**
 * `serve --stdio --auto-refresh` must accept the artifact its own workspace has.
 *
 * The guard that rejects a graph belonging to a different worktree compared the
 * requested path against a single spelling -- the legacy one -- so after the
 * cutover it refused `out/graph.madar` for the very workspace it was started
 * from. That is the command the MCP registry entry runs and the one the
 * generated agent configs use, so every host launch would have failed while the
 * existing tests stayed green: their fixtures are hand-written v1 graphs, which
 * matched the spelling the guard happened to check.
 *
 * Both artifacts belong to the workspace, so both must pass, and a graph from
 * somewhere else must still be refused.
 */

/** Starts the server just far enough to run the guard, then stops. */
async function startAndStop(graphPath: string, workspaceRoot: string): Promise<string> {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let started = false

  const serverPromise = serveGraphStdio({
    graphPath,
    autoRefresh: true,
    workspaceRoot,
    autoRefreshStarter: () => {
      started = true
      return { stop: () => undefined, invalidate: () => undefined } as never
    },
    input,
    output,
    errorOutput,
  })

  input.end()
  try {
    await serverPromise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  // A silent no-start would let the refusal case pass for the wrong reason.
  return started ? '' : 'auto-refresh never started'
}

describe('auto-refresh accepts the artifact the workspace has', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autorefresh-canonical-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
    generateGraph(root, { noHtml: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts the canonical artifact of a cut-over workspace', async () => {
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

    expect(await startAndStop(join(root, 'out', 'graph.madar'), root)).toBe('')
  })

  it('accepts the legacy artifact of a workspace that never cut over', async () => {
    // Still supported, and the spelling the guard used to check exclusively.
    rmSync(join(root, 'out', 'graph.madar'))
    writeFileSync(join(root, 'out', 'graph.json'), JSON.stringify({
      schema_version: 1,
      directed: true,
      root_path: root,
      nodes: [{ id: 'a', label: 'alpha()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' }],
      links: [],
    }))
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('legacy_v1_only')

    expect(await startAndStop(join(root, 'out', 'graph.json'), root)).toBe('')
  })

  it('still refuses a graph belonging to another workspace', async () => {
    const other = mkdtempSync(join(tmpdir(), 'autorefresh-other-'))
    try {
      mkdirSync(join(other, 'out'), { recursive: true })
      writeFileSync(join(other, 'out', 'graph.madar'), 'MADAR_GRAPH_ARTIFACT/2\n{"nodes":[],"facts":[]}')

      // The guard's actual purpose: refreshing this workspace would rebuild a
      // graph the caller did not ask about.
      const message = await startAndStop(join(other, 'out', 'graph.madar'), root)

      expect(message).toMatch(/Refusing to auto-refresh/)
      expect(message).toMatch(/intended worktree/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('names both artifacts of the workspace it checks against', () => {
    // The alias that caused this returned the legacy path from a field named
    // `graphPath`, so a caller reading it got one artifact without choosing.
    const workspace = resolveMadarWorkspace(root)

    expect(workspace.canonicalGraphPath.endsWith('graph.madar')).toBe(true)
    expect(workspace.legacyGraphPath.endsWith('graph.json')).toBe(true)
    // `in`, not Object.keys: the alias must be unreachable, and own-enumerable
    // is only one of the ways it could come back.
    expect('graphPath' in workspace).toBe(false)
  })

  it('accepts the canonical artifact while the tombstone sits beside it', async () => {
    // The published shape: both files present, only one of them a graph.
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    writeFileSync(join(root, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

    expect(await startAndStop(join(root, 'out', 'graph.madar'), root)).toBe('')
  })
})
