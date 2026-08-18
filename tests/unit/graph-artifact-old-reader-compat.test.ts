import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  RELEASE_SERVE_SOURCE_SHA256,
  RELEASE_TAG_OBJECT_SHA,
  compileOldLoadGraph,
  exactFunction,
  executableJavaScript,
  gitText,
  type OldLoadGraph,
} from './helpers/v0321-loader.js'
import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  GraphArtifactMovedError,
  loadGraphArtifact,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'

function compileOldArtifactReader(functionSource: string): (path: string) => Record<string, unknown> {
  const factory = new Function(
    'readFileSync',
    'validateGraphPath',
    'isRecord',
    `"use strict"; ${executableJavaScript(functionSource)}; return readGraphArtifactRecord;`,
  ) as (...dependencies: readonly unknown[]) => (path: string) => Record<string, unknown>
  return factory(
    readFileSync,
    (path: string) => path,
    (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
  )
}

function compileOldAnomalySummary(
  functionSource: string,
  readArtifact: (path: string) => Record<string, unknown>,
  oldLoadGraph: OldLoadGraph,
): (path: string) => string {
  const executableSource = executableJavaScript(functionSource)
  const factory = new Function(
    'validateGraphPath',
    'readGraphArtifactRecord',
    'storedSemanticAnomalies',
    'loadGraph',
    'communitiesFromGraph',
    'buildCommunityLabels',
    'storedCommunityLabels',
    'semanticAnomalies',
    `"use strict"; ${executableSource}; return semanticAnomaliesSummary;`,
  ) as (...dependencies: readonly unknown[]) => (path: string) => string
  return factory(
    (path: string) => path,
    readArtifact,
    () => [],
    oldLoadGraph,
    () => ({}),
    () => ({}),
    () => ({}),
    () => [],
  )
}

describe('v0.32.1 exact old-reader rejection proof', () => {
  let temporaryDirectory = ''
  let v2Path = ''
  let tombstonePath = ''
  let v1Path = ''
  let oldLoadGraph: OldLoadGraph
  let oldReadArtifact: (path: string) => Record<string, unknown>
  let oldAnomalySummarySource = ''

  beforeAll(() => {
    expect(gitText(['rev-parse', 'v0.32.1']).trim()).toBe(RELEASE_TAG_OBJECT_SHA)
    const source = gitText(['show', 'v0.32.1:src/runtime/serve.ts'])
    expect(createHash('sha256').update(source, 'utf8').digest('hex')).toBe(RELEASE_SERVE_SOURCE_SHA256)

    oldLoadGraph = compileOldLoadGraph(exactFunction(
      source,
      'export function loadGraph(graphPath: string): KnowledgeGraph {',
      '\n\nexport function communitiesFromGraph',
    ))
    oldReadArtifact = compileOldArtifactReader(exactFunction(
      source,
      'function readGraphArtifactRecord(graphPath: string): Record<string, unknown> {',
      '\n\nfunction storedCommunityLabels',
    ))
    oldAnomalySummarySource = exactFunction(
      source,
      'export function semanticAnomaliesSummary(graphPath: string, topN = 5): string {',
      '\n\nexport function godNodesSummary',
    )

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'madar-v0321-proof-'))
    v2Path = join(temporaryDirectory, 'graph.madar')
    tombstonePath = join(temporaryDirectory, 'graph.json')
    v1Path = join(temporaryDirectory, 'graph.v1.json')
    writeFileSync(v2Path, serializeGraphArtifactV2({
      graph: new KnowledgeGraph({ directed: true }),
      repositoryRevision: 'release-proof',
      generationMode: 'full',
      generatedAt: '2026-08-15T00:00:00.000Z',
    }))
    writeFileSync(tombstonePath, GRAPH_ARTIFACT_V2_TOMBSTONE)
    writeFileSync(v1Path, JSON.stringify({
      schema_version: 1,
      directed: true,
      nodes: [],
      links: [],
      hyperedges: [],
      community_labels: {},
    }))
  })

  afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

  it('makes the extracted v0.32.1 loader reject graph.madar and the tombstone', () => {
    expect(() => oldLoadGraph(v2Path)).toThrow(/graph\.json is corrupted .*Re-run madar to rebuild/i)
    expect(() => oldLoadGraph(tombstonePath)).toThrow(/graph\.json is corrupted .*Re-run madar to rebuild/i)
  })

  it('proves old-loader rejection is not vacuous with a valid v1 control', () => {
    expect(() => oldLoadGraph(v1Path)).not.toThrow()
  })

  it('proves swallowed metadata parsing falls through to the rejecting old loader', () => {
    expect(oldReadArtifact(v2Path)).toEqual({})
    const marker = new Error('old loadGraph fall-through reached')
    let loadCalls = 0
    const summary = compileOldAnomalySummary(oldAnomalySummarySource, oldReadArtifact, (path) => {
      loadCalls += 1
      expect(path).toBe(v2Path)
      throw marker
    })

    expect(() => summary(v2Path)).toThrow(marker)
    expect(loadCalls).toBe(1)
  })

  it('keeps the new-loader controls independently green', () => {
    expect(loadGraphArtifact(readFileSync(v2Path)).format).toBe('v2')
    const degraded = loadGraphArtifact(readFileSync(v1Path))
    expect(degraded.format).toBe('v1')
    expect(degraded.receipt.status).toBe('degraded')
    expect(() => loadGraphArtifact(readFileSync(tombstonePath))).toThrow(GraphArtifactMovedError)
    expect(() => loadGraphArtifact(readFileSync(tombstonePath))).toThrow(/graph\.madar/i)
  })
})
