import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraphArtifactFromPath, serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import {
  GraphArtifactActivationInterruptedError,
  type GraphArtifactActivationStep,
  GraphArtifactBackupError,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  activateGraphArtifactV2,
} from '../../src/infrastructure/graph-artifact-activation.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

const temporaryRoots: string[] = []

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label))
  temporaryRoots.push(root)
  return root
}

function v2Artifact(): Buffer {
  return serializeGraphArtifactV2({
    graph: new KnowledgeGraph({ directed: true }),
    repositoryRevision: 'revision-1',
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
  })
}

function legacyArtifact(label = 'legacy'): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    directed: true,
    nodes: [{ id: 'node', label }],
    links: [],
    hyperedges: [],
    community_labels: {},
  }), 'utf8')
}

function git(directory: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' })
}

function failureAt(stepToFail: GraphArtifactActivationStep) {
  return {
    beforeStep(step: GraphArtifactActivationStep): void {
      if (step === stepToFail) throw new Error(`injected ${step} failure`)
    },
  }
}

function legacyOutput(root: string): { outputDir: string; legacy: Buffer } {
  const outputDir = join(root, 'out')
  mkdirSync(outputDir)
  const legacy = legacyArtifact()
  writeFileSync(join(outputDir, 'graph.json'), legacy)
  return { outputDir, legacy }
}

