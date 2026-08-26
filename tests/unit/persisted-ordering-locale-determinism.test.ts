import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compareUnicodeCodePoints } from '../../src/contracts/canonical-json.js'
import {
  EXTRACTION_FALLBACK_REASONS,
  EXTRACTION_STRATEGIES,
  INDEXING_REASON_CODES,
} from '../../src/contracts/indexing.js'
import { parseIndexingManifest } from '../../src/infrastructure/indexing-manifest.js'
import { createIndexingManifest, shareSafeIndexingManifest } from '../../src/pipeline/indexing-outcomes.js'
import { computeSpiDiffOverlay } from '../../src/pipeline/spi/diff-overlay.js'
import type { SemanticProgramIndex } from '../../src/pipeline/spi/types.js'

import { workingTreeSourceModule, type PinnedSourceModule } from './helpers/pinned-source-module.js'

/**
 * Persisted collection ordering must not depend on the host's collation.
 *
 * `String.prototype.localeCompare` asks ICU, and ICU answers according to the
 * locale Node took from `LC_ALL`/`LANG` at startup. Two machines with different
 * locales therefore wrote DIFFERENT BYTES for the same inputs into
 * `indexing-manifest.json`, into `graph.madar`'s build-freshness provenance and
 * into the SPI diff overlay.
 *
 * Every control here asserts three things, because any one of them alone can be
 * satisfied by a broken implementation:
 *
 *   (a) the fixture actually discriminates -- the control's two locale arms
 *       disagree with each other, and at least one of them disagrees with
 *       code-point order. Without this the whole file passes on a corpus every
 *       comparator sorts alike, proving nothing.
 *   (b) the emitted order IS code-point order, and is not the order any
 *       divergent arm would have produced. This is the leg a comparator pinned
 *       to a fixed locale cannot survive: `localeCompare(a, b, 'sv-SE')` makes
 *       both host arms agree with each other while still emitting the wrong
 *       order.
 *   (c) the published bytes are identical between two child processes started
 *       under different `LC_ALL` values. This is the leg a locale dependency
 *       OUTSIDE the comparator cannot survive.
 *
 * The locale arms are per fixture, not global. Accented file names split en-US
 * from sv-SE. The closed reason-code domain is pure lowercase ASCII, where those
 * two agree; it splits en-US from az-AZ instead, because Azerbaijani places `x`
 * between `h` and `ı`. An earlier revision asserted that domain had no
 * discriminating fixture at all and gave it static coverage only, which was
 * wrong -- see `closed domains are classified by search, not assumed` below,
 * which derives the classification over a documented search space instead of
 * assuming it.
 *
 * Ordering intended for human reading is deliberately left locale-sensitive;
 * this is not a repository-wide ban on `localeCompare`.
 */

/** Names where ICU collation and code-unit order provably disagree. */
const ADVERSARIAL = [
  'Ångström',
  'angle',
  'Zebra',
  'apple',
  'café',
  'cafe',
  '_internal',
  '日本',
] as const

const PATHS = ADVERSARIAL.map((name) => `src/${name}.ts`)
const FIXED_NOW = new Date('2026-08-25T00:00:00.000Z')

/**
 * The two host collations a control runs its writer under.
 *
 * Not a single global pair. Which collations disagree depends on the fixture:
 * file paths with accented names split en-US from sv-SE, while the closed
 * reason-code domain is ASCII and splits en-US from az-AZ instead, because
 * Azerbaijani places `x` between `h` and `ı`. A pair that agrees on a given
 * fixture makes leg (c) compare two identical configurations.
 */
interface LocaleArms {
  /** BCP 47 tags, for in-process ordering. */
  readonly tags: readonly [string, string]
  /** The matching `LC_ALL` values, for the child processes. */
  readonly lcAll: readonly [string, string]
}

const LATIN_ACCENTED: LocaleArms = { tags: ['en-US', 'sv-SE'], lcAll: ['en_US.UTF-8', 'sv_SE.UTF-8'] }
const ASCII_REASON_CODES: LocaleArms = { tags: ['en-US', 'az-AZ'], lcAll: ['en_US.UTF-8', 'az_AZ.UTF-8'] }

const byLocale = (values: readonly string[], tag: string): string[] =>
  [...values].sort((left, right) => left.localeCompare(right, tag))
const byCodePoint = (values: readonly string[]): string[] =>
  [...values].sort(compareUnicodeCodePoints)

/**
 * Leg (a). Two things must hold, and they are not the same thing.
 *
 * The arms must disagree with EACH OTHER, or leg (c) compares two identical
 * configurations and proves nothing. And at least one arm must disagree with
 * code point, or leg (b) cannot bite either. Requiring *both* arms to differ
 * from code point would be too strong: on the reason-code fixture en-US happens
 * to agree with code point, and az-AZ is the one that diverges.
 */
function expectFixtureDiscriminates(values: readonly string[], what: string, arms: LocaleArms): void {
  const [first, second] = arms.tags
  expect(
    byLocale(values, first),
    `${what}: ${first} and ${second} agree, so the cross-host arm is vacuous`,
  ).not.toEqual(byLocale(values, second))
  const divergent = arms.tags.filter((tag) => JSON.stringify(byLocale(values, tag)) !== JSON.stringify(byCodePoint(values)))
  expect(
    divergent,
    `${what}: no arm disagrees with code-point order, so leg (b) cannot fail`,
  ).not.toEqual([])
}

