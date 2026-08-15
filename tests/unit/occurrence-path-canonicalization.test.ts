import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import {
  createEvidenceOccurrence,
  createSemanticFactId,
  normalizeIdentityRepositoryPath,
  SemanticIdentityInvariantError,
} from '../../src/contracts/semantic-identity.js'
import type { SemanticFactId } from '../../src/contracts/semantic-graph.js'

function discriminator(relation: string): never {
  const resolution = resolveRelationDiscriminator(relation as never)
  if (resolution.status !== 'registered') throw new Error(`${relation} is not registered`)
  return resolution.discriminator as never
}

const FACT_ID: SemanticFactId = createSemanticFactId({
  direction: 'directed',
  source: 'a',
  target: 'b',
  relation: 'calls',
  discriminator: discriminator('calls'),
})

const owner = { adapterId: 'ad', strategy: 'st' } as const

/**
 * Golden control. These ids were captured from the released v1 identity rules
 * before stored paths were canonicalized. Canonicalizing what is *stored* must
 * not move an id, because the id already normalized the path -- that mismatch
 * was the whole defect. If one of these changes, occurrence identity changed
 * and that is an architecture decision owned by #704, not a test to update.
 */
const GOLDEN = {
  sourceOnly: 'eo_9116f23ebd94d80d0af5b8fe47c68f4a6aabcbdec3753d53613a6027508b2ead',
  withTarget: 'eo_56dcdb5cee87e50b460d10f8968c88d068a129935df2b8bafc3b4bb61d52060d',
} as const

describe('occurrence identity is unchanged by canonicalizing stored paths', () => {
  it('keeps the pinned id for a canonical source path', () => {
    expect(createEvidenceOccurrence({ factId: FACT_ID, owner, sourceFile: 'src/a.ts' }).id)
      .toBe(GOLDEN.sourceOnly)
  })

  it('gives every equivalent spelling the same id', () => {
    const ids = ['src/a.ts', 'src\\a.ts', 'src//a.ts', 'src/./a.ts'].map((sourceFile) => (
      createEvidenceOccurrence({ factId: FACT_ID, owner, sourceFile }).id
    ))

    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(GOLDEN.sourceOnly)
  })
})

describe('the stored occurrence payload is canonical', () => {
  it('stores one canonical spelling regardless of input spelling', () => {
    const stored = ['src/a.ts', 'src\\a.ts', 'src//a.ts', 'src/./a.ts'].map((sourceFile) => (
      createEvidenceOccurrence({ factId: FACT_ID, owner, sourceFile }).sourceFile
    ))

    // Before the fix these were four different strings sharing one id.
    expect(stored).toEqual(['src/a.ts', 'src/a.ts', 'src/a.ts', 'src/a.ts'])
  })

  it('canonicalizes the target path too', () => {
    const canonical = createEvidenceOccurrence({
      factId: FACT_ID, owner, sourceFile: 'src/a.ts', targetFile: 'src/b.ts',
    })
    const noisy = createEvidenceOccurrence({
      factId: FACT_ID, owner, sourceFile: 'src/a.ts', targetFile: 'src\\b.ts',
    })

    expect(noisy.targetFile).toBe('src/b.ts')
    expect(noisy.id).toBe(canonical.id)
    expect(canonical.id).toBe(GOLDEN.withTarget)
  })

  it('canonicalizes owner.sourceFile rather than leaving it raw', () => {
    const occurrence = createEvidenceOccurrence({
      factId: FACT_ID,
      owner: { adapterId: 'ad', strategy: 'st', sourceFile: 'src\\a.ts' },
    })

    expect(occurrence.owner.sourceFile).toBe('src/a.ts')
    expect(occurrence.sourceFile).toBe('src/a.ts')
    expect(occurrence.id).toBe(GOLDEN.sourceOnly)
  })

  it('leaves an absent owner path absent instead of inventing one', () => {
    const occurrence = createEvidenceOccurrence({ factId: FACT_ID, owner, sourceFile: 'src/a.ts' })

    expect(occurrence.owner.sourceFile).toBeUndefined()
  })
})

describe('conflicting source paths fail loudly', () => {
  it('rejects a sourceFile that disagrees with owner.sourceFile', () => {
    expect(() => createEvidenceOccurrence({
      factId: FACT_ID,
      owner: { adapterId: 'ad', strategy: 'st', sourceFile: 'src/b.ts' },
      sourceFile: 'src/a.ts',
    })).toThrow(SemanticIdentityInvariantError)
  })

  it('accepts them when they differ only in spelling', () => {
    const occurrence = createEvidenceOccurrence({
      factId: FACT_ID,
      owner: { adapterId: 'ad', strategy: 'st', sourceFile: 'src\\a.ts' },
      sourceFile: 'src/./a.ts',
    })

    expect(occurrence.sourceFile).toBe('src/a.ts')
    expect(occurrence.owner.sourceFile).toBe('src/a.ts')
  })
})

describe('the strict identity API still refuses non-repository-relative paths', () => {
  it.each([
    ['absolute posix', '/etc/passwd'],
    ['drive absolute', 'C:/windows/a.ts'],
    ['url-like', 'https://host/a.ts'],
    ['traversal', '../outside/a.ts'],
  ])('rejects %s', (_label, sourceFile) => {
    expect(() => createEvidenceOccurrence({ factId: FACT_ID, owner, sourceFile }))
      .toThrow(SemanticIdentityInvariantError)
  })

  it('exposes exactly one normalizer for callers', () => {
    expect(normalizeIdentityRepositoryPath('src\\.\\a.ts', 'f')).toBe('src/a.ts')
    expect(normalizeIdentityRepositoryPath(null, 'f')).toBeNull()
  })
})

describe('the graph compatibility adapter agrees with the identity layer', () => {
  const admit = (sourceFile: string): KnowledgeGraph => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('a', {})
    graph.addNode('b', {})
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED', source_file: sourceFile })
    return graph
  }

  it.each([
    ['url-like', 'https://host/a.ts'],
    ['absolute posix', '/etc/passwd'],
    ['drive absolute', 'C:/windows/a.ts'],
    ['traversal', '../outside/a.ts'],
  ])('omits %s instead of crashing occurrence creation', (_label, sourceFile) => {
    // The adapter previously used its own looser rules, so a url-like path was
    // approved here and then thrown out inside createEvidenceOccurrence.
    expect(() => admit(sourceFile)).not.toThrow()
    expect(admit(sourceFile).numberOfFacts()).toBe(1)
  })

  it('passes a valid path through in canonical form', () => {
    const graph = admit('src\\a.ts')
    const [record] = graph.factRecords()
    if (record === undefined) throw new Error('no fact stored')
    const [occurrence] = graph.occurrencesForFact(record.fact.id)

    expect(occurrence?.sourceFile).toBe('src/a.ts')
  })
})