function expectOriginalLegacyOnly(outputDir: string, legacy: Buffer): void {
  expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(legacy)
  expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
  expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('graph artifact v2 activation', () => {
  it('publishes v2 and the exact tombstone in a normal checkout output directory', () => {
    const root = temporaryRoot('madar activation ')
    git(root, ['init'])
    const artifact = v2Artifact()

    const result = activateGraphArtifactV2(root, artifact)

    expect(result.outputDir).toBe(join(root, 'out'))
    expect(readFileSync(join(root, 'out', 'graph.madar'))).toEqual(artifact)
    expect(readFileSync(join(root, 'out', 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    expect(existsSync(join(root, 'out', 'graph.v1.json'))).toBe(false)
  })

  it('uses the resolved primary-checkout output for paths containing spaces and Unicode', () => {
    const parent = temporaryRoot('madar activation parent ')
    const root = join(parent, 'prïmary checkout space')
    mkdirSync(root)
    git(root, ['init'])

    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.outputDir).toBe(resolveMadarWorkspace(root).outputDir)
    expect(result.outputDir).toBe(join(root, 'out'))
    expect(existsSync(join(root, 'out', 'graph.madar'))).toBe(true)
  })

  it('uses the primary Git directory artifact root for a linked worktree', () => {
    const parent = temporaryRoot('madar activation linked ünïcode ')
    const primary = join(parent, 'primary checkout')
    const linked = join(parent, 'linked worktree')
    mkdirSync(primary)
    git(primary, ['init'])
    git(primary, ['config', 'user.email', 'madar-tests@example.com'])
    git(primary, ['config', 'user.name', 'Madar Tests'])
    writeFileSync(join(primary, 'main.ts'), 'export const value = 1\n', 'utf8')
    git(primary, ['add', '.'])
    git(primary, ['commit', '-m', 'initial'])
    git(primary, ['worktree', 'add', '-b', 'artifact-activation-test', linked])

    const workspace = resolveMadarWorkspace(linked)
    const result = activateGraphArtifactV2(linked, v2Artifact())

    expect(workspace.isLinkedWorktree).toBe(true)
    expect(result.outputDir).toBe(workspace.outputDir)
    expect(existsSync(join(workspace.outputDir, 'graph.madar'))).toBe(true)
    expect(existsSync(join(linked, 'out'))).toBe(false)
  })

  it('preserves an existing valid v1 artifact byte-for-byte before tombstoning graph.json', () => {
    const root = temporaryRoot('madar activation legacy ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const legacy = legacyArtifact()
    writeFileSync(join(outputDir, 'graph.json'), legacy)

    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupCreated).toBe(true)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(legacy)
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
  })

  it('does not back up an existing tombstone as legacy v1', () => {
    const root = temporaryRoot('madar activation already cut over ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    writeFileSync(join(outputDir, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

    // An already-cut-over workspace is accounted for, so publication proceeds
    // and there is nothing to preserve.
    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupCreated).toBe(false)
    expect(result.legacyBackupStatus).toBe('none')
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
  })

  it.each([
    ['existing v2', v2Artifact()],
    ['corrupt JSON', Buffer.from('{')],
    ['unrelated JSON', Buffer.from('{"hello":"world"}')],
    ['future schema', Buffer.from('{"schema_version":99,"directed":true,"nodes":[],"links":[]}')],
  ])('refuses %s at the legacy path rather than discarding it', (_label, existingGraph) => {
    const root = temporaryRoot('madar activation invalid prior ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    writeFileSync(join(outputDir, 'graph.json'), existingGraph)

    // Previously this content was simply not backed up and the tombstone
    // replaced it, destroying whatever it was. Madar cannot classify it, so it
    // refuses instead.
    expect(() => activateGraphArtifactV2(root, v2Artifact())).toThrow(GraphArtifactBackupError)
    expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(Buffer.from(existingGraph))
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
  })

  it('cuts over with a live v1 that differs from the preserved backup', () => {
    const root = temporaryRoot('madar activation backup differs ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const currentLegacy = legacyArtifact('current')
    const preservedLegacy = legacyArtifact('already-preserved')
    writeFileSync(join(outputDir, 'graph.json'), currentLegacy)
    writeFileSync(join(outputDir, 'graph.v1.json'), preservedLegacy)
    expect(currentLegacy).not.toEqual(preservedLegacy)

    // Inverted deliberately. graph.v1.json records the first cutover and the
    // live file records whatever happened after it, so the two are expected to
    // diverge. Treating that as a conflict wedged the only repair a mixed
    // workspace has. The backup is still never rewritten.
    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupStatus).toBe('preserved_existing')
    expect(result.legacyBackupCreated).toBe(false)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(preservedLegacy)
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
  })

  it('refuses a preserved backup it cannot read, before any mutation', () => {
    const root = temporaryRoot('madar activation backup invalid ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const currentLegacy = legacyArtifact('current')
    writeFileSync(join(outputDir, 'graph.json'), currentLegacy)
    writeFileSync(join(outputDir, 'graph.v1.json'), 'not a graph at all')

    expect(() => activateGraphArtifactV2(root, v2Artifact())).toThrow(GraphArtifactBackupError)
    expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(currentLegacy)
    expect(readFileSync(join(outputDir, 'graph.v1.json'), 'utf8')).toBe('not a graph at all')
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
  })

  it.each([
    ['corrupt JSON', '{ "nodes": ['],
    ['unrelated JSON', '{"unrelated":true}'],
    ['v2 magic at the legacy path', 'MADAR_GRAPH_ARTIFACT/2\n{}'],
  ])('refuses %s at the legacy path, before any mutation', (_label, contents) => {
    const root = temporaryRoot('madar activation legacy unexpected ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    writeFileSync(join(outputDir, 'graph.json'), contents)

    // Replacing this with a tombstone would destroy content Madar cannot
    // account for.
    expect(() => activateGraphArtifactV2(root, v2Artifact())).toThrow(GraphArtifactBackupError)
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(contents)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
  })

  it('reuses an identical existing graph.v1.json without rewriting it', () => {
    const root = temporaryRoot('madar activation backup idempotent ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const legacy = legacyArtifact()
    writeFileSync(join(outputDir, 'graph.json'), legacy)
    writeFileSync(join(outputDir, 'graph.v1.json'), legacy)

    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupCreated).toBe(false)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(legacy)
  })

  it('refuses an unreadable existing graph.v1.json rather than working around it', () => {
    const root = temporaryRoot('madar activation existing backup ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const existingBackup = Buffer.from('do not overwrite')
    writeFileSync(join(outputDir, 'graph.v1.json'), existingBackup)

    // It used to be left alone and ignored. A backup Madar cannot read is not
    // rollback evidence, and proceeding would quietly publish over a workspace
    // whose recovery state is unknown.
    expect(() => activateGraphArtifactV2(root, v2Artifact())).toThrow(GraphArtifactBackupError)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(existingBackup)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(false)
  })

  it('keeps a valid existing backup untouched when the legacy path is a tombstone', () => {
    const root = temporaryRoot('madar activation preserved backup ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const existingBackup = legacyArtifact('already-preserved')
    writeFileSync(join(outputDir, 'graph.v1.json'), existingBackup)
    writeFileSync(join(outputDir, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupStatus).toBe('preserved_existing')
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(existingBackup)
  })

  it.each([
    ['v2 temp write', 'write_v2_temp'],
    ['v2 rename', 'rename_v2'],
    ['v1 backup write', 'write_v1_backup_temp'],
    ['tombstone write', 'write_tombstone_temp'],
    ['tombstone rename', 'rename_tombstone'],
  ] as const)('rolls back safely when %s fails', (_label, step) => {
    const root = temporaryRoot('madar activation injected failure ')
    const { outputDir, legacy } = legacyOutput(root)

    expect(() => activateGraphArtifactV2(root, v2Artifact(), failureAt(step))).toThrow(`injected ${step} failure`)

    expectOriginalLegacyOnly(outputDir, legacy)
  })

  it('rolls back v2 when the v1 backup rename fails', () => {
    const root = temporaryRoot('madar activation backup rename failure ')
    const { outputDir, legacy } = legacyOutput(root)

    expect(() => activateGraphArtifactV2(root, v2Artifact(), failureAt('rename_v1_backup'))).toThrow(
      'injected rename_v1_backup failure',
    )

    expectOriginalLegacyOnly(outputDir, legacy)
  })

  it.each([
    'rename_v2',
    'rename_v1_backup',
    'rename_tombstone',
  ] as const)('rolls back when durability acknowledgement fails after visible %s', (stepToFail) => {
    const root = temporaryRoot('madar activation post rename failure ')
    const { outputDir, legacy } = legacyOutput(root)

    expect(() => activateGraphArtifactV2(root, v2Artifact(), {
      afterRename(step): void {
        if (step === stepToFail) throw new Error(`injected post-${step} failure`)
      },
    })).toThrow(`injected post-${stepToFail} failure`)

    expectOriginalLegacyOnly(outputDir, legacy)
  })

  it('leaves a safe v2-preferred state when interrupted after v2 activation', () => {
    const root = temporaryRoot('madar activation interrupted v2 ')
    const { outputDir, legacy } = legacyOutput(root)

    expect(() => activateGraphArtifactV2(root, v2Artifact(), {
      interruptAfterPhase: 'v2_activated',
    })).toThrow(GraphArtifactActivationInterruptedError)

    expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(legacy)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
    expect(loadGraphArtifactFromPath(join(outputDir, 'graph.json')).format).toBe('v2')
  })

  it('leaves a safe v2-preferred state when interrupted after v1 preservation', () => {
    const root = temporaryRoot('madar activation interrupted backup ')
    const { outputDir, legacy } = legacyOutput(root)

    expect(() => activateGraphArtifactV2(root, v2Artifact(), {
      interruptAfterPhase: 'v1_preserved',
    })).toThrow(GraphArtifactActivationInterruptedError)

    expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(legacy)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(legacy)
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
    expect(loadGraphArtifactFromPath(join(outputDir, 'graph.json')).format).toBe('v2')
  })
})
