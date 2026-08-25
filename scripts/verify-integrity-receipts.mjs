#!/usr/bin/env node
/**
 * Reproducible corpus, privacy and performance receipts for the #658
 * normalized candidate accounting boundary.
 *
 * The independent review reconstructed different corpus counts than the ones a
 * checkpoint reported, because the checkpoint published numbers without a
 * committed command, inventory, or checksum. Evidence that cannot be
 * regenerated from a clean checkout is not evidence, so this runner lives in
 * the repository and records everything needed to reproduce or refute it.
 *
 * Read-only: it reads source files and builds graphs in memory. It writes only
 * the receipt file it is asked to write.
 *
 * Usage:
 *   node scripts/verify-integrity-receipts.mjs [--out <path>] [--baseline <builtCheckout>]
 *
 * `--baseline` points at another built checkout of this repository; when given,
 * the runner measures both heads on identical input and reports the ratio.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { carryForwardSupersededEstimates } from './lib/receipt-estimate-history.mjs'
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import {
  ARM_ENVELOPE_VERSION,
  assertArmResult,
  buildArmDescriptor,
  assertCleanTree,
  assertDistinctArms,
  assertFreshBuild,
  partitionSessions,
  resolveExactCommit,
} from './lib/receipt-guards.mjs'
import { runChild, runChildOrThrow } from './lib/child-runner.mjs'
import {
  createResourceRegistry,
  directoryCleanup,
  installSignalCoordinator,
  worktreeCleanup,
} from './lib/resource-registry.mjs'

// One owner for every temporary resource this run creates, and exactly one
// signal coordinator above it. No helper below installs its own.
const REGISTRY = createResourceRegistry({
  onWarning: (message) => console.error(`warning: ${message}`),
})
installSignalCoordinator(REGISTRY, {
  onWarning: (message) => console.error(`warning: ${message}`),
})

/**
 * Refuses to begin a new phase once shutdown has started.
 *
 * Terminating in-flight work is not enough on its own: without this, the next
 * phase would start immediately after the previous one was killed, and the run
 * would keep making progress while the coordinator was tearing it down.
 */
function assertPhaseAdmitted(phase) {
  if (!REGISTRY.acceptingWork) {
    throw new Error(`refusing to begin "${phase}": shutdown has begun`)
  }
}

/** Long-running children get a bounded timeout; none may hold the run open. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const ARM_TIMEOUT_MS = 10 * 60 * 1000

const ROOT = process.cwd()
const args = process.argv.slice(2)
const argOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}
const OUT = argOf('--out')
const BASELINE = argOf('--baseline')
const BASELINE_REF = argOf('--baseline-ref')
// Lets the tool audit any historical pair, including one that predates the
// tool. Without it a past comparison could only be re-run by the very head
// being audited, which is what made the previous claim unverifiable.
const CANDIDATE_REF = argOf('--candidate-ref')
// Corpus receipts alone are a legitimate product, but they are not a
// qualification: the review found a receipt generated with no baseline being
// read as one. Saying which you want is now mandatory.
const CORPUS_ONLY = args.includes('--corpus-only')
const RUNS = Number(argOf('--runs') ?? 5)

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// One nonce per receipt run. An arm result carrying a different nonce belongs to
// another invocation and is refused rather than measured.
const RUN_NONCE = randomUUID()
const EXTRACTION_MODE = 'legacy'

/**
 * Bounded local metadata probe, deliberately synchronous.
 *
 * `git rev-parse` and friends return in milliseconds and cannot hold a live
 * child across the signal contract. Only children that can block materially --
 * installs, builds, measurement arms -- are asynchronous and registered.
 */
