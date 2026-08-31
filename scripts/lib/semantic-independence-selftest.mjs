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
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const OWNER_D = 'D. ranks a one-for-one substituted repository'
const OWNER_D2 = 'D2. selects the same nodes end-to-end'
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

/**
 * Where final membership is actually fixed. `orderedCandidates` is upstream of
 * the pack's own budgeted selection, so an injection there can be discarded and
 * prove nothing -- which is exactly what the membership premise caught.
 */
const MEMBERSHIP_ANCHOR = `  const matchedNodes = pack.nodes as RetrieveMatchedNode[]
`

function runOwningTest(root, testNameFilter, extraEnv = {}) {
  // `npx` is `npx.cmd` on Windows and spawnSync cannot execute it directly:
  // without a shell the call returns status null and every control below would
  // read as "the owning test failed", which is a false pass. Run the vitest
  // entry with the current node binary instead, which is portable and also
  // avoids resolving a shim on every platform.
  const result = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', OWNING_TEST_FILE, '-t', testNameFilter, '--reporter=dot'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', ...extraEnv } },
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

/**
 * The membership D2 itself measured, read back through a file seam.
 *
 * The premise these controls need is not "the file changed" but "the selected
 * SET changed". A reorder satisfies the first and not the second, and a control
 * that accepted the first would pass while proving nothing. Reusing the real
 * control rather than a generated spec means the observation cannot drift from
 * what the control asserts.
 */
