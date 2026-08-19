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
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const argOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}
const OUT = argOf('--out')
const BASELINE = argOf('--baseline')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

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

async function measure(dir, scope, files, runs) {
  const { extract, buildFromJson } = await loadPipeline(dir)
  const raw = extract(files)
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
  durations.sort((left, right) => left - right)
  return {
    scope,
    rawEdges: Array.isArray(raw.edges) ? raw.edges.length : 0,
    inputChecksum,
    medianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(1)),
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
  }
}

const RUNS = 5
const control = scannerControl()

const receipts = []
for (const scope of Object.keys(SCOPES)) {
  const { files, count, checksum } = inventory(scope)
  const measured = await measure(ROOT, scope, files, RUNS)
  receipts.push({ ...receiptFor(scope, files, checksum, measured), file_count: count })
}

let performance = { baseline: 'not supplied', note: 'pass --baseline <builtCheckout> to compare heads' }
if (BASELINE !== null) {
  const comparisons = []
  for (const scope of Object.keys(SCOPES)) {
    const { files } = inventory(scope)
    // Identical inventory and identical input for both arms, freshly built
    // dists on each side, so the ratio measures code and not corpus.
    const base = await measure(resolve(BASELINE), scope, files, RUNS)
    const head = await measure(ROOT, scope, files, RUNS)
    const ratio = Number((head.medianMs / base.medianMs).toFixed(3))
    comparisons.push({
      corpus_scope: scope,
      identical_input: base.inputChecksum === head.inputChecksum,
      baseline_median_ms: base.medianMs,
      candidate_median_ms: head.medianMs,
      ratio,
      gate: ratio > 2 ? 'HUMAN_GATE' : 'within budget',
      baseline_candidates: base.graph.normalizedAccountingSummary().emittedCandidates,
      candidate_candidates: head.graph.normalizedAccountingSummary().emittedCandidates,
    })
  }
  performance = { baseline_revision: git('-C', BASELINE, 'rev-parse', 'HEAD'), comparisons }
}

const usage = process.resourceUsage()
const receipt = {
  repository_revision: git('rev-parse', 'HEAD'),
  repository_dirty: git('status', '--porcelain').length > 0,
  candidate_code_revision: git('rev-parse', 'HEAD'),
  node_version: process.version,
  npm_version: (() => {
    try {
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

const rendered = JSON.stringify(receipt, null, 2)
if (OUT !== null) writeFileSync(resolve(ROOT, OUT), `${rendered}\n`)
console.log(rendered)

const balanced = receipts.every((entry) => entry.equation_balances)
const clean = receipts.every((entry) => entry.share_safety_hazards === 0)
const gated = performance.comparisons?.some((entry) => entry.gate === 'HUMAN_GATE') ?? false

console.log(`\nequation balances: ${balanced}`)
console.log(`share-safety hazards: ${clean ? 0 : 'PRESENT'}`)
console.log(`scanner control: ${control.passes ? 'PASSES' : 'FAILS'}`)
console.log(`focused performance: ${gated ? 'HUMAN_GATE' : 'within budget'}`)

const ok = balanced && clean && control.passes && !gated
console.log(ok ? 'INTEGRITY RECEIPTS PASS' : 'INTEGRITY RECEIPTS FAIL')
process.exit(ok ? 0 : 1)
