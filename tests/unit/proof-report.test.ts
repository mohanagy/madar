import { afterEach, describe, expect, it } from 'vitest'

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { writeCanonicalGraphFixtureFromGraph } from '../helpers/graph-artifact.js'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function withTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-proof-report-'))
  tempRoots.push(root)
  return root
}

function buildProofGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('route', {
    label: 'POST /login',
    source_file: 'src/auth/routes.ts',
    source_location: 'L10',
    node_kind: 'route',
    file_type: 'code',
    framework: 'express',
    framework_role: 'express_route',
    community: 0,
  })
  graph.addNode('controller', {
    label: 'AuthController.login',
    source_file: 'src/auth/controller.ts',
    source_location: 'L20',
    node_kind: 'method',
    file_type: 'code',
    framework: 'nestjs',
    framework_role: 'nest_controller',
    community: 0,
  })
  graph.addNode('service', {
    label: 'AuthService.login',
    source_file: 'src/auth/service.ts',
    source_location: 'L30',
    node_kind: 'method',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('worker', {
    label: 'SessionWorker.persist',
    source_file: 'src/session/worker.ts',
    source_location: 'L40',
    node_kind: 'method',
    file_type: 'code',
    framework_role: 'worker',
    community: 1,
  })
  graph.addEdge('route', 'controller', {
    relation: 'controller_route',
    confidence: 'EXTRACTED',
    source_file: 'src/auth/routes.ts',
  })
  graph.addEdge('controller', 'service', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'src/auth/controller.ts',
  })
  graph.addEdge('service', 'worker', {
    relation: 'enqueues_job',
    confidence: 'EXTRACTED',
    source_file: 'src/auth/service.ts',
  })
  return graph
}

function writeGraphFixture(root: string, outDir = 'out'): string {
  const graphDir = join(root, outDir)
  mkdirSync(graphDir, { recursive: true })
  const graphPath = join(graphDir, 'graph.json')
  writeCanonicalGraphFixtureFromGraph(
    buildProofGraph(),
    { 0: ['route', 'controller', 'service'], 1: ['worker'] },
    graphPath,
  )
  return graphPath
}

function writeCompareFixture(root: string): string {
  const compareDir = join(root, 'out', 'compare', 'login-flow')
  mkdirSync(compareDir, { recursive: true })
  writeFileSync(
    join(compareDir, 'report.share-safe.json'),
    JSON.stringify({
      question: 'How does login reach persistence?',
      baseline_mode: 'bounded',
      reduction_ratio: 3.7,
      effective_reduction_ratio: 4.2,
      total_reduction_ratio: 2.9,
      status: {
        baseline: 'completed',
        madar: 'completed',
      },
      failure_reason: {
        baseline: null,
        madar: null,
      },
      provider_proof: {
        winner: 'madar',
      },
    }, null, 2),
    'utf8',
  )
  return join(root, 'out', 'compare')
}

