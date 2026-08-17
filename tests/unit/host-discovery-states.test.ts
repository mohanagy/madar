import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { geminiInstall } from '../../src/infrastructure/install.js'

/**
 * Generated host discovery must classify the workspace, not ask whether a file
 * exists.
 *
 * Existence was wrong in both directions after the cutover: graph.json survives
 * as a tombstone, and a workspace holding only graph.madar looked empty. It also
 * could not tell a healthy workspace from an ambiguous or corrupt one. This
 * table is the check that a future "just use existsSync" simplification fails.
 */

const VALID_V2 = 'MADAR_GRAPH_ARTIFACT/2\n{"nodes":[],"facts":[]}'
const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], links: [] })

interface WorkspaceFiles {
  readonly canonical?: string
  readonly legacy?: string
  readonly backup?: string
  readonly gitFile?: boolean
}

function workspace(files: WorkspaceFiles): string {
  const root = mkdtempSync(join(tmpdir(), 'host-discovery-'))
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  if (files.canonical !== undefined) writeFileSync(join(out, 'graph.madar'), files.canonical)
  if (files.legacy !== undefined) writeFileSync(join(out, 'graph.json'), files.legacy)
  if (files.backup !== undefined) writeFileSync(join(out, 'graph.v1.json'), files.backup)
  if (files.gitFile === true) writeFileSync(join(root, '.git'), 'gitdir: ../.git/worktrees/linked\n')
  return root
}

/** Runs the generated hook and reports whether it emitted graph guidance. */
function hookReportsGraph(root: string): boolean {
  geminiInstall(root)
  const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  const command = settings.hooks?.BeforeTool?.[0]?.hooks?.[0]?.command ?? ''
  const nested = join(root, 'nested', 'session')
  mkdirSync(nested, { recursive: true })

  const controlled = process.platform === 'win32'
    ? command
    : `export PATH="${dirname(process.execPath)}:$PATH"; ${command}`
  const result = spawnSync(
    process.platform === 'win32' ? 'cmd' : 'sh',
    process.platform === 'win32' ? ['/c', controlled] : ['-c', controlled],
    { cwd: nested, input: JSON.stringify({ tool_name: 'read_file' }), encoding: 'utf8' },
  )
  return `${result.stdout ?? ''}`.includes('additionalContext')
}

describe('generated host discovery classifies the workspace', () => {
  it.each([
    ['current v2 with a tombstone', { canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, true],
    ['canonical only, no tombstone', { canonical: VALID_V2 }, true],
    ['legacy v1 only', { legacy: LIVE_V1 }, true],
    ['mixed B1 workspace', { canonical: VALID_V2, legacy: LIVE_V1 }, false],
    ['tombstone only', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, false],
    ['tombstone with a preserved backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, false],
    ['corrupt canonical with tombstone and backup',
      { canonical: 'MADAR_NOT_AN_ARTIFACT', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, false],
  ])('reports %s as ready=%s', (_label, files, expected) => {
    const root = workspace(files as WorkspaceFiles)
    try {
      expect(hookReportsGraph(root)).toBe(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the linked-worktree hint without inspecting an artifact', () => {
    const root = workspace({ gitFile: true })
    try {
      // A linked worktree stores artifacts outside the checkout, behind a
      // workspace hash the generated snippet cannot compute. The hint says the
      // MCP server will build a graph, not that one was found.
      expect(hookReportsGraph(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is not satisfied by an empty workspace', () => {
    const root = workspace({})
    try {
      expect(hookReportsGraph(root)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a truncated canonical body as a hint, leaving validation to the loader', () => {
    // A correct header with a truncated body passes a bounded prefix check.
    // That is deliberate: discovery is a hint, and the runtime loader is what
    // refuses the artifact before anything is answered from it.
    const root = workspace({ canonical: 'MADAR_GRAPH_ARTIFACT/2\n{ "nodes": [' })
    try {
      expect(hookReportsGraph(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
