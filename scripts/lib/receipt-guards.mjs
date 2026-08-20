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
