import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  hydrateEvidence,
} from '../../src/application/evidence-hydrator.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import {
  indexChannelId,
  type IndexBodyFact,
  type IndexCallFact,
  type IndexRange,
} from '../../src/domain/index/model.js'
import type { QueryGraph, ReadyQueryIndex } from '../../src/domain/query/index-status.js'
import type { EvidenceHydrationTargets } from '../../src/domain/query/types.js'

const roots: string[] = []
const path = 'src/flow.ts'
const fileId = 'file:flow'
const ownerId = 'symbol:owner'
const targetId = 'symbol:target'
const operationId = 'operation:call'
const sourceText = [
  'export function owner() { return target("secret") }',
  'export function target(value: string) { return value }',
  '',
].join('\n')

interface Fixture {
  root: string
  graph: KnowledgeGraph
  index: ReadyQueryIndex
  operations: Map<string, IndexBodyFact>
  operation: IndexCallFact
  directEdgeId: string
  publishEdgeId: string
  channelId: string
  targets: EvidenceHydrationTargets
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
const values = <T>(map: ReadonlyMap<string, T>): T[] => [...map.values()]

function position(text: string, offset: number): IndexRange['start'] {
  const lines = text.slice(0, offset).split('\n')
  return { line: lines.length, column: lines.at(-1)!.length + 1 }
}

function span(text: string, needle: string): IndexRange {
  const start = text.indexOf(needle)
  if (start < 0) throw new Error(`Missing fixture span ${needle}`)
  return { start: position(text, start), end: position(text, start + needle.length) }
}

function location(range: IndexRange): string {
  return range.start.line === range.end.line
    ? `L${range.start.line}`
    : `L${range.start.line}-L${range.end.line}`
}

function write(root: string, relative: string, contents: string | Buffer): void {
  const absolute = join(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'madar-hydrator-'))
  roots.push(root)
  write(root, path, sourceText)
  const fileHash = hash(sourceText)
  const ownerDefinition = span(sourceText, sourceText.split('\n')[0]!)
  const targetDefinition = span(sourceText, sourceText.split('\n')[1]!)
  const ownerDeclaration = span(sourceText, 'export function owner()')
  const targetDeclaration = span(sourceText, 'export function target(value: string)')
  const statementRange = span(sourceText, 'return target("secret")')
  const callRange = span(sourceText, 'target("secret")')
  const statementHash = hash('return target("secret")')
  const graph = new KnowledgeGraph({ root_path: root })
  graph.addNode(fileId, {
    label: 'flow.ts', node_kind: 'file', source_file: path,
    source_location: 'L1', content_hash: fileHash, provenance: [{}],
  })
  graph.addNode(ownerId, {
    label: 'owner()', node_kind: 'function', source_file: path,
    source_location: location(ownerDefinition), line_number: 1, end_line_number: 1,
    definition_range: ownerDefinition, declaration_range: ownerDeclaration,
    provenance: [{}],
  })
  graph.addNode(targetId, {
    label: 'target()', node_kind: 'function', source_file: path,
    source_location: location(targetDefinition), line_number: 2, end_line_number: 2,
    definition_range: targetDefinition, declaration_range: targetDeclaration,
    provenance: [{}],
  })
  const channel = {
    channel_kind: 'queue' as const,
    transport: 'bullmq' as const,
    key: 'reports',
  }
  const channelId = indexChannelId(channel)
  graph.addNode(channelId, {
    label: channel.key, node_kind: 'channel', ...channel,
  })
  const operation: IndexCallFact = {
    id: operationId, owner_symbol_id: ownerId, kind: 'call',
    order: [1, 3, 2, 0], control: [], confidence: 'high',
    source: 'typescript-semantic', callee: 'target', target_symbol_id: targetId,
    scheduling: 'sync',
    arguments: [{ kind: 'redacted', sha256: 'a'.repeat(64), byte_length: 6 }],
    evidence: {
      file_id: fileId, range: callRange, statement_range: statementRange,
      excerpt_sha256: statementHash,
    },
  }
  const directEdgeId = graph.addEdge(ownerId, targetId, {
    relation: 'calls', source_file: path, source_location: location(callRange),
    evidence: { source: 'typescript-semantic', range: callRange },
    provenance: [{}],
  })
  const publishEdgeId = graph.addEdge(ownerId, channelId, {
    relation: 'publishes_to', source_file: path,
    source_location: location(statementRange), execution_owner_id: ownerId,
    evidence: {
      source: 'typescript-semantic', range: callRange,
      statement_range: statementRange, excerpt_sha256: statementHash,
    },
    provenance: [{}],
  })
  const operations = new Map<string, IndexBodyFact>([[operation.id, operation]])
  const channelNode = { id: channelId, node_kind: 'channel' as const, ...channel }
  const index: ReadyQueryIndex = {
    state: 'ready', graph, root_path: root,
    file_hashes: new Map([[path, fileHash]]), unsupported_sources: [],
    operation_by_id: operations,
    operations_by_owner: new Map([[ownerId, [operation]]]),
    channels_by_id: new Map([[channelId, channelNode]]),
    channels_by_key: new Map([[channel.key, [channelNode]]]),
  }
  return {
    root, graph, index, operations, operation, directEdgeId, publishEdgeId, channelId,
    targets: {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId],
      operationIds: [operationId],
      edges: [
        { id: directEdgeId, fromId: ownerId, toId: targetId, relation: 'calls' },
        { id: publishEdgeId, fromId: ownerId, toId: channelId, relation: 'publishes_to' },
      ],
    },
  }
}

