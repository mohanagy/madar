/**
 * C1 — the arm-result envelope must be identity-bound to its parent.
 *
 * An independent reviewer forged a result carrying the correct corpus scope and
 * canonical input checksum but the wrong revision, wrong mode, wrong inventory
 * checksum, a stale arm identity and `completionState: 'partial'`, and it was
 * accepted as a measurement. Scope and checksum alone are not identity.
 *
 * Each control starts from a genuine matching envelope and alters exactly one
 * field, so every rejection is attributable to the field it names.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runChildOrThrow } from '../../scripts/lib/child-runner.mjs'
import type { ExpectedArmDescriptor } from '../../scripts/lib/receipt-guards.mjs'
import {
  ARM_ENVELOPE_VERSION,
  ARM_METRIC_NAMES,
  ARM_RSS_UNIT,
  ARM_WALL_UNIT,
  assertArmResult,
  buildArmDescriptor,
} from '../../scripts/lib/receipt-guards.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOLDER = resolve(REPO, 'tests/fixtures/descendant-holds-stdio.mjs')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const descriptorFor = (overrides: Record<string, unknown> = {}): ExpectedArmDescriptor =>
  buildArmDescriptor({
    runNonce: '11111111-2222-3333-4444-555555555555',
    armIdentity: '11111111-2222-3333-4444-555555555555:src-only:1',
    revision: 'a135efca773f5b5f4690a7195e48ad5c44b18ef9',
    mode: 'legacy',
    corpusScope: 'src-only',
    inputChecksum: 'a'.repeat(64),
    inventoryChecksum: 'b'.repeat(64),
    fileCount: 199,
    candidateCount: 15005,
    sampleCount: 5,
    ...overrides,
  } as Parameters<typeof buildArmDescriptor>[0])

/** A genuine, matching envelope for a descriptor. */
const envelopeFor = (descriptor: ExpectedArmDescriptor): Record<string, unknown> => ({
  envelopeVersion: descriptor.envelopeVersion,
  runNonce: descriptor.runNonce,
  armIdentity: descriptor.armIdentity,
  revision: descriptor.revision,
  mode: descriptor.mode,
  corpusScope: descriptor.corpusScope,
  inputChecksum: descriptor.inputChecksum,
  inventoryChecksum: descriptor.inventoryChecksum,
  fileCount: descriptor.fileCount,
  candidateCount: descriptor.candidateCount,
  completionState: 'complete',
  sampleContract: {
    sampleCount: 5,
    metricNames: [...ARM_METRIC_NAMES],
    wallUnit: ARM_WALL_UNIT,
    rssUnit: ARM_RSS_UNIT,
  },
  measurements: {
    samples: [10.1, 10.2, 10.3, 10.4, 10.5],
    medianMs: 10.3, minMs: 10.1, maxMs: 10.5, spreadMs: 0.4, peakRssMb: 512,
  },
})

const check = (mutate: (envelope: Record<string, unknown>) => void): (() => unknown) => {
  const descriptor = descriptorFor()
  const envelope = envelopeFor(descriptor)
  mutate(envelope)
  return () => assertArmResult(envelope, descriptor, { where: 'arm' })
}

