import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { compareVersions, getUpdateNotification } from '../../src/shared/update-notifier.js'

describe('update notifier', () => {
  it('returns a notice and caches the latest version when a newer release exists', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))

    try {
      const notice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000,
        fetchText: async () => JSON.stringify({ version: '0.22.9' }),
      })

      expect(notice).toContain('0.22.8')
      expect(notice).toContain('0.22.9')
      expect(notice).toContain('npm i -g @lubab/madar@latest')
      expect(notice).toContain('madar claude install | madar cursor install | madar gemini install')

      const cacheFile = join(cacheRoot, 'madar', 'update-check.json')
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('uses a fresh cache instead of refetching the registry or repeating the banner', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    let fetchCalls = 0

    try {
      const firstNotice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })

      const secondNotice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 60_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '9.9.9' })
        },
      })

      expect(firstNotice).toContain('0.22.9')
      expect(secondNotice).toBeNull()
      expect(fetchCalls).toBe(1)
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('preserves the refreshed checked_at timestamp when a stale cache is re-notified', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    const cacheFile = join(cacheRoot, 'madar', 'update-check.json')

    try {
      mkdirSync(join(cacheRoot, 'madar'), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      }))

      const notice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        fetchText: async () => JSON.stringify({ version: '0.22.9' }),
      })

      expect(notice).toContain('0.22.9')
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('writes a backoff cache entry when the registry refresh fails', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    const cacheFile = join(cacheRoot, 'madar', 'update-check.json')
    let fetchCalls = 0

    try {
      mkdirSync(join(cacheRoot, 'madar'), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      }))

      const notice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        fetchText: async () => {
          fetchCalls += 1
          throw new Error('offline')
        },
      })

      const secondNotice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000 + 1_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '9.9.9' })
        },
      })

      expect(notice).toBeNull()
      expect(secondNotice).toBeNull()
      expect(fetchCalls).toBe(1)
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('skips checks when disabled or non-interactive', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    let fetchCalls = 0

    try {
      await expect(getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: false,
        env: {},
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })).resolves.toBeNull()

      await expect(getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: { MADAR_DISABLE_UPDATE_NOTIFIER: '1' },
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })).resolves.toBeNull()

      expect(fetchCalls).toBe(0)
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })
})

/**
 * Independent code-point oracle for #717.
 *
 * Derived from Unicode scalar values directly rather than by calling the
 * production comparator, so the expected ordering in these controls is not
 * the implementation restating itself.
 */
function codePointOrder(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0) ?? 0)
  const rightPoints = [...right].map((character) => character.codePointAt(0) ?? 0)
  const shared = Math.min(leftPoints.length, rightPoints.length)

  for (let index = 0; index < shared; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return Math.sign((leftPoints[index] ?? 0) - (rightPoints[index] ?? 0))
    }
  }

  return Math.sign(leftPoints.length - rightPoints.length)
}

/** Named collations used to characterise fixtures. Never the host default. */
const NAMED_COLLATIONS = ['en-US', 'da-DK', 'sv-SE'] as const

function collationOrders(left: string, right: string): Record<string, number> {
  return Object.fromEntries(NAMED_COLLATIONS.map((locale) => [
    locale,
    Math.sign(new Intl.Collator(locale).compare(left, right)),
  ]))
}

/**
 * `discriminates` — at least two named collations disagree with each other, so
 * the pre-#717 answer provably depended on the host's ICU collation.
 *
 * `opposesEveryCollation` — code-point order differs from every named
 * collation, so the control fails against the pre-#717 implementation on any
 * host rather than only on one whose default locale happens to disagree.
 *
 * en-US and sv-SE order ASCII case identically, so neither is used as the sole
 * counterpart for a case-only fixture.
 */
interface OrderingFixture {
  readonly label: string
  readonly left: string
  readonly right: string
  readonly discriminates: boolean
  readonly opposesEveryCollation: boolean
}

/** Site A — `compareIdentifiers`, nonnumeric prerelease identifiers. */
const PRERELEASE_IDENTIFIER_FIXTURES: readonly OrderingFixture[] = [
  { label: 'Alpha/alpha', left: 'Alpha', right: 'alpha', discriminates: true, opposesEveryCollation: false },
  { label: 'B/a', left: 'B', right: 'a', discriminates: false, opposesEveryCollation: true },
]

/** Site B — `compareVersions` fallback, unparseable version strings. */
const UNPARSEABLE_FIXTURES: readonly OrderingFixture[] = [
  { label: 'Ångström/apple', left: 'Ångström', right: 'apple', discriminates: true, opposesEveryCollation: false },
  { label: 'éclair/zebra', left: 'éclair', right: 'zebra', discriminates: false, opposesEveryCollation: true },
]