/**
 * Leg (b). Pins the emitted order to a pure function of the strings, and shows
 * it is not merely whatever some collation would have produced.
 */
function expectCodePointOrder(
  emitted: readonly string[], inputs: readonly string[], what: string, arms: LocaleArms,
): void {
  expect(emitted, `${what}: not code-point order`).toEqual(byCodePoint(inputs))
  for (const tag of arms.tags) {
    const collated = byLocale(inputs, tag)
    if (JSON.stringify(collated) === JSON.stringify(byCodePoint(inputs))) continue
    expect(emitted, `${what}: emitted the ${tag} collation order`).not.toEqual(collated)
  }
}

const digest = (input: Buffer | string): string => createHash('sha256').update(input).digest('hex')

// ─────────────────────────────────────────────────────────────────────────────
// Leg (c): run today's source in child processes started under two locales.
// A process's collation is fixed when it starts, so this is the only honest way
// to test it.
// ─────────────────────────────────────────────────────────────────────────────

const materialized = new Map<string, PinnedSourceModule>()

afterAll(() => {
  for (const module of materialized.values()) module.dispose()
  materialized.clear()
})

function moduleFor(entries: readonly string[]): PinnedSourceModule {
  const key = entries.join('|')
  const existing = materialized.get(key)
  if (existing) return existing
  const created = workingTreeSourceModule(entries)
  materialized.set(key, created)
  return created
}

/**
 * A probe's stdout: a sha256 digest and the collator the child actually resolved.
 *
 * Parsed rather than destructured, so a probe that dies silently or prints
 * something unexpected fails as a malformed result instead of flowing into the
 * comparison as an empty string.
 */
interface ProbeResult {
  readonly digest: string
  readonly locale: string
}

const SHA256 = /^[0-9a-f]{64}$/

/**
 * A child timeout only attributes a hang to *this* probe if it fires before
 * vitest gives up on the whole test. Two earlier revisions got this wrong:
 *
 *   60s flat            the per-test budget (15s, or 30s on Windows) always won,
 *                       so the option was dead code;
 *   two thirds of it    fine for one probe, but each test runs TWO in sequence,
 *                       so a first probe over 5s pushed the second's deadline
 *                       past the budget and vitest won again.
 *
 * So the bound is not a fraction anyone picked. It is solved from the invariant
 * every probing test must satisfy:
 *
 *   MAX_SEQUENTIAL_PROBES_PER_TEST * PROBE_TIMEOUT_MS
 *     + SETUP_TEARDOWN_MARGIN_MS
 *     <= TEST_TIMEOUT_MS
 *
 * The margin covers the work a test does outside its probes -- materialising the
 * transpiled closure on first use, and building the fixture git repository --
 * which is why the bound is not simply half the budget.
 */
interface TimeoutBudget {
  readonly testTimeoutMs: number
  readonly maxSequentialProbesPerTest: number
  readonly probeTimeoutMs: number
  readonly setupTeardownMarginMs: number
}

/** The invariant itself, as a pure function so it can be tested when violated. */
function hierarchyHolds(budget: TimeoutBudget): boolean {
  return budget.maxSequentialProbesPerTest * budget.probeTimeoutMs
    + budget.setupTeardownMarginMs <= budget.testTimeoutMs
}

const PER_TEST_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000
/** Every cross-locale control calls `runUnderLocale` exactly twice; asserted below. */
const MAX_SEQUENTIAL_PROBES_PER_TEST = 2
/** Closure materialisation plus fixture setup; measured at well under a second. */
const SETUP_TEARDOWN_MARGIN_MS = 3_000
const PROBE_TIMEOUT_MS = Math.floor(
  (PER_TEST_TIMEOUT_MS - SETUP_TEARDOWN_MARGIN_MS) / MAX_SEQUENTIAL_PROBES_PER_TEST,
)

const TIMEOUT_BUDGET: TimeoutBudget = {
  testTimeoutMs: PER_TEST_TIMEOUT_MS,
  maxSequentialProbesPerTest: MAX_SEQUENTIAL_PROBES_PER_TEST,
  probeTimeoutMs: PROBE_TIMEOUT_MS,
  setupTeardownMarginMs: SETUP_TEARDOWN_MARGIN_MS,
}

/** Counts probes per test, so `MAX_SEQUENTIAL_PROBES_PER_TEST` is observed, not assumed. */
let probesInCurrentTest = 0

beforeEach(() => {
  probesInCurrentTest = 0
})

