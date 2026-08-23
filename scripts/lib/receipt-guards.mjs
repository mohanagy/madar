import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The decisions that make a receipt a qualification rather than an assertion,
 * separated from the process that acts on them so they can be executed in tests
 * against real repositories rather than asserted about by reading source.
 *
 * A policy test that greps for the word `finally` proves the word is present.
 * These functions can be run.
 */

/** Resolves a ref to an exact commit, or refuses. */
export function resolveExactCommit(repoRoot, ref) {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('a baseline ref is required')
  }
  let resolved
  try {
    resolved = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim()
  } catch {
    throw new Error(`baseline ref cannot be resolved: ${ref}`)
  }
  if (!/^[0-9a-f]{40}$/.test(resolved)) {
    throw new Error(`baseline ref did not resolve to an exact commit: ${ref}`)
  }
  return resolved
}

/**
 * A measurement of a dirty tree describes no commit, so it cannot be evidence
 * about one.
 */
export function assertCleanTree(repoRoot) {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (status.length > 0) {
    throw new Error('refusing to measure a dirty tree; commit or stash first')
  }
}

/**
 * A worktree must carry a build produced from its own checkout.
 *
 * Reusing whatever `dist` happens to be present would measure the current head
 * twice and report the ratio as a comparison.
 */
export function assertFreshBuild(dir, sha) {
  const entry = join(dir, 'dist/src/pipeline/build.js')
  if (!existsSync(entry)) {
    throw new Error(`baseline build at ${sha} produced no dist`)
  }
  return entry
}

/**
 * Both arms must have received the same bytes.
 *
 * Without this, each arm extracts its own input and the difference between two
 * extractions is reported as the difference between two heads.
 */
export function sessionIsComparable(session) {
  return session.base.inputChecksum === session.head.inputChecksum
}

export function partitionSessions(sessions, scope) {
  const usable = []
  const invalidated = []
  for (const session of sessions) {
    if (sessionIsComparable(session)) usable.push(session)
    else invalidated.push({ scope, order: session.order, reason: 'arms did not receive identical input' })
  }
  return { usable, invalidated }
}

/** Distinct commits, or the comparison compares a head with itself. */
export function assertDistinctArms(baselineSha, candidateSha) {
  if (baselineSha === candidateSha) {
    throw new Error(`baseline and candidate are the same commit: ${baselineSha}`)
  }
}

/** The envelope version this parent understands. */
export const ARM_ENVELOPE_VERSION = 1

/** The measurement contract every arm must satisfy, fixed by the parent. */
export const ARM_METRIC_NAMES = Object.freeze([
  'samples', 'medianMs', 'minMs', 'maxMs', 'spreadMs', 'peakRssMb',
])
export const ARM_WALL_UNIT = 'ms'
export const ARM_RSS_UNIT = 'MiB'

/** Identity fields the child must copy verbatim from the parent descriptor. */
const IDENTITY_FIELDS = Object.freeze([
  'envelopeVersion', 'runNonce', 'armIdentity', 'revision', 'mode', 'corpusScope',
  'inputChecksum', 'inventoryChecksum', 'fileCount', 'candidateCount',
])

const ENVELOPE_KEYS = Object.freeze([
  ...IDENTITY_FIELDS, 'completionState', 'sampleContract', 'measurements',
])

const MEASUREMENT_KEYS = Object.freeze([
  'samples', 'medianMs', 'minMs', 'maxMs', 'spreadMs', 'peakRssMb',
])

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Reads an own DATA property without invoking user code.
 *
 * Descriptor-first: an accessor on an identity field is refused rather than
 * executed, and an inherited value is not something the child wrote.
 */
function ownData(owner, key, where, problems) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (descriptor === undefined) {
    problems.push(`${where}: missing required field \`${key}\``)
    return { ok: false }
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    problems.push(`${where}: \`${key}\` is an accessor, not stored data`)
    return { ok: false }
  }
  return { ok: true, value: descriptor.value }
}

function assertClosedPlainObject(value, keys, where, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${where}: expected a plain object`)
    return false
  }
  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length > 0) {
    problems.push(`${where}: carries symbol key ${String(symbols[0])}`)
    return false
  }
  const own = Object.keys(value)
  for (const extra of own) {
    if (!keys.includes(extra)) problems.push(`${where}: unexpected key \`${extra}\``)
  }
  return true
}

/**
 * Validates an arm result against the descriptor the PARENT generated before
 * the arm was spawned.
 *
 * Scope and input checksum alone were not enough: an independent reviewer
 * forged a result carrying the right scope and checksum but the wrong revision,
 * wrong mode, wrong inventory, a stale arm identity and
 * `completionState: partial`, and it was accepted as a measurement.
 *
 * Every identity field must equal the parent's expectation exactly, and it is
 * checked before any measurement is read.
 */
