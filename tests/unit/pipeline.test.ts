import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { deserializeGraphArtifact, GRAPH_ARTIFACT_VERSION } from '../../src/domain/graph/artifact.js'
import { godNodes, suggestQuestions, surprisingConnections } from '../../src/pipeline/analyze.js'
import { cluster, scoreAll } from '../../src/pipeline/cluster.js'
import { detect } from '../../src/pipeline/detect.js'
import { generate } from '../../src/pipeline/report.js'
import {
  CANONICAL_INDEX_FIXTURE_ROOT,
  canonicalFixtureSourceFiles,
} from '../helpers/canonical-index-gold.js'
import { buildCanonicalTestGraph } from '../helpers/knowledge-graph.js'

const FIXTURES_DIR = CANONICAL_INDEX_FIXTURE_ROOT

function escapeMarkdownInline(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/([\\`*_[\]()!])/g, '\\$1')
}

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-pipeline-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function runPipeline(tempDir: string) {
  const detection = detect(FIXTURES_DIR)
  expect(detection.total_files).toBeGreaterThan(0)
  expect(detection.files.code.length).toBeGreaterThan(0)
  expect(detection.files.code).toEqual(canonicalFixtureSourceFiles())

  const graph = buildCanonicalTestGraph({ root: FIXTURES_DIR, files: detection.files.code })
  expect(graph.numberOfNodes()).toBeGreaterThan(0)
  expect(graph.numberOfEdges()).toBeGreaterThan(0)

  const communities = cluster(graph)
  expect(Object.keys(communities).length).toBeGreaterThan(0)

  const cohesion = scoreAll(graph, communities)
  for (const score of Object.values(cohesion)) {
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  }

  const gods = godNodes(graph)
  expect(gods.length).toBeGreaterThan(0)

  const surprises = surprisingConnections(graph, communities)
  const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Group ${communityId}`]))
  const questions = suggestQuestions(graph, communities, labels)
  expect(Array.isArray(questions)).toBe(true)

  const report = generate(
    graph,
    communities,
    cohesion,
    labels,
    gods,
    surprises,
    [],
    detection as unknown as Record<string, unknown>,
    { input: 0, output: 0 },
    FIXTURES_DIR,
    questions,
  )
  expect(report).toContain('God Nodes')
  expect(report).toContain('Communities')
  expect(report.length).toBeGreaterThan(100)

  const jsonPath = join(tempDir, 'graph.json')
  writeGraphArtifact(graph, jsonPath)
  const jsonData = JSON.parse(readFileSync(jsonPath, 'utf8'))
  expect(jsonData).toMatchObject({ schema: 'madar.graph', version: GRAPH_ARTIFACT_VERSION, directed: true })
  expect(jsonData).toHaveProperty('nodes')
  expect(jsonData).toHaveProperty('edges')
  for (const node of jsonData.nodes as Array<Record<string, unknown>>) {
    expect(node).toHaveProperty('id')
    expect(node).toHaveProperty('attributes')
  }
  for (const edge of jsonData.edges as Array<Record<string, unknown>>) {
    expect(edge).toHaveProperty('id')
    expect(edge).toHaveProperty('source')
    expect(edge).toHaveProperty('target')
    expect(edge).toHaveProperty('attributes')
  }
  const loaded = deserializeGraphArtifact(readFileSync(jsonPath, 'utf8'))
  expect(loaded.numberOfNodes()).toBe(graph.numberOfNodes())
  expect(loaded.numberOfEdges()).toBe(graph.numberOfEdges())

  return {
    detection,
    graph,
    communities,
    cohesion,
    gods,
    surprises,
    questions,
    report,
  }
}

describe('pipeline', () => {
  // The full CI matrix runs this compiler-backed reference corpus beside
  // other canonical index suites.
  const referenceFixturesTimeoutMs = 180_000
  let referenceResult: ReturnType<typeof runPipeline>

  beforeAll(() => {
    referenceResult = withTempDir((tempDir) => runPipeline(tempDir))
  }, referenceFixturesTimeoutMs)

  it('runs end to end on the reference fixtures', () => {
    expect(referenceResult.graph.numberOfNodes()).toBeGreaterThan(0)
  })

  it('keeps node and edge counts stable across repeated runs', () => {
    withTempDir((tempDir) => {
      const second = runPipeline(tempDir)
      expect(referenceResult.graph.numberOfNodes()).toBe(second.graph.numberOfNodes())
      expect(referenceResult.graph.numberOfEdges()).toBe(second.graph.numberOfEdges())
    })
  }, referenceFixturesTimeoutMs)

  it('mentions the top god node in the generated report', () => {
    expect(referenceResult.report).toContain(`\`${escapeMarkdownInline(referenceResult.gods[0]?.label ?? '')}\``)
  })

  it('passes only supported TypeScript and JavaScript files into the index', () => {
    expect(referenceResult.detection.files.code.length).toBeGreaterThan(0)
    expect(Object.keys(referenceResult.detection.files)).toEqual(['code'])
  })

  it('keeps canonical edge confidence labels within the expected set', () => {
    const valid = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
    for (const [, , attributes] of referenceResult.graph.edgeEntries()) {
      expect(valid.has(String(attributes.confidence))).toBe(true)
    }
  })

  it('does not introduce self loops into the built graph', () => {
    for (const [source, target] of referenceResult.graph.edgeEntries()) {
      expect(source).not.toBe(target)
    }
  })
})
