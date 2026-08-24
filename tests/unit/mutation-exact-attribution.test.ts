import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ATTRIBUTION_REASONS,
  compareFailureIdentitySets,
  isExactAttribution,
  recomputeExactAttribution,
  scoreMutant,
  validateExactDeclaration,
} from '../../scripts/lib/mutation-scoring.mjs'

/**
 * Exact failure-set attribution for the one bounded shared-policy exception.
 *
 * The default rule is unchanged: a mutant owns one test, and that named test
 * failing attributes it. This file governs the other mode, where a mutant
 * legitimately breaks a known group and the declaration therefore has to name
 * the whole group.
 *
 * The reason it exists: the group was previously declared as one exact name
 * plus a broad regex, and matching a pattern is not the same claim as set
 * equality. A pattern says which names are acceptable. It cannot say which must
 * ALL be present and no others. An independent review reproduced both halves of
 * that gap against the genuine 25-identity failure set -- 26 scored `caught` as
 * 26/26, and 24 scored `caught` as 24/24, each indistinguishable from the truth.
 *
 * Every control below uses that genuine shape rather than a toy one, because a
 * three-name fixture would not have exposed the defect either.
 */

const IDENTITY_PREFIX = 'S3-W — strict and qualification fail closed on every warning family '

const FAMILIES = [
  'partial_discriminator_retained',
  'context_bound_endpoint_identity',
  'unknown_endpoint_identity',
  'legacy_endpoint_identity',
] as const

/** The genuine 25, rebuilt from the same shape Vitest emits. */
function genuineIdentities(): readonly string[] {
  const perFamily = FAMILIES.flatMap((family) => (['strict', 'qualification'] as const).flatMap((mode) => [
    `${IDENTITY_PREFIX}${mode} refuses ${family}`,
    `${IDENTITY_PREFIX}${mode} refuses ${family} with a typed artifact invariant`,
    `${IDENTITY_PREFIX}${mode} exposes no artifact when it refuses ${family}`,
  ]))
  return Object.freeze([
    ...perFamily,
    'S3-W — the retained partial discriminator is fatal on its own is refused by strict '
    + 'even though every candidate was retained',
  ])
}

const DECLARED = genuineIdentities()

/** Index helper: the declaration is fixed-length, so this is total. */
const at = (index: number): string => DECLARED[index] as string

function score(declared: readonly (string | RegExp)[], failed: readonly string[]) {
  const result = scoreMutant({
    expect: declared,
    result: { usable: true, total: 43, failed: [...failed] },
    exactFailureSet: true,
  })
  // Exact-set scoring only ever persists the exact-set shape; narrowing here
  // keeps every assertion below reading the fields it means.
  return {
    ...result,
    attribution: isExactAttribution(result.attribution) ? result.attribution : undefined,
  }
}

describe('exact attribution — the declaration itself is validated', () => {
  it('accepts a duplicate-free list of exact strings', () => {
    expect(validateExactDeclaration([...DECLARED]).ok).toBe(true)
  })

  it('refuses a regex, because a pattern cannot express set equality', () => {
    const result = validateExactDeclaration([at(0), /^S3-W — strict/])
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(ATTRIBUTION_REASONS.invalidExactDeclaration)
  })

  it('refuses a repeated declared identity rather than collapsing it', () => {
    // Silently de-duplicating would let a 25-entry declaration cover 24
    // distinct identities while still claiming 25.
    const result = validateExactDeclaration([...DECLARED, at(0)])
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(ATTRIBUTION_REASONS.duplicateDeclaredTestIdentity)
  })

  it('refuses an empty or blank entry', () => {
    expect(validateExactDeclaration([...DECLARED, '   ']).ok).toBe(false)
    expect(validateExactDeclaration([]).ok).toBe(false)
  })
})

