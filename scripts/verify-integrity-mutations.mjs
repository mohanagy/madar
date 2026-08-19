#!/usr/bin/env node
/**
 * Mutation verification for the #658 graph-integrity contracts.
 *
 * Each mutant breaks one invariant in production code and must turn its focused
 * suite RED. A mutant that leaves the suite green is UNCAUGHT: the test naming
 * that invariant is vacuous.
 *
 * This lives in the repository rather than a scratchpad because evidence that
 * cannot be reproduced from a clean checkout is not evidence. The independent
 * Stage 2 review made exactly that point.
 *
 * Scoring is deliberately strict. A mutant counts as caught only when the suite
 * actually ran and reported real test failures. Every other outcome -- a stale
 * anchor, a replacement that changed nothing, a missing test file, a worker
 * startup failure, any non-test crash -- is SKIPPED, never caught. An earlier
 * harness used `grep -F` to check anchors, which matches ANY SINGLE LINE of a
 * multi-line pattern; a stale anchor passed, the replacement silently failed,
 * the suite ran on unmutated source and was scored UNCAUGHT. The
 * did-the-file-actually-change check below exists because of that.
 *
 * Usage:  node scripts/verify-integrity-mutations.mjs [--filter <substring>]
 * Exit 0 only when caught > 0, uncaught === 0 and skipped === 0.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const CONTRACTS = 'src/contracts/graph-integrity.ts'
const SESSION = 'src/contracts/graph-integrity-session.ts'
const BUILD = 'src/pipeline/build.ts'
const GRAPH = 'src/contracts/graph.ts'
const SNAPSHOT_SRC = 'src/contracts/graph-integrity-snapshot.ts'

const SHARE_SAFETY = 'tests/unit/integrity-record-share-safety.test.ts'
const ACCOUNTING = 'tests/unit/normalized-candidate-accounting.test.ts'
const CONTRACT_TESTS = 'tests/unit/graph-integrity-contracts.test.ts'
const RECEIPT_TESTS = 'tests/unit/graph-integrity-receipt.test.ts'
const SNAPSHOT = 'tests/unit/integrity-snapshot.test.ts'
const TARGET_POLICY = 'tests/unit/verification-target-policy.test.ts'

/**
 * Every mutant names the file it breaks and the ONE focused suite expected to
 * catch it, so a green result cannot come from some unrelated suite.
 */
/**
 * Deliberately NOT mutated, because they are equivalent by construction and a
 * green result would be a false negative rather than evidence:
 *
 * - the narrowed catch in `sanitizedPathLike`. `normalizeIdentityRepositoryPath`
 *   throws only `SemanticIdentityInvariantError`, so narrowing is behaviourally
 *   identical today and is forward-looking defence against a future signature
 *   change. It is kept because the review asked for it, not because a test can
 *   currently distinguish it.
 * - the retained-draft memory bound, whose presence or absence produces the same
 *   record cap and the same exact distinct total.
 */
