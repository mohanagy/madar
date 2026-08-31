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
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { ByteSnapshot } from './grader-boundary-selftest.mjs'

/**
 * Resolved from vitest's own package manifest rather than shelled out to, so
 * this works identically on Windows, where `npx` is a `.cmd` shim that
 * `spawnSync` cannot execute directly.
 */
function resolveVitestBin() {
  const require_ = createRequire(import.meta.url)
  const manifestPath = require_.resolve('vitest/package.json')
  const { bin } = require_(manifestPath)
  const entry = typeof bin === 'string' ? bin : bin?.vitest
  if (typeof entry !== 'string') {
    throw new Error('vitest package.json declares no bin entry; cannot run the owning control')
  }
  return join(dirname(manifestPath), entry)
}

const VITEST_BIN = resolveVitestBin()

const FALLBACK = 'src/runtime/retrieve/conceptual-fallback.ts'
const RETRIEVE = 'src/runtime/retrieve.ts'
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

/**
 * The retrieval-path anchor. Mutations attached here run in `retrieveContext`
 * itself, so they are owned by the END-TO-END control rather than by the
 * fallback planner's boost map. A control that only ever watched boosts would
 * miss a forced selection applied after ranking.
 */
const RETRIEVE_ANCHOR = `      let orderedCandidates = inclusionOrder
      let sliceMetadata: ContextPackSliceMetadata | undefined
`

function runOwningTest(root, testNameFilter) {
  // `npx` is `npx.cmd` on Windows and spawnSync cannot execute it directly:
  // without a shell the call returns status null and every control below would
  // read as "the owning test failed", which is a false pass. Run the vitest
  // entry with the current node binary instead, which is portable and also
  // avoids resolving a shim on every platform.
  const result = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', OWNING_TEST_FILE, '-t', testNameFilter, '--reporter=dot'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  )
  if (result.error) {
    return { failed: true, status: null, output: `spawn failed: ${result.error.message}`, spawnFailed: true }
  }
  if (result.status === null) {
    return { failed: true, status: null, output: `vitest did not run to completion (signal ${result.signal})`, spawnFailed: true }
  }
  return {
    failed: result.status !== 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const run0Detail = (run) => run.output.slice(0, 300).replace(/\s+/g, ' ')

function cases() {
  return [
    {
      id: 'H1',
      title: 'a restored public+page task-phrase forced selection is caught by control D',
      file: FALLBACK,
      testFilter: 'D. ranks a one-for-one substituted repository',
      ownerPattern: /ranks a one-for-one substituted repository/,
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
      file: FALLBACK,
      testFilter: 'D. ranks a one-for-one substituted repository',
      ownerPattern: /ranks a one-for-one substituted repository/,
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
    {
      id: 'H4',
      title: 'a forced selection on the retrieval path is caught by the end-to-end control',
      file: RETRIEVE,
      testFilter: 'D2. selects the same nodes end-to-end',
      ownerPattern: /selects the same nodes end-to-end/,
      inject(snapshot) {
        // Applied AFTER ranking, where a boost-watching control cannot see it.
        snapshot.replaceOnce(RETRIEVE, RETRIEVE_ANCHOR, `${RETRIEVE_ANCHOR}
      // #660-B H4 injection -- a repository-path forced selection.
      orderedCandidates = [
        ...orderedCandidates.filter((entry) => entry.sourceFile.includes('/checker/')),
        ...orderedCandidates.filter((entry) => !entry.sourceFile.includes('/checker/')),
      ]
`)
      },
    },
    {
      id: 'H5',
      title: 'a slice-v1 bypass on the retrieval path is caught by the end-to-end control',
      file: RETRIEVE,
      testFilter: 'D2. selects the same nodes end-to-end',
      ownerPattern: /selects the same nodes end-to-end/,
      inject(snapshot) {
        snapshot.replaceOnce(RETRIEVE, RETRIEVE_ANCHOR, `${RETRIEVE_ANCHOR}
      // #660-B H5 injection -- a question-shaped bypass of the requested slice.
      const h5Bypass = /\\bstatus\\b/i.test(options.question ?? '')
      if (h5Bypass) {
        orderedCandidates = orderedCandidates.slice(0, 2)
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
  const baseline = runOwningTest(root, 'D. ')
  results.push({
    id: 'H0',
    title: 'both owning behavioural controls pass on the untouched tree',
    passed: !baseline.failed,
    detail: baseline.failed
      ? `baseline controls are already failing (exit ${baseline.status}); nothing below proves anything: ${
        run0Detail(baseline)}`
      : 'controls D and D2 green before any injection',
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
      const injected = readFileSync(resolve(root, testCase.file), 'utf8')
      if (!injected.includes(`#660-B ${testCase.id} injection`)) {
        detail = 'injection did not reach the file; the control proves nothing'
      } else {
        const run = runOwningTest(root, testCase.testFilter)
        // A crash, a type error or a missing test would also be a non-zero
        // exit. Only the control's OWN assertion counts as ownership.
        const failedOnItsAssertion = run.failed
          && !run.spawnFailed
          && /AssertionError/.test(run.output)
          && testCase.ownerPattern.test(run.output)
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
  const after = runOwningTest(root, 'D. ')
  results.push({
    id: 'H3',
    title: 'the tree is restored and both owning controls are green again',
    passed: !after.failed,
    detail: after.failed
      ? `controls D/D2 still failing after restore (exit ${after.status})`
      : 'controls D and D2 green after restore',
  })

  for (const entry of results) {
    log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
    log(`        ${entry.detail}`)
  }

  return { ok: results.every((entry) => entry.passed), results }
}
