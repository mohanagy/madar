import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import { GraphArtifactStateError } from '../../src/contracts/graph-artifact-selection.js'
import {
  isDefaultGraphPathSpelling,
  normalizeGraphPathSpelling,
  resolveMadarWorkspace,
  resolveWorkspaceGraphArtifact,
} from '../../src/shared/workspace.js'

const GIT_TIMEOUT_MS = 30_000

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true })
}

function canonicalArtifact(): Buffer {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-16T00:00:00.000Z',
  })
}

const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
}

describe('workspace-aware artifact selection', () => {
  let tempDir: string
  let linked: string
  let workspace: ReturnType<typeof resolveMadarWorkspace>

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'madar-selection-worktree-'))
    const primary = join(tempDir, 'primary')
    linked = join(tempDir, 'linked')
    git(tempDir, ['init', primary])
    git(primary, ['config', 'user.email', 'madar-tests@example.com'])
    git(primary, ['config', 'user.name', 'Madar Tests'])
    writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8')
    git(primary, ['add', '.'])
    git(primary, ['commit', '-m', 'initial'])
    git(primary, ['worktree', 'add', '-b', 'feature/selection', linked])

    workspace = resolveMadarWorkspace(linked)
    mkdirSync(workspace.outputDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeWorkspaceArtifacts(files: Partial<Record<'canonical' | 'legacy', string | Buffer>>): void {
    rmSync(workspace.outputDir, { recursive: true, force: true })
    mkdirSync(workspace.outputDir, { recursive: true })
    if (files.canonical !== undefined) writeFileSync(workspace.canonicalGraphPath, files.canonical)
    if (files.legacy !== undefined) writeFileSync(workspace.legacyGraphPath, files.legacy)
  }

  it('confirms the fixture is a linked worktree with a redirected output directory', () => {
    expect(workspace.isLinkedWorktree).toBe(true)
    // Everything below is only meaningful because physical != logical here.
    expect(isInside(workspace.outputDir, linked)).toBe(false)
  })

  it('reads the redirected artifact while reporting the conventional path', () => {
    writeWorkspaceArtifacts({ canonical: canonicalArtifact(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })

    const selection = resolveWorkspaceGraphArtifact({ intent: 'default', workspaceRoot: linked })

    expect(selection.selectedPhysicalPath).toBe(workspace.canonicalGraphPath)
    expect(selection.selectedLogicalPath).toBe('out/graph.madar')
    // The private worktree directory must never reach public output. Asserted
    // on the pair rather than on the logical path alone: the line above already
    // pins that to a literal, so a `not.toContain` on it could never fail.
    expect(selection.selectedPhysicalPath).toContain(workspace.outputDir)
    expect(isInside(selection.selectedPhysicalPath, linked)).toBe(false)
  })

  it('reports the legacy logical path when the workspace is pre-cutover', () => {
    writeWorkspaceArtifacts({ legacy: LIVE_V1 })

    const selection = resolveWorkspaceGraphArtifact({ intent: 'default', workspaceRoot: linked })

    // Not 'out/graph.madar' -- the logical path follows what was selected.
    expect(selection.selectedLogicalPath).toBe('out/graph.json')
    expect(selection.selectedPhysicalPath).toBe(workspace.legacyGraphPath)
    expect(selection.format).toBe('v1')
  })

  it.each([
    'out/graph.madar',
    './out/graph.madar',
    'out\\graph.madar',
    '.\\out\\graph.madar',
    'out/graph.json',
    './out/graph.json',
    'out\\graph.json',
    '.\\out\\graph.json',
  ])('routes the conventional spelling %s to the same redirected artifact', (spelling) => {
    writeWorkspaceArtifacts({ canonical: canonicalArtifact(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })

    const selection = resolveWorkspaceGraphArtifact({
      intent: 'default',
      requestedPath: spelling,
      workspaceRoot: linked,
    })

    expect(selection.selectedPhysicalPath).toBe(workspace.canonicalGraphPath)
    expect(selection.requestedPath).toBe(spelling)
  })

  it.each([
    ['out\\graph.madar', 'explicit_v2'],
    ['.\\out\\graph.madar', 'explicit_v2'],
    ['out/graph.madar', 'explicit_v2'],
    ['out\\graph.json', 'explicit_legacy'],
    ['.\\out\\graph.json', 'explicit_legacy'],
    ['out/graph.json', 'explicit_legacy'],
  ])('resolves the spelling %s by basename under explicit intent', (spelling, expected) => {
    // Under default intent the basename is irrelevant -- classification is
    // directory-based, so every spelling above takes one identical path and the
    // table proves nothing about normalization. Explicit intent dispatches on
    // the basename, so here a lost backslash actually changes the answer.
    writeWorkspaceArtifacts({ canonical: canonicalArtifact(), legacy: LIVE_V1 })

    const selection = resolveWorkspaceGraphArtifact({
      intent: 'explicit',
      requestedPath: spelling,
      workspaceRoot: linked,
    })

    expect(selection.selection).toBe(expected)
  })

  it('leaves a non-conventional explicit path outside the workspace alone', () => {
    writeWorkspaceArtifacts({ canonical: canonicalArtifact(), legacy: GRAPH_ARTIFACT_V2_TOMBSTONE })
    const elsewhere = join(tempDir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const explicitPath = join(elsewhere, 'graph.json')
    writeFileSync(explicitPath, LIVE_V1)

    const selection = resolveWorkspaceGraphArtifact({
      intent: 'explicit',
      requestedPath: explicitPath,
      workspaceRoot: linked,
    })

    // Serving an arbitrary artifact still works and is not redirected.
    expect(selection.selectedPhysicalPath).toBe(explicitPath)
    expect(selection.selectedLogicalPath).toBe(explicitPath)
  })

  it.each([
    ['mixed', { canonical: canonicalArtifact(), legacy: LIVE_V1 }],
    ['moved without canonical', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }],
    ['invalid canonical', { canonical: 'broken', legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }],
    ['missing', {}],
  ])('keeps the private worktree path out of the %s refusal', (_label, files) => {
    writeWorkspaceArtifacts(files as never)

    let thrown: GraphArtifactStateError | undefined
    try {
      resolveWorkspaceGraphArtifact({ intent: 'default', workspaceRoot: linked })
    } catch (error) {
      thrown = error as GraphArtifactStateError
    }

    expect(thrown).toBeInstanceOf(GraphArtifactStateError)
    const error = thrown as GraphArtifactStateError

    // Refusals are the states an operator most needs to read, so this is
    // exactly where the redirected physical directory must not appear.
    const fields = [
      error.message,
      error.tombstonePath ?? '',
      error.expectedCanonicalPath ?? '',
      error.legacyBackupPath ?? '',
    ]
    for (const field of fields) {
      expect(field).not.toContain(workspace.outputDir)
      expect(field).not.toContain('worktrees')
      expect(field).not.toContain('.git')
    }
    expect(error.expectedCanonicalPath).toBe('out/graph.madar')
    expect(error.tombstonePath).toBe('out/graph.json')
  })

  it('separates default and explicit intent for the identical path text', () => {
    writeWorkspaceArtifacts({ canonical: canonicalArtifact(), legacy: LIVE_V1 })

    expect(() => resolveWorkspaceGraphArtifact({
      intent: 'default',
      requestedPath: 'out/graph.json',
      workspaceRoot: linked,
    })).toThrow(GraphArtifactStateError)

    const explicit = resolveWorkspaceGraphArtifact({
      intent: 'explicit',
      requestedPath: 'out/graph.json',
      workspaceRoot: linked,
    })

    // Same six characters of path, opposite outcomes -- which is why intent
    // cannot be inferred from the string.
    expect(explicit.format).toBe('v1')
    expect(explicit.workspaceState).toBe('mixed_v2_and_live_v1')
  })
})

describe('path spelling helpers', () => {
  it.each([
    ['out/graph.madar', 'out/graph.madar'],
    ['./out/graph.madar', 'out/graph.madar'],
    ['out\\graph.madar', 'out/graph.madar'],
    ['.\\out\\graph.madar', 'out/graph.madar'],
    ['././out/graph.json', 'out/graph.json'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGraphPathSpelling(input)).toBe(expected)
  })

  it.each(['out/graph.madar', './out/graph.madar', 'out\\graph.json', '.\\out\\graph.json'])(
    'recognizes %s as a workspace default spelling',
    (spelling) => {
      expect(isDefaultGraphPathSpelling(spelling)).toBe(true)
    },
  )

  it.each(['graph.madar', 'other/graph.madar', 'out/graph.v1.json', '/abs/out/graph.madar'])(
    'does not treat %s as a workspace default spelling',
    (spelling) => {
      expect(isDefaultGraphPathSpelling(spelling)).toBe(false)
    },
  )
})
