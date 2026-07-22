import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { godNodes, semanticAnomalies, suggestQuestions, surprisingConnections } from '../../src/pipeline/analyze.js'
import { cluster, scoreAll } from '../../src/pipeline/cluster.js'
import { generate } from '../../src/pipeline/report.js'
import { createTestGraph } from '../helpers/knowledge-graph.js'

function makeInputs() {
  const graph = createTestGraph({
    nodes: [
      ['n_transformer', { label: 'Transformer', file_type: 'code', source_file: 'model.ts' }],
      ['n_attention', { label: 'MultiHeadAttention', file_type: 'code', source_file: 'attention.ts' }],
      ['n_layernorm', { label: 'LayerNorm', file_type: 'code', source_file: 'normalization.ts' }],
      ['n_kernel', { label: 'AttentionKernel', file_type: 'code', source_file: 'kernel.ts' }],
    ],
    edges: [
      ['n_transformer', 'n_attention', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.ts' }],
      ['n_transformer', 'n_layernorm', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.ts' }],
      ['n_attention', 'n_kernel', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'attention.ts' }],
      ['n_layernorm', 'n_kernel', { relation: 'references', confidence: 'INFERRED', source_file: 'normalization.ts' }],
    ],
  })
  const communities = cluster(graph)
  const cohesion = scoreAll(graph, communities)
  const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Community ${communityId}`]))
  const gods = godNodes(graph)
  const surprises = surprisingConnections(graph, communities)
  const anomalies = semanticAnomalies(graph, communities, labels)
  const questions = suggestQuestions(graph, communities, labels)
  const detection = { total_files: 4, total_words: 62400, needs_graph: true, warning: null }
  const tokens = { input: 1200, output: 340 }

  return { graph, communities, cohesion, labels, gods, surprises, anomalies, questions, detection, tokens }
}

function makeLowCohesionInputs() {
  const graph = new KnowledgeGraph()
  for (let index = 1; index <= 15; index += 1) {
    const nodeId = `n${index}`
    graph.addNode(nodeId, { label: `Node ${index}`, source_file: `module-${index}.ts`, file_type: 'code' })
  }
  for (let index = 1; index <= 15; index += 1) {
    const nodeId = `n${index}`
    const nextNodeId = `n${index === 15 ? 1 : index + 1}`
    graph.addEdge(nodeId, nextNodeId, { relation: 'calls', confidence: 'EXTRACTED', source_file: `module-${index}.ts` })
  }
  graph.addNode('file', { label: 'module-1.ts', source_file: 'module-1.ts', file_type: 'code' })
  graph.addEdge('file', 'n1', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'module-1.ts' })

  const communities = cluster(graph)
  const cohesion = scoreAll(graph, communities)
  const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Community ${communityId}`]))
  const detection = { total_files: 15, total_words: 1500, needs_graph: true, warning: null }
  const tokens = { input: 0, output: 0 }

  return { graph, communities, cohesion, labels, detection, tokens }
}

function makeBridgeInputs() {
  const graph = new KnowledgeGraph()
  graph.addNode('api', { label: 'loginUser()', source_file: 'backend/api.ts', file_type: 'code' })
  graph.addNode('web', { label: 'loadSession()', source_file: 'web-app/session.ts', file_type: 'code' })
  graph.addNode('worker', { label: 'syncSession()', source_file: 'worker/jobs.ts', file_type: 'code' })
  graph.addNode('shared', { label: 'createSession()', source_file: 'shared/auth.ts', file_type: 'code' })
  graph.addEdge('api', 'shared', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'backend/api.ts' })
  graph.addEdge('web', 'shared', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'web-app/session.ts' })
  graph.addEdge('worker', 'shared', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'worker/jobs.ts' })

  const communities = {
    0: ['api'],
    1: ['web'],
    2: ['worker'],
    3: ['shared'],
  }
  const cohesion = scoreAll(graph, communities)
  const labels = {
    0: 'Backend API',
    1: 'Web Session',
    2: 'Worker Jobs',
    3: 'Shared Auth',
  }
  const detection = { total_files: 4, total_words: 500, needs_graph: true, warning: null }
  const tokens = { input: 0, output: 0 }

  return { graph, communities, cohesion, labels, detection, tokens }
}