function git(...rest) {
  try {
    return execFileSync('git', rest, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unavailable'
  }
}

/** JS/TS sources, and everything the detector would classify, kept separate. */
const JS_TS = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo', '.cache'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/**
 * Corpus scope is what files were read. Extraction mode is how they were read.
 * The review found these conflated, which is how one run's "mode" label ended
 * up describing another run's breadth.
 */
const SCOPES = {
  'src-only': { dirs: ['src'], filter: (path) => JS_TS.test(path) },
  'src-plus-tests-js-ts': { dirs: ['src', 'tests'], filter: (path) => JS_TS.test(path) },
}

function inventory(scope) {
  const spec = SCOPES[scope]
  const files = spec.dirs
    .flatMap((dir) => walk(resolve(ROOT, dir)))
    .filter(spec.filter)
    .sort()
  // Checksum over repository-relative paths AND content, so the same file list
  // with different content is a different inventory.
  const digest = sha256(files.map((path) => `${relative(ROOT, path)}:${sha256(readFileSync(path))}`).join('\n'))
  return { files, count: files.length, checksum: digest }
}

async function loadPipeline(dir) {
  const base = `${dir}/dist/src`
  const [{ extract }, { buildFromJson }] = await Promise.all([
    import(`${base}/pipeline/extract.js`),
    import(`${base}/pipeline/build.js`),
  ])
  return { extract, buildFromJson }
}

const FLAT_ROOT = ROOT.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()

/**
 * Detects values that must never appear in a share-safe record.
 *
 * Kept deliberately dumb and independent of the sanitizers it audits: if it
 * reused their logic, a sanitizer bug would hide itself.
 */
function scanHazards(accounting) {
  const hazards = []
  const unsafe = (value) => typeof value === 'string' && (
    value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.includes('mohammednaji')
    || value.toLowerCase() === FLAT_ROOT
    || value.toLowerCase().startsWith(`${FLAT_ROOT}_`)
  )
  for (const record of accounting.unresolvedRecords) {
    for (const value of [record.source, record.target, record.relation]) {
      if (unsafe(value)) hazards.push(value)
    }
    for (const target of record.verificationTargets) if (unsafe(target.file)) hazards.push(target.file)
  }
  for (const record of accounting.rejectedRecords) {
    for (const value of Object.values(record.sanitizedCandidate)) if (unsafe(value)) hazards.push(value)
  }
  for (const failure of accounting.scopeFailures) if (unsafe(failure)) hazards.push(failure)
  return hazards
}

/** The control: planted hazards the scanner must detect, or its zeros are vacuous. */
function scannerControl() {
  const planted = {
    unresolvedRecords: [{
      source: '/Users/planted/secret.ts',
      target: `${FLAT_ROOT}_src_b`,
      relation: 'calls',
      verificationTargets: [{ file: 'C:\\planted\\secret.ts' }],
    }],
    rejectedRecords: [{ sanitizedCandidate: { source: '\\\\server\\share\\planted.ts' } }],
    scopeFailures: ['/Users/planted/scope.ts'],
  }
  const detected = scanHazards(planted)
  return { planted: 5, detected: detected.length, passes: detected.length === 5 }
}


/**
 * Builds an exact baseline ref in a throwaway worktree.
 *
 * The previous runner could only be pointed at a checkout somebody had already
 * prepared by hand, so the published comparison was not reproducible from a
 * clean tree -- and the receipt it produced recorded a revision that was not
 * the one being claimed. Resolving the ref here means the command itself is the
 * evidence.
 */
async function withBaselineWorktree(ref, run) {
  assertPhaseAdmitted('baseline worktree')
  const resolved = resolveExactCommit(ROOT, ref)
  assertCleanTree(ROOT)

  const dir = mkdtempSync(join(tmpdir(), 'madar-baseline-'))
  // Registered with the single owner before any work, so an interrupt at any
  // point cleans this up along with everything else -- including resources
  // owned by callers further out, which per-helper handlers could not reach.
  const token = REGISTRY.register(`worktree ${ref} at ${dir}`, worktreeCleanup(ROOT, dir))

  try {
    await runChildOrThrow('git', ['worktree', 'add', '--detach', dir, resolved], {
      cwd: ROOT, registry: REGISTRY, description: `git worktree add ${resolved}`, timeoutMs: BUILD_TIMEOUT_MS,
    })
    // The pinned lockfile and toolchain, not whatever happens to be installed.
    // Asynchronous so a signal arriving mid-install is actually serviced: a
    // synchronous child blocks the event loop and no handler can run at all.
    for (const step of [['ci'], ['run', 'build']]) {
      assertPhaseAdmitted(`npm ${step.join(' ')}`)
      try {
        await runChildOrThrow('npm', step, {
          cwd: dir,
          registry: REGISTRY,
          description: `npm ${step.join(' ')} at ${resolved}`,
          timeoutMs: BUILD_TIMEOUT_MS,
        })
      } catch (error) {
        throw new Error(`baseline "npm ${step.join(' ')}" failed at ${resolved}:\n${error.message}`)
      }
    }
    assertFreshBuild(dir, resolved)
    // Awaited inside the try, not returned from it: returning the promise
    // would let the finally below delete the worktree while the measurement
    // that depends on it was still running.
    return await run({ dir, sha: resolved })
  } finally {
    REGISTRY.release(token)
  }
}

/**
 * One canonical normalized input, produced once by a declared authority and
 * handed byte-identically to both arms.
 *
 * Letting each arm extract its own input and then calling the result a build
 * comparison measures two different extractions as if they were one.
 */
function inputAuthority(files) {
  return { extractedBy: 'candidate head', files }
}

async function measure(dir, scope, files, runs, sharedInput = null) {
  const { extract, buildFromJson } = await loadPipeline(dir)
  const raw = sharedInput ?? extract(files)
  const inputChecksum = sha256(JSON.stringify(raw))
  const durations = []
  let graph = null
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint()
    graph = buildFromJson(raw, {
      directed: true,
      accounting: 'normalized_extraction_boundary',
      repositoryRoot: ROOT,
    })
    durations.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  const sorted = [...durations].sort((left, right) => left - right)
  return {
    scope,
    rawEdges: Array.isArray(raw.edges) ? raw.edges.length : 0,
    inputChecksum,
    samples: durations.map((value) => Number(value.toFixed(1))),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
    minMs: Number(sorted[0].toFixed(1)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    spreadMs: Number((sorted[sorted.length - 1] - sorted[0]).toFixed(1)),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    graph,
  }
}

function receiptFor(scope, files, checksum, measured) {
  const { graph } = measured
  const accounting = graph.normalizedAccountingSummary()
  const snapshot = graph.normalizedIntegritySnapshot()
  const terminalSum = Object.values(accounting.counts).reduce((total, value) => total + value, 0)
  const hazards = scanHazards(accounting)
  return {
    corpus_scope: scope,
    extraction_mode: 'legacy',
    command: 'extract(files) -> buildFromJson(accounting: normalized_extraction_boundary)',
    file_count: files.length,
    inventory_checksum: checksum,
    extraction_input_checksum: measured.inputChecksum,
    cache_state: 'no extractor cache used; extract() called directly on the inventory',
    raw_normalized_edges: measured.rawEdges,
    emitted_candidates: accounting.emittedCandidates,
    terminal_counts: accounting.counts,
    terminal_sum: terminalSum,
    equation_balances: terminalSum === accounting.emittedCandidates,
    facts: graph.numberOfFacts(),
    occurrences: graph.numberOfOccurrences(),
    endpoint_pairs: graph.numberOfEndpointPairs(),
    record_retention: accounting.recordRetention,
    scope_failure_retention: accounting.scopeFailureRetention,
    verification_targets: accounting.unresolvedRecords
      .reduce((total, record) => total + record.verificationTargets.length, 0),
    share_safety_hazards: hazards.length,
    hazard_examples: hazards.slice(0, 3),
    finalized_snapshot: snapshot === null ? 'ABSENT' : `attached, status=${snapshot.status}`,
    build_median_ms: measured.medianMs,
    build_samples_ms: measured.samples,
    build_spread_ms: measured.spreadMs,
  }
}


// One arm, in its own process. Arms must never share a process: a JIT warmed by
// the first arm makes the second look faster for reasons that have nothing to
// do with either head.
const MEASURE_ARM = argOf('--measure-arm')
if (MEASURE_ARM !== null) {
  const scope = argOf('--scope')
  const inputPath = argOf('--input')
  const shared = JSON.parse(readFileSync(inputPath, 'utf8'))
  const measured = await measure(MEASURE_ARM, scope, [], RUNS, shared)
  const accounting = measured.graph.normalizedAccountingSummary()
  // The child does not invent identity. It copies the parent's descriptor
  // verbatim and adds only what it actually measured.
  const DESCRIPTOR_FILE = argOf('--descriptor-file')
  if (DESCRIPTOR_FILE === null) {
    console.error('arm invoked without --descriptor-file; refusing to publish an unbound result')
    process.exit(2)
  }
  const descriptor = JSON.parse(readFileSync(DESCRIPTOR_FILE, 'utf8'))
  const payload = {
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
    sampleContract: descriptor.sampleContract,
    measurements: {
      samples: measured.samples,
      medianMs: measured.medianMs,
      minMs: measured.minMs,
      maxMs: measured.maxMs,
      spreadMs: measured.spreadMs,
      peakRssMb: measured.peakRssMb,
    },
  }
  // The parent independently derived the candidate count; a disagreement here
  // is the child's problem, not something to paper over in the envelope.
  if (accounting.emittedCandidates !== descriptor.candidateCount) {
    console.error(`arm measured ${accounting.emittedCandidates} candidates, parent expected ${descriptor.candidateCount}`)
    process.exit(3)
  }
  const serialized = JSON.stringify(payload)

  // Result transport is a file, not stdout.
  //
  // stdout is inherited by descendants and can be interleaved or truncated; a
  // reviewer saw a complete-looking payload on a pipe that the wrapper could
  // never finish reading. Written to a temp file, fsynced, then atomically
  // renamed, so a reader observes either nothing or the whole result.
  const RESULT_FILE = argOf('--result-file')
  if (RESULT_FILE !== null) {
    const temporary = `${RESULT_FILE}.tmp-${process.pid}`
    const handle = openSync(temporary, 'w')
    try {
      writeSync(handle, serialized)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, RESULT_FILE)
  }
  // Retained for diagnostics only; never parsed as the result.
  console.log(serialized)
  process.exit(0)
}

// Argument validation happens HERE, before any measurement.
//
// It used to sit after the corpus receipts were built, so `node
// verify-integrity-receipts.mjs` with no arguments spent ~60 seconds
// constructing graphs before discovering it had never been asked for a
// comparison. The focused control that proves this refusal paid that cost on
// every mutant invocation, which is what pushed six exact-ref rows to ~250s
// against a 300s bound and timed two of them out in an independent matrix.
//
// Placed after the `--measure-arm` branch deliberately: an arm subprocess is
// invoked without a baseline ref by design and must not be refused.
if (BASELINE_REF === null && BASELINE === null && !CORPUS_ONLY) {
  console.error(
    'refusing to produce a receipt with no comparison.\n'
    + '  --baseline-ref <sha>   reproducible exact-head qualification (required for qualification)\n'
    + '  --corpus-only          current-head corpus receipts only, explicitly not a qualification',
  )
  process.exit(2)
}

const control = scannerControl()

const receipts = []
for (const scope of Object.keys(SCOPES)) {
  const { files, count, checksum } = inventory(scope)
  const measured = await measure(ROOT, scope, files, RUNS)
  receipts.push({ ...receiptFor(scope, files, checksum, measured), file_count: count })
}

/**
 * Runs one arm in its own child process and returns its parsed measurement.
 *
 * Asynchronous for the same reason the builds are: an arm can run for minutes,
 * and a signal during one must be able to terminate it rather than wait for it.
 */
let armSequence = 0

async function runArm(dir, scope, inputPath, expectation) {
  assertPhaseAdmitted(`arm ${scope}`)
  const armIdentity = `${RUN_NONCE}:${scope}:${armSequence += 1}`
  const workspace = mkdtempSync(join(tmpdir(), 'madar-arm-'))
  // Run-specific AND arm-specific, so no two arms can ever share a path.
  const resultFile = join(workspace, `${armIdentity.replace(/[^A-Za-z0-9]+/g, '-')}.json`)
  const descriptorFile = join(workspace, 'descriptor.json')
  const token = REGISTRY.register(`arm workspace ${armIdentity}`, () => {
    rmSync(workspace, { recursive: true, force: true })
  })
  try {
    const descriptor = buildArmDescriptor({ ...expectation, armIdentity, revision: expectation.revision })
    writeFileSync(descriptorFile, JSON.stringify(descriptor))
    // Nothing may pre-exist at the final path.
    if (existsSync(resultFile)) throw new Error(`arm ${armIdentity}: a result already existed before the arm ran`)

    const result = await runChildOrThrow(process.execPath, [
      resolve(ROOT, 'scripts/verify-integrity-receipts.mjs'),
      '--measure-arm', dir, '--scope', scope, '--input', inputPath, '--runs', String(RUNS),
      '--result-file', resultFile, '--descriptor-file', descriptorFile,
    ], {
      cwd: ROOT,
      registry: REGISTRY,
      description: `arm ${scope} at ${dir}`,
      timeoutMs: ARM_TIMEOUT_MS,
    })
    // A completed process is necessary and not sufficient.
    if (!existsSync(resultFile)) {
      throw new Error(`arm ${armIdentity} exited ${result.code} without writing a result file`)
    }
    // Read once, then confirm the bytes did not change underneath us.
    const bytes = readFileSync(resultFile)
    const digest = sha256(bytes)
    if (sha256(readFileSync(resultFile)) !== digest) {
      throw new Error(`arm ${armIdentity}: result changed while being read`)
    }
    let parsed
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      throw new Error(`arm ${armIdentity} wrote an unreadable result: ${error.message}`)
    }
    const envelope = assertArmResult(parsed, descriptor, { where: `arm ${armIdentity}` })
    // Flattened for the existing session comparators, which read these names.
    return {
      scope: envelope.corpusScope,
      inputChecksum: envelope.inputChecksum,
      emittedCandidates: envelope.candidateCount,
      ...envelope.measurements,
    }
  } finally {
    REGISTRY.release(token)
  }
}

async function comparePerformance(baselineDir, baselineSha, candidateDir = ROOT, candidateSha = null) {
  assertPhaseAdmitted('measurement arms')
  // Comparing a commit with itself is not a comparison.
  assertDistinctArms(baselineSha, candidateSha ?? git('rev-parse', 'HEAD'))
  const comparisons = []
  const invalidated = []
  for (const scope of Object.keys(SCOPES)) {
    const { files, checksum } = inventory(scope)
    // Extracted once, by a declared authority, and handed byte-identically to
    // both arms. Letting each arm extract its own input measures two different
    // extractions and calls the difference a build comparison.
    // The declared authority is the candidate arm's extractor.
    assertPhaseAdmitted('input extraction')
    const { extract } = await loadPipeline(candidateDir)
    const shared = extract(files)
    const authority = inputAuthority(files)
    const inputDir = mkdtempSync(join(tmpdir(), 'madar-input-'))
    const inputToken = REGISTRY.register(`shared input at ${inputDir}`, directoryCleanup(inputDir))
    let sessions
    let inputChecksum
    try {
      const inputPath = join(inputDir, 'extraction.json')
      const serializedInput = JSON.stringify(shared)
      writeFileSync(inputPath, serializedInput)
      inputChecksum = sha256(readFileSync(inputPath))
      // The arm hashes `JSON.stringify(parsed)`, so the expectation is computed
      // the same way rather than assuming a round-trip is byte-identical.
      const armInputChecksum = sha256(serializedInput)

      // Candidate count is derived HERE, by the parent, from the canonical
      // input it owns. Deriving it from an arm result would mean comparing one
      // untrusted child field against another.
      assertPhaseAdmitted(`candidate authority ${scope}`)
      const authorityRun = await measure(ROOT, scope, [], 1, shared)
      const expectedCandidates = authorityRun.graph.normalizedAccountingSummary().emittedCandidates

      const expectationFor = (revision) => ({
        runNonce: RUN_NONCE,
        revision,
        mode: EXTRACTION_MODE,
        corpusScope: scope,
        inputChecksum: armInputChecksum,
        inventoryChecksum: checksum,
        fileCount: files.length,
        candidateCount: expectedCandidates,
        sampleCount: RUNS,
      })
      const baselineExpectation = expectationFor(baselineSha)
      const candidateExpectation = expectationFor(candidateSha ?? git('rev-parse', 'HEAD'))

      // Two sessions with opposite starting arms, so ordering cannot favour
      // either head.
      // Sequential and counterbalanced: never concurrent, because two arms
      // sharing a machine measure contention rather than code.
      const baselineFirstBase = await runArm(baselineDir, scope, inputPath, baselineExpectation)
      const baselineFirstHead = await runArm(candidateDir, scope, inputPath, candidateExpectation)
      const candidateFirstHead = await runArm(candidateDir, scope, inputPath, candidateExpectation)
      const candidateFirstBase = await runArm(baselineDir, scope, inputPath, baselineExpectation)
      sessions = [
        { order: 'baseline-first', base: baselineFirstBase, head: baselineFirstHead },
        { order: 'candidate-first', head: candidateFirstHead, base: candidateFirstBase },
      ]
    } finally {
      // A throwing arm previously skipped this line entirely, because it was
      // not in a finally.
      REGISTRY.release(inputToken)
    }

    const partitioned = partitionSessions(sessions, scope)
    invalidated.push(...partitioned.invalidated)
    const usable = partitioned.usable
    if (usable.length === 0) {
      comparisons.push({ corpus_scope: scope, gate: 'NOT ESTABLISHED', reason: 'no session had identical input' })
      continue
    }

    // One estimator, and it aggregates PAIRS.
    //
    // `Math.min` used to be applied to the two arms independently, so the
    // baseline minimum could be taken from one order and the candidate minimum
    // from the other -- a comparison no session ever produced. On
    // `src-plus-tests-js-ts` that published 943.3 against 941.9 for a ratio of
    // 0.999, while the two sessions actually measured 1.029 and 0.946. Mixing
    // order conditions is precisely what counterbalancing exists to prevent,
    // and taking the best of each arm biases the result toward whichever arm
    // happened to get the luckiest run.
    //
    // Each session is now reduced to its own candidate/baseline ratio first,
    // and those ratios are aggregated. The aggregate is the geometric mean
    // because a ratio estimator must be symmetric: swapping baseline and
    // candidate has to invert the result exactly, which an arithmetic mean of
    // ratios does not do.
    const sessionRatios = usable.map((session) => ({
      order: session.order,
      wall: session.head.medianMs / session.base.medianMs,
      rss: session.head.peakRssMb / session.base.peakRssMb,
    }))
    const geometricMean = (values) => Math.exp(
      values.reduce((total, value) => total + Math.log(value), 0) / values.length,
    )
    // Reported per arm as the same aggregate, so the published medians and the
    // published ratio describe one estimator rather than two. This is exact,
    // not approximate: geomean(head)/geomean(base) === geomean(head/base).
    const baseMedian = Number(geometricMean(usable.map((s) => s.base.medianMs)).toFixed(1))
    const headMedian = Number(geometricMean(usable.map((s) => s.head.medianMs)).toFixed(1))
    const ratio = Number(geometricMean(sessionRatios.map((s) => s.wall)).toFixed(3))
    const rssRatio = Number(geometricMean(sessionRatios.map((s) => s.rss)).toFixed(3))
    comparisons.push({
      corpus_scope: scope,
      extraction_mode: 'legacy',
      input_authority: candidateSha ?? authority.extractedBy,
      input_files: files.length,
      inventory_checksum: checksum,
      canonical_input_checksum: inputChecksum,
      identical_input: true,
      cache_state: 'no extractor cache; one extraction shared by both arms',
      baseline_sha: baselineSha,
      candidate_sha: candidateSha ?? git('rev-parse', 'HEAD'),
      sessions: usable.map((session) => ({
        order: session.order,
        baseline: {
          samples: session.base.samples, medianMs: session.base.medianMs, spreadMs: session.base.spreadMs,
          peakRssMb: session.base.peakRssMb, emittedCandidates: session.base.emittedCandidates,
        },
        candidate: {
          samples: session.head.samples, medianMs: session.head.medianMs, spreadMs: session.head.spreadMs,
          peakRssMb: session.head.peakRssMb, emittedCandidates: session.head.emittedCandidates,
        },
      })),
      baseline_median_ms: baseMedian,
      candidate_median_ms: headMedian,
      // The raw per-session ratios are retained, never only the aggregate: an
      // aggregate that hides two disagreeing sessions is how a mixed-order
      // number looked reasonable in the first place.
      estimator: 'geometric mean of per-session candidate/baseline ratios',
      session_ratios: sessionRatios.map((s) => ({
        order: s.order,
        wall_ratio: Number(s.wall.toFixed(3)),
        rss_ratio: Number(s.rss.toFixed(3)),
      })),
      ratio,
      rss_ratio: rssRatio,
      gate: ratio > 2 || rssRatio > 2 ? 'HUMAN_GATE' : 'within budget',
    })
  }
  return { baseline_revision: baselineSha, comparisons, invalidated_runs: invalidated }
}



let performance = {
  baseline: 'not supplied',
  qualifies: false,
  note: 'corpus-only run; not a qualification. Use --baseline-ref for an exact-head comparison.',
}
if (BASELINE_REF !== null) {
  performance = await withBaselineWorktree(BASELINE_REF, async (baseline) => (
    CANDIDATE_REF === null
      ? comparePerformance(baseline.dir, baseline.sha)
      : withBaselineWorktree(CANDIDATE_REF, async (candidate) => (
        comparePerformance(baseline.dir, baseline.sha, candidate.dir, candidate.sha)
      ))
  ))
} else if (BASELINE !== null) {
  // Lower-level debugging path: an already-built checkout, not reproducible on
  // its own, so it is labelled as such in the receipt.
  performance = {
    ...(await comparePerformance(resolve(BASELINE), git('-C', BASELINE, 'rev-parse', 'HEAD'))),
    reproducible: false,
    note: 'built from a manually prepared checkout; use --baseline-ref for qualification',
  }
}

const usage = process.resourceUsage()
const receipt = {
  repository_revision: git('rev-parse', 'HEAD'),
  repository_dirty: git('status', '--porcelain').length > 0,
  candidate_code_revision: git('rev-parse', 'HEAD'),
  node_version: process.version,
  npm_version: (() => {
    try {
      // Bounded metadata probe; see the note on git() above.
      return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
    } catch {
      return 'unavailable'
    }
  })(),
  lockfile_checksum: sha256(readFileSync(resolve(ROOT, 'package-lock.json'))),
  platform: `${process.platform}-${process.arch}`,
  supported_extraction_modes: {
    legacy: 'measured below',
    spi: 'not measured: the extraction handed to the normalized boundary in spi and auto modes is '
      + 'assembled inside generate() by unexported merge and node-precedence logic. Reproducing that '
      + 'assembly here would measure a reimplementation rather than production, so no spi receipt is '
      + 'fabricated. Measuring it requires exporting that assembly, which is out of scope for #658.',
    auto: 'not measured: same reason as spi.',
  },
  scanner_control: control,
  receipts,
  performance,
  // Node reports maxRSS in kilobytes on every platform it supports; verified
  // against process.memoryUsage().rss rather than assumed from the docs.
  peak_rss_mb: typeof usage.maxRSS === 'number' && usage.maxRSS > 0
    ? Math.round(usage.maxRSS / 1024)
    : 'unavailable: process.resourceUsage().maxRSS reported no value on this platform',
}

assertPhaseAdmitted('receipt write')
const rendered = JSON.stringify(receipt, null, 2)
if (OUT !== null) writeFileSync(resolve(ROOT, OUT), `${carryForwardSupersededEstimates(rendered, resolve(ROOT, OUT))}\n`)
console.log(rendered)

const balanced = receipts.every((entry) => entry.equation_balances)
const clean = receipts.every((entry) => entry.share_safety_hazards === 0)
const gated = performance.comparisons?.some((entry) => entry.gate === 'HUMAN_GATE') ?? false
const unestablished = performance.comparisons?.some((entry) => entry.gate === 'NOT ESTABLISHED') ?? false

console.log(`\nequation balances: ${balanced}`)
console.log(`share-safety hazards: ${clean ? 0 : 'PRESENT'}`)
console.log(`scanner control: ${control.passes ? 'PASSES' : 'FAILS'}`)
console.log(`focused performance: ${gated ? 'HUMAN_GATE' : unestablished ? 'NOT ESTABLISHED' : 'within budget'}`)

const ok = balanced && clean && control.passes && !gated && !unestablished
console.log(ok ? 'INTEGRITY RECEIPTS PASS' : 'INTEGRITY RECEIPTS FAIL')
process.exit(ok ? 0 : 1)
