import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { build } from '../../src/pipeline/build.js'
import { extract } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'go-semantic-workspace')
const FIXTURE_FILES = [
  join(FIXTURE_ROOT, 'cmd', 'api', 'main.go'),
  join(FIXTURE_ROOT, 'internal', 'handlers', 'user_handler.go'),
  join(FIXTURE_ROOT, 'internal', 'service', 'user_service.go'),
  join(FIXTURE_ROOT, 'internal', 'service', 'user_service_validation.go'),
  join(FIXTURE_ROOT, 'internal', 'repository', 'user_repository.go'),
]

function stripFileNodes(extraction: ReturnType<typeof extract>): ReturnType<typeof extract> {
  const nodeIds = new Set(extraction.nodes.filter((node) => String(node.node_kind ?? '') !== '').map((node) => node.id))
  return {
    ...extraction,
    nodes: extraction.nodes.filter((node) => nodeIds.has(node.id)),
    edges: extraction.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  }
}

describe('retrieve Go semantic context', () => {
  it('returns route-centric runtime context beyond the tree-sitter-only baseline', () => {
    const semanticExtraction = stripFileNodes(extract(FIXTURE_FILES))
    const semanticGraph = build([semanticExtraction], { directed: true })

    const baselineGraph = new KnowledgeGraph({ directed: true })
    baselineGraph.addNode('handler_create_user', {
      label: '.CreateUser()',
      source_file: join(FIXTURE_ROOT, 'internal', 'handlers', 'user_handler.go'),
      line_number: 17,
      node_kind: 'method',
      file_type: 'code',
      community: 0,
    })
    baselineGraph.addNode('service_create', {
      label: '.Create()',
      source_file: join(FIXTURE_ROOT, 'internal', 'service', 'user_service.go'),
      line_number: 9,
      node_kind: 'method',
      file_type: 'code',
      community: 0,
    })
    baselineGraph.addNode('service_validate', {
      label: '.validate()',
      source_file: join(FIXTURE_ROOT, 'internal', 'service', 'user_service_validation.go'),
      line_number: 3,
      node_kind: 'method',
      file_type: 'code',
      community: 0,
    })
    baselineGraph.addNode('repository_insert', {
      label: '.Insert()',
      source_file: join(FIXTURE_ROOT, 'internal', 'repository', 'user_repository.go'),
      line_number: 5,
      node_kind: 'method',
      file_type: 'code',
      community: 0,
    })
    baselineGraph.addEdge('handler_create_user', 'service_create', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: join(FIXTURE_ROOT, 'internal', 'handlers', 'user_handler.go'),
    })
    baselineGraph.addEdge('service_create', 'service_validate', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: join(FIXTURE_ROOT, 'internal', 'service', 'user_service.go'),
    })
    baselineGraph.addEdge('service_create', 'repository_insert', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: join(FIXTURE_ROOT, 'internal', 'service', 'user_service.go'),
    })

    const semanticResult = retrieveContext(semanticGraph, {
      question: 'which route creates users in the go api',
      budget: 5000,
      fileType: 'code',
    })
    const baselineResult = retrieveContext(baselineGraph, {
      question: 'which route creates users in the go api',
      budget: 5000,
      fileType: 'code',
    })

    expect(semanticResult.matched_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'POST /api/users',
          node_kind: 'route',
          framework: 'gin',
        }),
      ]),
    )
    expect(semanticResult.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'POST /api/users', to: '.CreateUser()', relation: 'depends_on' }),
        expect.objectContaining({ from: '.CreateUser()', to: '.Create()', relation: 'calls' }),
      ]),
    )
    expect(baselineResult.matched_nodes.some((node) => node.node_kind === 'route')).toBe(false)

    expect(semanticResult.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: '.Create()', to: '.Insert()', relation: 'calls' }),
      ]),
    )
  })
})
