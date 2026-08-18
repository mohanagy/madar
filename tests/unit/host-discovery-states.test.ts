import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { geminiInstall } from '../../src/infrastructure/install.js'
import { generatedGraphDiscoverySource } from '../../src/shared/generated-graph-discovery.js'

/**
 * Generated host discovery must classify the workspace, not ask whether a file
 * exists.
 *
 * Existence was wrong in both directions after the cutover: graph.json survives
 * as a tombstone, and a workspace holding only graph.madar looked empty. It also
 * could not tell a healthy workspace from an ambiguous or corrupt one. This
 * table is the check that a future "just use existsSync" simplification fails.
 *
 * The matrix runs the snippet the installer actually generates, in process, and
 * asserts the state it computes rather than the boolean it prints -- a boolean
 * cannot distinguish "classified as unusable" from "could not read the file", and
 * the earlier subprocess-per-case version was heavy enough to hit that second
 * case under load and read it as a verdict. Two cases below still go through the
 * real shell command, which is what proves the snippet works as generated.
 */

const VALID_V2 = 'MADAR_GRAPH_ARTIFACT/2\n{"nodes":[],"facts":[]}'
const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], links: [] })

const CLASSIFIER_FUNCTION = 'classifyMadarWorkspace'

interface WorkspaceFiles {
  readonly canonical?: string
  readonly legacy?: string
  readonly backup?: string
  readonly gitFile?: boolean
}

interface Discovery {
  readonly graphState: string
  readonly linkedWorktree: boolean
  readonly hasGraph: boolean
  readonly legacyGraph: boolean
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

/** The BeforeTool command the installer generated for this workspace. */
function generatedHookCommand(root: string): string {
  geminiInstall(root)
  const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  const command = settings.hooks?.BeforeTool?.[0]?.hooks?.[0]?.command
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('installer generated no BeforeTool command')
  }
  if (!command.includes(CLASSIFIER_FUNCTION)) {
    throw new Error(`generated command does not embed ${CLASSIFIER_FUNCTION}`)
  }
  return command
}

/**
 * Runs the shipped classifier generator verbatim, from `cwd`.
 *
 * Evaluating the generator's own text rather than a copy is the point: a
 * reimplementation here could pass while what ships to hosts does not. The
 * generated command is separately asserted to embed this same function, which
 * is the seam that keeps the two from drifting.
 */
function classifyFrom(_command: string, cwd: string): Discovery {
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('require', `${generatedGraphDiscoverySource('commonjs')}
    return ${CLASSIFIER_FUNCTION}`) as (requireFn: NodeRequire) => (directory: string) => Discovery

  return evaluate(createRequire(import.meta.url))(cwd)
}

