import { describe, expect, it } from 'vitest'
import {
  contextExpansionQueryProgress, createContextExpansionQueryGoal, createContextExpansionQueryRegistry,
  type ContextExpansionQueryGoal,
} from '../../src/runtime/context-expansion-query.js'

const question = 'Explain amber invoices; violet journals; cobalt receipts.'
const binding = 'logical-root:canonical-root:graph-generation:source-generation'
const source = (id: string, words: string) => ({
  node_id: id, label: `${id}()`, source_file: `${id}.ts`,
  snippet: `export function ${id}() { return "${words}"; }`,
})
function goal(): ContextExpansionQueryGoal {
  const value = createContextExpansionQueryGoal(question, [source('initial', 'amber invoices')])
  if (!value) throw new Error('Fixture requires a residual query goal')
  return { ...value, missing_obligations: [...value.missing_obligations] }
}

describe('transport-lifetime advisory query registry', () => {
  it('copies goals independently, reuses identical claims and retains only residual lexical progress', () => {
    const registry = createContextExpansionQueryRegistry(), original = goal()
    expect(original.missing_obligations).toEqual(['query:obligation:2', 'query:obligation:3'])
    registry.observe('generic', 'ordered-context-and-final-page', original, binding)
    const retained = registry.resolve('generic', 'ordered-context-and-final-page', binding)!
    expect(retained).toEqual(original)
    expect(retained).not.toBe(original)
    expect(retained.missing_obligations).not.toBe(original.missing_obligations)
    expect(Object.isFrozen(retained) && Object.isFrozen(retained.missing_obligations)).toBe(true)
    original.question = 'changed caller input'
    original.missing_obligations.splice(0)
    registry.observe('generic', 'ordered-context-and-final-page', goal(), binding)
    expect(registry.resolve('generic', 'ordered-context-and-final-page', binding)).toBe(retained)
    expect(contextExpansionQueryProgress(retained, [source('journal', 'violet journals')])).toEqual(['query:obligation:2'])
    expect(contextExpansionQueryProgress(retained, [source('initial', 'amber invoices')])).toEqual([])
    expect(contextExpansionQueryProgress(retained, [{ ...source('flagged', 'violet journals'), snippet_unverified: true }])).toEqual([])
  })

  it('never unions or revives conflicting claims, including marked and unmarked reissues', () => {
    const original = goal(), other = { ...goal(), missing_obligations: ['query:obligation:3'] }
    const cases = [
      { first: original, second: original, fingerprint: 'different-ordered-scope', binding },
      { first: original, second: other, fingerprint: 'same', binding },
      { first: original, second: original, fingerprint: 'same', binding: 'different-root-or-generation' },
      { first: original, second: undefined, fingerprint: 'same', binding },
      { first: undefined, second: original, fingerprint: 'same', binding },
    ]
    for (const scenario of cases) {
      const registry = createContextExpansionQueryRegistry()
      registry.observe('generic', 'same', scenario.first, binding)
      registry.observe('generic', scenario.fingerprint, scenario.second, scenario.binding)
      registry.observe('generic', 'same', original, binding)
      expect(registry.resolve('generic', 'same', binding)).toBeUndefined()
      expect(registry.resolve('generic', scenario.fingerprint, scenario.binding)).toBeUndefined()
    }
  })

  it('counts unmarked publications and disables the whole registry permanently at saturation', () => {
    const registry = createContextExpansionQueryRegistry(2), original = goal()
    registry.observe('marked', 'one', original, binding)
    registry.observe('unmarked', 'two')
    registry.observe('marked', 'one', original, binding)
    expect(registry.resolve('marked', 'one', binding)).toEqual(original)
    registry.observe('overflow', 'three')
    registry.observe('marked', 'one', original, binding)
    registry.observe('new', 'four', original, binding)
    expect(registry.resolve('marked', 'one', binding)).toBeUndefined()
    expect(registry.resolve('new', 'four', binding)).toBeUndefined()
    expect(Object.keys(registry).sort()).toEqual(['observe', 'resolve'])
    const nextTransport = createContextExpansionQueryRegistry(2)
    nextTransport.observe('marked', 'one', original, binding)
    expect(nextTransport.resolve('marked', 'one', binding)).toEqual(original)
  })

  it('falls back for missing or mismatched current claims and refuses invalid marked goals', () => {
    const registry = createContextExpansionQueryRegistry(), original = goal()
    registry.observe('generic', 'same', original, binding)
    expect(registry.resolve('absent', 'same', binding)).toBeUndefined()
    expect(registry.resolve('generic', 'changed-page-or-context', binding)).toBeUndefined()
    expect(registry.resolve('generic', 'same', 'changed-root-or-generation')).toBeUndefined()
    expect(registry.resolve('generic', 'same', '')).toBeUndefined()
    expect(registry.resolve('generic', 'same', binding)).toEqual(original)
    registry.observe('unmarked', 'same', undefined, binding)
    expect(registry.resolve('unmarked', 'same', binding)).toBeUndefined()
    registry.observe('invalid', 'same', { ...original, missing_obligations: ['query:obligation:99'] }, binding)
    registry.observe('invalid', 'same', original, binding)
    registry.observe('unbound', 'same', original)
    registry.observe('unbound', 'same', original, binding)
    expect(registry.resolve('invalid', 'same', binding)).toBeUndefined()
    expect(registry.resolve('unbound', 'same', binding)).toBeUndefined()
  })
})