describe('C1 — identity fields must equal the parent expectation', () => {
  it('01 rejects a wrong revision', () => {
    expect(check((e) => { e['revision'] = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })).toThrow(/revision is/)
  })

  it('02 rejects a wrong generation mode', () => {
    expect(check((e) => { e['mode'] = 'spi' })).toThrow(/mode is/)
  })

  it('03 rejects a wrong corpus scope', () => {
    expect(check((e) => { e['corpusScope'] = 'src-plus-tests-js-ts' })).toThrow(/corpusScope is/)
  })

  it('04 rejects a wrong inventory checksum', () => {
    expect(check((e) => { e['inventoryChecksum'] = 'c'.repeat(64) })).toThrow(/inventoryChecksum is/)
  })

  it('05 rejects a wrong file count', () => {
    expect(check((e) => { e['fileCount'] = 198 })).toThrow(/fileCount is/)
  })

  it('06 rejects a wrong candidate count', () => {
    expect(check((e) => { e['candidateCount'] = 999999 })).toThrow(/candidateCount is/)
  })

  it('07 rejects a wrong canonical input checksum', () => {
    expect(check((e) => { e['inputChecksum'] = 'd'.repeat(64) })).toThrow(/inputChecksum is/)
  })

  it('08 rejects a wrong run nonce', () => {
    expect(check((e) => { e['runNonce'] = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toThrow(/runNonce is/)
  })

  it('09 rejects a wrong arm identity', () => {
    expect(check((e) => { e['armIdentity'] = 'someone-elses-arm' })).toThrow(/armIdentity is/)
  })

  it('13 rejects a valid result copied from another invocation', () => {
    // Internally consistent and complete, but produced under a different run.
    const other = descriptorFor({
      runNonce: '99999999-8888-7777-6666-555555555555',
      armIdentity: '99999999-8888-7777-6666-555555555555:src-only:1',
    })
    const stolen = envelopeFor(other)
    expect(() => assertArmResult(stolen, descriptorFor(), { where: 'arm' }))
      .toThrow(/runNonce is/)
  })
})

describe('C1 — completion state and envelope version', () => {
  it('10 rejects a partial completion state', () => {
    expect(check((e) => { e['completionState'] = 'partial' })).toThrow(/completion state is "partial"/)
  })

  it('11 rejects a missing completion state', () => {
    expect(check((e) => { delete e['completionState'] })).toThrow(/missing required field `completionState`/)
  })

  it('12 rejects a wrong envelope version', () => {
    expect(check((e) => { e['envelopeVersion'] = ARM_ENVELOPE_VERSION + 1 })).toThrow(/envelope version/)
  })

  it('rejects a missing envelope version', () => {
    expect(check((e) => { delete e['envelopeVersion'] })).toThrow(/missing required field `envelopeVersion`/)
  })
})

describe('C1 — sample and unit contract', () => {
  it('14 rejects a wrong sample count in the contract', () => {
    expect(check((e) => {
      (e['sampleContract'] as Record<string, unknown>)['sampleCount'] = 4
    })).toThrow(/sample count 4, expected 5/)
  })

  it('15 rejects a missing sample', () => {
    expect(check((e) => {
      (e['measurements'] as Record<string, unknown>)['samples'] = [10.1, 10.2, 10.3, 10.4]
    })).toThrow(/samples: 4 entries, expected exactly 5/)
  })

  it('16 rejects an extra sample', () => {
    expect(check((e) => {
      (e['measurements'] as Record<string, unknown>)['samples'] = [10.1, 10.2, 10.3, 10.4, 10.5, 10.6]
    })).toThrow(/samples: 6 entries, expected exactly 5/)
  })

  it('17 rejects a wrong metric contract', () => {
    expect(check((e) => {
      (e['sampleContract'] as Record<string, unknown>)['metricNames'] = ['samples', 'medianMs']
    })).toThrow(/entries, expected exactly/)
  })

  it('18 rejects a wrong wall unit', () => {
    expect(check((e) => {
      (e['sampleContract'] as Record<string, unknown>)['wallUnit'] = 's'
    })).toThrow(/wallUnit/)
  })

  it('18b rejects a wrong RSS unit', () => {
    expect(check((e) => {
      (e['sampleContract'] as Record<string, unknown>)['rssUnit'] = 'bytes'
    })).toThrow(/rssUnit/)
  })

  it('rejects a non-finite sample', () => {
    expect(check((e) => {
      (e['measurements'] as Record<string, unknown>)['samples'] = [10.1, 10.2, 10.3, 10.4, 'x']
    })).toThrow(/sample 4 is not a finite number/)
  })
})

describe('C1 — envelope shape is closed and plain', () => {
  it('rejects an unexpected identity-bearing key', () => {
    expect(check((e) => { e['revisionOverride'] = 'sneaky' })).toThrow(/unexpected key `revisionOverride`/)
  })

  it('rejects a symbol key', () => {
    expect(check((e) => { (e as Record<symbol, unknown>)[Symbol('x')] = 1 })).toThrow(/symbol key/)
  })

  it('never executes an accessor on an identity field', () => {
    let reads = 0
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.defineProperty(envelope, 'revision', {
      get() { reads += 1; throw new Error('validator invoked a getter') },
      configurable: true,
      enumerable: true,
    })
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/is an accessor/)
    expect(reads).toBe(0)
  })

  it('rejects a non-plain envelope', () => {
    const descriptor = descriptorFor()
    const envelope = Object.assign(Object.create({ inherited: true }), envelopeFor(descriptor))
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/plain object/)
  })
})

/**
 * Enumerability is a presentation flag, not a closure boundary.
 *
 * Exact-key closure was built on `Object.keys`, which reports only ENUMERABLE
 * own keys. A reviewer defined a non-enumerable own `hiddenAuthority` on a
 * genuine contract and the forged evidence was accepted. The same helper owns
 * the envelope and `measurements`, so all three boundaries leaked identically.
 *
 * These objects arrive as JSON. A non-enumerable own key cannot survive
 * `JSON.stringify`, so its presence proves the object was assembled rather than
 * parsed -- which is exactly the forgery this guard exists to refuse.
 */
describe('C1 — closure covers every own key, not only the enumerable ones', () => {
  const hide = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true })
  }
  const contractOf = (e: Record<string, unknown>): Record<string, unknown> =>
    e['sampleContract'] as Record<string, unknown>

  // One helper owns all three closed objects, so this is ONE behaviour and is
  // asserted as one control -- per boundary, with its own message. Split across
  // three `it`s, a single mutation of the shared helper would fail three
  // controls while declaring one, which is not attributable.
  it('rejects a non-enumerable hidden key on every closed boundary', () => {
    expect(check((e) => { hide(contractOf(e), 'hiddenAuthority', 'forged') }))
      .toThrow(/sampleContract: unexpected key `hiddenAuthority`/)
    expect(check((e) => { hide(e, 'hiddenAuthority', 'forged') }))
      .toThrow(/^arm: unexpected key `hiddenAuthority`/)
    expect(check((e) => { hide(e['measurements'] as object, 'hiddenAuthority', 'forged') }))
      .toThrow(/measurements: unexpected key `hiddenAuthority`/)
  })

  it('rejects an enumerable extra key on the sample contract', () => {
    expect(check((e) => { contractOf(e)['extra'] = 1 }))
      .toThrow(/sampleContract: unexpected key `extra`/)
  })

  it('rejects a symbol key on the sample contract', () => {
    expect(check((e) => { (contractOf(e) as Record<symbol, unknown>)[Symbol('forged')] = 1 }))
      .toThrow(/sampleContract: carries symbol key Symbol\(forged\)/)
  })

  it('rejects an expected authority field that is non-enumerable', () => {
    // Same value, same own data descriptor -- only hidden from JSON.
    expect(check((e) => {
      const contract = contractOf(e)
      const value = contract['sampleCount']
      delete contract['sampleCount']
      hide(contract, 'sampleCount', value)
    })).toThrow(/`sampleCount` is non-enumerable and could not have survived JSON transport/)
  })

  // Same reasoning: metricNames and measurements.samples share one array-closure
  // helper, so their hidden-key behaviour is one control with two assertions.
  it('rejects a non-enumerable hidden key on every closed array', () => {
    expect(check((e) => { hide(contractOf(e)['metricNames'] as object, 'hiddenAuthority', 'forged') }))
      .toThrow(/metricNames: unexpected own key `hiddenAuthority`/)
    expect(check((e) => {
      hide((e['measurements'] as Record<string, unknown>)['samples'] as object, 'hiddenAuthority', 'forged')
    })).toThrow(/samples: unexpected own key `hiddenAuthority`/)
  })

  it('rejects a symbol key on metricNames', () => {
    expect(check((e) => {
      (contractOf(e)['metricNames'] as unknown as Record<symbol, unknown>)[Symbol('forged')] = 1
    })).toThrow(/metricNames: carries symbol key Symbol\(forged\)/)
  })

  it('accepts the standard non-enumerable array length', () => {
    // The one own key an ordinary dense array is expected to carry.
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    const names = (envelope['sampleContract'] as Record<string, unknown>)['metricNames'] as string[]
    expect(Object.getOwnPropertyDescriptor(names, 'length')?.enumerable).toBe(false)
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).not.toThrow()
  })

  it('accepts a genuine matching baseline envelope', () => {
    const descriptor = descriptorFor({ corpusScope: 'src-only' })
    expect(() => assertArmResult(envelopeFor(descriptor), descriptor, { where: 'arm' })).not.toThrow()
  })

  it('accepts a genuine matching candidate envelope', () => {
    const descriptor = descriptorFor({
      armIdentity: '11111111-2222-3333-4444-555555555555:src-plus-tests-js-ts:2',
      corpusScope: 'src-plus-tests-js-ts',
      fileCount: 694,
      candidateCount: 21210,
    })
    const envelope = envelopeFor(descriptor)
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).not.toThrow()
  })
})

