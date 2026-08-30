/**
 * #660-A falsifiability harness for the structural grader boundary.
 *
 * A boundary check that has never been shown to fail is decorative. These
 * injections put a real grader dependency back into real production files and
 * require the guard to reject it with the exact reason, then put the bytes back
 * and prove they went back.
 *
 * Restoration is by byte snapshot, never by `git checkout`/`reset`/`clean`: the
 * worktree may legitimately carry other uncommitted work, and a git-based
 * "restore" would destroy it. Every snapshot records content AND mode, every
 * restore is verified by digest, and a file that cannot be restored is reported
 * loudly rather than left for a later run to discover as a mysterious failure.
 *
 * Runs standalone (never inside the vitest worker pool) because it mutates
 * source files on disk.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { analyzeGraderBoundary, invalidateGraderBoundaryCache, GRADER_TRUTH_REACHABLE } from './grader-boundary.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

class ByteSnapshot {
  #root
  #entries = new Map()

  constructor(root) {
    this.#root = root
  }

  /** Snapshot an existing file's bytes and mode, or record that it is absent. */
  capture(relativePath) {
    if (this.#entries.has(relativePath)) return
    const absolute = resolve(this.#root, relativePath)
    if (existsSync(absolute)) {
      const bytes = readFileSync(absolute)
      this.#entries.set(relativePath, { existed: true, bytes, mode: statSync(absolute).mode })
    } else {
      this.#entries.set(relativePath, { existed: false, bytes: null, mode: null })
    }
  }

  write(relativePath, contents) {
    this.capture(relativePath)
    const absolute = resolve(this.#root, relativePath)
    const existing = this.#entries.get(relativePath)
    writeFileSync(absolute, contents)
    if (existing.existed && existing.mode !== null) chmodSync(absolute, existing.mode)
  }

  append(relativePath, suffix) {
    this.capture(relativePath)
    const absolute = resolve(this.#root, relativePath)
    this.write(relativePath, `${readFileSync(absolute, 'utf8')}${suffix}`)
  }

  /** Put every touched path back and PROVE it went back. Returns failures. */
  restore() {
    const unrestored = []
    for (const [relativePath, entry] of this.#entries) {
      const absolute = resolve(this.#root, relativePath)
      try {
        if (!entry.existed) {
          rmSync(absolute, { force: true })
          if (existsSync(absolute)) unrestored.push(`${relativePath} (injected file still present)`)
          continue
        }
        writeFileSync(absolute, entry.bytes)
        chmodSync(absolute, entry.mode)
        const after = readFileSync(absolute)
        if (digest(after) !== digest(entry.bytes)) unrestored.push(`${relativePath} (content digest mismatch)`)
        else if (statSync(absolute).mode !== entry.mode) unrestored.push(`${relativePath} (mode mismatch)`)
      } catch (error) {
        unrestored.push(`${relativePath} (${error?.message ?? String(error)})`)
      }
    }
    this.#entries.clear()
    return unrestored
  }

  get touched() {
    return [...this.#entries.keys()]
  }
}

const PROBE_HELPER = 'src/shared/__grader_boundary_probe_helper.ts'
const PROBE_REEXPORT = 'src/shared/__grader_boundary_probe_reexport.ts'

/**
 * Each case injects, asserts the injected edge is actually present in the
 * analyzed graph (so a no-op injection cannot masquerade as a passing control),
 * then asserts the guard rejects it for the expected file with the exact reason.
 */
function cases(root) {
  return [
    {
      id: 'G1',
      title: 'direct grader import from a normal product module',
      expectFile: 'src/infrastructure/context-prompt-command.ts',
      expectRule: 'normal_product_root',
      inject(snapshot) {
        snapshot.append('src/infrastructure/context-prompt-command.ts', [
          '',
          '// #660-A G1 injection',
          "import { loadBenchmarkRuntimeProofProfiles } from './benchmark/runtime-proof.js'",
          'export const __g1Probe = loadBenchmarkRuntimeProofProfiles',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G2',
      title: 'transitive grader reach through a neutral helper',
      expectFile: 'src/runtime/stdio/tools.ts',
      expectRule: 'normal_product_root',
      expectChainIncludes: PROBE_HELPER,
      inject(snapshot) {
        snapshot.write(PROBE_HELPER, [
          '// #660-A G2 injection: a neutral-looking helper that reaches the grader.',
          "import { loadBenchmarkRuntimeProofProfiles } from '../infrastructure/benchmark/runtime-proof.js'",
          '',
          'export function probeHelper(): unknown {',
          '  return loadBenchmarkRuntimeProofProfiles',
          '}',
          '',
        ].join('\n'))
        snapshot.append('src/runtime/stdio/tools.ts', [
          '',
          '// #660-A G2 injection',
          "import { probeHelper } from '../../shared/__grader_boundary_probe_helper.js'",
          'export const __g2Probe = probeHelper',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G3',
      title: 'grader truth exposed through an intermediate re-export',
      expectFile: 'src/infrastructure/context-prompt-command.ts',
      expectRule: 'normal_product_root',
      expectChainIncludes: PROBE_REEXPORT,
      inject(snapshot) {
        snapshot.write(PROBE_REEXPORT, [
          '// #660-A G3 injection: re-export only, no local use.',
          "export { loadBenchmarkRuntimeProofProfiles } from '../infrastructure/benchmark/runtime-proof.js'",
          '',
        ].join('\n'))
        snapshot.append('src/infrastructure/context-prompt-command.ts', [
          '',
          '// #660-A G3 injection',
          "import { loadBenchmarkRuntimeProofProfiles } from '../shared/__grader_boundary_probe_reexport.js'",
          'export const __g3Probe = loadBenchmarkRuntimeProofProfiles',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G6',
      title: 'direct filesystem read of the grader data file from normal product code',
      expectFile: 'src/infrastructure/context-prompt-command.ts',
      expectRule: 'direct_data_read_in_normal_product',
      inject(snapshot) {
        snapshot.append('src/infrastructure/context-prompt-command.ts', [
          '',
          '// #660-A G6 injection: no import at all, just the path.',
          "export const __g6Probe = 'docs/benchmarks/suite/runtime-proof.json'",
          '',
        ].join('\n'))
      },
    },
  ].map((entry) => ({ ...entry, root }))
}

export function runGraderBoundarySelfTest({ root = process.cwd(), log = console.log } = {}) {
  const results = []

  // G4 — the legitimate grader/benchmark path must still be ACCEPTED. Run it
  // first, on the untouched tree, so a broken baseline is reported as such
  // rather than as a failed injection.
  invalidateGraderBoundaryCache()
  const baseline = analyzeGraderBoundary({ root, cache: false })
  const approved = baseline.ancestors ?? []
  results.push({
    id: 'G4',
    title: 'legitimate grader and benchmark ancestors remain accepted',
    passed: baseline.ok === true && approved.length > 0,
    detail: baseline.ok
      ? `clean; ${approved.length} approved grader/benchmark ancestor(s): ${approved.join(', ')}`
      : `baseline is NOT clean: ${(baseline.violations ?? []).map((violation) => `${violation.file} [${violation.rule}]`).join(', ')}`,
  })

  for (const testCase of cases(root)) {
    const snapshot = new ByteSnapshot(root)
    let passed = false
    let detail = ''
    try {
      testCase.inject(snapshot)

      invalidateGraderBoundaryCache()
      const injected = analyzeGraderBoundary({ root, cache: false })
      const violation = (injected.violations ?? []).find((candidate) => candidate.file === testCase.expectFile)

      // Prove the injected edge is really in the analyzed graph before judging
      // the guard. A silently no-op injection would otherwise look like a pass.
      const edgePresent = testCase.expectRule === 'direct_data_read_in_normal_product'
        ? (injected.dataReferences ?? []).some((reference) => reference.file === testCase.expectFile)
        : (injected.ancestors ?? []).includes(testCase.expectFile)

      if (!edgePresent) {
        detail = `injection did not create the expected edge into ${testCase.expectFile}; the control proves nothing`
      } else if (!violation) {
        detail = `guard did NOT reject ${testCase.expectFile} after injection`
      } else if (violation.reason !== GRADER_TRUTH_REACHABLE) {
        detail = `wrong reason: ${violation.reason}`
      } else if (violation.rule !== testCase.expectRule) {
        detail = `wrong rule: ${violation.rule} (expected ${testCase.expectRule})`
      } else if (testCase.expectChainIncludes && !violation.chain.includes(testCase.expectChainIncludes)) {
        detail = `chain did not name the intermediate ${testCase.expectChainIncludes}: ${violation.chain.join(' -> ')}`
      } else if (injected.ok !== false) {
        detail = 'guard reported ok despite a violation'
      } else {
        passed = true
        detail = `${violation.reason} / ${violation.rule} :: ${violation.chain.join(' -> ')}`
      }
    } catch (error) {
      detail = `threw: ${error?.message ?? String(error)}`
    } finally {
      const unrestored = snapshot.restore()
      if (unrestored.length > 0) {
        passed = false
        detail = `${detail} | FAILED TO RESTORE: ${unrestored.join(', ')}`
      }
    }
    results.push({ id: testCase.id, title: testCase.title, passed, detail })
  }

  // The tree must be exactly as it was. Verified by re-running the untouched
  // analysis rather than by trusting the restore loop.
  invalidateGraderBoundaryCache()
  const after = analyzeGraderBoundary({ root, cache: false })
  results.push({
    id: 'G0',
    title: 'worktree restored: post-injection analysis matches the baseline',
    passed: after.ok === baseline.ok
      && JSON.stringify(after.ancestors) === JSON.stringify(baseline.ancestors)
      && !existsSync(resolve(root, PROBE_HELPER))
      && !existsSync(resolve(root, PROBE_REEXPORT)),
    detail: `ok=${after.ok} ancestors=${(after.ancestors ?? []).length} probes-removed=${!existsSync(resolve(root, PROBE_HELPER)) && !existsSync(resolve(root, PROBE_REEXPORT))}`,
  })

  for (const result of results) {
    log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`)
    log(`         ${result.detail}`)
  }

  return { ok: results.every((result) => result.passed), results }
}

export { ByteSnapshot }