/** Runs `body` inside the materialized tree under `locale` and parses its stdout. */
function runUnderLocale(entries: readonly string[], name: string, body: string, locale: string): ProbeResult {
  probesInCurrentTest += 1
  expect(
    probesInCurrentTest,
    `${name}: this test ran ${probesInCurrentTest} probes, but PROBE_TIMEOUT_MS was solved `
    + `for at most ${MAX_SEQUENTIAL_PROBES_PER_TEST}; the timeout invariant no longer holds`,
  ).toBeLessThanOrEqual(MAX_SEQUENTIAL_PROBES_PER_TEST)

  const tree = moduleFor(entries)
  const entryPath = join(tree.root, `${name}.mjs`)
  writeFileSync(entryPath, body, 'utf8')
  const stdout = execFileSync(process.execPath, [entryPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: locale, LANG: locale },
    timeout: PROBE_TIMEOUT_MS,
  }).trim()

  const fields = stdout.split(' ')
  expect(
    fields,
    `${name}: probe under ${locale} printed ${JSON.stringify(stdout)}, not "<digest> <locale>"`,
  ).toHaveLength(2)
  const [digest, resolvedLocale] = fields as [string, string]
  expect(digest, `${name}: probe under ${locale} produced no sha256 digest`).toMatch(SHA256)
  expect(resolvedLocale, `${name}: probe under ${locale} reported no collator`).not.toBe('')
  return { digest, locale: resolvedLocale }
}

/**
 * Leg (c) for one writer: identical bytes under the control's two locale arms.
 *
 * Both digests are validated by `runUnderLocale` before they get here, on every
 * platform including Windows. Two probes that died silently would otherwise
 * compare `''` to `''` and pass while proving nothing -- the failure mode this
 * file guards against everywhere else.
 *
 * The divergence check is deliberately an assertion and not a warning. This
 * control's whole purpose is to run the writer under two genuinely different
 * collations; if the arms resolve to the same one, the byte comparison is
 * between two identical configurations and the control has silently stopped
 * testing what it claims to. On Windows that is expected and unavoidable -- ICU
 * there follows the system locale and ignores `LC_ALL` -- so Windows relies on
 * leg (b), which pins the order to a pure function of the strings. Everywhere
 * else a collapsed pair is a real loss of coverage and should fail loudly.
 *
 * Verified against the supported matrix rather than assumed: all six protected
 * lanes (ubuntu, macOS and Windows on Node 20 and 22) pass with this assertion
 * in place.
 */
function expectSameBytesAcrossLocales(
  entries: readonly string[], name: string, body: string, arms: LocaleArms,
): void {
  const [firstLcAll, secondLcAll] = arms.lcAll
  const first = runUnderLocale(entries, name, body, firstLcAll)
  const second = runUnderLocale(entries, name, body, secondLcAll)
  expect(second.digest, `${name}: bytes differ between host collations`).toBe(first.digest)
  if (process.platform !== 'win32') {
    expect(
      first.locale,
      `${name}: both arms resolved to ${first.locale}, so this control compared two `
      + 'identical configurations and proved nothing about cross-host bytes',
    ).not.toBe(second.locale)
  }
}