export function assertArmResult(actual, expected, { where }) {
  const problems = []

  if (!assertClosedPlainObject(actual, ENVELOPE_KEYS, where, problems)) {
    throw new Error(`${where}: ${problems.join('; ')}`)
  }

  const version = ownData(actual, 'envelopeVersion', where, problems)
  if (version.ok && version.value !== ARM_ENVELOPE_VERSION) {
    problems.push(`${where}: envelope version ${JSON.stringify(version.value)} is not ${ARM_ENVELOPE_VERSION}`)
  }

  const completion = ownData(actual, 'completionState', where, problems)
  if (completion.ok && completion.value !== 'complete') {
    problems.push(`${where}: completion state is ${JSON.stringify(completion.value)}, expected "complete"`)
  }

  // Identity, field by field, against the parent's own expectation.
  for (const field of IDENTITY_FIELDS) {
    if (field === 'envelopeVersion') continue
    const read = ownData(actual, field, where, problems)
    if (!read.ok) continue
    if (read.value !== expected[field]) {
      problems.push(
        `${where}: ${field} is ${JSON.stringify(read.value)}, expected ${JSON.stringify(expected[field])}`,
      )
    }
  }

  // Sample and unit contract, also parent-declared.
  const contract = ownData(actual, 'sampleContract', where, problems)
  if (contract.ok) {
    const CONTRACT_KEYS = ['sampleCount', 'metricNames', 'wallUnit', 'rssUnit']
    if (assertClosedPlainObject(contract.value, CONTRACT_KEYS, `${where}.sampleContract`, problems)) {
      const wanted = expected.sampleContract
      if (contract.value.sampleCount !== wanted.sampleCount) {
        problems.push(`${where}: sample count ${contract.value.sampleCount}, expected ${wanted.sampleCount}`)
      }
      if (contract.value.wallUnit !== wanted.wallUnit) {
        problems.push(`${where}: wall unit ${JSON.stringify(contract.value.wallUnit)}, expected ${JSON.stringify(wanted.wallUnit)}`)
      }
      if (contract.value.rssUnit !== wanted.rssUnit) {
        problems.push(`${where}: rss unit ${JSON.stringify(contract.value.rssUnit)}, expected ${JSON.stringify(wanted.rssUnit)}`)
      }
      const names = contract.value.metricNames
      if (!Array.isArray(names) || names.length !== wanted.metricNames.length
        || names.some((name, index) => name !== wanted.metricNames[index])) {
        problems.push(`${where}: metric contract ${JSON.stringify(names)}, expected ${JSON.stringify(wanted.metricNames)}`)
      }
    }
  }

  // Only now are measurements read at all.
  const measurements = ownData(actual, 'measurements', where, problems)
  if (measurements.ok && assertClosedPlainObject(measurements.value, MEASUREMENT_KEYS, `${where}.measurements`, problems)) {
    const m = measurements.value
    for (const key of ['medianMs', 'minMs', 'maxMs', 'spreadMs', 'peakRssMb']) {
      const read = ownData(m, key, `${where}.measurements`, problems)
      if (read.ok && (typeof read.value !== 'number' || !Number.isFinite(read.value))) {
        problems.push(`${where}.measurements: \`${key}\` is not a finite number`)
      }
    }
    const samples = ownData(m, 'samples', `${where}.measurements`, problems)
    if (samples.ok) {
      if (!Array.isArray(samples.value)) {
        problems.push(`${where}.measurements: samples is not an array`)
      } else {
        const wantedCount = expected.sampleContract.sampleCount
        if (samples.value.length !== wantedCount) {
          problems.push(`${where}.measurements: ${samples.value.length} samples, expected exactly ${wantedCount}`)
        }
        for (let index = 0; index < samples.value.length; index += 1) {
          const element = Object.getOwnPropertyDescriptor(samples.value, String(index))
          if (element === undefined || !Object.prototype.hasOwnProperty.call(element, 'value')) {
            problems.push(`${where}.measurements: sample ${index} is a hole or accessor`)
            continue
          }
          if (typeof element.value !== 'number' || !Number.isFinite(element.value)) {
            problems.push(`${where}.measurements: sample ${index} is not a finite number`)
          }
        }
      }
    }
  }

  if (problems.length > 0) throw new Error(problems.join('; '))
  return actual
}

/** Builds the immutable expectation the parent hands to one arm. */
export function buildArmDescriptor(fields) {
  return Object.freeze({
    envelopeVersion: ARM_ENVELOPE_VERSION,
    runNonce: fields.runNonce,
    armIdentity: fields.armIdentity,
    revision: fields.revision,
    mode: fields.mode,
    corpusScope: fields.corpusScope,
    inputChecksum: fields.inputChecksum,
    inventoryChecksum: fields.inventoryChecksum,
    fileCount: fields.fileCount,
    candidateCount: fields.candidateCount,
    sampleContract: Object.freeze({
      sampleCount: fields.sampleCount,
      metricNames: ARM_METRIC_NAMES,
      wallUnit: ARM_WALL_UNIT,
      rssUnit: ARM_RSS_UNIT,
    }),
  })
}