function writePackFixture(root: string): string {
  const packPath = join(root, 'out', 'proof-inputs', 'context-pack.json')
  mkdirSync(dirname(packPath), { recursive: true })
  writeFileSync(
    packPath,
    JSON.stringify({
      schema_version: 1,
      task: 'explain',
      task_intent: 'explain',
      prompt: 'Trace login persistence flow',
      budget: 1000,
      graph_path: 'out/graph.json',
      claims: [
        {
          evidence_class: 'primary',
          text: 'AuthService.login writes session data through SessionWorker.persist.',
          node_labels: ['AuthService.login', 'SessionWorker.persist'],
        },
      ],
      expandable: [],
      coverage: {
        required_evidence: ['primary'],
        semantic_required: ['implementation'],
        semantic_optional: [],
        entries: [
          {
            evidence_class: 'primary',
            required: true,
            available_nodes: 3,
            selected_nodes: 3,
            status: 'covered',
          },
        ],
        semantic_entries: [
          {
            category: 'implementation',
            label: 'Implementation',
            required: true,
            available_nodes: 3,
            selected_nodes: 3,
            status: 'covered',
          },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 2,
        selected_relationships: 2,
      },
      pack: {
        token_count: 400,
        matched_nodes: [
          {
            label: 'POST /login',
            source_file: 'src/http/routes.ts',
            line_number: 10,
            snippet: 'router.post("/login", controller.login)',
            match_score: 0.98,
            source_domain: 'production',
          },
          {
            label: 'AuthService.login',
            source_file: 'src/auth/service.ts',
            line_number: 42,
            snippet: null,
            match_score: 0.91,
            source_domain: 'production',
          },
          {
            label: 'SessionWorker.persist',
            source_file: 'src/session/worker.ts',
            line_number: 88,
            snippet: null,
            match_score: 0.84,
            source_domain: 'production',
          },
        ],
        relationships: [
          {
            from: 'POST /login',
            to: 'AuthService.login',
            relation: 'calls',
          },
          {
            from: 'AuthService.login',
            to: 'SessionWorker.persist',
            relation: 'calls',
          },
        ],
        community_context: [],
        graph_signals: {
          god_nodes: [],
          bridge_nodes: ['AuthService.login'],
        },
      },
    }, null, 2),
    'utf8',
  )
  return packPath
}

describe('proof report', () => {
  it('writes a local markdown proof report from graph, pack, and compare evidence', async () => {
    const root = withTempRoot()
    const graphPath = writeGraphFixture(root)
    const compareDir = writeCompareFixture(root)
    const packPath = writePackFixture(root)
    const outputDir = join(root, 'out', 'proof-report')

    const proofReportModule = await import('../../src/infrastructure/proof-report.js') as {
      runProofReportCommand: (options: {
        graphPath: string
        outputDir: string
        compareDir: string
        packPath: string | null
      }) => { outputPath: string; report: string }
    }

    const result = proofReportModule.runProofReportCommand({
      graphPath,
      outputDir,
      compareDir,
      packPath,
    })

    expect(result.outputPath).toBe(join(outputDir, 'proof-report.md'))
    expect(readFileSync(result.outputPath, 'utf8')).toBe(result.report)
    expect(result.report).toContain('# Local Proof Report')
    expect(result.report).toContain('## Graph quality')
    expect(result.report).toContain('## Top workflows')
    expect(result.report).toContain('## Pack quality')
    expect(result.report).toContain('## Compare results')
    expect(result.report).toContain('## Limitations')
    expect(result.report).toContain('## Next commands')
    expect(result.report).toContain('- Nodes: 4')
    expect(result.report).toContain('- Edges: 3')
    expect(result.report).toContain('POST /login')
    expect(result.report).toContain('SessionWorker.persist')
    expect(result.report).toContain('How does login reach persistence?')
    expect(result.report).toContain('Reduction ratio: 3.70x')
    expect(result.report).toContain('Quality score:')
    expect(result.report).toContain('Claims: 1')
    expect(result.report).toContain('Snippet coverage: 33%')
    expect(result.report).toContain('67% of nodes lack a source snippet')
  })

  it('spells out missing local evidence with limitations and next commands', async () => {
    const root = withTempRoot()
    const graphPath = writeGraphFixture(root)
    const outputDir = join(root, 'out', 'proof-report')

    const proofReportModule = await import('../../src/infrastructure/proof-report.js') as {
      runProofReportCommand: (options: {
        graphPath: string
        outputDir: string
        compareDir: string
        packPath: string | null
      }) => { outputPath: string; report: string }
    }

    const result = proofReportModule.runProofReportCommand({
      graphPath,
      outputDir,
      compareDir: join(root, 'out', 'compare'),
      packPath: null,
    })

    expect(result.report).toContain('No local context-pack diagnostics were provided.')
    expect(result.report).toContain('No local compare receipts were found.')
    expect(result.report).toContain('Pack quality has not been measured locally yet.')
    expect(result.report).toContain('Compare evidence is missing for this repository snapshot.')
    expect(result.report).toContain(`madar pack "<question>" --task explain --graph ${graphPath} > out/proof-inputs/context-pack.json`)
    expect(result.report).toContain(`madar compare "<question>" --exec "<runner template>" --yes --graph ${graphPath}`)
    expect(result.report).toContain(`madar summary ${graphPath}`)
    expect(result.report).toContain(`madar doctor ${graphPath}`)
  })

  it('treats a missing saved pack path as absent evidence instead of failing', async () => {
    const root = withTempRoot()
    const graphPath = writeGraphFixture(root)
    const outputDir = join(root, 'out', 'proof-report')

    const proofReportModule = await import('../../src/infrastructure/proof-report.js') as {
      runProofReportCommand: (options: {
        graphPath: string
        outputDir: string
        compareDir: string
        packPath: string | null
      }) => { outputPath: string; report: string }
    }

    const result = proofReportModule.runProofReportCommand({
      graphPath,
      outputDir,
      compareDir: join(root, 'out', 'compare'),
      packPath: join(root, 'out', 'proof-inputs', 'missing-context-pack.json'),
    })

    expect(result.outputPath).toBe(join(outputDir, 'proof-report.md'))
    expect(result.report).toContain('No local context-pack diagnostics were provided.')
  })

  it('threads a custom graph path into next commands', async () => {
    const root = withTempRoot()
    const graphPath = writeGraphFixture(root, join('out', 'custom'))
    const outputDir = join(root, 'out', 'custom', 'proof-report')

    const proofReportModule = await import('../../src/infrastructure/proof-report.js') as {
      runProofReportCommand: (options: {
        graphPath: string
        outputDir: string
        compareDir: string
        packPath: string | null
      }) => { outputPath: string; report: string }
    }

    const result = proofReportModule.runProofReportCommand({
      graphPath,
      outputDir,
      compareDir: join(root, 'out', 'custom', 'compare'),
      packPath: null,
    })

    expect(result.report).toContain(`madar pack "<question>" --task explain --graph ${graphPath} > out/proof-inputs/context-pack.json`)
    expect(result.report).toContain(`madar compare "<question>" --exec "<runner template>" --yes --graph ${graphPath}`)
    expect(result.report).toContain(`madar summary ${graphPath}`)
    expect(result.report).toContain(`madar doctor ${graphPath}`)
  })
})