describe('the probe bound is solved from the timeout invariant, not chosen', () => {
  it('satisfies the invariant with the configuration actually in use', () => {
    expect(hierarchyHolds(TIMEOUT_BUDGET), JSON.stringify(TIMEOUT_BUDGET)).toBe(true)
  })

  it('rejects a configuration that violates it — the negative control', () => {
    // Without this, `hierarchyHolds` could return true unconditionally and the
    // check above would pass while guarding nothing. Each case below is one of
    // the two mistakes actually made in this file's history.
    expect(hierarchyHolds({ ...TIMEOUT_BUDGET, probeTimeoutMs: 60_000 }), 'the flat 60s bound')
      .toBe(false)
    expect(
      hierarchyHolds({ ...TIMEOUT_BUDGET, probeTimeoutMs: Math.floor((PER_TEST_TIMEOUT_MS * 2) / 3) }),
      'two thirds of the budget, which one probe survives and two do not',
    ).toBe(false)
    // And the boundary: one more millisecond than the invariant allows.
    expect(hierarchyHolds({ ...TIMEOUT_BUDGET, probeTimeoutMs: PROBE_TIMEOUT_MS + 1 })).toBe(false)
  })

  it('leaves each probe a wide margin over its measured cost', () => {
    // The heaviest probe builds a git repository and a graph: about a second
    // locally, and its two-arm test runs in ~1.9s.
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('mirrors vitest.config.ts, and fails if that budget moves without this one', () => {
    // Read rather than assumed: a mirrored constant that nobody checks is how the
    // 60s version went unnoticed.
    const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')
    const declared = /DEFAULT_TEST_TIMEOUT\s*=\s*process\.platform\s*===\s*'win32'\s*\?\s*([\d_]+)\s*:\s*([\d_]+)/
      .exec(config)
    expect(declared, 'vitest.config.ts no longer declares DEFAULT_TEST_TIMEOUT in the expected shape').not.toBeNull()
    const [windows, other] = [declared?.[1], declared?.[2]].map((value) => Number(value?.replaceAll('_', '')))
    expect(PER_TEST_TIMEOUT_MS).toBe(process.platform === 'win32' ? windows : other)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C1 -- indexing-manifest.json and its share-safe and failed variants
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_ENTRIES = [
  'src/pipeline/indexing-outcomes.ts',
  'src/infrastructure/indexing-manifest.ts',
] as const

describe('C1-paths -- manifest outcome ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(PATHS, 'outcome paths', LATIN_ACCENTED)
  })

  it('emits outcomes in code-point order, not this host’s collation order', () => {
    const manifest = createIndexingManifest({
      outcomes: PATHS.map((path) => ({
        path, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability: null,
      })),
      now: FIXED_NOW,
    })
    expectCodePointOrder(manifest.outcomes.map((outcome) => outcome.path), PATHS, 'manifest outcomes', LATIN_ACCENTED)
  })

  it('writes the same manifest bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-paths', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const paths = ${JSON.stringify(PATHS)}
const manifest = createIndexingManifest({
  outcomes: paths.map((path) => ({ path, kind: 'file', status: 'indexed', reason: 'indexed', capability: null })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })
})

/**
 * `capability` is the case the closed reason/strategy/fallback domains are not:
 * `parseIndexingManifest` accepts ANY string for it, and incremental generation
 * returns a prior outcome verbatim, so whatever a manifest on disk carries comes
 * back and is bucketed. The fixture therefore has to arrive THROUGH the parser,
 * not as a literal -- a control built from literals would still discriminate
 * while no longer exercising the route that makes those values reachable.
 */
const CAPABILITIES = ['Ångström', 'apple', 'Zebra', 'café', 'cafe'] as const

function manifestOnDisk(): Record<string, unknown> {
  return {
    version: 1,
    generated_at: FIXED_NOW.toISOString(),
    summary: {},
    outcomes: CAPABILITIES.map((capability, index) => ({
      path: `src/file-${index}.ts`, kind: 'file', status: 'indexed',
      reason: 'indexed', capability,
    })),
    spi_diagnostics: [],
  }
}

describe('C1-capability -- capability bucket ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(CAPABILITIES, 'capability values', LATIN_ACCENTED)
  })

  /**
   * The route and the ordering are asserted together, in one test, on purpose.
   *
   * What makes `capability` an open domain is not the values themselves -- it is
   * that `parseIndexingManifest` accepts any string for it and incremental
   * generation hands a prior outcome straight back. Split across two tests, one
   * could be rewritten to use literals while the other still passed, and the
   * file would keep proving the ordering without proving it on the reachable
   * path. Kept together, dropping the route means visibly deleting it.
   *
   * Note what this cannot do: a fixture built from literals equal to the parser's
   * output would order identically, so no assertion can distinguish them. That
   * is a property of the values being equal by construction, and it is why the
   * parser call is structural here rather than something a control checks.
   */
  it('reaches the sort through parseIndexingManifest and orders by code point', () => {
    const parsed = parseIndexingManifest(manifestOnDisk())
    expect(parsed, 'parseIndexingManifest rejected the fixture; the route is gone').not.toBeNull()
    const fromParser = parsed as NonNullable<typeof parsed>
    expect(
      fromParser.outcomes.map((outcome) => outcome.capability),
      'the parser no longer round-trips these capabilities; the domain may have closed',
    ).toEqual([...CAPABILITIES])

    const manifest = createIndexingManifest({ outcomes: fromParser.outcomes, now: FIXED_NOW })
    expectCodePointOrder(
      Object.keys(manifest.summary.capability_buckets),
      CAPABILITIES,
      'capability_buckets',
      LATIN_ACCENTED,
    )

    // Why no assertion can catch a fixture rebuilt from literals: the parser
    // returns the same capability strings it was handed, so the two routes are
    // equal by construction and produce identical bytes. That is recorded here
    // rather than in a comment alone, so if the parser ever starts transforming
    // capabilities this stops being true and says so.
    const viaLiterals = createIndexingManifest({
      outcomes: CAPABILITIES.map((capability, index) => ({
        path: `src/file-${index}.ts`, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability,
      })),
      now: FIXED_NOW,
    })
    expect(
      digest(`${JSON.stringify(viaLiterals, null, 2)}\n`),
      'the parser route and a literal route now differ, so the literal-fixture mutation '
      + 'became observable and needs a control',
    ).toBe(digest(`${JSON.stringify(manifest, null, 2)}\n`))
  })

  it('writes the same manifest and share-safe bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-capability', `
import { createHash } from 'node:crypto'
import { parseIndexingManifest } from './src/infrastructure/indexing-manifest.js'
import { createIndexingManifest, shareSafeIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const parsed = parseIndexingManifest(${JSON.stringify(manifestOnDisk())})
if (parsed === null) throw new Error('probe fixture rejected by parseIndexingManifest')
const manifest = createIndexingManifest({ outcomes: parsed.outcomes, now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}) })
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
  + JSON.stringify(shareSafeIndexingManifest(manifest), null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })
})

/**
 * SPI diagnostic ids reach this sort projected verbatim from `result.spi.diagnostics`,
 * and the SPI cache shape-checks only `version`/`workspace`/`files`/`symbols`, so a
 * cached index can carry any id at all.
 */
const DIAGNOSTIC_IDS = ADVERSARIAL.map((name) => `spi.import.unresolved.${name}`)

describe('C1-diagnostics -- spi_diagnostics ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(DIAGNOSTIC_IDS, 'spi diagnostic ids', LATIN_ACCENTED)
  })

  it('emits spi_diagnostics in code-point order', () => {
    const manifest = createIndexingManifest({
      outcomes: [],
      spiDiagnostics: DIAGNOSTIC_IDS.map((id) => ({
        id, level: 'info' as const, reason: 'spi_diagnostic' as const,
      })),
      now: FIXED_NOW,
    })
    expectCodePointOrder(
      manifest.spi_diagnostics.map((diagnostic) => diagnostic.id),
      DIAGNOSTIC_IDS,
      'spi_diagnostics',
      LATIN_ACCENTED,
    )
  })

  it('writes the same manifest bytes under two host collations', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-diagnostics', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const ids = ${JSON.stringify(DIAGNOSTIC_IDS)}
const manifest = createIndexingManifest({
  outcomes: [],
  spiDiagnostics: ids.map((id) => ({ id, level: 'info', reason: 'spi_diagnostic' })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })
})

/**
 * The guarantee is host-independence, which is not the same as "code-point order
 * everywhere", and the difference is reachable.
 *
 * `JSON.stringify` emits object keys in ECMAScript enumeration order: integer-index
 * keys first, ascending numerically, and only then string keys in insertion order.
 * `capability` is an open domain, so `"10"` and `"2"` are accepted values, and they
 * serialize as `"2"` before `"10"` whatever the comparator returns.
 *
 * That reordering is a language rule rather than an ICU one, so the bytes are still
 * the same on every host -- which is what this issue promises. Asserting it here
 * keeps the promise honest: an earlier draft of the comment claimed insertion order
 * simply IS byte order, and that is false.
 */
describe('C1-integer-keys -- host-independent even where enumeration outranks the comparator', () => {
  const NUMERIC_CAPABILITIES = ['10', '2', 'Ångström', 'apple'] as const

  function numericManifest(): ReturnType<typeof createIndexingManifest> {
    return createIndexingManifest({
      outcomes: NUMERIC_CAPABILITIES.map((capability, index) => ({
        path: `src/file-${index}.ts`, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability,
      })),
      now: FIXED_NOW,
    })
  }

  it('emits integer-like keys first, then the comparator’s order for the rest', () => {
    const emitted = Object.keys(numericManifest().summary.capability_buckets)
    // "2" before "10" is the language ordering integer indices numerically;
    // "apple" before "Ångström" is the comparator, still doing its job on the
    // string keys.
    expect(emitted).toEqual(['2', '10', 'apple', 'Ångström'])
    // And so the emitted order is NOT code-point order overall, which would have
    // put "10" first. That is the claim an earlier draft got wrong.
    expect(byCodePoint(NUMERIC_CAPABILITIES)).toEqual(['10', '2', 'apple', 'Ångström'])
    expect(emitted).not.toEqual(byCodePoint(NUMERIC_CAPABILITIES))
  })

  it('writes the same bytes under two host collations anyway', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-integer-capabilities', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const capabilities = ${JSON.stringify(NUMERIC_CAPABILITIES)}
const manifest = createIndexingManifest({
  outcomes: capabilities.map((capability, index) => ({
    path: 'src/file-' + index + '.ts', kind: 'file', status: 'indexed',
    reason: 'indexed', capability,
  })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The closed summary-bucket domains
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which closed domains can be tested behaviourally, derived rather than asserted.
 *
 * An earlier revision claimed all three were comparator-invariant, on a sweep of
 * six hand-picked locales. That claim was false: `az-AZ` reverses
 * `empty_extraction` against `extractor_error`, because Azerbaijani places `x`
 * between `h` and `ı`. Turkish, which the sweep did include, has no `x` in its
 * alphabet at all, which is exactly why it slipped through.
 *
 * So the classification is computed over the documented search space below
 * rather than written down. If a future reason code, strategy or fallback
 * introduces a discriminating pair into a domain recorded as having none, this
 * fails and says so -- which is the signal to add a behavioural control rather
 * than to widen the expectation.
 */
const CLOSED_DOMAINS = [
  { name: 'INDEXING_REASON_CODES', members: [...INDEXING_REASON_CODES], discriminable: true },
  { name: 'EXTRACTION_STRATEGIES', members: [...EXTRACTION_STRATEGIES], discriminable: false },
  { name: 'EXTRACTION_FALLBACK_REASONS', members: [...EXTRACTION_FALLBACK_REASONS], discriminable: false },
] as const

/**
 * The search space, stated exactly rather than called exhaustive.
 *
 * There is no API that enumerates every locale ICU can collate:
 * `Intl.Collator.supportedLocalesOf` only filters the list it is given, so a
 * hand-picked list silently bounds the search — which is how the first attempt
 * here reported "no discriminator" for a domain that has four.
 *
 * So the candidates are generated instead of curated: every two-letter language
 * subtag, all 676 of them, plus the longer tags below whose collations are known
 * to reorder Latin letters. `supportedLocalesOf` then narrows that to what this
 * build actually collates. This is a documented, mechanically-derived search
 * space, not a proof that no other locale exists.
 */
const LONGER_SUBTAGS = [
  'haw', 'fil', 'smn', 'wae', 'lkt', 'kok', 'ceb', 'chr', 'nso', 'dsb', 'hsb', 'sah', 'yue',
  'kea', 'ckb', 'tzm', 'kab', 'bem', 'ewo', 'fur', 'gsw', 'jgo', 'kkj', 'ksh', 'lag', 'luy',
  'mgo', 'naq', 'nnh', 'nyn', 'qut', 'rof', 'rwk', 'saq', 'seh', 'shi', 'teo', 'twq', 'vun',
  'xog', 'yav', 'zgh',
] as const

const TWO_LETTER_SUBTAGS = ((): string[] => {
  const letters = [...'abcdefghijklmnopqrstuvwxyz']
  return letters.flatMap((first) => letters.map((second) => `${first}${second}`))
})()

const SEARCHED_LOCALES = Intl.Collator.supportedLocalesOf([...TWO_LETTER_SUBTAGS, ...LONGER_SUBTAGS])

function discriminatingPairs(members: readonly string[]): { locale: string; a: string; b: string }[] {
  const found: { locale: string; a: string; b: string }[] = []
  for (const locale of SEARCHED_LOCALES) {
    const collator = new Intl.Collator(locale)
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const [a, b] = [members[i] as string, members[j] as string]
        if (Math.sign(compareUnicodeCodePoints(a, b)) !== Math.sign(collator.compare(a, b))) {
          found.push({ locale, a, b })
        }
      }
    }
  }
  return found
}

describe('closed domains are classified by search, not assumed', () => {
  it('searches a non-trivial locale space', () => {
    // A search over an empty or tiny locale set would report "no discriminator"
    // forever. The candidate list is generated, so this also catches the
    // generation silently producing nothing.
    expect(TWO_LETTER_SUBTAGS).toHaveLength(676)
    expect(SEARCHED_LOCALES.length).toBeGreaterThan(100)
  })

  for (const domain of CLOSED_DOMAINS) {
    it(`${domain.name} is ${domain.discriminable ? '' : 'not '}discriminable, as recorded`, () => {
      const found = discriminatingPairs(domain.members)
      if (domain.discriminable) {
        expect(
          found,
          `${domain.name} has no discriminating pair any more; its behavioural control is now vacuous`,
        ).not.toEqual([])
        return
      }
      expect(
        found.slice(0, 3),
        `${domain.name} now has a discriminating pair, so it needs a behavioural control `
        + 'rather than static coverage alone',
      ).toEqual([])
    })
  }
})

/**
 * The reason-code domain, tested behaviourally under the arms that split it.
 *
 * `empty_extraction` and `extractor_error` are both members of
 * `INDEXING_REASON_CODES` and both survive `parseIndexingManifest`, so this pair
 * is reachable in a real manifest, not a synthetic one.
 */
describe('C4-reason-codes -- closed reason-code ordering', () => {
  const REASON_PAIR = ['empty_extraction', 'extractor_error'] as const

  function reasonManifest(): ReturnType<typeof createIndexingManifest> {
    return createIndexingManifest({
      outcomes: REASON_PAIR.map((reason, index) => ({
        path: `src/reason-${index}.ts`, kind: 'file' as const, status: 'indexed' as const,
        reason, capability: null,
      })),
      now: FIXED_NOW,
    })
  }

  it('uses a pair that is valid in the real domain', () => {
    for (const reason of REASON_PAIR) {
      expect(INDEXING_REASON_CODES as readonly string[], `${reason} is not a real reason code`)
        .toContain(reason)
    }
    // And the parser accepts it, so the pair reaches the sort through a manifest.
    const parsed = parseIndexingManifest({
      version: 1,
      generated_at: FIXED_NOW.toISOString(),
      summary: {},
      outcomes: REASON_PAIR.map((reason, index) => ({
        path: `src/reason-${index}.ts`, kind: 'file', status: 'indexed', reason, capability: null,
      })),
      spi_diagnostics: [],
    })
    expect(parsed, 'parseIndexingManifest rejected the reason pair').not.toBeNull()
  })

  it('has a fixture where code point and az-AZ collation genuinely disagree', () => {
    expectFixtureDiscriminates(REASON_PAIR, 'reason codes', ASCII_REASON_CODES)
    // Named explicitly, because this is the pair the six-locale sweep missed.
    expect(byCodePoint(REASON_PAIR)).toEqual(['empty_extraction', 'extractor_error'])
    expect(byLocale(REASON_PAIR, 'az-AZ')).toEqual(['extractor_error', 'empty_extraction'])
  })

  it('emits reason buckets in code-point order', () => {
    expectCodePointOrder(
      Object.keys(reasonManifest().summary.reason_buckets),
      REASON_PAIR,
      'reason_buckets',
      ASCII_REASON_CODES,
    )
  })

  it('writes the same manifest bytes under en-US and az-AZ', () => {
    expectSameBytesAcrossLocales(MANIFEST_ENTRIES, 'manifest-reason-codes', `
import { createHash } from 'node:crypto'
import { createIndexingManifest } from './src/pipeline/indexing-outcomes.js'
const reasons = ${JSON.stringify(REASON_PAIR)}
const manifest = createIndexingManifest({
  outcomes: reasons.map((reason, index) => ({
    path: 'src/reason-' + index + '.ts', kind: 'file', status: 'indexed', reason, capability: null,
  })),
  now: new Date(${JSON.stringify(FIXED_NOW.toISOString())}),
})
const bytes = JSON.stringify(manifest, null, 2) + '\\n'
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, ASCII_REASON_CODES)
  })
})