const MUTANTS = [
  {
    name: 'B1: stop refusing root-derived endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (isRootDerivedIdentifier(normalized, flattenedRoot)) return undefined',
    to: '',
  },
  {
    name: 'B1: match the root anywhere instead of at a segment boundary',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return lower.startsWith(`${flattenedRoot}_`)',
    to: '  return lower.includes(flattenedRoot)',
  },
  {
    name: 'B1: key identity on the redacted projection',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '      ...(draft.source !== undefined ? { source: draft.source } : {}),',
    to: '      ...(source !== undefined ? { source } : {}),',
  },
  {
    name: 'B2: accept percent-encoded separators in endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (PERCENT_ESCAPE.test(normalized)) return undefined',
    to: '',
  },
  {
    name: 'B2: accept Unicode separator look-alikes in endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (SEPARATOR_LOOKALIKES.test(normalized)) return undefined',
    to: '',
  },
  {
    name: 'B2: skip NFC normalization',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: "  const normalized = value.normalize('NFC')",
    to: '  const normalized = value',
  },
  {
    name: 'B2: accept traversal-only endpoint values',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (TRAVERSAL_ONLY.test(normalized)) return undefined',
    to: '',
  },
  {
    // Renamed: this resets one retention object. It does NOT reconstruct from
    // the bounded array, which was the actual B3 defect -- the two mutants
    // below do that.
    name: 'B3: reset occurrence retention during multiplicity finalization',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return Object.freeze({ ...record, multiplicity }) as unknown as T',
    to: '  return Object.freeze({ ...record, multiplicity, occurrenceRetention: detailRetention(0, 0) }) as unknown as T',
  },
  {
    // The real B3 shape: rebuild the record from its already-bounded detail, so
    // 50 occurrences capped to 16 report a total of 16 instead of 50.
    name: 'B3: rebuild occurrence retention from the bounded array',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return Object.freeze({ ...record, multiplicity }) as unknown as T',
    to: `  return Object.freeze({
    ...record,
    multiplicity,
    ...('occurrences' in record
      ? { occurrenceRetention: detailRetention(record.occurrences.length, record.occurrences.length) }
      : {}),
  }) as unknown as T`,
  },
  {
    name: 'B3: digest only the retained fingerprint slice',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '      candidate_fingerprints: orderedCanonicalArray(complete),',
    to: '      candidate_fingerprints: orderedCanonicalArray(complete.slice(0, MAX_CONFLICT_FINGERPRINTS)),',
  },
  {
    name: 'R2: drop per-kind record retention',
    file: SESSION,
    test: SNAPSHOT,
    from: '        unresolved: detailRetention(unresolvedRecords.length, this.unresolvedRetained.distinctTotal),',
    to: '        unresolved: detailRetention(unresolvedRecords.length, unresolvedRecords.length),',
  },
  {
    name: 'R2: skip nested retention validation at finalize',
    file: SNAPSHOT_SRC,
    test: SNAPSHOT,
    from: '    assertRecordRetention(record, `record ${record.id}`)',
    to: '',
  },
  {
    name: 'R2: accept an inconsistent omitted count',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  if (retention.omitted !== retention.total - retention.retained) {',
    to: '  if (false) {',
  },
  {
    name: 'R2: accept a false truncated flag',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  if (retention.truncated !== retention.omitted > 0) {',
    to: '  if (false) {',
  },
  {
    name: 'R3: never finalize the composite snapshot',
    file: GRAPH,
    test: SNAPSHOT,
    from: '    this.integritySnapshot = finalizeNormalizedIntegritySnapshot({',
    to: '    this.integritySnapshot = (null as never) && finalizeNormalizedIntegritySnapshot({',
  },
  {
    name: 'R3: keep a stale snapshot after later graph mutation',
    file: GRAPH,
    test: SNAPSHOT,
    from: '      this.integritySnapshot = null\n    }',
    to: '    }',
  },
  {
    name: 'R3: let a subgraph inherit the full-graph snapshot',
    file: GRAPH,
    test: SNAPSHOT,
    from: '    copied.integritySnapshot = isFullCopy ? this.integritySnapshot : null',
    to: '    copied.integritySnapshot = this.integritySnapshot',
  },
  {
    name: 'R1: stop rejecting scheme forms in verification targets',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '    return null\n  }\n\n  const segments = candidate.split',
    to: '    void 0\n  }\n\n  const segments = candidate.split',
  },
  {
    name: 'R1: use startsWith(..) instead of a segment test',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '  return segments.includes(\'..\')',
    to: '  return segments.join(\'/\').startsWith(\'..\')',
  },
  {
    name: 'R1: stop bounding verification-target length',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: 'export const MAX_VERIFICATION_TARGET_LENGTH = 512 as const',
    to: 'export const MAX_VERIFICATION_TARGET_LENGTH = 1_000_000 as const',
  },
  {
    name: 'R1: accept control characters in verification targets',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '  if (/[\\u0000-\\u001f\\u007f-\\u009f]/.test(normalized)) return null\n  if (/%[0-9A-Fa-f]{2}/.test(normalized)) return null',
    to: '  if (/%[0-9A-Fa-f]{2}/.test(normalized)) return null',
  },
  {
    name: 'B4: count scope failures after sanitization',
    file: SESSION,
    test: SHARE_SAFETY,
    from: '    const submittedScopeFailures = this.scopeFailureSet.size',
    to: '    const submittedScopeFailures = [...this.scopeFailureSet].filter((s) => safeScopeName(s) !== null).length',
  },
  {
    name: 'accounting: default buildFromJson to attached accounting',
    file: BUILD,
    test: ACCOUNTING,
    from: "  const session = options.accounting === 'normalized_extraction_boundary'",
    to: '  const session = options.accounting !== undefined || true',
  },
  {
    name: 'accounting: never attach the finalized result',
    file: BUILD,
    test: ACCOUNTING,
    from: '  if (session !== null) graph.attachNormalizedAccounting(session.finalize())',
    to: '',
  },
  {
    name: 'accounting: restore the silent missing-endpoint continue',
    file: BUILD,
    test: ACCOUNTING,
    from: '      session?.dispose(fingerprint, unresolvedEndpoint({',
    to: '      if (true) continue\n      session?.dispose(fingerprint, unresolvedEndpoint({',
  },
  {
    name: 'equation: stop comparing the terminal totals',
    file: CONTRACTS,
    test: CONTRACT_TESTS,
    from: '  if (total !== emittedCandidates) {',
    to: '  if (false) {',
  },
  {
    name: 'equation: drop safe-integer validation',
    file: CONTRACTS,
    from: 'function assertCount(value: number, field: string): number {\n  if (!Number.isSafeInteger(value) || value < 0) {',
    test: CONTRACT_TESTS,
    to: 'function assertCount(value: number, field: string): number {\n  if (false) {',
  },
  {
    name: 'cap: retain the first K encountered instead of the smallest ids',
    file: SESSION,
    test: ACCOUNTING,
    from: '    if (largest === null || id >= largest) return',
    to: '    return',
  },
  {
    name: 'cap: stop tracking distinct ids exactly',
    file: SESSION,
    test: ACCOUNTING,
    from: '    this.seenIds.add(id)',
    to: '',
  },
  {
    name: 'receipt: stop re-deriving status on load',
    file: 'src/contracts/graph-integrity-receipt.ts',
    test: RECEIPT_TESTS,
    from: '  if (derived.status !== receipt.status) {',
    to: '  if (false) {',
  },
  {
    name: 'graph: let a rebuilt graph launder accounting away',
    file: GRAPH,
    test: ACCOUNTING,
    from: '      this.normalizedAccounting = source.normalizedAccounting',
    to: '',
  },
]

const filterArg = process.argv.indexOf('--filter')
const filter = filterArg >= 0 ? process.argv[filterArg + 1] : null
const selected = filter === null ? MUTANTS : MUTANTS.filter((m) => m.name.includes(filter))

const digest = (path) => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')

let caught = 0
let uncaught = 0
let skipped = 0
const originals = new Map()

function restore() {
  for (const [path, text] of originals) writeFileSync(resolve(ROOT, path), text)
}
process.on('exit', restore)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { restore(); process.exit(130) })
}