describe('#717 fixture characterisation', () => {
  const allFixtures = [...PRERELEASE_IDENTIFIER_FIXTURES, ...UNPARSEABLE_FIXTURES]

  it.each(allFixtures)('$label carries the discrimination it claims', (fixture) => {
    const orders = collationOrders(fixture.left, fixture.right)
    const expected = codePointOrder(fixture.left, fixture.right)
    const distinct = new Set(Object.values(orders))

    expect(expected).not.toBe(0)
    expect(distinct.has(0)).toBe(false)

    // Claimed host-sensitivity must actually hold: two named collations disagree.
    expect(distinct.size > 1).toBe(fixture.discriminates)

    // Claimed universal falsifiability must actually hold: no collation agrees
    // with code-point order, so restoring localeCompare fails on every host.
    expect(Object.values(orders).every((order) => order !== expected))
      .toBe(fixture.opposesEveryCollation)
  })

  it('gives each comparison site both a host-sensitivity witness and a universal falsifier', () => {
    for (const site of [PRERELEASE_IDENTIFIER_FIXTURES, UNPARSEABLE_FIXTURES]) {
      expect(site.some((fixture) => fixture.discriminates)).toBe(true)
      expect(site.some((fixture) => fixture.opposesEveryCollation)).toBe(true)
    }
  })

  it('never leans on the en-US/sv-SE pair for a case-only fixture', () => {
    const caseOnly = PRERELEASE_IDENTIFIER_FIXTURES
      .filter((fixture) => fixture.left.toLowerCase() === fixture.right.toLowerCase())

    expect(caseOnly.length).toBeGreaterThan(0)
    for (const fixture of caseOnly) {
      const orders = collationOrders(fixture.left, fixture.right)
      expect(orders['en-US']).toBe(orders['sv-SE'])
      expect(new Set(Object.values(orders)).size).toBeGreaterThan(1)
    }
  })
})

