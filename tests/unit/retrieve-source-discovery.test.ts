import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  compactRetrieveResult,
  contextPackFromRetrieveResult,
  retrieveContext,
} from '../../src/runtime/retrieve.js'

type Attributes = Record<string, unknown>
const ROOT = '/workspace'

function graph(): KnowledgeGraph {
  const value = new KnowledgeGraph({ directed: true })
  value.graph.root_path = ROOT
  return value
}

function provenance(sourceFile: string, sourceLocation = 'L7', capabilityId = 'builtin:extract:typescript'): Attributes[] {
  return [{ capability_id: capabilityId, stage: 'extract', source_file: sourceFile, source_location: sourceLocation }]
}

function sourceOwner(overrides: Attributes = {}): Attributes {
  const sourceFile = typeof overrides.source_file === 'string' ? overrides.source_file : `${ROOT}/src/neutral.ts`
  return {
    label: '.operate()',
    file_type: 'code',
    source_file: sourceFile,
    source_location: 'L7-L9',
    node_kind: 'method',
    snippet: 'export function neutral() {\n  return ledger.parcel_checksum\n}',
    provenance: provenance(sourceFile),
    community: 0,
    ...overrides,
  }
}

function addOwner(target: KnowledgeGraph, id: string, overrides: Attributes = {}): void {
  target.addNode(id, sourceOwner(overrides))
}