function report(kind, name, detail) {
  const label = kind.padEnd(8)
  console.log(`  ${label} ${name.padEnd(58)} ${detail}`)
  if (kind === 'caught') caught += 1
  else if (kind === 'UNCAUGHT') uncaught += 1
  else skipped += 1
}

console.log(`#658 integrity mutation controls (${selected.length} mutants)\n`)

for (const mutant of selected) {
  const filePath = resolve(ROOT, mutant.file)
  const testPath = resolve(ROOT, mutant.test)

  if (!existsSync(filePath)) { report('SKIPPED', mutant.name, `missing source ${mutant.file}`); continue }
  if (!existsSync(testPath)) { report('SKIPPED', mutant.name, `missing test ${mutant.test}`); continue }

  if (!originals.has(mutant.file)) originals.set(mutant.file, readFileSync(filePath, 'utf8'))
  restore()

  const before = digest(mutant.file)
  const source = readFileSync(filePath, 'utf8')
  if (!source.includes(mutant.from)) { report('SKIPPED', mutant.name, 'anchor not found'); continue }
  writeFileSync(filePath, source.replace(mutant.from, mutant.to))
  if (digest(mutant.file) === before) { report('SKIPPED', mutant.name, 'mutation changed nothing'); continue }

  let output = ''
  try {
    output = execFileSync('npx', ['vitest', 'run', mutant.test], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  } finally {
    restore()
  }

  // A worker startup failure is a host problem, never evidence about a mutant.
  if (/Failed to start forks worker|Timeout waiting for worker to respond/.test(output)) {
    report('SKIPPED', mutant.name, 'worker startup failure'); continue
  }
  const failed = /Tests\s+(\d+)\s+failed/.exec(output)
  if (failed !== null) { report('caught', mutant.name, `${failed[1]} test(s) failed`); continue }
  if (/Tests\s+\d+\s+passed/.test(output)) { report('UNCAUGHT', mutant.name, 'suite stayed green'); continue }
  report('SKIPPED', mutant.name, 'suite did not run cleanly')
}

restore()
console.log(`\ncaught=${caught} uncaught=${uncaught} skipped=${skipped}`)
const ok = caught > 0 && uncaught === 0 && skipped === 0
console.log(ok ? 'MUTATION CONTROLS PASS' : 'MUTATION CONTROLS FAIL')
process.exit(ok ? 0 : 1)