describe('#717 parsed prerelease identifier ordering', () => {
  it.each(PRERELEASE_IDENTIFIER_FIXTURES)(
    '$label orders by code point on every host, not by collation',
    (fixture) => {
      const expected = codePointOrder(fixture.left, fixture.right)
      const forward = Math.sign(compareVersions(`1.0.0-${fixture.left}`, `1.0.0-${fixture.right}`))
      const reverse = Math.sign(compareVersions(`1.0.0-${fixture.right}`, `1.0.0-${fixture.left}`))

      expect(forward).toBe(expected)
      expect(reverse).toBe(-expected)

      if (fixture.opposesEveryCollation) {
        for (const order of Object.values(collationOrders(fixture.left, fixture.right))) {
          expect(forward).not.toBe(order)
        }
      }
    },
  )

  it('orders 1.0.0-Alpha below 1.0.0-alpha as semver §11 requires', () => {
    expect(Math.sign(compareVersions('1.0.0-Alpha', '1.0.0-alpha'))).toBe(-1)
    expect(Math.sign(compareVersions('1.0.0-alpha', '1.0.0-Alpha'))).toBe(1)
  })

  it('preserves semver precedence rules the fix must not disturb', () => {
    // Numeric identifiers compare numerically, not as strings.
    expect(Math.sign(compareVersions('1.0.0-2', '1.0.0-10'))).toBe(-1)

    // Numeric identifiers have lower precedence than nonnumeric identifiers.
    expect(Math.sign(compareVersions('1.0.0-1', '1.0.0-alpha'))).toBe(-1)
    expect(Math.sign(compareVersions('1.0.0-alpha', '1.0.0-1'))).toBe(1)
    expect(Math.sign(compareVersions('1.0.0-1', '1.0.0-Alpha'))).toBe(-1)

    // A larger set of prerelease fields has higher precedence when the
    // preceding identifiers are equal.
    expect(Math.sign(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'))).toBe(-1)
    expect(Math.sign(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'))).toBe(1)

    // A release outranks any of its prereleases.
    expect(Math.sign(compareVersions('1.0.0', '1.0.0-alpha'))).toBe(1)
    expect(Math.sign(compareVersions('1.0.0-alpha', '1.0.0'))).toBe(-1)

    // Core ordering is numeric and still dominates the prerelease comparison.
    expect(Math.sign(compareVersions('1.0.10', '1.0.9'))).toBe(1)
    expect(Math.sign(compareVersions('2.0.0-alpha', '1.9.9'))).toBe(1)

    // Build metadata is ignored, and a leading `v` still parses.
    expect(compareVersions('1.0.0+build.9', '1.0.0+build.1')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(Math.sign(compareVersions('1.0.0-Alpha+meta', '1.0.0-alpha+meta'))).toBe(-1)
  })
})

describe('#717 unparseable version fallback', () => {
  it.each(UNPARSEABLE_FIXTURES)(
    '$label falls back to code-point order on every host',
    (fixture) => {
      const expected = codePointOrder(fixture.left, fixture.right)
      const forward = Math.sign(compareVersions(fixture.left, fixture.right))

      expect(forward).toBe(expected)
      expect(Math.sign(compareVersions(fixture.right, fixture.left))).toBe(-expected)

      if (fixture.opposesEveryCollation) {
        for (const order of Object.values(collationOrders(fixture.left, fixture.right))) {
          expect(forward).not.toBe(order)
        }
      }
    },
  )

  it('reaches the fallback only for unparseable input', () => {
    // A fixture of valid versions never executes the fallback, so these
    // controls are stated on input the parser genuinely rejects.
    for (const fixture of UNPARSEABLE_FIXTURES) {
      expect(Math.sign(compareVersions(fixture.left, `${fixture.left}`))).toBe(0)
    }

    // One parseable side is still enough to take the fallback.
    expect(Math.sign(compareVersions('1.0.0', 'not-a-version')))
      .toBe(codePointOrder('1.0.0', 'not-a-version'))
  })

  it('stays antisymmetric and keeps distinct invalid strings distinct', () => {
    const invalid = ['Ångström', 'apple', 'éclair', 'zebra', 'not-a-version', 'Not-A-Version', '']

    for (const left of invalid) {
      expect(compareVersions(left, left)).toBe(0)

      for (const right of invalid) {
        const forward = Math.sign(compareVersions(left, right))
        const reverse = Math.sign(compareVersions(right, left))

        // `-0` and `0` are distinct under `Object.is`, so negate only a
        // genuine ordering rather than the equal case.
        expect(forward).toBe(reverse === 0 ? 0 : -reverse)
        expect(forward === 0).toBe(left === right)
      }
    }
  })

  it('is deterministic across repeated calls', () => {
    const results = Array.from({ length: 5 }, () => compareVersions('not-a-version', 'Not-A-Version'))
    expect(new Set(results).size).toBe(1)
    expect(Math.sign(results[0] ?? 0)).toBe(codePointOrder('not-a-version', 'Not-A-Version'))
  })
})

describe('#717 notifier decisions follow code-point order', () => {
  async function notify(currentVersion: string, latestVersion: string): Promise<{
    notice: string | null
    cache: unknown
  }> {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-717-'))

    try {
      const notice = await getUpdateNotification({
        packageName: '@lubab/madar',
        currentVersion,
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000,
        fetchText: async () => JSON.stringify({ version: latestVersion }),
      })

      return {
        notice,
        cache: JSON.parse(readFileSync(join(cacheRoot, 'madar', 'update-check.json'), 'utf8')),
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  }

  it('reports a newer prerelease', async () => {
    const { notice } = await notify('1.0.0-alpha', '1.0.0-beta')
    expect(notice).toContain('1.0.0-alpha -> 1.0.0-beta')
  })

  it('does not report an older prerelease', async () => {
    const { notice } = await notify('1.0.0-beta', '1.0.0-alpha')
    expect(notice).toBeNull()
  })

  it('emits no notice merely because host collation orders case differently', async () => {
    // Every named collation orders `B` after `a`; code point orders it before.
    // Under the pre-#717 comparator this published a downgrade as an update.
    expect(Object.values(collationOrders('B', 'a')).every((order) => order === 1)).toBe(true)
    expect(codePointOrder('B', 'a')).toBe(-1)

    const { notice } = await notify('1.0.0-a', '1.0.0-B')
    expect(notice).toBeNull()
  })

  it('reports the case-sensitive upgrade that code-point order does mandate', async () => {
    const { notice } = await notify('1.0.0-B', '1.0.0-a')
    expect(notice).toContain('1.0.0-B -> 1.0.0-a')
  })

  it('follows semver rather than collation for Alpha/alpha', async () => {
    expect((await notify('1.0.0-alpha', '1.0.0-Alpha')).notice).toBeNull()
    expect((await notify('1.0.0-Alpha', '1.0.0-alpha')).notice).toContain('1.0.0-Alpha -> 1.0.0-alpha')
  })

  it('keeps the persisted cache decision intact for a prerelease upgrade', async () => {
    const { notice, cache } = await notify('1.0.0-Alpha', '1.0.0-alpha')

    expect(notice).toContain('npm i -g @lubab/madar@latest')
    expect(cache).toEqual({
      checked_at: 1_700_000_000_000,
      latest_version: '1.0.0-alpha',
      notified_at: 1_700_000_000_000,
    })
  })

  it('records the refreshed check without notifying when no upgrade is due', async () => {
    const { notice, cache } = await notify('1.0.0-a', '1.0.0-B')

    expect(notice).toBeNull()
    expect(cache).toEqual({
      checked_at: 1_700_000_000_000,
      latest_version: '1.0.0-B',
    })
  })

  it('decides the unparseable fallback deterministically end to end', async () => {
    // Every named collation orders `éclair` before `zebra`; code point does not.
    expect(Object.values(collationOrders('éclair', 'zebra')).every((order) => order === -1)).toBe(true)

    const upgrade = await notify('zebra', 'éclair')
    expect(upgrade.notice).toContain('zebra -> éclair')
    expect(upgrade.cache).toEqual({
      checked_at: 1_700_000_000_000,
      latest_version: 'éclair',
      notified_at: 1_700_000_000_000,
    })

    const downgrade = await notify('éclair', 'zebra')
    expect(downgrade.notice).toBeNull()
  })
})
