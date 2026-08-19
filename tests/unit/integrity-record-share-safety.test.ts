import { describe, expect, it } from 'vitest'

import {
  CandidateRecordIdentityFactory,
  MAX_CONFLICT_FINGERPRINTS,
  MAX_RECORD_OCCURRENCES,
  flattenedRootPrefix,
  isRootDerivedIdentifier,
  safeEndpointIdentifier,
  safeRelationToken,
  withMultiplicityPreservingIdentity,
} from '../../src/contracts/graph-integrity.js'
import { NormalizedAccountingSession, sanitizeCandidate } from '../../src/contracts/graph-integrity-session.js'

const POSIX_ROOT = '/Users/someone/Desktop/projects/works/madar-658'
const POSIX_FLAT = 'users_someone_desktop_projects_works_madar_658'

function factory(repositoryRoot?: string): CandidateRecordIdentityFactory {
  return new CandidateRecordIdentityFactory(undefined, repositoryRoot === undefined ? {} : { repositoryRoot })
}

function unresolved(f: CandidateRecordIdentityFactory, source?: string, target?: string): ReturnType<CandidateRecordIdentityFactory['createUnresolvedRecord']> {
  return f.createUnresolvedRecord({
    candidateFingerprint: 'cf_a',
    multiplicity: 1,
    ...(source !== undefined ? { source } : {}),
    ...(target !== undefined ? { target } : {}),
    reasons: ['missing_target_endpoint'],
  })
}

describe('B1 — a flattened checkout path never reaches a shared record', () => {
  it('derives the flattened form of a POSIX root', () => {
    expect(flattenedRootPrefix(POSIX_ROOT)).toBe(POSIX_FLAT)
  })

  it('derives the flattened form of a Windows drive root', () => {
    expect(flattenedRootPrefix('C:\\Users\\someone\\proj')).toBe('c_users_someone_proj')
  })

  it('handles spaces and punctuation in a root', () => {
    expect(flattenedRootPrefix('/Users/some one/My Proj (v2)')).toBe('users_some_one_my_proj_v2')
  })

  it('treats an empty or whitespace root as no root', () => {
    expect(flattenedRootPrefix('')).toBeNull()
    expect(flattenedRootPrefix('   ')).toBeNull()
  })

  it('matches the flattened root only at a segment boundary', () => {
    expect(isRootDerivedIdentifier(`${POSIX_FLAT}_tests_fixtures_a`, POSIX_FLAT)).toBe(true)
    expect(isRootDerivedIdentifier(POSIX_FLAT, POSIX_FLAT)).toBe(true)
    // Shares a prefix but is not the root followed by a segment separator.
    expect(isRootDerivedIdentifier(`${POSIX_FLAT}x_other`, POSIX_FLAT)).toBe(false)
  })

  it('matches case-insensitively, because a Windows checkout can differ only in case', () => {
    expect(isRootDerivedIdentifier(`${POSIX_FLAT.toUpperCase()}_TESTS`, POSIX_FLAT)).toBe(true)
  })

  it('omits a root-derived endpoint from the share-safe record', () => {
    const record = unresolved(factory(POSIX_ROOT), `${POSIX_FLAT}_tests_fixtures_parent`, 'beta')
    expect(record.source).toBeUndefined()
    expect(record.target).toBe('beta')
  })

  it('never lets the username appear in a share-safe record', () => {
    const record = unresolved(factory(POSIX_ROOT), `${POSIX_FLAT}_tests_a`)
    expect(JSON.stringify(record)).not.toContain('someone')
  })

  it('keeps a legitimate underscore-rich identifier that is not root-derived', () => {
    // The check is tied to the actual root, not to "looks like a flattened path".
    const legit = 'infrastructure_benchmark_runtime_proof_handler_v2'
    expect(unresolved(factory(POSIX_ROOT), legit).source).toBe(legit)
  })

  it('refuses a Windows root-derived value', () => {
    const f = factory('C:\\Users\\someone\\proj')
    expect(unresolved(f, 'c_users_someone_proj_src_a').source).toBeUndefined()
  })

  it('refuses a linked-worktree physical root when that root is supplied', () => {
    const f = factory('/repo/.git/madar/worktrees/abc123')
    expect(unresolved(f, 'repo_git_madar_worktrees_abc123_src_a').source).toBeUndefined()
  })

  it('redacts nothing when no root is supplied, rather than inventing one', () => {
    // A wrong root is worse than none: it would redact legitimate identifiers.
    expect(unresolved(factory(), `${POSIX_FLAT}_tests_a`).source).toBe(`${POSIX_FLAT}_tests_a`)
  })

  it('keeps record identity deterministic when the hint is omitted', () => {
    const f = factory(POSIX_ROOT)
    const first = unresolved(f, `${POSIX_FLAT}_a`)
    const second = unresolved(factory(POSIX_ROOT), `${POSIX_FLAT}_a`)
    expect(second.id).toBe(first.id)
  })

  it('does not collapse two redacted endpoints onto one record', () => {
    // Identity keys on the ORIGINAL endpoints, so omitting the display hint
    // cannot merge two genuinely different candidates.
    const f = factory(POSIX_ROOT)
    const left = unresolved(f, `${POSIX_FLAT}_tests_a`)
    const right = unresolved(f, `${POSIX_FLAT}_tests_b`)
    expect(left.source).toBeUndefined()
    expect(right.source).toBeUndefined()
    expect(left.id).not.toBe(right.id)
  })
})

