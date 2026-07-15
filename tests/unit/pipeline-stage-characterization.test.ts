import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { extract } from '../../src/pipeline/extract.js'
import type { ExtractionFileOutcome } from '../../src/pipeline/extract/dispatch.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

interface PipelineCharacterizationFixture {
  retrieval: {
    question: string
    selected_node_ids: string[]
    excluded_node_ids: string[]
    relationships: string[]
    task_kind: string
    retrieval_strategy: string
  }
  extraction: {
    fixture: string
    labels: string[]
    call_relationships: string[]
    outcome_status: string
    outcome_reason: string
    capability: string
  }
}

const fixturesDirectory = join(process.cwd(), 'tests', 'fixtures')
const fixture = JSON.parse(readFileSync(
  join(fixturesDirectory, 'pipeline-stage-characterization.json'),
  'utf8',
)) as PipelineCharacterizationFixture

function characterizationGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('auth-controller', {
    label: 'AuthController.login',
    source_file: 'src/auth/auth.controller.ts',
    source_location: 'L10',
    node_kind: 'method',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('auth-service', {
    label: 'AuthService.login',
    source_file: 'src/auth/auth.service.ts',
    source_location: 'L20',
    node_kind: 'method',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session-store', {
    label: 'SessionStore.find',
    source_file: 'src/auth/session.store.ts',
    source_location: 'L30',
    node_kind: 'method',
    file_type: 'code',
    community: 1,
  })
  graph.addNode('billing-service', {
    label: 'InvoiceLedger.charge',
    source_file: 'src/unrelated/invoice-ledger.ts',
    source_location: 'L40',
    node_kind: 'method',
    file_type: 'code',
    community: 2,
  })
  graph.addEdge('auth-controller', 'auth-service', { relation: 'calls' })
  graph.addEdge('auth-service', 'session-store', { relation: 'calls' })
  return graph
}

describe('retrieval and extraction pipeline characterization', () => {
  it('preserves the default retrieval result contract before stage extraction', () => {
    const result = retrieveContext(characterizationGraph(), {
      question: fixture.retrieval.question,
      budget: 1_200,
    })
    const selectedIds = result.matched_nodes.flatMap((node) => node.node_id ? [node.node_id] : [])
    const relationships = result.relationships.map((edge) => `${edge.from_id}|${edge.relation}|${edge.to_id}`)

    expect(selectedIds).toEqual(expect.arrayContaining(fixture.retrieval.selected_node_ids))
    expect(selectedIds).not.toEqual(expect.arrayContaining(fixture.retrieval.excluded_node_ids))
    expect(relationships).toEqual(expect.arrayContaining(fixture.retrieval.relationships))
    expect(result.task_contract?.task_kind).toBe(fixture.retrieval.task_kind)
    expect(result.retrieval_strategy).toBe(fixture.retrieval.retrieval_strategy)
    expect(result.coverage).toBeDefined()
    expect(result.expandable).toBeDefined()
  })

  it('preserves extraction symbols, relationships, and per-file outcome semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-stage-characterization-'))
    try {
      const sourcePath = join(fixturesDirectory, fixture.extraction.fixture)
      const filePath = join(root, fixture.extraction.fixture)
      writeFileSync(filePath, readFileSync(sourcePath, 'utf8'), 'utf8')
      const outcomes: ExtractionFileOutcome[] = []
      const result = extract([filePath], {
        onFileOutcome: (outcome) => outcomes.push(outcome),
      })
      const labels = result.nodes.map((node) => node.label)
      const labelsById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = result.edges
        .filter((edge) => edge.relation === 'calls')
        .map((edge) => `${labelsById.get(edge.source)}->${labelsById.get(edge.target)}`)

      expect(labels).toEqual(expect.arrayContaining(fixture.extraction.labels))
      expect(calls).toEqual(expect.arrayContaining(fixture.extraction.call_relationships))
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        status: fixture.extraction.outcome_status,
        reason: fixture.extraction.outcome_reason,
        capability: fixture.extraction.capability,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