function addConsumedEdge(value: Fixture): string {
  const statementRange = span(sourceText, 'return target("secret")')
  const callRange = span(sourceText, 'target("secret")')
  return value.graph.addEdge(value.channelId, targetId, {
    relation: 'consumed_by', source_file: path,
    source_location: location(statementRange), execution_owner_id: ownerId,
    evidence: {
      source: 'wrapper-summary', range: callRange,
      statement_range: statementRange, excerpt_sha256: hash('return target("secret")'),
    },
    provenance: [{}],
  })
}

function setWrapperBinding(
  value: Fixture, id = operationId, reference = targetId,
): IndexCallFact {
  const operation: IndexCallFact = {
    id, owner_symbol_id: ownerId, kind: 'call', order: [1, 3, 2, 0], control: [],
    confidence: 'high', source: 'wrapper-summary', callee: 'registerWorker',
    scheduling: 'sync', evidence: value.operation.evidence,
    arguments: [{
      kind: 'object', entries: [{ key: 'handler', value: {
        kind: 'array', elements: [{ kind: 'symbol', symbol_id: reference }],
      } }],
    }],
  }
  value.operations.set(id, operation)
  ;(value.index.operations_by_owner as Map<string, IndexBodyFact[]>).set(ownerId, [operation])
  return operation
}