describe('C1 — the nested sample contract is closed and descriptor-first', () => {
  /**
   * The previous validator read `contract.sampleCount` directly and checked
   * `metricNames` with Array.isArray + .length + .some(). A reviewer replaced
   * sampleCount with an enumerable getter -- which was EXECUTED -- and deleted
   * metricNames[2] leaving length at 6. `.some()` skips holes, so both
   * malformed contracts were accepted.
   */
  const contractOf = (envelope: Record<string, unknown>): Record<string, unknown> =>
    envelope['sampleContract'] as Record<string, unknown>
  const metricsOf = (envelope: Record<string, unknown>): unknown[] =>
    contractOf(envelope)['metricNames'] as unknown[]

  it('never executes an accessor-backed sampleCount', () => {
    let reads = 0
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.defineProperty(contractOf(envelope), 'sampleCount', {
      get() { reads += 1; return 5 },
      enumerable: true,
      configurable: true,
    })

    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/is an accessor/)
    expect(reads, 'the getter was executed').toBe(0)
  })

  it.each(['wallUnit', 'rssUnit', 'metricNames'])('never executes an accessor-backed %s', (field) => {
    let reads = 0
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.defineProperty(contractOf(envelope), field, {
      get() { reads += 1; return undefined },
      enumerable: true,
      configurable: true,
    })

    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/is an accessor/)
    expect(reads).toBe(0)
  })

  it('never executes an accessor-backed sampleContract', () => {
    let reads = 0
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.defineProperty(envelope, 'sampleContract', {
      get() { reads += 1; return undefined },
      enumerable: true,
      configurable: true,
    })

    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/is an accessor/)
    expect(reads).toBe(0)
  })

  it('rejects a sparse hole in metricNames with the length unchanged', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    const metrics = metricsOf(envelope)
    const before = metrics.length
    delete metrics[2]

    // The shape the reviewer used: length intact, index genuinely absent.
    expect(metrics.length).toBe(before)
    expect(Object.prototype.hasOwnProperty.call(metrics, '2')).toBe(false)
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/\[2\]: is a hole/)
  })

  it('never executes an accessor-backed metric index', () => {
    let reads = 0
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.defineProperty(metricsOf(envelope), '3', {
      get() { reads += 1; return 'spreadMs' },
      enumerable: true,
      configurable: true,
    })

    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/\[3\]: is an accessor/)
    expect(reads).toBe(0)
  })

  it('rejects a wrong metric element', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    metricsOf(envelope)[1] = 'medianSeconds'
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/\[1\]: "medianSeconds"/)
  })

  it.each([
    ['a missing element', (m: unknown[]) => { m.length = 5 }],
    ['an extra element', (m: unknown[]) => { m.push('extraMetric') }],
  ])('rejects %s', (_label, mutate) => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    mutate(metricsOf(envelope))
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/entries, expected exactly/)
  })

  it('rejects a non-string metric element', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    metricsOf(envelope)[0] = 42
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/must be a non-empty string/)
  })

  it('rejects an unexpected own key on metricNames', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    ;(metricsOf(envelope) as unknown as Record<string, unknown>)['smuggled'] = 'x'
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/unexpected own key `smuggled`/)
  })

  it('rejects a symbol key on metricNames', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    ;(metricsOf(envelope) as unknown as Record<symbol, unknown>)[Symbol('x')] = 1
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/symbol key/)
  })

  it('rejects a custom prototype on metricNames', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    Object.setPrototypeOf(metricsOf(envelope), { sneaky: true })
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/plain prototype/)
  })

  it.each([
    ['an extra key', (c: Record<string, unknown>) => { c['extra'] = 1 }, /unexpected key `extra`/],
    ['a symbol key', (c: Record<string, unknown>) => {
      (c as Record<symbol, unknown>)[Symbol('s')] = 1
    }, /symbol key/],
  ])('rejects %s on the sample contract', (_label, mutate, pattern) => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    mutate(contractOf(envelope))
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(pattern)
  })

  it('rejects a custom prototype on the sample contract', () => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    envelope['sampleContract'] = Object.assign(Object.create({ inherited: 1 }), contractOf(envelope))
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' })).toThrow(/plain object|plain prototype/)
  })

  it.each([
    ['negative', -1],
    ['fractional', 5.5],
    ['a string', '5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects a %s sampleCount', (_label, value) => {
    const descriptor = descriptorFor()
    const envelope = envelopeFor(descriptor)
    contractOf(envelope)['sampleCount'] = value
    expect(() => assertArmResult(envelope, descriptor, { where: 'arm' }))
      .toThrow(/is not a non-negative safe integer|sample count/)
  })

  it('accepts a truthful dense contract on both arms', () => {
    // The positive counterpart: this discipline must not reject faithful arms.
    for (const revision of ['a135efca773f5b5f4690a7195e48ad5c44b18ef9', '06c23330496663fdbb7f71055cd4b4653e823d36']) {
      const descriptor = descriptorFor({ revision })
      const envelope = envelopeFor(descriptor)
      expect(assertArmResult(envelope, descriptor, { where: 'arm' })).toBe(envelope)
    }
  })
})

