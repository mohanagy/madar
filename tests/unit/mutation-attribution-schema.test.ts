import { createHash } from 'node:crypto'
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ATTRIBUTION_MODES,
  NESTED_SCHEMA,
  canonicalJsonValue,
  fieldState,
  jsonTypeOf,
} from '../../scripts/lib/attribution-schema.mjs'
import {
  copyMatrix,
  discardMatrix,
  matrixDir,
  produceEvidenceMatrix,
} from './helpers/evidence-matrix.js'

/**
 * The total persisted-attribution schema, proven over its finite state space.
 *
 * Four independent reviews found the same class of defect on different fields:
 * a persisted conclusion trusted without re-derivation, or a persisted state
 * collapsed in the digest that exists to distinguish states. Each round the
 * named field was repaired and the class was not.
 *
 * So this suite does not test values, it tests STATE CLASSES. A persisted JSON
 * field has exactly six types plus absence, and every one of them is driven
 * here for both modes. Once the finite space is covered the general algorithm
 * is the proof and further literals add nothing.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AUDITOR = resolve(REPO, 'scripts/audit-mutation-evidence.mjs')

/** Failures that mean the probe itself was botched, never a real detection. */
const MASKING = [
  'artifact_outside_invocation_bounds', 'report_digest_mismatch',
  // The auditor emits `report_size_mismatch`; `report_bytes_mismatch` is a
  // code no path produces, so a probe invalidated by a size mismatch was not
  // recognised as masked and passed `expect(result.masked).toBe(false)` while
  // detecting nothing.
  'report_size_mismatch', 'report_freshness_violation',
]

interface Mode { readonly project: string; readonly golden: string }
const modes: Record<'exact' | 'owning', Mode> = { exact: { project: '', golden: '' }, owning: { project: '', golden: '' } }
const copies: string[] = []

beforeAll(() => {
  const exact = produceEvidenceMatrix({ exactFailureSet: true })
  modes.exact = { project: exact.project, golden: exact.runRoot }
  const owning = produceEvidenceMatrix()
  modes.owning = { project: owning.project, golden: owning.runRoot }
}, 120_000)

afterAll(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const mode of Object.values(modes)) if (mode.project !== '') discardMatrix(mode.project)
})

function matrix(mode: keyof typeof modes): string {
  const root = copyMatrix(modes[mode].golden)
  copies.push(dirname(root))
  return root
}

const readJson = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<string, unknown>

const edit = (dir: string, file: string, change: (value: Record<string, unknown>) => void): void => {
  const value = readJson(dir, file)
  change(value)
  writeFileSync(resolve(dir, file), JSON.stringify(value, null, 2))
}

function restamp(dir: string): void {
  const bytes = readFileSync(resolve(dir, 'vitest-report.json'))
  edit(dir, 'report-identity.json', (identity) => {
    identity['report_digest'] = createHash('sha256').update(bytes).digest('hex')
    identity['report_bytes'] = bytes.byteLength
  })
  const started = Date.parse(String(readJson(dir, 'report-identity.json')['invocation_started_at'])) / 1000
  utimesSync(resolve(dir, 'vitest-report.json'), started, started)
}

interface Probe { readonly detected: boolean; readonly masked: boolean; readonly codes: readonly string[]; readonly digest: string }

function audit(mode: keyof typeof modes, root: string): Probe {
  const out = resolve(dirname(root), `audit-${Math.random().toString(36).slice(2)}.json`)
  const child = spawnSync(process.execPath, [
    AUDITOR, root, '--expect-mutants', '1', '--expect-baselines', '1', '--json', out,
  ], { cwd: modes[mode].project, encoding: 'utf8' })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const codes = [...output.matchAll(/\[([a-z_]+)\]/g)].map((match) => match[1] as string)
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as { semantic_audit_digest: string }
  return {
    detected: child.status !== 0,
    masked: codes.some((code) => MASKING.includes(code)),
    codes,
    digest: parsed.semantic_audit_digest,
  }
}

/** One probe: copy, mutate the mutant's scoring.json, audit. */
function probe(mode: keyof typeof modes, mutate: (scoring: Record<string, unknown>) => void): Probe {
  const root = matrix(mode)
  edit(matrixDir(root, 'mutant'), 'scoring.json', mutate)
  return audit(mode, root)
}

const truthful = (mode: keyof typeof modes): Probe => probe(mode, () => {})

