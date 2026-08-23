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

/**
 * Every field an arm result must carry, with its exact type and identity.
 *
 * A completed process is necessary and not sufficient. The result used to be
 * parsed from the last line of the arm's stdout, a pipe descendants can write
 * to or truncate; it is now read from an atomically renamed file and checked
 * here before it can influence a comparison.
 */
export function assertArmResult(value, { scope, inputChecksum, where }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: arm result is not an object`)
  }
  const number = (key) => {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new Error(`${where}: arm result field "${key}" is not a finite number`)
    }
  }
  for (const key of ['medianMs', 'minMs', 'maxMs', 'spreadMs', 'peakRssMb', 'emittedCandidates']) number(key)
  if (!Array.isArray(value.samples) || value.samples.length === 0) {
    throw new Error(`${where}: arm result carries no samples`)
  }
  for (const sample of value.samples) {
    if (typeof sample !== 'number' || !Number.isFinite(sample)) {
      throw new Error(`${where}: arm result sample is not a finite number`)
    }
  }
  // Identity, not just shape: an arm result from another scope or another
  // canonical input is not evidence about this comparison.
  if (value.scope !== scope) throw new Error(`${where}: arm result is for scope "${value.scope}", expected "${scope}"`)
  if (value.inputChecksum !== inputChecksum) {
    throw new Error(`${where}: arm result input checksum does not match the shared input`)
  }
  return value
}