/** Runs the generated hook end to end and reports whether it emitted guidance. */
function hookReportsGraph(root: string): boolean {
  const command = generatedHookCommand(root)
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

  // A hook that never ran is not an answer. Reporting false here would let every
  // "not ready" expectation pass for the wrong reason.
  if (result.error) throw result.error
  if (typeof result.status !== 'number') {
    throw new Error(`hook did not run to completion: signal=${String(result.signal)}`)
  }
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${`${result.stderr ?? ''}`.slice(0, 200)}`)
  }
  return `${result.stdout ?? ''}`.includes('additionalContext')
}

describe('generated host discovery classifies the workspace', () => {
  it.each([
    ['current v2 with a tombstone', { canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'current', true],
    ['canonical only, no tombstone', { canonical: VALID_V2 }, 'current', true],
    ['legacy v1 only', { legacy: LIVE_V1 }, 'legacy', true],
    ['a mixed B1 workspace', { canonical: VALID_V2, legacy: LIVE_V1 }, 'mixed', false],
    ['a tombstone alone', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }, 'moved', false],
    ['a tombstone with a preserved backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'moved', false],
    ['a corrupt canonical beside a tombstone and backup',
      { canonical: 'MADAR_NOT_AN_ARTIFACT', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }, 'invalid', false],
    ['an empty workspace', {}, 'none', false],
    // A correct header with a truncated body passes a bounded prefix check.
    // Deliberate: discovery is a hint, and the runtime loader is what refuses
    // the artifact before anything is answered from it.
    ['a truncated canonical body', { canonical: 'MADAR_GRAPH_ARTIFACT/2\n{ "nodes": [' }, 'current', true],
  ])('reads %s as %s (ready=%s)', (_label, files, state, ready) => {
    const root = workspace(files as WorkspaceFiles)
    try {
      const command = generatedHookCommand(root)
      const nested = join(root, 'nested', 'session')
      mkdirSync(nested, { recursive: true })

      // Classified from a nested directory: the snippet has to walk up to the
      // workspace before it can classify anything.
      expect(classifyFrom(command, nested)).toMatchObject({ graphState: state, hasGraph: ready })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks only a live v1 workspace as the legacy case', () => {
    const legacy = workspace({ legacy: LIVE_V1 })
    const current = workspace({ canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    try {
      // legacyGraph drives the degraded guidance. A cut-over workspace claiming
      // it would tell the host to keep using the artifact that was retired.
      expect(classifyFrom(generatedHookCommand(legacy), legacy).legacyGraph).toBe(true)
      expect(classifyFrom(generatedHookCommand(current), current).legacyGraph).toBe(false)
    } finally {
      rmSync(legacy, { recursive: true, force: true })
      rmSync(current, { recursive: true, force: true })
    }
  })

  it('keeps the linked-worktree hint without inspecting an artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-discovery-worktree-'))
    writeFileSync(join(root, '.git'), 'gitdir: ../.git/worktrees/linked\n')
    try {
      // A linked worktree stores artifacts outside the checkout, behind a
      // workspace hash the generated snippet cannot compute. The hint says the
      // MCP server will build a graph, not that one was found.
      const discovery = classifyFrom(generatedHookCommand(root), root)

      expect(discovery).toMatchObject({ graphState: 'none', linkedWorktree: true, hasGraph: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops climbing at the first workspace it finds', () => {
    // An unusable inner workspace must not be resolved by a healthy outer one.
    const outer = workspace({ canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    const inner = join(outer, 'packages', 'inner')
    mkdirSync(join(inner, 'out'), { recursive: true })
    writeFileSync(join(inner, 'out', 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)
    try {
      expect(classifyFrom(generatedHookCommand(outer), inner)).toMatchObject({
        graphState: 'moved',
        hasGraph: false,
      })
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  /*
   * Executed without a shell, on every platform including Windows.
   *
   * An earlier version ran the generated command through `cmd /c` on Windows,
   * where quoting mangled the program before node saw it. That measured the
   * harness, not the product. #705 changed the generated program, so recording
   * Windows as an unverified gap was not good enough -- the program is spawned
   * directly instead, with argv carrying the program and its base64 payloads.
   *
   * Splitting on the double quote is safe precisely because the generator
   * refuses to emit one; see escapeGeneratedString.
   */
  const spawnGeneratedProgram = (command: string, cwd: string): { status: number | null, stdout: string } => {
    const parts = command.split('"')
    const program = parts[1]
    const payloads = parts.slice(2).map((part) => part.trim()).filter((part) => part.length > 0)
    if (typeof program !== 'string' || payloads.length === 0) {
      throw new Error(`could not split the generated command into a program and payloads: ${command.slice(0, 80)}`)
    }

    const result = spawnSync(process.execPath, ['-e', program, ...payloads], {
      cwd,
      input: JSON.stringify({ tool_name: 'read_file' }),
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    return { status: result.status, stdout: `${result.stdout ?? ''}` }
  }

  describe('the generated program runs as written, without a shell', () => {
    it('emits guidance for a cut-over workspace', () => {
      const root = workspace({ canonical: VALID_V2, legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
      try {
        const nested = join(root, 'nested', 'session')
        mkdirSync(nested, { recursive: true })
        const result = spawnGeneratedProgram(generatedHookCommand(root), nested)

        expect(result.status).toBe(0)
        expect(result.stdout).toContain('additionalContext')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('stays silent when only the tombstone remains', () => {
      const root = workspace({ legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
      try {
        const nested = join(root, 'nested', 'session')
        mkdirSync(nested, { recursive: true })
        const result = spawnGeneratedProgram(generatedHookCommand(root), nested)

        expect(result.status).toBe(0)
        expect(result.stdout).not.toContain('additionalContext')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('qualifies the guidance for a legacy workspace', () => {
      const root = workspace({ legacy: LIVE_V1 })
      try {
        const nested = join(root, 'nested', 'session')
        mkdirSync(nested, { recursive: true })
        const result = spawnGeneratedProgram(generatedHookCommand(root), nested)

        // Sibling cases assert this; a program that failed after printing
        // partial output would otherwise satisfy both string checks.
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('additionalContext')
        expect(result.stdout).toContain('legacy out/graph.json')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