/** Sets a nested field, creating the object when a mode persists none. */
const ABSENT = Symbol('absent')
const nested = (key: string, value: unknown) => (scoring: Record<string, unknown>): void => {
  const object = (scoring['attribution'] ?? {}) as Record<string, unknown>
  scoring['attribution'] = object
  if (value === ABSENT) delete object[key]
  else object[key] = value
}

/** The finite JSON state space one persisted field can occupy. */
const SCALAR_STATES: ReadonlyArray<readonly [string, unknown]> = [
  ['missing', ABSENT], ['null', null], ['number', 7], ['unknown string', 'bogus_mode'],
]
const LIST_STATES: ReadonlyArray<readonly [string, unknown]> = [
  ['missing', ABSENT], ['null', null], ['string', 'x'], ['object', { n: 1 }],
  ['number array', [7]], ['string array', ['7']],
]

describe('the canonicalizer is type-lossless', () => {
  it('names every JSON type, with null distinct from object', () => {
    expect(jsonTypeOf(null)).toBe('null')
    expect(jsonTypeOf([])).toBe('array')
    expect(jsonTypeOf({})).toBe('object')
    expect(jsonTypeOf(7)).toBe('number')
    expect(jsonTypeOf('7')).toBe('string')
    expect(jsonTypeOf(false)).toBe('boolean')
  })

  it('keeps a number distinct from its string form', () => {
    expect(JSON.stringify(canonicalJsonValue(7))).not.toBe(JSON.stringify(canonicalJsonValue('7')))
  })

  it('distinguishes missing from every present state', () => {
    const states = [
      fieldState({}, 'k'),
      fieldState({ k: undefined as never }, 'k'),
      fieldState({ k: null }, 'k'),
      fieldState({ k: false }, 'k'),
      fieldState({ k: 0 }, 'k'),
      fieldState({ k: 'invalid' }, 'k'),
    ].map((state) => JSON.stringify(state))
    expect(new Set(states).size).toBe(states.length)
  })

  it('sorts a valid set-like array but preserves an invalid one', () => {
    const valid = (value: unknown): boolean => Array.isArray(value) && value.every((e) => typeof e === 'string')
    const present = (container: unknown): { validity: string; value: unknown } => {
      const state = fieldState(container, 'k', { valid, setLike: true })
      if (state.state !== 'present') throw new Error('expected a present field state')
      return { validity: state.validity, value: state.value }
    }
    expect(present({ k: ['b', 'a'] }).value).toEqual(['a', 'b'])
    // An invalid array keeps its order: normalizing it would erase the shape
    // that makes it invalid.
    expect(present({ k: [2, 1] }).value).toEqual([2, 1])
    expect(present({ k: [2, 1] }).validity).toBe('invalid')
  })

  it('refuses a non-finite number rather than serializing it as null', () => {
    expect(canonicalJsonValue(Number.POSITIVE_INFINITY)).toEqual({ non_finite: 'Infinity' })
    expect(canonicalJsonValue(Number.NaN)).toEqual({ non_finite: 'NaN' })
  })

  it('declares exactly two modes and one closed schema per mode', () => {
    expect([...ATTRIBUTION_MODES].sort()).toEqual(['exact_failure_set', 'owning_test'])
    expect(Object.keys(NESTED_SCHEMA).sort()).toEqual(['exact_failure_set', 'owning_test'])
    for (const keys of Object.values(NESTED_SCHEMA)) expect(keys).toContain('mode')
  })
})

