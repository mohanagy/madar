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
  GraphArtifactBackupConflictError,
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

  it.each([
    ['existing tombstone', Buffer.from(GRAPH_ARTIFACT_V2_TOMBSTONE)],
    ['existing v2', v2Artifact()],
    ['corrupt JSON', Buffer.from('{')],
    ['unrelated JSON', Buffer.from('{"hello":"world"}')],
    ['future schema', Buffer.from('{"schema_version":99,"directed":true,"nodes":[],"links":[]}')],
  ])('does not back up %s as legacy v1', (_label, existingGraph) => {
    const root = temporaryRoot('madar activation invalid prior ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    writeFileSync(join(outputDir, 'graph.json'), existingGraph)

    const result = activateGraphArtifactV2(root, v2Artifact())

    expect(result.legacyBackupCreated).toBe(false)
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
  })

  it('fails before activation instead of overwriting a different graph.v1.json', () => {
    const root = temporaryRoot('madar activation backup conflict ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const currentLegacy = legacyArtifact('current')
    const preservedLegacy = legacyArtifact('already-preserved')
    writeFileSync(join(outputDir, 'graph.json'), currentLegacy)
    writeFileSync(join(outputDir, 'graph.v1.json'), preservedLegacy)

    expect(() => activateGraphArtifactV2(root, v2Artifact())).toThrow(GraphArtifactBackupConflictError)
    expect(readFileSync(join(outputDir, 'graph.json'))).toEqual(currentLegacy)
    expect(readFileSync(join(outputDir, 'graph.v1.json'))).toEqual(preservedLegacy)
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

  it('leaves an unrelated existing graph.v1.json untouched when no backup is needed', () => {
    const root = temporaryRoot('madar activation existing backup ')
    const outputDir = join(root, 'out')
    mkdirSync(outputDir)
    const existingBackup = Buffer.from('do not overwrite')
    writeFileSync(join(outputDir, 'graph.v1.json'), existingBackup)

    activateGraphArtifactV2(root, v2Artifact())

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
