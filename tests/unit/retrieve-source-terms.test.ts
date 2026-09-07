import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  reconcileStoredSourceTerms,
  storedSourceTermCacheInspection,
} from '../../src/runtime/retrieve-source-terms.js'
import { retrieveContext, scoreNode, tokenizeLabel, tokenizeQuestion } from '../../src/runtime/retrieve.js'

type Attributes = Record<string, unknown>
const ROOT = '/workspace'

function graph(): KnowledgeGraph {
  const value = new KnowledgeGraph({ directed: true })
  value.graph.root_path = ROOT
  return value
}

function owner(sourceFile: string, overrides: Attributes = {}): Attributes {
  return {
    label: '.operate()',
    file_type: 'code',
    source_file: sourceFile,
    source_location: 'L7-L9',
    node_kind: 'method',
    snippet: 'function neutral() {\n  return parcel_checksum\n}',
    provenance: [{
      capability_id: 'builtin:extract:typescript',
      stage: 'extract',
      source_file: sourceFile,
      source_location: 'L7',
    }],
    community: 0,
    ...overrides,
  }
}

describe('stored-source term cache controls', () => {
  it('reuses unchanged token arrays and retokenizes only the changed tuple', () => {
    const target = graph()
    target.addNode('one', owner(`${ROOT}/src/one.ts`))
    target.addNode('two', owner(`${ROOT}/src/two.ts`, { snippet: 'function neutral() {\n  return amber_signal\n}' }))

    const cold = reconcileStoredSourceTerms(target, ROOT)
    const oneCold = cold.get('one')?.tokens
    const twoCold = cold.get('two')?.tokens
    const warm = reconcileStoredSourceTerms(target, ROOT)
    expect(warm.get('one')?.tokens).toBe(oneCold)
    expect(warm.get('two')?.tokens).toBe(twoCold)
    expect(storedSourceTermCacheInspection(target).tokenizationCount).toBe(2)

    target.addNode('one', owner(`${ROOT}/src/one.ts`, { snippet: 'function neutral() {\n  return revised_signal\n}' }))
    const revised = reconcileStoredSourceTerms(target, ROOT)
    expect(revised.get('one')?.tokens).not.toBe(oneCold)
    expect(revised.get('one')?.tokens).toEqual(expect.arrayContaining(['revised', 'signal']))
    expect(revised.get('two')?.tokens).toBe(twoCold)
    expect(storedSourceTermCacheInspection(target).tokenizationCount).toBe(3)
  })

  it('detects nested object edits even when the containing reference is reused', () => {
    const target = graph()
    const metadata: Attributes = { external_call: false }
    target.addNode('one', owner(`${ROOT}/src/one.ts`, { framework_metadata: metadata }))
    const before = reconcileStoredSourceTerms(target, ROOT).get('one')
    expect(before?.eligible).toBe(true)

    metadata.external_call = true
    const after = reconcileStoredSourceTerms(target, ROOT).get('one')
    expect(after?.eligible).toBe(false)
    expect(after).not.toBe(before)
  })

  it('takes add/replace/removal views and bounds retained entries to current cardinality', () => {
    const target = graph()
    target.addNode('one', owner(`${ROOT}/src/one.ts`))
    reconcileStoredSourceTerms(target, ROOT)
    expect(storedSourceTermCacheInspection(target).entryCount).toBe(1)

    target.addNode('two', owner(`${ROOT}/src/two.ts`))
    reconcileStoredSourceTerms(target, ROOT)
    expect(storedSourceTermCacheInspection(target).entryCount).toBe(2)

    const controlledCurrentView = target.nodeEntries().filter(([id]) => id !== 'one')
    reconcileStoredSourceTerms(target, ROOT, controlledCurrentView)
    expect(storedSourceTermCacheInspection(target).entryCount).toBe(controlledCurrentView.length)
    expect(storedSourceTermCacheInspection(target).tokenArrays.has('one')).toBe(false)

    target.addNode('two', owner(`${ROOT}/src/two.ts`, { snippet: 'function neutral() {\n  return replacement_value\n}' }))
    reconcileStoredSourceTerms(target, ROOT, target.nodeEntries().filter(([id]) => id === 'two'))
    expect(storedSourceTermCacheInspection(target).entryCount).toBe(1)
    expect(storedSourceTermCacheInspection(target).tokenArrays.get('two')).toEqual(expect.arrayContaining(['replacement', 'value']))
  })

  it('reconciles early-return and filtered-out nodes before later queries', () => {
    const target = graph()
    target.addNode('one', owner(`${ROOT}/src/one.ts`))
    retrieveContext(target, { question: 'parcelChecksum', budget: 500, retrievalLevel: 1 })
    const initialTokens = storedSourceTermCacheInspection(target).tokenArrays.get('one')

    target.addNode('one', owner(`${ROOT}/src/one.ts`, { snippet: 'function neutral() {\n  return early_return_value\n}' }))
    retrieveContext(target, { question: 'hello', budget: 500, retrievalLevel: 0 })
    const earlyTokens = storedSourceTermCacheInspection(target).tokenArrays.get('one')
    expect(earlyTokens).not.toBe(initialTokens)
    expect(earlyTokens).toEqual(expect.arrayContaining(['early', 'return', 'value']))

    target.addNode('one', owner(`${ROOT}/src/one.ts`, {
      provenance: [{ capability_id: 'builtin:extract:typescript', stage: 'extract', source_file: `${ROOT}/src/foreign.ts`, source_location: 'L7' }],
    }))
    retrieveContext(target, { question: 'parcelChecksum', budget: 500, retrievalLevel: 1, community: 99 })
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(false)
    expect(retrieveContext(target, { question: 'parcelChecksum', budget: 500, retrievalLevel: 1 }).matched_nodes).toEqual([])
  })

  it('invalidates path, range, kind presence, label, provenance, and root context independently', () => {
    const target = graph()
    const original = owner(`${ROOT}/src/one.ts`)
    target.addNode('one', original)
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(true)

    target.addNode('one', { ...original, source_location: 'L9-L7' })
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(false)
    target.addNode('one', { ...original, source_file: `${ROOT}/src/other.ts` })
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(false)
    target.addNode('one', { ...original, node_kind: 'class' })
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(false)

    const absentKind: Attributes = { ...original, label: 'operate()' }
    delete absentKind.node_kind
    target.addNode('one', absentKind)
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(true)
    target.addNode('one', { ...absentKind, label: 'Owner.operate()' })
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(false)

    target.addNode('one', original)
    expect(reconcileStoredSourceTerms(target, '/different-root').get('one')?.eligible).toBe(false)
    expect(reconcileStoredSourceTerms(target, ROOT).get('one')?.eligible).toBe(true)
  })

  it('owns independent state per graph and keeps cold/warm retrieval bytes equal', () => {
    const first = graph()
    const second = graph()
    first.addNode('same', owner(`${ROOT}/src/same.ts`))
    second.addNode('same', owner(`${ROOT}/src/same.ts`, { snippet: 'function neutral() {\n  return second_graph\n}' }))
    reconcileStoredSourceTerms(first, ROOT)
    reconcileStoredSourceTerms(second, ROOT)
    expect(storedSourceTermCacheInspection(first).tokenArrays.get('same')).not.toEqual(
      storedSourceTermCacheInspection(second).tokenArrays.get('same'),
    )

    const options = { question: 'parcelChecksum', budget: 800, retrievalLevel: 1 as const }
    const cold = retrieveContext(first, options)
    const warm = retrieveContext(first, options)
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold))
    expect(Object.keys(warm.matched_nodes[0] ?? {})).not.toContain('sourceTokenScore')
  })

  it('fixes the unit-weight source formula with deduplicated normalized question terms and a cap of one', () => {
    const sourceTokens = tokenizeLabel('orbit orbit detail detail member_token')
    const questionTokens = [...new Set(tokenizeQuestion('orbit detail memberToken orbit detail'))]
    const score = 0.5 * Math.min(2, scoreNode(questionTokens, sourceTokens, undefined, Math.max(sourceTokens.length, 1)))
    expect(score).toBe(1)

    const single = 0.5 * Math.min(2, scoreNode(['orbit'], sourceTokens, undefined, sourceTokens.length))
    expect(single).toBeGreaterThan(0)
    expect(single).toBeLessThanOrEqual(1)
  })
})