describe('report', () => {
  it('generates the expected report sections', () => {
    const { graph, communities, cohesion, labels, gods, surprises, anomalies, questions, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, anomalies, detection, tokens, './project', questions)

    expect(report).toContain('# Graph Report')
    expect(report).toContain('## Corpus Check')
    expect(report).toContain('## God Nodes')
    expect(report).toContain('## Surprising Connections')
    expect(report).toContain('## Semantic Anomalies')
    expect(report).toContain('## Structure Signals')
    expect(report).toContain('## Workspace Bridges')
    expect(report).toContain('Entity graph basis')
    expect(report).toContain('Weakly connected components')
    expect(report).toContain('Largest component')
    expect(report).toContain('## Communities')
    expect(report).not.toContain('## Ambiguous Edges')
    expect(report).toContain('## Suggested Questions')
    expect(report).toContain('## Knowledge Gaps')
  })

  it('shows token cost and entity-basis community cohesion values', () => {
    const { graph, communities, cohesion, labels, gods, surprises, anomalies, questions, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, anomalies, detection, tokens, './project', questions)

    expect(report).toContain('Token cost')
    expect(report).toContain('1,200')
    expect(report).toContain('Cohesion (entity basis within full-graph community):')
    expect(report).not.toContain('✓')
    expect(report).not.toContain('⚠')
  })

  it('renders low-cohesion structure signals on the shared entity basis', () => {
    const { graph, communities, cohesion, labels, detection, tokens } = makeLowCohesionInputs()
    const report = generate(graph, communities, cohesion, labels, [], [], [], detection, tokens, './project', [])

    // With Louvain clustering, the 15-node cycle is split into well-cohesioned
    // sub-communities, so no low-cohesion signals appear
    expect(report).toContain('Low-cohesion communities: 0')
  })

  it('renders bridge-first navigation hints for mixed workspaces', () => {
    const { graph, communities, cohesion, labels, detection, tokens } = makeBridgeInputs()
    const report = generate(graph, communities, cohesion, labels, [], [], [], detection, tokens, './project', [])

    expect(report).toContain('## Workspace Bridges')
    expect(report).toContain('`createSession\\(\\)`')
    expect(report).toContain('connects `Backend API`, `Web Session`, `Worker Jobs`')
    expect(report).toContain('home: `Shared Auth`')
    expect(report).toContain('source files: `backend/api.ts`, `shared/auth.ts`, `web-app/session.ts`, `worker/jobs.ts`')
  })

  it('renders no-signal suggestions as explanatory prose', () => {
    const { graph, communities, cohesion, labels, gods, surprises, anomalies, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, anomalies, detection, tokens, './project', [
      { type: 'no_signal', question: null, why: 'Nothing weird here.' },
    ])

    expect(report).toContain('## Suggested Questions')
    expect(report).toContain('Nothing weird here.')
    expect(report).not.toContain('Questions this graph is uniquely positioned to answer')
  })

  it('escapes markdown-sensitive content', () => {
    const { graph, communities, cohesion, labels, detection, tokens } = makeInputs()
    const report = generate(
      graph,
      communities,
      cohesion,
      labels,
      [{ id: 'n1', label: '[trap](javascript:alert(1))', edges: 3 }],
      [
        {
          source: '[source](javascript:alert(1))',
          target: '`target`',
          source_files: ['a.ts', 'b.ts'],
          confidence: 'INFERRED',
          confidence_score: 0.75,
          relation: ']] exploit',
          why: 'Tries to break markdown.',
        },
      ],
      [
        {
          id: 'anomaly-1',
          kind: 'bridge_node',
          severity: 'HIGH',
          score: 9.5,
          summary: '[bridge](javascript:alert(1)) spans communities.',
          why: 'Still needs escaping.',
        },
      ],
      detection,
      tokens,
      './project',
      [],
    )

    expect(report).not.toContain('[source](javascript:alert(1))')
    expect(report).toContain('## Semantic Anomalies')
    expect(report).toContain('INFERRED 0.75')
  })
})