describe('C1 — truthful arms are accepted', () => {
  it('accepts a fresh matching baseline arm', () => {
    const descriptor = descriptorFor({ revision: 'a135efca773f5b5f4690a7195e48ad5c44b18ef9' })
    const envelope = envelopeFor(descriptor)
    expect(assertArmResult(envelope, descriptor, { where: 'baseline arm' })).toBe(envelope)
  })

  it('accepts a fresh matching candidate arm', () => {
    const descriptor = descriptorFor({
      revision: '06c23330496663fdbb7f71055cd4b4653e823d36',
      armIdentity: '11111111-2222-3333-4444-555555555555:src-only:2',
      corpusScope: 'src-plus-tests-js-ts',
      fileCount: 692,
      candidateCount: 21189,
    })
    const envelope = envelopeFor(descriptor)
    expect(assertArmResult(envelope, descriptor, { where: 'candidate arm' })).toBe(envelope)
  })
})

describe('C1 — a complete result cannot rescue a failed process', () => {
  it('19 rejects a non-zero child exit even when the result file is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-arm-exit-'))
    scratch.push(dir)
    const resultFile = join(dir, 'result.json')

    await expect(runChildOrThrow(process.execPath, [HOLDER], {
      cwd: REPO,
      timeoutMs: 20_000,
      graceMs: 300,
      env: {
        ...process.env,
        MADAR_STDIO_HOLD_MS: '0',
        MADAR_RESULT_FILE: resultFile,
        MADAR_EXIT_CODE: '3',
      },
    })).rejects.toThrow(/exit 3/)

    // The complete result exists and is still not evidence.
    expect(existsSync(resultFile)).toBe(true)
  }, 40_000)

  it('an arm invoked without a descriptor refuses to publish', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-arm-nodesc-'))
    scratch.push(dir)
    let status = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [
        resolve(REPO, 'scripts/verify-integrity-receipts.mjs'),
        '--measure-arm', REPO, '--scope', 'src-only',
        '--input', join(dir, 'missing.json'), '--runs', '1',
        '--result-file', join(dir, 'result.json'),
      ], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    } catch (error) {
      const failure = error as { status?: number; stderr?: string }
      status = failure.status ?? -1
      stderr = failure.stderr ?? ''
    }
    expect(status).not.toBe(0)
    expect(existsSync(join(dir, 'result.json'))).toBe(false)
    expect(stderr.length).toBeGreaterThan(0)
  }, 180_000)
})