describe('C1 -- the share-safe manifest carries only closed-domain summary values', () => {
  it('is byte-stable across repeated serialization', () => {
    const manifest = createIndexingManifest({
      outcomes: PATHS.map((path) => ({
        path, kind: 'file' as const, status: 'indexed' as const,
        reason: 'indexed' as const, capability: 'spi:typescript',
      })),
      now: FIXED_NOW,
    })
    const bytes = (): string => `${JSON.stringify(shareSafeIndexingManifest(manifest), null, 2)}\n`
    expect(digest(bytes())).toBe(digest(bytes()))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 -- graph.madar provenance.graph_build_freshness.git.dirty_files
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_ENTRIES = [
  'src/contracts/graph-artifact.ts',
  'src/pipeline/build.ts',
  'src/shared/graph-build-freshness.ts',
] as const

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

/** A real git repository whose dirty set is exactly `PATHS`. */
function dirtyRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-715-dirty-'))
  tempRoots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'control@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'control'], { cwd: root })
  writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const path of PATHS) writeFileSync(join(root, path), 'export const x = 1\n', 'utf8')
  return root
}

describe('C2 -- graph.madar build-freshness provenance ordering', () => {
  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(PATHS, 'dirty file paths', LATIN_ACCENTED)
  })

  it('orders dirty files by code point, not by this host’s collation', async () => {
    const { buildGraphBuildFreshnessMetadata } = await import('../../src/shared/graph-build-freshness.js')
    const freshness = buildGraphBuildFreshnessMetadata(dirtyRepository(), PATHS)
    expect(freshness.strategy).toBe('git')
    expectCodePointOrder(freshness.git?.dirty_files ?? [], PATHS, 'graph_build_freshness.git.dirty_files', LATIN_ACCENTED)
  })

  it('serializes the same graph.madar bytes under two host collations', () => {
    // The probe builds its own repository so both arms see identical inputs; only
    // the clock is pinned afterwards, never the ordering under test.
    expectSameBytesAcrossLocales(GRAPH_ENTRIES, 'graph-artifact', `
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serializeGraphArtifactV2 } from './src/contracts/graph-artifact.js'
import { buildFromJson } from './src/pipeline/build.js'
import { buildGraphBuildFreshnessMetadata } from './src/shared/graph-build-freshness.js'

const paths = ${JSON.stringify(PATHS)}
const root = mkdtempSync(join(tmpdir(), 'madar-715-probe-'))
execFileSync('git', ['init', '-q'], { cwd: root })
execFileSync('git', ['config', 'user.email', 'p@example.com'], { cwd: root })
execFileSync('git', ['config', 'user.name', 'p'], { cwd: root })
writeFileSync(join(root, 'seed.txt'), 'seed\\n', 'utf8')
execFileSync('git', ['add', '.'], { cwd: root })
execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
for (const path of paths) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'export const x = 1\\n', 'utf8')
}
const freshness = buildGraphBuildFreshnessMetadata(root, paths)
// Pin only what a clock decides: the wall clock, and the commit sha, which
// differs between the two arms because each builds its own repository and a
// commit's identity includes its timestamp. Ordering -- the property under
// test -- is untouched.
const pinned = {
  ...freshness,
  generated_at: '2026-08-25T00:00:00.000Z',
  generated_ms: 0,
  git: { ...freshness.git, head_sha: 'pinned-head-sha' },
}
const extraction = {
  schema_version: 2,
  directed: true,
  nodes: paths.map((id) => ({ id, label: id, file_type: 'code', source_file: id, endpointIdentity: { status: 'stable', reasons: [] } })),
  edges: paths.slice(1).map((target, index) => ({ source: paths[index], target, relation: 'contains', confidence: 'EXTRACTED', source_file: paths[index] })),
}
const graph = buildFromJson(extraction, { directed: true, accounting: 'normalized_extraction_boundary' })
const bytes = serializeGraphArtifactV2({
  graph,
  repositoryRevision: 'persisted-ordering',
  generationMode: 'full',
  generatedAt: '2026-08-25T00:00:00.000Z',
  provenance: { schema_version: 2, graph_build_freshness: pinned },
})
process.stdout.write(createHash('sha256').update(bytes).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })

  it('leaves a clean worktree with no dirty files to order', async () => {
    // The positive half. Nothing in this change touches a clean build, so the
    // ordering fix must be invisible when there is nothing to order.
    const { buildGraphBuildFreshnessMetadata } = await import('../../src/shared/graph-build-freshness.js')
    const root = mkdtempSync(join(tmpdir(), 'madar-715-clean-'))
    tempRoots.push(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'control@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'control'], { cwd: root })
    writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })

    const freshness = buildGraphBuildFreshnessMetadata(root, [])
    expect(freshness.strategy).toBe('git')
    expect(freshness.git?.dirty_files).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C3 -- SPI diff overlay edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Symbol ids begin with a per-file hash, so only symbols in the SAME file reach
 * the Unicode tail of the sort key. A fixture with one symbol per file is
 * decided entirely by ASCII hex and proves nothing.
 */
const OVERLAY_FILE_ID = 'file:0123456789abcdef'

function overlaySpi(): SemanticProgramIndex {
  const symbols = ADVERSARIAL.map((name) => ({
    id: `symbol:${OVERLAY_FILE_ID}/function/${name}`,
    file_id: OVERLAY_FILE_ID,
    name,
    kind: 'function' as const,
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
  }))
  return {
    version: 1,
    generated_at: FIXED_NOW.toISOString(),
    workspace: { root: '/repo', fingerprint: 'fp', extractor_version: 'test', madar_version: '0.0.0-test' },
    files: [{ id: OVERLAY_FILE_ID, path: 'src/many.ts', language: 'typescript', loc: 1, hash: 'h' }],
    symbols,
    edges: [],
    diagnostics: [],
  } as unknown as SemanticProgramIndex
}

describe('C3 -- SPI diff overlay edge ordering', () => {
  const overlayKeys = ADVERSARIAL.map(
    (name) => `symbol:${OVERLAY_FILE_ID}/function/${name}|${OVERLAY_FILE_ID}|changed_in`,
  )

  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(overlayKeys, 'overlay edge keys', LATIN_ACCENTED)
  })

  it('orders edges_added by code point', () => {
    const overlay = computeSpiDiffOverlay({
      spi: overlaySpi(),
      root: '/repo',
      baseRef: 'BASE',
      headRef: 'HEAD',
      runGitDiff: () => '+++ src/many.ts\n@@ -1 +1 @@\n',
    })
    expectCodePointOrder(
      overlay.edges_added.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`),
      overlayKeys,
      'overlay edges_added',
      LATIN_ACCENTED,
    )
  })

  it('produces the same overlay bytes under two host collations', () => {
    expectSameBytesAcrossLocales(['src/pipeline/spi/diff-overlay.ts'], 'diff-overlay', `
import { createHash } from 'node:crypto'
import { computeSpiDiffOverlay } from './src/pipeline/spi/diff-overlay.js'
const spi = ${JSON.stringify(overlaySpi())}
const overlay = computeSpiDiffOverlay({
  spi, root: '/repo', baseRef: 'BASE', headRef: 'HEAD',
  runGitDiff: () => '+++ src/many.ts\\n@@ -1 +1 @@\\n',
})
process.stdout.write(createHash('sha256').update(JSON.stringify(overlay)).digest('hex') + ' ' + Intl.Collator().resolvedOptions().locale)
`, LATIN_ACCENTED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C4 -- proof-report compare-section ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No cross-host arm here, deliberately. `proof-report.ts` reaches the graph
 * runtime, so materializing its closure into a child process would cost far more
 * than it proves: the assertion above already pins the emitted order to a pure
 * function of the strings, which is what a comparator regression breaks.
 */
describe('C4 -- proof report compare-section ordering', () => {
  const compareNames = ADVERSARIAL.map((name) => `compare-${name}`)

  it('has a fixture where the collations genuinely disagree', () => {
    expectFixtureDiscriminates(compareNames, 'compare directory names', LATIN_ACCENTED)
  })

  it('orders compare summaries by code point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-715-proof-'))
    tempRoots.push(root)

    const { KnowledgeGraph } = await import('../../src/contracts/graph.js')
    const { toJson } = await import('../../src/pipeline/export.js')
    const graph = new KnowledgeGraph()
    graph.addNode('alpha', { label: 'alpha', source_file: 'src/a.ts', source_location: 'L1', file_type: 'code', community: 0 })
    graph.addNode('beta', { label: 'beta', source_file: 'src/b.ts', source_location: 'L2', file_type: 'code', community: 0 })
    graph.addEdge('alpha', 'beta', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' })
    mkdirSync(join(root, 'out'), { recursive: true })
    const graphPath = join(root, 'out', 'graph.json')
    toJson(graph, { 0: ['alpha', 'beta'] }, graphPath)

    // One compare directory per adversarial name, each identifiable by its question.
    for (const name of compareNames) {
      const dir = join(root, 'out', 'compare', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'report.share-safe.json'), JSON.stringify({
        question: `Q ${name}`,
        baseline_mode: 'bounded',
        reduction_ratio: 2,
        status: { baseline: 'completed', madar: 'completed' },
        provider_proof: { winner: 'madar' },
      }, null, 2), 'utf8')
    }

    const { runProofReportCommand } = await import('../../src/infrastructure/proof-report.js')
    const result = runProofReportCommand({
      graphPath,
      // The fixture supplies the path, so the intent is explicit; a default
      // lookup would classify the workspace and hand back a different artifact.
      graphPathIntent: 'explicit',
      outputDir: join(root, 'out', 'proof-report'),
      compareDir: join(root, 'out', 'compare'),
      packPath: null,
    })

    const emitted = compareNames
      .map((name) => ({ name, at: result.report.indexOf(`Q ${name}`) }))
      .filter((entry) => entry.at >= 0)
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.name)

    expect(emitted, 'no compare questions reached the report; the fixture drifted')
      .toHaveLength(compareNames.length)
    expectCodePointOrder(emitted, compareNames, 'proof-report compare sections', LATIN_ACCENTED)
    expect(readFileSync(result.outputPath, 'utf8')).toBe(result.report)
  })
})
