import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { resolveGraphArtifact } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { startGraphServer } from '../../src/runtime/http-server.js'
import { generatedGraphDiscoverySource } from '../../src/shared/generated-graph-discovery.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

/** Hygiene contracts for the artifact surfaces: headers, descriptors, paths. */

const SILENT = { log: () => undefined, error: () => undefined }

describe('HTTP freshness headers describe the artifact in the body', () => {
  let root: string
  let handle: Awaited<ReturnType<typeof startGraphServer>>

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hygiene-http-'))
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'graph.json'), JSON.stringify({
      schema_version: 1,
      directed: true,
      nodes: [{ id: 'a', label: 'alpha()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' }],
      links: [],
    }))
    handle = await startGraphServer({ graphPath: join(root, 'out', 'graph.json'), port: 0, logger: SILENT })
  })

  afterAll(async () => {
    await handle.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('sizes the legacy response against the legacy artifact it served', async () => {
    const response = await fetch(`${handle.url}graph.json`)
    const body = await response.text()

    // The headers measured the configured path rather than the served file, so
    // etag and the resource-byte headers could describe a different artifact
    // than the bytes they accompany.
    expect(response.status).toBe(200)
    expect(Number(response.headers.get('x-madar-resource-bytes'))).toBe(Buffer.byteLength(body, 'utf8'))
    expect(response.headers.get('etag')).toBeTruthy()
  }, 120_000)
})

describe('the generated classifier closes descriptors it opens', () => {
  it('does not leak when the read fails after a successful open', () => {
    const root = mkdtempSync(join(tmpdir(), 'hygiene-fd-'))
    try {
      // A directory opens but cannot be read: openSync succeeds, readSync
      // raises EISDIR. That is the shape of the failing-mount case too.
      mkdirSync(join(root, 'out', 'graph.madar'), { recursive: true })

      // eslint-disable-next-line no-new-func
      const build = new Function('require', `${generatedGraphDiscoverySource('commonjs')}
        return classifyMadarWorkspace`) as (r: NodeRequire) => (d: string) => { graphState: string }
      const classify = build(createRequire(import.meta.url))

      const openDescriptors = (): number => {
        try {
          return readdirSync('/dev/fd').length
        } catch {
          return -1
        }
      }

      expect(classify(root).graphState).toBe('none')
      const before = openDescriptors()
      for (let attempt = 0; attempt < 40; attempt += 1) classify(root)
      const after = openDescriptors()

      // Forty failing reads leaked forty descriptors before the finally block.
      if (before >= 0) expect(after - before).toBeLessThan(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('refusals never name a private worktree directory', () => {
  it('keeps the linked-worktree artifact directory out of every refusal', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hygiene-refusal-'))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')
    const git = (args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' })
    }
    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      git(['-C', primary, '-c', 'user.email=tests@example.com', '-c', 'user.name=Tests', 'commit', '--allow-empty', '-m', 'initial'])
      git(['-C', primary, 'worktree', 'add', '-b', 'hygiene/refusal', linked])

      const workspace = resolveMadarWorkspace(linked)
      mkdirSync(workspace.outputDir, { recursive: true })
      writeFileSync(workspace.legacyGraphPath, GRAPH_ARTIFACT_V2_TOMBSTONE)

      const messages: string[] = []
      for (const requested of [workspace.legacyGraphPath, workspace.canonicalGraphPath]) {
        try {
          resolveGraphArtifact(requested, { intent: 'explicit', logicalOutputDir: 'out' })
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error))
        }
      }

      // Two refusals interpolated the requested path directly instead of
      // routing it through the display boundary every other message uses.
      expect(messages.length).toBe(2)
      for (const message of messages) {
        expect(message).not.toContain('.git/madar/worktrees')
        expect(message).not.toContain(workspace.outputDir)
      }
    } finally {
      try {
        execFileSync('git', ['-C', primary, 'worktree', 'remove', '--force', linked], { stdio: 'pipe' })
      } catch {
        // Temp cleanup below handles a partially-created worktree.
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 120_000)
})