function measureD2Membership(root) {
  const out = join(tmpdir(), `madar-d2-membership-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  try {
    runOwningTest(root, OWNER_D2, { MADAR_D2_MEMBERSHIP_OUT: out })
    if (!existsSync(out)) {
      return { ok: false, membership: [], detail: 'D2 did not emit a membership measurement' }
    }
    const parsed = JSON.parse(readFileSync(out, 'utf8'))
    return { ok: true, membership: parsed.qualification?.membership ?? [], detail: '' }
  } catch (error) {
    return { ok: false, membership: [], detail: `membership read failed: ${error?.message ?? String(error)}` }
  } finally {
    if (existsSync(out)) {
      rmSync(out, { force: true })
    }
  }
}

const run0Detail = (run) => run.output.slice(0, 300).replace(/\s+/g, ' ')

function cases() {
  return [
    {
      id: 'H1',
      title: 'a restored public+page task-phrase forced selection is caught by control D',
      file: FALLBACK,
      testFilter: OWNER_D,
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
      testFilter: OWNER_D,
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
      title: 'a forced final-membership change on the retrieval path is caught by D2',
      file: RETRIEVE,
      testFilter: OWNER_D2,
      ownerPattern: /selects the same nodes end-to-end/,
      // A reorder of already-selected candidates is NOT a sufficient premise:
      // D2 asserts membership, so shuffling the same set proves nothing. This
      // injection promotes a repository-path candidate the clean tree does not
      // select at all, which is a genuine membership change.
      membershipNode: 'h4-forced-membership',
      inject(snapshot) {
        snapshot.replaceOnce(RETRIEVE, MEMBERSHIP_ANCHOR, `${MEMBERSHIP_ANCHOR}
  // #660-B1 H4 injection -- a payload entry pinned in because a repository
  // path is present, which is the shape the removed claim-pinning path had.
  // The pinned entry is one the clean tree never selects, so its appearance is
  // a genuine final-membership change rather than a reordering.
  if (orderedCandidates.some((entry) => entry.sourceFile.includes('/checker/'))) {
    matchedNodes.push({
      node_id: 'h4-forced-membership',
      label: 'h4ForcedMembership()',
      source_file: '/apps/checker/forced.go',
      line_number: 1,
      snippet: null,
      relevance_band: 'direct',
    } as RetrieveMatchedNode)
  }
`)
      },
    },
    {
      id: 'H5',
      title: 'a question-shaped bypass inside the requested slice is caught by D2',
      file: RETRIEVE,
      testFilter: OWNER_D2,
      ownerPattern: /selects the same nodes end-to-end/,
      // Removes a candidate the clean tree DOES select, so membership shrinks
      // on one side only. Gated on the requested slice, so it exercises the
      // path D2 now requests rather than a strategy nothing asked for.
      membershipNode: 'n2',
      inject(snapshot) {
        snapshot.replaceOnce(RETRIEVE, MEMBERSHIP_ANCHOR, `${MEMBERSHIP_ANCHOR}
  // #660-B1 H5 injection -- a question-shaped bypass applied where membership
  // is final, gated on a slice actually having been requested.
  if (options.retrievalStrategy === 'slice-v1' && /\\bstatus\\b/i.test(options.question ?? '')) {
    for (let h5i = matchedNodes.length - 1; h5i >= 0; h5i -= 1) {
      if ((matchedNodes[h5i]?.source_file ?? '').includes('/checker/')) {
        matchedNodes.splice(h5i, 1)
      }
    }
  }
`)
      },
    },
  ]
}

/**
 * True when the injection actually moved the SELECTED SET, not just its order.
 * `membershipNode` names the node whose selection state must flip.
 */
function membershipPremiseHolds(root, testCase, reportFailure) {
  const probe = measureD2Membership(root)
  if (!probe.ok) {
    reportFailure(`membership probe failed, so the premise is unproven: ${probe.detail}`)
    return false
  }
  const node = testCase.membershipNode
  const present = probe.membership.includes(node)
  // H4 adds a node the clean tree lacks; H5 removes one it has.
  const flipped = testCase.id === 'H4' ? present : !present
  if (!flipped) {
    reportFailure(
      `injection did not change final membership (${node} ${present ? 'present' : 'absent'}, `
      + `set ${JSON.stringify(probe.membership)}); a reorder is not a sufficient premise`,
    )
    return false
  }
  return true
}

export function runSemanticIndependenceSelfTest({ root = process.cwd(), log = console.log } = {}) {
  const results = []

  // The owning test must pass on the untouched tree, or "it failed after the
  // injection" proves nothing at all.
  // Vitest -t is a substring match, so 'D. ' does NOT select 'D2. '. The two
  // controls have to be run as two filters or the D2 baseline is never
  // established -- which is exactly what a previous version of this harness
  // claimed and did not do.
  const runBothOwners = () => ({
    d: runOwningTest(root, OWNER_D),
    d2: runOwningTest(root, OWNER_D2),
  })
  const baseline = runBothOwners()
  const baselineOk = !baseline.d.failed && !baseline.d2.failed
  results.push({
    id: 'H0',
    title: 'controls D and D2 each pass on the untouched tree, run as separate filters',
    passed: baselineOk,
    detail: baselineOk
      ? 'D green and D2 green before any injection'
      : `baseline already failing -- D exit ${baseline.d.status}, D2 exit ${baseline.d2.status}; nothing below proves anything: ${
        run0Detail(baseline.d.failed ? baseline.d : baseline.d2)}`,
  })

  if (!baselineOk) {
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

      // PREMISE 1: the injected rule is really on disk.
      const injected = readFileSync(resolve(root, testCase.file), 'utf8')
      const marker = `${testCase.id} injection`
      if (!injected.includes(marker)) {
        detail = 'injection did not reach the file; the control proves nothing'
      } else if (testCase.membershipNode !== undefined
        && !membershipPremiseHolds(root, testCase, (message) => { detail = message })) {
        // PREMISE 2 handled inside membershipPremiseHolds, which writes detail.
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
  const after = runBothOwners()
  const afterOk = !after.d.failed && !after.d2.failed
  results.push({
    id: 'H3',
    title: 'the tree is restored and controls D and D2 are each green again',
    passed: afterOk,
    detail: afterOk
      ? 'D green and D2 green after restore'
      : `still failing after restore -- D exit ${after.d.status}, D2 exit ${after.d2.status}`,
  })

  for (const entry of results) {
    log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
    log(`        ${entry.detail}`)
  }

  return { ok: results.every((entry) => entry.passed), results }
}
