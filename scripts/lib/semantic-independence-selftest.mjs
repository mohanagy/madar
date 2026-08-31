/**
 * #660-B falsifiability harness for the SEMANTIC half of production independence.
 *
 * The forbidden-knowledge scanner cannot see this class. A rule keyed on prompt
 * vocabulary, or one that forces a candidate into the result, encodes a
 * qualification task while containing no name any manifest could list. That
 * class is owned by behavioural tests -- so those tests have to be shown to
 * fail when the contamination comes back, or they are decoration.
 *
 * Each control puts one real task-phrase or forced-selection rule back into a
 * real production file, runs the specific behavioural test that owns it as a
 * child process, and requires that test to FAIL. It then restores the bytes and
 * proves they went back, and finally requires the same test to pass again, so a
 * control that "passed" because the suite was broken all along is caught.
 *
 * Runs standalone (never inside the vitest worker pool) because it mutates
 * source files on disk and spawns vitest.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ByteSnapshot } from './grader-boundary-selftest.mjs'

const FALLBACK = 'src/runtime/retrieve/conceptual-fallback.ts'
const OWNING_TEST_FILE = 'tests/unit/production-independence.test.ts'

/**
 * The anchor every injection attaches to: the end of the per-obligation
 * reservation loop. If this text ever moves, the injection fails loudly rather
 * than silently doing nothing.
 */
const RESERVATION_ANCHOR = `  for (const nodeId of preferredObligationAnchorIds) {
    boosts.set(nodeId, Math.max(boosts.get(nodeId) ?? 0, CONCEPTUAL_WORKFLOW_RESERVATION_BOOST))
  }
`

function runOwningTest(root, testNameFilter) {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', OWNING_TEST_FILE, '-t', testNameFilter, '--reporter=dot'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  )
  return {
    failed: result.status !== 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function cases() {
  return [
    {
      id: 'H1',
      title: 'a restored public+page task-phrase forced selection is caught by control D',
      testFilter: 'D. ranks a one-for-one substituted repository',
      inject(snapshot) {
        // A task-phrase score adjustment: exactly the shape §5 names. It fires
        // only when the prompt carries both words, so it moves the original
        // fixture and leaves the substituted one alone.
        snapshot.replaceOnce(FALLBACK, RESERVATION_ANCHOR, `${RESERVATION_ANCHOR}
  // #660-B H1 injection -- an obligation-term score adjustment.
  if (obligations.some((entry) => entry.terms.includes('public') && entry.terms.includes('page'))) {
    for (const anchor of anchors) {
      if (anchor.sourceFile.includes('/router/')) {
        boosts.set(anchor.id, (boosts.get(anchor.id) ?? 0) + 25)
      }
    }
  }
`)
      },
    },
    {
      id: 'H2',
      title: 'a restored repository-path ranking boost is caught by control D',
      testFilter: 'D. ranks a one-for-one substituted repository',
      inject(snapshot) {
        // A repository-path boost with no prompt vocabulary at all, so a
        // prompt-shaped control would not see it either.
        snapshot.replaceOnce(FALLBACK, RESERVATION_ANCHOR, `${RESERVATION_ANCHOR}
  // #660-B H2 injection -- a repository-path score adjustment.
  for (const anchor of anchors) {
    if (anchor.sourceFile.includes('/checker/')) {
      boosts.set(anchor.id, (boosts.get(anchor.id) ?? 0) + 25)
    }
  }
`)
      },
    },
  ]
}

export function runSemanticIndependenceSelfTest({ root = process.cwd(), log = console.log } = {}) {
  const results = []

  // The owning test must pass on the untouched tree, or "it failed after the
  // injection" proves nothing at all.
  const baseline = runOwningTest(root, 'D. ranks a one-for-one substituted repository')
  results.push({
    id: 'H0',
    title: 'the owning behavioural control passes on the untouched tree',
    passed: !baseline.failed,
    detail: baseline.failed
      ? `baseline control is already failing (exit ${baseline.status}); nothing below proves anything`
      : 'control D green before any injection',
  })

  if (baseline.failed) {
    for (const entry of results) {
      log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
      log(`        ${entry.detail}`)
    }
    return { ok: false, results }
  }

  for (const testCase of cases()) {
    const snapshot = new ByteSnapshot(root)
    let passed = false
    let detail = ''
    try {
      testCase.inject(snapshot)

      // PREMISE: the injected rule is really on disk. Without this a no-op
      // injection is indistinguishable from a working control.
      const injected = readFileSync(resolve(root, FALLBACK), 'utf8')
      if (!injected.includes(`#660-B ${testCase.id} injection`)) {
        detail = 'injection did not reach the file; the control proves nothing'
      } else {
        const run = runOwningTest(root, testCase.testFilter)
        // A crash, a type error or a missing test would also be a non-zero
        // exit. Only the control's OWN assertion counts as ownership.
        const failedOnItsAssertion = run.failed
          && /AssertionError/.test(run.output)
          && /ranks a one-for-one substituted repository/.test(run.output)
        passed = failedOnItsAssertion
        detail = passed
          ? `owning control failed on its own assertion (exit ${run.status})`
          : run.failed
            ? `control failed for an UNRELATED reason, which proves nothing: ${run.output.slice(0, 400).replace(/\s+/g, ' ')}`
            : 'owning control still PASSED with the contamination present; it does not own this behaviour'
      }
    } catch (error) {
      detail = `control threw: ${error?.message ?? String(error)}`
    } finally {
      const unrestored = snapshot.restore()
      if (unrestored.length > 0) {
        passed = false
        detail += ` | RESTORE FAILED: ${unrestored.join(', ')}`
      }
    }
    results.push({ id: testCase.id, title: testCase.title, passed, detail })
  }

  // The tree must be exactly as green afterwards as before.
  const after = runOwningTest(root, 'D. ranks a one-for-one substituted repository')
  results.push({
    id: 'H3',
    title: 'the tree is restored and the owning control is green again',
    passed: !after.failed,
    detail: after.failed ? `control D is still failing after restore (exit ${after.status})` : 'control D green after restore',
  })

  for (const entry of results) {
    log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
    log(`        ${entry.detail}`)
  }

  return { ok: results.every((entry) => entry.passed), results }
}