describe('exact attribution — the shared-policy mutant', () => {
  it('7.1 catches a truthful set regardless of order', () => {
    const forward = score(DECLARED, DECLARED)
    const reversed = score(DECLARED, [...DECLARED].reverse())
    expect(forward.kind).toBe('caught')
    expect(reversed.kind).toBe('caught')
    expect(reversed.attribution!.equal).toBe(true)
    expect(reversed.attribution!.unexpected).toEqual([])
    expect(reversed.attribution!.missing).toEqual([])
  })

  it('7.2 refuses one undeclared extra failure', () => {
    // The exact case the old broad regex accepted: a name it matched, that
    // nobody declared.
    const intruder = `${IDENTITY_PREFIX}strict refuses an invented family nobody declared`
    const result = score(DECLARED, [...DECLARED, intruder])
    expect(result.kind).not.toBe('caught')
    expect(result.reason).toBe(ATTRIBUTION_REASONS.unexpectedFailedTest)
    expect(result.attribution!.unexpected).toEqual([intruder])
    expect(result.attribution!.missing).toEqual([])
  })

  it('7.3 refuses one declared failure going missing', () => {
    const dropped = at(0)
    const result = score(DECLARED, DECLARED.slice(1))
    expect(result.kind).not.toBe('caught')
    expect(result.reason).toBe(ATTRIBUTION_REASONS.missingExpectedFailedTest)
    expect(result.attribution!.missing).toEqual([dropped])
    expect(result.attribution!.unexpected).toEqual([])
  })

  it('7.4 refuses a duplicated observed identity', () => {
    const result = score(DECLARED, [...DECLARED.slice(0, 24), at(0)])
    expect(result.kind).not.toBe('caught')
    expect(result.reason).toBe(ATTRIBUTION_REASONS.duplicateFailedTestIdentity)
    expect(result.attribution!.duplicateActual).toEqual([at(0)])
  })

  it('7.5 refuses a duplicated declaration before scoring', () => {
    const result = score([...DECLARED, at(0)], DECLARED)
    expect(result.kind).not.toBe('caught')
    expect(result.reason).toBe(ATTRIBUTION_REASONS.duplicateDeclaredTestIdentity)
  })

  it('7.6 refuses a substitution that keeps the cardinality', () => {
    // 25 in, 25 out, and still wrong. A count-only check passes this; only set
    // equality in both directions catches it.
    const substitute = `${IDENTITY_PREFIX}strict refuses something else entirely`
    const displaced = at(24)
    const result = score(DECLARED, [...DECLARED.slice(0, 24), substitute])
    expect(result.kind).not.toBe('caught')
    expect(result.attribution!.unexpected).toEqual([substitute])
    expect(result.attribution!.missing).toEqual([displaced])
  })

  it('7.7 refuses the former broad-pattern declaration shape', () => {
    const result = score([at(0), /^S3-W — strict/], DECLARED)
    expect(result.kind).not.toBe('caught')
    expect(result.reason).toBe(ATTRIBUTION_REASONS.invalidExactDeclaration)
  })

  it('reports uncaught, not caught, when the suite stays green', () => {
    const result = score(DECLARED, [])
    expect(result.kind).toBe('UNCAUGHT')
  })
})

describe('exact attribution — the default owning-test rule is untouched', () => {
  it('still attributes an ordinary mutant by its one named test', () => {
    const result = scoreMutant({
      expect: ['refuses a forged valid status'],
      result: {
        usable: true,
        total: 10,
        failed: ['suite > refuses a forged valid status', 'suite > some other consequence'],
      },
    })
    expect(result.kind).toBe('caught')
  })

  it('still accepts a regex for an ordinary mutant', () => {
    const result = scoreMutant({
      expect: [/forged valid status/],
      result: { usable: true, total: 10, failed: ['suite > refuses a forged valid status'] },
    })
    expect(result.kind).toBe('caught')
  })
})

describe('exact attribution — comparison is symmetric and reported whole', () => {
  it('names both sides of a disagreement', () => {
    const comparison = compareFailureIdentitySets(['a', 'b', 'c'], ['b', 'c', 'd'])
    expect(comparison.unexpected).toEqual(['d'])
    expect(comparison.missing).toEqual(['a'])
  })

  it('reports duplicates on each side independently', () => {
    const comparison = compareFailureIdentitySets(['a', 'a'], ['b', 'b'])
    expect(comparison.duplicateDeclared).toEqual(['a'])
    expect(comparison.duplicateActual).toEqual(['b'])
  })
})

describe('exact attribution — the live declaration matches the live suite', () => {
  /**
   * The declaration is only as good as its agreement with the test file it
   * describes. A renamed or added control in the matrix must break attribution
   * until the list is updated deliberately, so this asserts the two are in
   * step rather than trusting that they are.
   */
  const harness = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')

  it('declares exactly 25 identities for the shared-policy mutant', () => {
    const start = harness.indexOf('exactFailureSet: true')
    expect(start).toBeGreaterThan(0)
    const block = harness.slice(start, harness.indexOf('  },', start))
    const declared = [...block.matchAll(/^ {4}'(S3-W —[^']*)',$/gm)].map((match) => match[1])
    expect(declared).toHaveLength(25)
    expect(new Set(declared).size).toBe(25)
  })

  it('declares no pattern for the shared-policy mutant', () => {
    const start = harness.indexOf('exactFailureSet: true')
    const block = harness.slice(start, harness.indexOf('  },', start))
    expect(block).not.toMatch(/^\s*\//m)
  })

  it('uses exact-set mode for exactly one mutant', () => {
    // The bounded exception stays bounded. Every other mutant keeps the
    // one-owning-test rule.
    expect(harness.split('exactFailureSet: true').length - 1).toBe(1)
  })
})

describe('exact attribution — the auditor derives the verdict itself', () => {
  it('exposes a derivation the auditor can call without the scorer', () => {
    // The auditor must not read the scorer's boolean. This is the shared
    // derivation both sides run independently over the same evidence.
    expect(typeof recomputeExactAttribution).toBe('function')
    const truthful = recomputeExactAttribution([...DECLARED], [...DECLARED])
    expect(truthful.equal).toBe(true)
    const intruder = recomputeExactAttribution([...DECLARED], [...DECLARED, 'x'])
    expect(intruder.equal).toBe(false)
    expect(intruder.unexpected).toEqual(['x'])
  })
})
