import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { deserializeGraphArtifact } from '../../src/domain/graph/artifact.js'
import { godNodes, suggestQuestions, surprisingConnections } from '../../src/pipeline/analyze.js'
import { buildGraphFromExtraction } from '../../src/application/build-graph.js'
import { cluster, scoreAll } from '../../src/pipeline/cluster.js'
import { detect } from '../../src/pipeline/detect.js'
import { extract } from '../../src/pipeline/extract.js'
import { generate } from '../../src/pipeline/report.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

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

  const extraction = extract([...detection.files.code, ...detection.files.document, ...detection.files.paper, ...detection.files.image])
  expect(extraction.nodes.length).toBeGreaterThan(0)
  expect(extraction.edges.length).toBeGreaterThan(0)

  const graph = buildGraphFromExtraction(extraction, { rootPath: FIXTURES_DIR })
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
    { input: extraction.input_tokens, output: extraction.output_tokens },
    FIXTURES_DIR,
    questions,
  )
  expect(report).toContain('God Nodes')
  expect(report).toContain('Communities')
  expect(report.length).toBeGreaterThan(100)

  const jsonPath = join(tempDir, 'graph.json')
  writeGraphArtifact(graph, jsonPath)
  const jsonData = JSON.parse(readFileSync(jsonPath, 'utf8'))
  expect(jsonData).toMatchObject({ schema: 'madar.graph', version: 1, directed: true })
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
    extraction,
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
  // The full CI matrix runs this CPU-heavy reference corpus beside other
  // extraction suites. It can exceed the normal 30s deadline under parallel
  // load without indicating a correctness regression.
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

  it('detects both code and docs in the fixture corpus', () => {
    expect(referenceResult.detection.files.code.length).toBeGreaterThan(0)
    expect(referenceResult.detection.files.document.length).toBeGreaterThan(0)
    expect(referenceResult.extraction.nodes.some((node) => node.file_type === 'document')).toBe(true)
  })

  it('keeps extraction confidence labels within the expected set', () => {
    const valid = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
    for (const edge of referenceResult.extraction.edges) {
      expect(valid.has(edge.confidence)).toBe(true)
    }
  })

  it('does not introduce self loops into the built graph', () => {
    for (const [source, target] of referenceResult.graph.edgeEntries()) {
      expect(source).not.toBe(target)
    }
  })
})