describe.each(['exact', 'owning'] as const)('mode concordance — declaration %s', (mode) => {
  const opposite = mode === 'exact' ? 'owning_test' : 'exact_failure_set'

  it('accepts truthful evidence', () => {
    const result = truthful(mode)
    expect(result.masked).toBe(false)
    expect(result.detected).toBe(false)
  })

  it.each(SCALAR_STATES)('rejects a top-level mode that is %s', (label, value) => {
    const result = probe(mode, (scoring) => {
      if (value === ABSENT) delete scoring['attribution_mode']
      else scoring['attribution_mode'] = value
    })
    expect(result.masked, `${label} was masked`).toBe(false)
    expect(result.detected).toBe(true)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(result.digest).not.toBe(truthful(mode).digest)
  })

  it.each(SCALAR_STATES)('rejects a nested mode that is %s', (label, value) => {
    const result = probe(mode, nested('mode', value))
    expect(result.masked, `${label} was masked`).toBe(false)
    expect(result.detected).toBe(true)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(result.digest).not.toBe(truthful(mode).digest)
  })

  it('rejects the opposite valid mode at both levels', () => {
    for (const apply of [
      (scoring: Record<string, unknown>) => { scoring['attribution_mode'] = opposite },
      nested('mode', opposite),
    ]) {
      const result = probe(mode, apply)
      expect(result.detected).toBe(true)
      expect(result.codes).toContain('attribution_derivation_disagrees')
    }
  })

  it('rejects a missing nested attribution object', () => {
    // Neither branch may be the weaker sibling: both persist a nested result
    // and both require it.
    const result = probe(mode, (scoring) => { delete scoring['attribution'] })
    expect(result.detected).toBe(true)
    expect(result.codes).toContain('attribution_derivation_disagrees')
    expect(result.digest).not.toBe(truthful(mode).digest)
  })

  it.each([['array', []], ['primitive', 'x'], ['null', null]] as const)(
    'rejects a nested attribution that is a %s',
    (_label, value) => {
      const result = probe(mode, (scoring) => { scoring['attribution'] = value })
      expect(result.detected).toBe(true)
      expect(result.codes).toContain('attribution_derivation_disagrees')
    },
  )

  it('rejects an unknown nested key', () => {
    const result = probe(mode, nested('surprise', true))
    expect(result.detected).toBe(true)
    expect(result.digest).not.toBe(truthful(mode).digest)
  })

  it('declares the mode it persists', () => {
    const root = matrix(mode)
    const dir = matrixDir(root, 'mutant')
    const expected = mode === 'exact' ? 'exact_failure_set' : 'owning_test'
    expect(readJson(dir, 'meta.json')['attribution_mode']).toBe(expected)
    expect(readJson(dir, 'scoring.json')['attribution_mode']).toBe(expected)
    const object = readJson(dir, 'scoring.json')['attribution'] as Record<string, unknown>
    expect(object['mode']).toBe(expected)
    expect(Object.keys(object).sort()).toEqual([...NESTED_SCHEMA[expected]].sort())
  })
})

describe.each([
  ['exact', 'equal', 'actual'],
  ['owning', 'caught', 'matched'],
] as const)('field state space — %s mode', (mode, booleanField, listField) => {
  const key = mode as keyof typeof modes

  it('keeps every boolean state distinct and detected', () => {
    const base = truthful(key)
    const digests = new Map<string, string>([[base.digest, 'truthful']])
    for (const [label, value] of [
      ['false', false], ['missing', ABSENT], ['null', null], ['"invalid"', 'invalid'], ['0', 0],
    ] as const) {
      const result = probe(key, nested(booleanField, value))
      expect(result.masked, `${label} masked`).toBe(false)
      expect(result.detected, `${label} not detected`).toBe(true)
      expect(digests.has(result.digest), `${label} collides with ${digests.get(result.digest)}`).toBe(false)
      digests.set(result.digest, label)
    }
  })

  it.each(LIST_STATES)(`keeps a ${listField} that is %s distinct and detected`, (label, value) => {
    const result = probe(key, nested(listField, value))
    expect(result.masked, `${label} masked`).toBe(false)
    expect(result.detected).toBe(true)
    expect(result.digest).not.toBe(truthful(key).digest)
  })

  it('keeps every list state distinct from every other', () => {
    const digests = new Map<string, string>()
    for (const [label, value] of LIST_STATES) {
      const result = probe(key, nested(listField, value))
      expect(digests.has(result.digest), `${label} collides with ${digests.get(result.digest)}`).toBe(false)
      digests.set(result.digest, label)
    }
  })

  it('is order-invariant for a truthful set-like array', () => {
    // The one required collision: permuting a valid identity list is not a
    // different state, and a digest that moved here would make any comparison
    // between two truthful matrices meaningless.
    const base = truthful(key)
    const permuted = probe(key, (scoring) => {
      const object = scoring['attribution'] as Record<string, unknown>
      object[listField] = [...(object[listField] as string[])].reverse()
    })
    expect(permuted.detected).toBe(false)
    expect(permuted.digest).toBe(base.digest)
  })
})

describe('report-order permutation is not a state change', () => {
  it.each(['exact', 'owning'] as const)('%s mode digests identically', (mode) => {
    const base = truthful(mode)
    const root = matrix(mode)
    const dir = matrixDir(root, 'mutant')
    const report = JSON.parse(readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')) as {
      testResults: Array<{ assertionResults: unknown[] }>
    }
    for (const suite of report.testResults) suite.assertionResults.reverse()
    writeFileSync(resolve(dir, 'vitest-report.json'), JSON.stringify(report))
    restamp(dir)
    const result = audit(mode, root)
    expect(result.detected).toBe(false)
    expect(result.digest).toBe(base.digest)
  })
})