function duplicateSelectedEdge(index: ReadyQueryIndex, id: string): QueryGraph {
  const graph = index.graph
  const methods = {
    hasNode: graph.hasNode.bind(graph), hasEdge: graph.hasEdge.bind(graph),
    nodeEntries: graph.nodeEntries.bind(graph), predecessors: graph.predecessors.bind(graph),
    successors: graph.successors.bind(graph), edgesBetween: graph.edgesBetween.bind(graph),
    nodeAttributes: graph.nodeAttributes.bind(graph),
  }
  return {
    ...methods,
    edgeEntries: () => {
      const rows = graph.edgeEntries()
      const selected = rows.find((row) => row[3] === id)!
      return [...rows, selected]
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('selected evidence hydration', () => {
  it('authenticates exact symbol, operation, direct-call and channel-edge targets', () => {
    const value = fixture()
    const first = hydrateEvidence(value.index, value.targets)
    const second = hydrateEvidence(value.index, {
      symbolIds: [...value.targets.symbolIds].reverse(),
      declarationSymbolIds: [...value.targets.declarationSymbolIds].reverse(),
      operationIds: [...value.targets.operationIds].reverse(),
      edges: [...value.targets.edges].reverse(),
    })

    expect(second).toEqual(first)
    expect(first.state).toBe('ready')
    if (first.state !== 'ready') return
    expect(first.files.get(path)).toEqual(['f0', hash(sourceText)])
    expect(values(first.entities).map((entity) => entity[1])).toEqual([
      'symbol', 'symbol', 'operation', 'channel',
    ])
    const operation = values(first.entities).find((entity) => entity[1] === 'operation')
    expect(operation?.[3]).toMatchObject({
      kind: 'call', arguments: [
        { kind: 'redacted', sha256: 'a'.repeat(64), byte_length: 6 },
      ],
    })
    const edgeProofs = values(first.proofs).filter((proof) => proof[1] === 'edge')
    expect(edgeProofs).toHaveLength(2)
    expect(edgeProofs.find((proof) => proof[4] === 'calls')).toHaveLength(6)
    expect(values(first.proofs).some((proof) => proof[1] === 'operation')).toBe(true)
    expect(values(first.excerpts).map((item) => item[4])).toEqual([
      'export function owner()',
      'return target("secret")',
    ])
    expect(first.proofs.has(targetId)).toBe(false)
  })

  it('deduplicates repeated targets and shared statement proofs', () => {
    const value = fixture()
    const result = hydrateEvidence(value.index, {
      symbolIds: [ownerId, ownerId, targetId],
      declarationSymbolIds: [ownerId, ownerId],
      operationIds: [operationId, operationId],
      edges: [...value.targets.edges, ...value.targets.edges],
    })
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.files.size).toBe(1)
    expect(result.entities.size).toBe(4)
    expect(result.excerpts.size).toBe(2)
    expect(result.proofs.size).toBe(4)
  })

  it('authenticates validation-only operations without emitting their excerpts', () => {
    const value = fixture()
    const targets = {
      symbolIds: [ownerId], declarationSymbolIds: [ownerId],
      operationIds: [], validationOperationIds: [operationId], edges: [],
    }
    const result = hydrateEvidence(value.index, targets)

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.entities.has(operationId)).toBe(false)
    expect(result.proofs.has(operationId)).toBe(false)
    expect(values(result.excerpts).map((item) => item[4]))
      .toEqual(['export function owner()'])

    value.operations.set(operationId, {
      ...value.operation,
      evidence: { ...value.operation.evidence, excerpt_sha256: 'b'.repeat(64) },
    })
    expect(hydrateEvidence(value.index, targets))
      .toEqual({ state: 'corrupt', subject: operationId })
  })

  it('rejects metadata-only symbols without an incident authenticated proof', () => {
    const value = fixture()
    expect(hydrateEvidence(value.index, {
      symbolIds: [targetId], declarationSymbolIds: [], operationIds: [], edges: [],
    })).toEqual({ state: 'corrupt', subject: targetId })
  })

  it('binds an indirect consumed_by owner to one authenticated consumer call', () => {
    const value = fixture()
    const edgeId = addConsumedEdge(value)
    const result = hydrateEvidence(value.index, {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId],
      operationIds: [operationId],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(values(result.proofs).find((proof) =>
      proof[1] === 'edge' && proof[4] === 'consumed_by')).toHaveLength(6)
    expect(values(result.proofs).some((proof) => proof[1] === 'operation')).toBe(true)
  })

  it('binds a wrapper call through its exact authenticated statement', () => {
    const value = fixture()
    setWrapperBinding(value, operationId, ownerId)
    const edgeId = addConsumedEdge(value)
    const result = hydrateEvidence(value.index, {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId], operationIds: [],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(values(result.proofs).find((proof) => proof[1] === 'edge')).toHaveLength(6)
    expect(values(result.entities).some((entity) => entity[1] === 'operation')).toBe(false)
  })

  it('accepts consumed_by evidence owned directly by the consumer', () => {
    const value = fixture()
    const statementRange = span(sourceText, 'return value')
    const edgeId = value.graph.addEdge(value.channelId, targetId, {
      relation: 'consumed_by', source_file: path,
      source_location: location(statementRange), execution_owner_id: targetId,
      evidence: {
        source: 'wrapper-summary', range: statementRange,
        statement_range: statementRange, excerpt_sha256: hash('return value'),
      },
      provenance: [{}],
    })
    const result = hydrateEvidence(value.index, {
      symbolIds: [targetId], declarationSymbolIds: [], operationIds: [],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(values(result.proofs).find((proof) => proof[1] === 'edge')).toHaveLength(6)
  })

  it('rejects consumed_by evidence whose indirect owner lacks the authenticated call', () => {
    const value = fixture()
    const edgeId = addConsumedEdge(value)
    ;(value.index.operations_by_owner as Map<string, IndexBodyFact[]>).set(ownerId, [])

    expect(hydrateEvidence(value.index, {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId],
      operationIds: [],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })).toEqual({ state: 'corrupt', subject: edgeId })
  })

  it('rejects an indirect consumed_by binding inconsistent across operation indexes', () => {
    const value = fixture()
    const operation = setWrapperBinding(value)
    const edgeId = addConsumedEdge(value)
    value.operations.set(operationId, {
      ...operation,
      evidence: { ...operation.evidence, excerpt_sha256: 'b'.repeat(64) },
    })

    expect(hydrateEvidence(value.index, {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId],
      operationIds: [],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })).toEqual({ state: 'corrupt', subject: edgeId })
  })

  it('rejects ambiguous wrapper calls with the same authenticated statement', () => {
    const value = fixture()
    const first = setWrapperBinding(value)
    const second = { ...first, id: 'operation:ambiguous' }
    value.operations.set(second.id, second)
    ;(value.index.operations_by_owner as Map<string, IndexBodyFact[]>).set(
      ownerId, [first, second],
    )
    const edgeId = addConsumedEdge(value)

    expect(hydrateEvidence(value.index, {
      symbolIds: [ownerId, targetId], declarationSymbolIds: [ownerId], operationIds: [],
      edges: [{ id: edgeId, fromId: value.channelId, toId: targetId,
        relation: 'consumed_by' }],
    })).toEqual({ state: 'corrupt', subject: edgeId })
  })

  it('returns stale when selected source bytes changed', () => {
    const value = fixture()
    write(value.root, path, `${sourceText}// changed\n`)
    expect(hydrateEvidence(value.index, value.targets)).toEqual({ state: 'stale', subject: path })
  })

  it('returns unavailable when a selected source is missing', () => {
    const value = fixture()
    unlinkSync(join(value.root, path))
    expect(hydrateEvidence(value.index, value.targets)).toEqual({
      state: 'unavailable', subject: path,
    })
  })

  it('rejects corrupt ranges, hashes and operation references', () => {
    const badRange = fixture()
    const owner = badRange.graph.nodeAttributes(ownerId)
    badRange.graph.replaceNodeAttributes(ownerId, {
      ...owner,
      declaration_range: { start: { line: 1, column: 1 }, end: { line: 1, column: 999 } },
    })
    expect(hydrateEvidence(badRange.index, badRange.targets)).toEqual({
      state: 'corrupt', subject: ownerId,
    })

    const badHash = fixture()
    badHash.operations.set(operationId, {
      ...badHash.operation,
      evidence: { ...badHash.operation.evidence, excerpt_sha256: 'f'.repeat(64) },
    })
    expect(hydrateEvidence(badHash.index, badHash.targets)).toEqual({
      state: 'corrupt', subject: operationId,
    })

    const badReference = fixture()
    badReference.operations.set(operationId, {
      ...badReference.operation, target_symbol_id: 'symbol:missing',
    })
    expect(hydrateEvidence(badReference.index, badReference.targets)).toEqual({
      state: 'corrupt', subject: 'symbol:missing',
    })
  })

  it('isolates corruption in an unselected owner fact', () => {
    const value = fixture()
    const bad: IndexCallFact = {
      ...value.operation, id: 'operation:unselected', target_symbol_id: 'symbol:missing',
      evidence: { ...value.operation.evidence, excerpt_sha256: 'b'.repeat(64) },
    }
    value.operations.set(bad.id, bad)
    ;(value.index.operations_by_owner as Map<string, IndexBodyFact[]>).set(
      ownerId, [value.operation, bad],
    )
    expect(hydrateEvidence(value.index, value.targets).state).toBe('ready')
  })

  it('rejects a selected edge with mismatched or ambiguous identity', () => {
    const mismatch = fixture()
    expect(hydrateEvidence(mismatch.index, {
      ...mismatch.targets,
      edges: [{ id: mismatch.directEdgeId, fromId: targetId, toId: ownerId }],
    })).toEqual({ state: 'corrupt', subject: mismatch.directEdgeId })

    const ambiguous = fixture()
    const index = { ...ambiguous.index,
      graph: duplicateSelectedEdge(ambiguous.index, ambiguous.directEdgeId) }
    expect(hydrateEvidence(index, ambiguous.targets)).toEqual({
      state: 'corrupt', subject: ambiguous.directEdgeId,
    })
  })

  it('rejects a selected source that resolves outside the indexed root', () => {
    const value = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'madar-hydrator-outside-'))
    roots.push(outside)
    write(outside, 'flow.ts', sourceText)
    unlinkSync(join(value.root, path))
    symlinkSync(join(outside, 'flow.ts'), join(value.root, path))
    expect(hydrateEvidence(value.index, value.targets)).toEqual({
      state: 'unavailable', subject: path,
    })
    const implementation = readFileSync(
      new URL('../../src/application/evidence-hydrator.ts', import.meta.url),
      'utf8',
    )
    expect(implementation.indexOf('const relativePath = relative(root, candidate)'))
      .toBeLessThan(implementation.indexOf('bytes = readFileSync(candidate)'))
  })

  it('rejects fatal UTF-8 while distinguishing it from stale bytes', () => {
    const value = fixture()
    const bytes = Buffer.from([0xff])
    write(value.root, path, bytes)
    const fileHash = hash(bytes)
    const fileNode = value.graph.nodeAttributes(fileId)
    value.graph.replaceNodeAttributes(fileId, { ...fileNode, content_hash: fileHash })
    const index = { ...value.index, file_hashes: new Map([[path, fileHash]]) }
    expect(hydrateEvidence(index, value.targets)).toEqual({ state: 'corrupt', subject: path })
  })
})