describe('B2 — endpoint identifiers refuse every path disguise', () => {
  const refused = (value: string): undefined | string => safeEndpointIdentifier(value, 'test')

  it.each([
    ['percent-encoded separator', '%2FUsers%2Fsomeone%2Fsecret.ts'],
    ['U+2044 fraction slash', 'a\u2044b'],
    ['U+2215 division slash', '\u2215Users\u2215someone'],
    ['U+29F8 big solidus', 'a\u29f8b'],
    ['U+FF0F fullwidth solidus', 'a\uff0fb'],
    ['U+FE68 small reverse solidus', 'a\ufe68b'],
    ['U+2216 set minus', 'a\u2216b'],
    ['dot-dot', '..'],
    ['single dot', '.'],
    ['absolute posix', '/Users/someone/x'],
    ['windows drive', 'C:\\Users\\someone'],
    ['UNC', '\\\\server\\share'],
    ['file URI', 'file:///Users/someone/x'],
    ['https URL', 'https://example.com/x'],
    ['home relative', '~/secret'],
    ['null byte', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['tab', 'a\tb'],
    ['C1 control', 'a\u0085b'],
  ])('refuses %s', (_label, value) => {
    expect(refused(value)).toBeUndefined()
  })

  it.each([
    ['ascii identifier', 'context_pack_command'],
    ['accented', 'm\u00f3dulo_caf\u00e9'],
    ['CJK', '\u30e2\u30b8\u30e5\u30fc\u30eb_\u65e5\u672c'],
    ['Arabic', '\u0648\u062d\u062f\u0629_\u0627\u062e\u062a\u0628\u0627\u0631'],
    ['dotted but not traversal', 'a.b.c'],
  ])('preserves a legitimate %s identifier', (_label, value) => {
    expect(refused(value)).toBe(value.normalize('NFC'))
  })

  it('treats NFC and NFD spellings as one identifier', () => {
    const nfc = 'caf\u00e9'
    const nfd = 'cafe\u0301'
    expect(safeEndpointIdentifier(nfd, 'test')).toBe(nfc)
    expect(safeEndpointIdentifier(nfc, 'test')).toBe(nfc)
  })

  it('applies the same disguise rules to relation tokens', () => {
    expect(safeRelationToken('a\u2044b', 'test')).toBeUndefined()
    expect(safeRelationToken('%2Fx', 'test')).toBeUndefined()
    expect(safeRelationToken('imports_from', 'test')).toBe('imports_from')
  })
})

describe('B3 — finalization preserves retention truth and record identity', () => {
  it('keeps the true occurrence total when detail is capped', () => {
    const session = new NormalizedAccountingSession()
    const occurrences = Array.from({ length: 50 }, (_, index) => (
      { id: `eo_${String(index).padStart(3, '0')}`, factId: 'sf_x' }
    )) as never[]
    session.dispose('cf_occ', { state: 'unresolved', reasons: ['missing_target_endpoint'], occurrences })
    const record = session.finalize().unresolvedRecords[0]!

    expect(record.occurrences).toHaveLength(MAX_RECORD_OCCURRENCES)
    expect(record.occurrenceRetention).toEqual({
      retained: MAX_RECORD_OCCURRENCES, total: 50, omitted: 34, truncated: true,
    })
  })

  it('finalizes a conflict group larger than the fingerprint cap without throwing', () => {
    const session = new NormalizedAccountingSession()
    const fingerprints = Array.from({ length: 40 }, (_, i) => `cf_${String(i).padStart(3, '0')}`)
    session.dispose('cf_grp', {
      state: 'conflicting', reasons: ['conflicting_behavior_metadata'], groupFingerprints: fingerprints,
    })
    const record = session.finalize().conflictRecords[0]!

    expect(record.candidateFingerprints).toHaveLength(MAX_CONFLICT_FINGERPRINTS)
    expect(record.fingerprintRetention).toEqual({
      retained: MAX_CONFLICT_FINGERPRINTS, total: 40, omitted: 8, truncated: true,
    })
    expect(record.fingerprintSetDigest).toMatch(/^cs_[a-f0-9]{64}$/)
  })

  it('keeps the record id and full-set digest stable when multiplicity is applied', () => {
    const session = new NormalizedAccountingSession()
    const fingerprints = Array.from({ length: 40 }, (_, i) => `cf_${String(i).padStart(3, '0')}`)
    for (let i = 0; i < 3; i += 1) {
      session.dispose('cf_grp', {
        state: 'conflicting', reasons: ['conflicting_behavior_metadata'], groupFingerprints: fingerprints,
      })
    }
    const record = session.finalize().conflictRecords[0]!

    expect(record.multiplicity).toBe(3)
    // Digest still covers all 40, not the retained 32.
    const reference = new CandidateRecordIdentityFactory().createConflictRecord({
      candidateFingerprints: fingerprints, multiplicity: 1, reasons: ['conflicting_behavior_metadata'],
    })
    expect(record.fingerprintSetDigest).toBe(reference.fingerprintSetDigest)
    expect(record.id).toBe(reference.id)
  })

  it('changes identity when the complete set changes, even if the retained slice does not', () => {
    const base = Array.from({ length: MAX_CONFLICT_FINGERPRINTS }, (_, i) => `cf_${String(i).padStart(3, '0')}`)
    const make = (extra: string): string => new CandidateRecordIdentityFactory().createConflictRecord({
      candidateFingerprints: [...base, extra], multiplicity: 1, reasons: ['conflicting_behavior_metadata'],
    }).id
    expect(make('cf_zzz1')).not.toBe(make('cf_zzz2'))
  })

  it('replaces multiplicity without touching anything identity-bearing', () => {
    const record = new CandidateRecordIdentityFactory().createUnresolvedRecord({
      candidateFingerprint: 'cf_a', multiplicity: 1, source: 'alpha', reasons: ['missing_target_endpoint'],
    })
    const applied = withMultiplicityPreservingIdentity(record, 7)
    expect(applied.id).toBe(record.id)
    expect(applied.multiplicity).toBe(7)
    expect(applied.occurrenceRetention).toEqual(record.occurrenceRetention)
  })

  it('refuses a non-positive multiplicity', () => {
    const record = new CandidateRecordIdentityFactory().createUnresolvedRecord({
      candidateFingerprint: 'cf_a', multiplicity: 1, reasons: ['missing_target_endpoint'],
    })
    expect(() => withMultiplicityPreservingIdentity(record, 0)).toThrow(/positive safe integer/)
  })
})

describe('B2 — the sanitizer does not swallow arbitrary failures', () => {
  it('propagates an error raised while reading a candidate attribute', () => {
    // Narrower than it looks: this proves sanitizeCandidate does not wrap
    // property access in a catch-all. The catch inside sanitizedPathLike is
    // separately narrowed, but `normalizeIdentityRepositoryPath` only ever
    // throws SemanticIdentityInvariantError, so that narrowing is forward-looking
    // defence rather than something a test can currently distinguish.
    const hostile = {
      get relation(): string { throw new TypeError('not a path failure') },
    }
    expect(() => sanitizeCandidate(hostile)).toThrow(TypeError)
  })

  it('still drops an ordinary unsafe path without throwing', () => {
    expect(sanitizeCandidate({ kind: '/Users/someone/secret.ts' })).toEqual({})
  })
})

describe('B4 — scope-failure totals count what was submitted', () => {
  it('counts unsanitizable submissions in the total', () => {
    const session = new NormalizedAccountingSession()
    session.recordScopeFailure('src/ok1.ts')
    session.recordScopeFailure('src/ok2.ts')
    session.recordScopeFailure('/Users/someone/private/a.ts')
    session.recordScopeFailure('~/b.ts')
    session.recordScopeFailure('C:\\Users\\me\\c.ts')
    const result = session.finalize()

    expect(result.scopeFailures).toEqual(['src/ok1.ts', 'src/ok2.ts'])
    expect(result.scopeFailureRetention).toEqual({ retained: 2, total: 5, omitted: 3, truncated: true })
  })

  it('reports a complete set as untruncated', () => {
    const session = new NormalizedAccountingSession()
    session.recordScopeFailure('src/a.ts')
    expect(session.finalize().scopeFailureRetention)
      .toEqual({ retained: 1, total: 1, omitted: 0, truncated: false })
  })

  it('reports all-unsafe submissions as fully omitted', () => {
    const session = new NormalizedAccountingSession()
    session.recordScopeFailure('/abs/a.ts')
    session.recordScopeFailure('~/b.ts')
    const result = session.finalize()
    expect(result.scopeFailures).toEqual([])
    expect(result.scopeFailureRetention).toEqual({ retained: 0, total: 2, omitted: 2, truncated: true })
  })

  it('counts distinct names, so a duplicate submission does not inflate the total', () => {
    const session = new NormalizedAccountingSession()
    session.recordScopeFailure('src/a.ts')
    session.recordScopeFailure('src/a.ts')
    expect(session.finalize().scopeFailureRetention.total).toBe(1)
  })

  it('is independent of submission order', () => {
    const build = (order: readonly string[]): string => {
      const session = new NormalizedAccountingSession()
      for (const scope of order) session.recordScopeFailure(scope)
      return JSON.stringify(session.finalize().scopeFailureRetention)
    }
    const names = ['src/a.ts', '/abs/x.ts', 'src/b.ts', '~/y.ts']
    expect(build([...names].reverse())).toBe(build(names))
  })

  it('leaves the candidate equation untouched', () => {
    const session = new NormalizedAccountingSession()
    session.dispose('cf_1', { state: 'retained_new_fact' })
    session.recordScopeFailure('/abs/unsafe.ts')
    const result = session.finalize()
    expect(result.emittedCandidates).toBe(1)
    expect(result.scopeFailureRetention.total).toBe(1)
  })
})
