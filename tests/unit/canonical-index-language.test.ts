import { describe, expect, it } from 'vitest'

import {
  assertClosedGoldBucket,
  buildCanonicalFixtureFacts,
  matchesGoldSelector,
  measureGoldBucket,
  readCanonicalGoldDefinition,
  type GoldSelector,
} from '../helpers/canonical-index-gold.js'

const SEMANTIC_RELATIONS = new Set([
  'calls',
  'extends',
  'implements',
  'param_type',
  'return_type',
])

describe('canonical TypeScript/JavaScript language gold facts', () => {
  const gold = readCanonicalGoldDefinition()
  const facts = buildCanonicalFixtureFacts()

  it('covers JS, JSX, TS, TSX, ESM, CommonJS, declarations, and exported symbols', () => {
    const missing = gold.required_nodes.filter((selector) =>
      !facts.nodes.some((fact) => matchesGoldSelector({ ...fact }, selector)))
    expect(missing, `missing required nodes:\n${JSON.stringify(missing, null, 2)}`).toEqual([])
  })

  it('treats duplicate actual facts as unexpected instead of reusing one expected selector', () => {
    const selector = { relation: 'calls', from_name: 'caller', to_name: 'target', source_location: 'L7' }
    const duplicate = { ...selector, source_file: 'core/duplicate.ts' }
    const measurement = measureGoldBucket('duplicate-proof', [duplicate, { ...duplicate }], [selector])

    expect(measurement).toMatchObject({ matched: 1, recall: 1, precision: 0.5 })
    expect(measurement.missing).toEqual([])
    expect(measurement.unexpected).toEqual([duplicate])
  })

  it('meets the closed import/re-export recall and precision gate', () => {
    const actual = facts.edges.filter((fact) =>
      (fact.relation === 'imports_from' || fact.relation === 'reexports_from')
      && fact.to_file.length > 0) as unknown as GoldSelector[]
    const measurement = measureGoldBucket('imports-and-reexports', actual, gold.module_facts)

    assertClosedGoldBucket(measurement, gold.thresholds.module_recall)
    expect(measurement.recall).toBeGreaterThanOrEqual(0.95)
    expect(measurement.precision).toBe(1)
  })

  it('keeps calls, parameter/return types, inheritance, and implementations exact', () => {
    const actual = facts.edges.filter((fact) =>
      (fact.from_file.startsWith('core/') || fact.from_file.startsWith('packages/'))
      && SEMANTIC_RELATIONS.has(fact.relation)) as unknown as GoldSelector[]
    const measurement = measureGoldBucket('language-semantics', actual, gold.semantic_facts)

    assertClosedGoldBucket(measurement, 1)
    expect(measurement.precision).toBe(1)
  })

  it('resolves inherited paths across referenced projects', () => {
    expect(facts.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_file: 'packages/app/src/use-shared.ts',
        relation: 'imports_from',
        to_file: 'packages/shared/src/model.ts',
      }),
      expect.objectContaining({
        from_name: 'sharedId',
        relation: 'param_type',
        to_name: 'SharedModel',
      }),
    ]))
  })
})