function retrieveIds(target: KnowledgeGraph, question: string, options: Attributes = {}): string[] {
  return retrieveContext(target, {
    question,
    budget: 1_200,
    retrievalLevel: 2,
    ...options,
  }).matched_nodes.map((node) => node.node_id ?? '')
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('stored-source candidate discovery', () => {
  it('admits a neutral body-only camelCase/snake_case member owner and expands its directed call', () => {
    const target = graph()
    addOwner(target, 'owner')
    target.addNode('callee', {
      label: '.forward()', file_type: 'code', source_file: `${ROOT}/src/downstream.ts`, source_location: 'L20', node_kind: 'method', community: 0,
    })
    target.addEdge('owner', 'callee', { relation: 'calls' })
    const ids = retrieveIds(target, 'Explain parcelChecksum')
    expect(ids).toContain('owner')
    expect(ids).toContain('callee')
  })

  it('discovers the body owner in label/path competition instead of merely avoiding an empty result', () => {
    const target = graph()
    addOwner(target, 'body_owner', { label: '.transmit()', source_file: `${ROOT}/src/channel.ts`, provenance: provenance(`${ROOT}/src/channel.ts`) })
    target.addNode('label_distractor', {
      label: 'ParcelChecksumCatalog', file_type: 'code', source_file: `${ROOT}/src/parcel-checksum-catalog.ts`, source_location: 'L30', node_kind: 'class', community: 0,
    })
    const ids = retrieveIds(target, 'Explain parcelChecksum')
    expect(ids).toContain('label_distractor')
    expect(ids).toContain('body_owner')
  })

  it('uses an independent source ranking to order admitted body-only candidates', () => {
    const target = graph()
    addOwner(target, 'high_source', {
      label: 'Zulu()', source_file: `${ROOT}/src/zulu.ts`, snippet: 'function zulu() {\n  return orbit + detail\n}', provenance: provenance(`${ROOT}/src/zulu.ts`),
    })
    addOwner(target, 'low_source', {
      label: 'Alpha()', source_file: `${ROOT}/src/alpha.ts`, snippet: 'function alpha() {\n  return orbit\n}', provenance: provenance(`${ROOT}/src/alpha.ts`),
    })
    const ids = retrieveIds(target, 'Explain orbit detail')
    expect(ids).toEqual(expect.arrayContaining(['high_source', 'low_source']))
    expect(ids.indexOf('high_source')).toBeLessThan(ids.indexOf('low_source'))
  })

  it('deduplicates repeated terms and keeps source scoring capped and deterministic', () => {
    const target = graph()
    addOwner(target, 'owner', { snippet: 'function neutral() {\n  return parcel_checksum + parcelChecksum + parcel_checksum\n}' })
    const once = retrieveContext(target, { question: 'parcelChecksum', budget: 1_200, retrievalLevel: 1 })
    const repeated = retrieveContext(target, { question: 'parcelChecksum parcelChecksum parcelChecksum', budget: 1_200, retrievalLevel: 1 })
    expect(once.matched_nodes.find((node) => node.node_id === 'owner')?.match_score).toBe(
      repeated.matched_nodes.find((node) => node.node_id === 'owner')?.match_score,
    )
    expect(retrieveIds(target, 'parcelChecksum')).toEqual(retrieveIds(target, 'parcelChecksum'))
  })

  it('keeps ambiguous equally supported owners as related evidence without invented certainty', () => {
    const target = graph()
    addOwner(target, 'left', { label: 'Left()', source_file: `${ROOT}/src/left.ts`, provenance: provenance(`${ROOT}/src/left.ts`) })
    addOwner(target, 'right', { label: 'Right()', source_file: `${ROOT}/src/right.ts`, provenance: provenance(`${ROOT}/src/right.ts`) })
    const result = retrieveContext(target, { question: 'parcelChecksum', budget: 1_200, retrievalLevel: 1 })
    const owners = result.matched_nodes.filter((node) => node.node_id === 'left' || node.node_id === 'right')
    expect(owners).toHaveLength(2)
    expect(owners.map((node) => node.relevance_band)).toEqual(['related', 'related'])
    expect(owners.every((node) => node.match_score > 0)).toBe(true)
  })

  it('keeps levels, exclusions, community and file-type filters effective', () => {
    const target = graph()
    addOwner(target, 'owner')
    target.addNode('callee', {
      label: '.forward()', file_type: 'code', source_file: `${ROOT}/src/downstream.ts`, source_location: 'L20', node_kind: 'method', community: 0,
    })
    target.addEdge('owner', 'callee', { relation: 'calls' })
    expect(retrieveIds(target, 'parcelChecksum', { retrievalLevel: 0 })).toEqual([])
    expect(retrieveIds(target, 'parcelChecksum', { retrievalLevel: 1 })).toContain('owner')
    expect(retrieveIds(target, 'parcelChecksum', { retrievalLevel: 1 })).not.toContain('callee')
    expect(retrieveIds(target, 'parcelChecksum', { retrievalLevel: 2 })).toContain('callee')
    expect(retrieveIds(target, 'parcelChecksum', { community: 9 })).toEqual([])
    expect(retrieveIds(target, 'parcelChecksum', { fileType: 'document' })).toEqual([])
    expect(retrieveIds(target, 'Explain parcelChecksum without parcelChecksum')).toEqual([])
  })

  it('retains source-domain pollution penalties and only allows an intentionally requested domain', () => {
    const target = graph()
    addOwner(target, 'test_owner', { source_file: `${ROOT}/tests/neutral.test.ts`, provenance: provenance(`${ROOT}/tests/neutral.test.ts`) })
    expect(retrieveIds(target, 'Explain parcelChecksum production behavior')).not.toContain('test_owner')
    expect(retrieveIds(target, 'Explain parcelChecksum tests')).toContain('test_owner')
  })

  it('does not let a body hit unlock a metadata-only runtime-boundary boost or anchor flags', () => {
    const target = graph()
    addOwner(target, 'owner', { snippet: 'function neutral() {\n  return polar_cipher\n}', framework_metadata: { runtime_boundary: 'server' } })
    const result = retrieveContext(target, { question: 'Explain the next server polarCipher behavior', budget: 1_200, retrievalLevel: 1 })
    const owner = result.matched_nodes.find((node) => node.node_id === 'owner')
    expect(owner).toEqual(expect.objectContaining({ framework_boost: 0, relevance_band: 'related' }))
    expect(owner).not.toHaveProperty('source_token_score')
  })

  it('preserves exact raw, compact, and compiled bytes without eligible snippets', () => {
    const target = graph()
    target.addNode('first', { label: 'CopperRelay', file_type: 'code', source_file: `${ROOT}/src/copper-relay.ts`, source_location: 'L7-L9', node_kind: 'function', community: 0 })
    target.addNode('second', { label: 'RelayLedger', file_type: 'code', source_file: `${ROOT}/src/relay-ledger.ts`, source_location: 'L20-L21', node_kind: 'method', community: 0 })
    target.addEdge('first', 'second', { relation: 'calls' })
    const raw = retrieveContext(target, { question: 'Explain CopperRelay', budget: 800, retrievalLevel: 2 })
    expect(digest(raw)).toBe('6b8789709c070b669c156ba9cc25930abfecdb606dbe1369092b782f88b36d3d')
    expect(digest(compactRetrieveResult(raw))).toBe('180d8692454d70748d34568fb6b32814b32a7113f3d3d17243b7e5a5258862ac')
    expect(digest(contextPackFromRetrieveResult(raw))).toBe('69ed3fb7ee9faadd7ba507e1b8b136760cd5d6211d265d254719256edef91f39')
  })

  it.each([
    ['absent kind TypeScript', { node_kind: undefined }, true],
    ['explicit function', { node_kind: 'function' }, true],
    ['explicit method', { node_kind: 'method', label: '.operate()' }, true],
    ['JavaScript extractor', { source_file: `${ROOT}/src/neutral.js`, provenance: provenance(`${ROOT}/src/neutral.js`, 'L7', 'builtin:extract:javascript') }, true],
    ['JSX extractor', { source_file: `${ROOT}/src/neutral.JSX`, provenance: provenance(`${ROOT}/src/neutral.JSX`, 'L7', 'builtin:extract:javascript') }, true],
    ['Unicode absent-kind function', { node_kind: undefined, label: 'προβολή()' }, true],
    ['dollar absent-kind function', { node_kind: undefined, label: '$relay()' }, true],
    ['underscore absent-kind method', { node_kind: undefined, label: '._relay()' }, true],
    ['present undefined kind', { node_kind: undefined, label: 'operate()' }, false, true],
    ['null kind', { node_kind: null, label: 'operate()' }, false],
    ['empty kind', { node_kind: '', label: 'operate()' }, false],
    ['unknown kind', { node_kind: 'unknown', label: 'operate()' }, false],
    ['wrong typed kind', { node_kind: 1, label: 'operate()' }, false],
    ['class kind', { node_kind: 'class' }, false],
    ['type kind', { node_kind: 'type' }, false],
    ['constant kind', { node_kind: 'constant' }, false],
    ['qualified inferred label', { node_kind: undefined, label: 'Box.operate()' }, false],
    ['escaped inferred label', { node_kind: undefined, label: '\\u006fperate()' }, false],
    ['spaced inferred label', { node_kind: undefined, label: 'operate ()' }, false],
    ['generic inferred label', { node_kind: undefined, label: 'operate<T>()' }, false],
    ['extra-dot inferred label', { node_kind: undefined, label: '..operate()' }, false],
  ])('enforces declaration identity: %s', (_name, overrides, expected, forceOwnUndefined = false) => {
    const target = graph()
    const rawOverrides = overrides as Attributes
    const attributes = sourceOwner(rawOverrides)
    if (!forceOwnUndefined && Object.prototype.hasOwnProperty.call(rawOverrides, 'node_kind') && rawOverrides.node_kind === undefined) delete attributes.node_kind
    target.addNode('candidate', attributes)
    expect(retrieveIds(target, 'parcelChecksum').includes('candidate')).toBe(expected)
  })

  it.each([
    ['single L7', { source_location: 'L7', snippet: 'parcelChecksum' }, true],
    ['single L7-L7', { source_location: 'L7-L7', snippet: 'parcelChecksum' }, true],
    ['last safe line', { source_location: 'L9007199254740991', snippet: 'parcelChecksum', provenance: provenance(`${ROOT}/src/neutral.ts`, 'L9007199254740991') }, true],
    ['partial', { source_location: 'L7-' }, false],
    ['reversed', { source_location: 'L9-L7' }, false],
    ['zero', { source_location: 'L0' }, false],
    ['unsafe', { source_location: 'L9007199254740992', provenance: provenance(`${ROOT}/src/neutral.ts`, 'L9007199254740992') }, false],
    ['contradictory line number', { line_number: 8 }, false],
    ['multiline single range', { source_location: 'L7', snippet: 'parcelChecksum\nreturn true' }, false],
    ['snippet exceeds span', { source_location: 'L7-L8', snippet: 'parcelChecksum\nreturn true\nend' }, false],
    ['CRLF', { snippet: 'parcelChecksum\r\nreturn true' }, false],
    ['outer whitespace', { snippet: ' parcelChecksum' }, false],
    ['26 lines', { source_location: 'L7-L40', snippet: Array.from({ length: 26 }, () => 'parcelChecksum').join('\n') }, false],
    ['2000 chars', { source_location: 'L7', snippet: `parcelChecksum${'x'.repeat(1_986)}` }, true],
    ['2003 canonical chars', { source_location: 'L7', snippet: `parcelChecksum${'x'.repeat(1_986)}...` }, true],
    ['2001 no suffix', { source_location: 'L7', snippet: `parcelChecksum${'x'.repeat(1_987)}` }, false],
    ['whitespace before suffix', { source_location: 'L7', snippet: `parcelChecksum${'x'.repeat(1_983)} ...` }, false],
  ])('enforces ranges and literal snippet shape: %s', (_name, overrides, expected) => {
    const target = graph()
    target.addNode('candidate', sourceOwner(overrides as Attributes))
    expect(retrieveIds(target, 'parcelChecksum').includes('candidate')).toBe(expected)
  })

  it.each([
    ['missing source path', { source_file: undefined }, false],
    ['foreign path', { source_file: '/foreign/src/neutral.ts', provenance: provenance('/foreign/src/neutral.ts') }, false],
    ['escaping path', { source_file: '../foreign.ts', provenance: provenance('../foreign.ts') }, false],
    ['NUL path', { source_file: `${ROOT}/src/bad\0.ts`, provenance: provenance(`${ROOT}/src/bad\0.ts`) }, false],
    ['wrong extractor', { provenance: provenance(`${ROOT}/src/neutral.ts`, 'L7', 'builtin:extract:javascript') }, false],
    ['wrong stage', { provenance: [{ capability_id: 'builtin:extract:typescript', stage: 'normalize', source_file: `${ROOT}/src/neutral.ts`, source_location: 'L7' }] }, false],
    ['wrong provenance path', { provenance: provenance(`${ROOT}/src/other.ts`) }, false],
    ['wrong provenance start', { provenance: provenance(`${ROOT}/src/neutral.ts`, 'L8') }, false],
    ['matching plus unrelated', { provenance: [...provenance(`${ROOT}/src/neutral.ts`), { capability_id: 'custom:index', stage: 'index' }] }, true],
    ['matching plus conflicting applicable', { provenance: [...provenance(`${ROOT}/src/neutral.ts`), ...provenance(`${ROOT}/src/other.ts`)] }, false],
    ['matching plus malformed applicable', { provenance: [...provenance(`${ROOT}/src/neutral.ts`), { stage: 'extract' }] }, false],
    ['flat external call', { external_call: true }, false],
    ['nested external call', { framework_metadata: { external_call: true } }, false],
    ['malformed flat exclusion', { external_call: 'yes' }, false],
    ['malformed nested exclusion', { framework_metadata: { external_call: 'yes' } }, false],
    ['file-like owner', { label: 'neutral.ts' }, false],
    ['placeholder owner', { placeholder: true }, false],
    ['synthetic owner', { synthetic: true }, false],
    ['explicit placeholder owner', { is_placeholder: true }, false],
    ['explicit synthetic owner', { is_synthetic: true }, false],
    ['non-code owner', { file_type: 'document' }, false],
  ])('enforces source/provenance/exclusion identity: %s', (_name, overrides, expected) => {
    const target = graph()
    target.addNode('candidate', sourceOwner(overrides as Attributes))
    expect(retrieveIds(target, 'parcelChecksum').includes('candidate')).toBe(expected)
  })

  it('invalidates same-graph source, identity, nested metadata, filtered nodes, and root mutations', () => {
    const target = graph()
    const metadata: Attributes = { external_call: false }
    const original = sourceOwner({ framework_metadata: metadata })
    target.addNode('candidate', original)
    expect(retrieveIds(target, 'parcelChecksum')).toContain('candidate')
    target.addNode('candidate', { ...original, snippet: 'return revisedToken' })
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
    expect(retrieveIds(target, 'revisedToken')).toContain('candidate')
    const deletedSnippet = { ...original }
    delete deletedSnippet.snippet
    target.addNode('candidate', deletedSnippet)
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
    target.addNode('candidate', original)
    metadata.external_call = true
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
    metadata.external_call = false
    const absentKindWithBadLabel: Attributes = { ...original, label: 'not canonical' }
    delete absentKindWithBadLabel.node_kind
    target.addNode('candidate', absentKindWithBadLabel)
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
    target.addNode('candidate', original)
    expect(retrieveIds(target, 'parcelChecksum', { community: 9 })).toEqual([])
    target.addNode('candidate', { ...original, provenance: provenance(`${ROOT}/src/other.ts`) })
    expect(retrieveIds(target, 'parcelChecksum', { community: 9 })).toEqual([])
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
    target.addNode('candidate', original)
    target.graph.root_path = '/different-root'
    expect(retrieveIds(target, 'parcelChecksum')).not.toContain('candidate')
  })
})
