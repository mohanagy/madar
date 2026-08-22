/**
 * Negative controls for the standalone mutation-evidence audit.
 *
 * An independent reviewer copied a complete 95-invocation matrix, pointed one
 * invocation's Vitest report at an unrelated suite and set its stored
 * `exactlyOne` to false. The audit printed `artifact audit OK`. It had only
 * ever checked that the files existed.
 *
 * So every control here starts from a REAL matrix produced by the real harness,
 * breaks exactly one thing, and asserts the exact classification the audit is
 * required to return. The positive control -- an untouched copy that must pass
 * -- is what stops the other twenty from passing merely because the audit
 * always fails.
 */
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertUsableVitestJsonReport } from '../../scripts/lib/evidence-audit.mjs'
import {
  copyMatrix,
  discardMatrix,
  matrixDir,
  produceEvidenceMatrix,
  SUITE,
  TARGET,
  TEST_NAME,
} from './helpers/evidence-matrix.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AUDITOR = resolve(REPO, 'scripts/audit-mutation-evidence.mjs')
/** A real report from the installed reporter, committed as a shape reference. */
const REAL_REPORT = resolve(REPO, 'tests/fixtures/vitest-4.1.10-report.reference.json')

const OTHER_SUITE = 'tests/unit/somewhere-else.test.ts'
const HOUR_MS = 3_600_000

let project = ''
let goldenRun = ''
const copies: string[] = []

beforeAll(() => {
  const produced = produceEvidenceMatrix()
  project = produced.project
  goldenRun = produced.runRoot
}, 60_000)

afterAll(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (project !== '') discardMatrix(project)
})

/** A private, byte-identical copy of the golden matrix, timestamps intact. */
function matrix(): string {
  const root = copyMatrix(goldenRun)
  copies.push(dirname(root))
  return root
}

const dirFor = (root: string, kind: 'mutant' | 'baseline'): string => matrixDir(root, kind)

const readJson = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<string, unknown>

const writeJson = (dir: string, file: string, value: unknown): void => {
  writeFileSync(resolve(dir, file), JSON.stringify(value, null, 2))
}

const edit = (dir: string, file: string, change: (value: Record<string, unknown>) => void): void => {
  const value = readJson(dir, file)
  change(value)
  writeJson(dir, file, value)
}

/**
 * Re-stamps the report sidecar after a control rewrites the report.
 *
 * Used only by controls whose point is something OTHER than the digest binding:
 * without it every such control would be caught by `report_digest_mismatch`
 * and would prove nothing about the check it was written for.
 */
function restamp(dir: string): void {
  const bytes = readFileSync(resolve(dir, 'vitest-report.json'))
  edit(dir, 'report-identity.json', (identity) => {
    identity['report_digest'] = createHash('sha256').update(bytes).digest('hex')
    identity['report_bytes'] = bytes.byteLength
  })
  // Keep the file inside its own invocation window; the bounds check has its
  // own control.
  const started = Date.parse(String(readJson(dir, 'report-identity.json')['invocation_started_at'])) / 1000
  utimesSync(resolve(dir, 'vitest-report.json'), started, started)
}

const reportFor = (suite: string, status: 'passed' | 'failed', name = TEST_NAME): unknown => ({
  numTotalTestSuites: 1,
  numTotalTests: 1,
  testResults: [{ name: suite, assertionResults: [{ fullName: name, status, title: name }] }],
})

interface AuditResult {
  readonly status: number | null
  readonly output: string
  readonly codes: readonly string[]
  readonly digest: string | null
}

/** The auditor's own derived record for one invocation, read from its JSON. */
function auditRecordFor(root: string, kind: 'mutant' | 'baseline'): Record<string, unknown> {
  const out = resolve(dirname(root), `audit-${kind}.json`)
  spawnSync(process.execPath, [AUDITOR, root, '--json', out], { cwd: project, encoding: 'utf8' })
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as { invocations: Array<Record<string, unknown>> }
  const record = parsed.invocations.find((entry) => entry['kind'] === kind)
  if (record === undefined) throw new Error(`no ${kind} invocation in the audit record`)
  return record
}

function audit(root: string): AuditResult {
  const child = spawnSync(process.execPath, [
    AUDITOR, root, '--expect-mutants', '1', '--expect-baselines', '1',
  ], { cwd: project, encoding: 'utf8' })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  return {
    status: child.status,
    output,
    codes: [...output.matchAll(/\[([a-z_]+)\]/g)].map((match) => match[1] as string),
    digest: /semantic audit digest\s+([0-9a-f]{64})/.exec(output)?.[1] ?? null,
  }
}

describe('semantic evidence audit — positive control', () => {
  it('passes an untouched matrix and reports a semantic digest', () => {
    // Without this, all twenty negative controls below could pass because the
    // audit rejects everything.
    const result = audit(matrix())
    expect(result.output).toContain('semantic audit OK')
    expect(result.status).toBe(0)
    expect(result.codes).toEqual([])
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives two equivalent matrices the same semantic digest', () => {
    // Same meaning, different run identity, different paths, different
    // timestamps.
    expect(audit(matrix()).digest).toBe(audit(matrix()).digest)
  })

  it('gives a matrix with one changed conclusion a different semantic digest', () => {
    const baseline = audit(matrix()).digest
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'scoring.json', (scoring) => { scoring['classification'] = 'uncaught' })
    expect(audit(root).digest).not.toBe(baseline)
  })
})

describe('semantic evidence audit — negative controls', () => {
  it('01 rejects a stale or unrelated Vitest report', () => {
    const root = matrix()
    // Deliberately NOT re-stamped: this is the digest binding under test.
    writeJson(dirFor(root, 'mutant'), 'vitest-report.json', reportFor(OTHER_SUITE, 'failed'))
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('report_digest_mismatch')
  })

  it('02 rejects a report naming a suite that was not requested', () => {
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    writeJson(dir, 'vitest-report.json', reportFor(OTHER_SUITE, 'failed'))
    restamp(dir)
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('report_suite_mismatch')
  })

  it('03 rejects a suite identity that declares the wrong suite', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'suite-identity.json', (identity) => { identity['requested'] = OTHER_SUITE })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('requested_suite_mismatch')
  })

  it('04 rejects a stored exactlyOne that the report does not support', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'suite-identity.json', (identity) => { identity['exactlyOne'] = false })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('suite_identity_disagrees')
  })

  it('05 rejects a same-basename report carried in from elsewhere', () => {
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    // Byte-for-byte plausible and correctly stamped -- only its age gives it
    // away, which is the point of binding artifacts to invocation bounds.
    restamp(dir)
    const stale = Date.now() / 1000 - HOUR_MS / 1000
    utimesSync(resolve(dir, 'vitest-report.json'), stale, stale)
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('artifact_outside_invocation_bounds')
  })

  it('06 rejects artifacts that name different invocations', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'meta.json', (meta) => { meta['invocation_id'] = 'someone-elses-invocation' })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('invocation_id_mismatch')
  })

  it('07 rejects a report truncated by an interrupted invocation', () => {
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    const whole = readFileSync(resolve(dir, 'vitest-report.json'), 'utf8')
    writeFileSync(resolve(dir, 'vitest-report.json'), whole.slice(0, Math.floor(whole.length / 2)))
    restamp(dir)
    for (const file of ['meta.json', 'scoring.json']) {
      edit(dir, file, (value) => {
        const outcome = (value['outcome'] ?? value['process_outcome']) as Record<string, unknown>
        outcome['termination_signal'] = 'SIGTERM'
        outcome['exit_code'] = null
      })
    }
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('report_unreadable')
  })

  it('08 rejects an invocation whose restoration did not succeed', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'restoration.json', (restoration) => {
      restoration['restoration_succeeded'] = false
      restoration['tree_clean_after'] = false
      restoration['leftover_paths'] = [TARGET]
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('restoration_failed')
  })

  it('09 rejects a missing scoring.json', () => {
    const root = matrix()
    rmSync(resolve(dirFor(root, 'mutant'), 'scoring.json'), { force: true })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('missing_artifact')
    expect(result.output).toContain('missing scoring.json')
  })

  it('10 rejects a missing restoration.json', () => {
    const root = matrix()
    rmSync(resolve(dirFor(root, 'mutant'), 'restoration.json'), { force: true })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('missing_artifact')
    expect(result.output).toContain('missing restoration.json')
  })

  it('11 rejects corrupt scoring JSON', () => {
    const root = matrix()
    writeFileSync(resolve(dirFor(root, 'mutant'), 'scoring.json'), '{ not json')
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('artifact_unreadable')
    expect(result.output).toContain('scoring.json unreadable')
  })

  it('12 rejects corrupt restoration JSON', () => {
    const root = matrix()
    writeFileSync(resolve(dirFor(root, 'mutant'), 'restoration.json'), '{ not json')
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('artifact_unreadable')
    expect(result.output).toContain('restoration.json unreadable')
  })

  it('13 rejects a scoring record that misstates the process outcome', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'scoring.json', (scoring) => {
      (scoring['process_outcome'] as Record<string, unknown>)['exit_code'] = 0
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('process_outcome_mismatch')
  })

  it('14 rejects a mutated digest equal to the pre-mutation digest', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'restoration.json', (restoration) => {
      const pre = restoration['pre_mutation_digests'] as Record<string, string>
      restoration['mutated_digests'] = { ...pre }
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    // The exact defect the reviewer found in 77 records twice over.
    expect(result.codes).toContain('mutation_lifecycle_not_applied')
  })

  it('15 rejects a post-restoration digest that differs from the pre-mutation digest', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'restoration.json', (restoration) => {
      restoration['post_restoration_digests'] = { [TARGET]: 'c'.repeat(64) }
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('restoration_not_verified')
  })

  it('16 rejects "caught" when the expected named test did not fail', () => {
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    // Both meta and scoring are changed, so the ONLY thing wrong is that the
    // stored verdict is unsupported.
    for (const file of ['meta.json', 'scoring.json']) {
      edit(dir, file, (value) => {
        if (value['expected'] !== undefined) value['expected'] = ['a test that never ran']
        if (value['expected_test_identities'] !== undefined) value['expected_test_identities'] = ['a test that never ran']
      })
    }
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('classification_unsupported')
    expect(result.output).toContain('scoring says caught')
  })

  it('17 rejects "baseline_passed" when the report is red', () => {
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    writeJson(dir, 'vitest-report.json', reportFor(SUITE, 'failed'))
    restamp(dir)
    edit(dir, 'scoring.json', (scoring) => { scoring['observed_failed_test_identities'] = [TEST_NAME] })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('classification_unsupported')
    expect(result.output).toContain('scoring says baseline_passed')
  })

  it('18 rejects a report captured outside its own invocation window', () => {
    const root = matrix()
    edit(dirFor(root, 'mutant'), 'report-identity.json', (identity) => {
      const started = Date.parse(String(identity['invocation_started_at']))
      identity['captured_at'] = new Date(started - HOUR_MS).toISOString()
    })
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('report_freshness_violation')
  })

  it('19 rejects an artifact directory carrying an unaccounted file', () => {
    const root = matrix()
    writeFileSync(resolve(dirFor(root, 'mutant'), 'notes-from-somewhere.json'), '{}')
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('unexpected_artifact')
  })

  it('20 rejects two invocations sharing one identity', () => {
    const root = matrix()
    const stolen = readJson(dirFor(root, 'mutant'), 'scoring.json')['invocation_id']
    for (const file of ['meta.json', 'command.json', 'suite-identity.json', 'report-identity.json', 'scoring.json', 'restoration.json']) {
      edit(dirFor(root, 'baseline'), file, (value) => { value['invocation_id'] = stolen })
    }
    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('duplicate_invocation_id')
  })
})

describe('semantic evidence audit — process/report status concordance', () => {
  /**
   * M1-05D-C. The cross-artifact check compares `meta.json` against
   * `scoring.json`, so falsifying BOTH consistently defeated it, and nothing
   * compared either against the report. A reviewer set both exit codes to 0,
   * left five failing tests in place, and the audit reported OK -- producing a
   * different-but-accepted digest rather than a failure.
   *
   * Every control below starts from a matrix the real harness produced, edits a
   * private copy, and leaves the source matrix untouched.
   */
  it('A rejects a red report whose persisted statuses both claim exit 0', () => {
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    // Both artifacts, consistently. Signal and timeout stay as ordinary
    // completion so the invocation cannot be excused as infrastructure.
    for (const file of ['meta.json', 'scoring.json']) {
      edit(dir, file, (value) => {
        const outcome = (value['outcome'] ?? value['process_outcome']) as Record<string, unknown>
        outcome['exit_code'] = 0
        outcome['termination_signal'] = null
        outcome['timed_out'] = false
      })
    }

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('red_report_zero_exit')
    // The failing tests it names must never be readable as proof of a catch.
    expect(result.output).toContain('evidence supports unverifiable')
  })

  it('B rejects a green report whose persisted statuses both claim non-zero exit', () => {
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    for (const file of ['meta.json', 'scoring.json']) {
      edit(dir, file, (value) => {
        const outcome = (value['outcome'] ?? value['process_outcome']) as Record<string, unknown>
        outcome['exit_code'] = 1
        outcome['termination_signal'] = null
        outcome['timed_out'] = false
      })
    }

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('green_report_nonzero_exit')
    expect(result.output).toContain('evidence supports unverifiable')
  })

  it('C reports cross-artifact disagreement, not report concordance, when only one lies', () => {
    const root = matrix()
    // Only scoring is changed: the two status artifacts now disagree, so there
    // is no established process status to compare against the report.
    edit(dirFor(root, 'mutant'), 'scoring.json', (scoring) => {
      (scoring['process_outcome'] as Record<string, unknown>)['exit_code'] = 0
    })

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('process_outcome_mismatch')
    expect(result.codes).not.toContain('red_report_zero_exit')
    expect(result.codes).not.toContain('green_report_nonzero_exit')
  })

  it('leaves an infrastructure ending governed by its own classification', () => {
    // A signalled child says nothing about whether tests passed, so the
    // ordinary concordance rule must not be applied to it. Forcing it here
    // would reclassify real infrastructure failures as tampering.
    const root = matrix()
    const dir = dirFor(root, 'mutant')
    for (const file of ['meta.json', 'scoring.json']) {
      edit(dir, file, (value) => {
        const outcome = (value['outcome'] ?? value['process_outcome']) as Record<string, unknown>
        outcome['exit_code'] = null
        outcome['termination_signal'] = 'SIGKILL'
      })
    }

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).not.toContain('red_report_zero_exit')
    expect(result.codes).not.toContain('green_report_nonzero_exit')
    // Still refused, but as the infrastructure condition it actually is.
    expect(result.codes).toContain('classification_unsupported')
    expect(result.output).toContain('infrastructure_failure')
  })
})

describe('semantic evidence audit — truthful status is accepted', () => {
  it('accepts a green baseline report with an ordinary exit 0', () => {
    const root = matrix()
    const result = audit(root)
    expect(result.status).toBe(0)

    const record = auditRecordFor(root, 'baseline')
    expect(record['report_status']).toBe('green')
    expect(record['process_status']).toBe('ordinary_zero')
    expect(record['classification']).toBe('baseline_passed')
  })

  it('accepts a red caught-mutant report with an ordinary non-zero exit', () => {
    const root = matrix()
    const result = audit(root)
    expect(result.status).toBe(0)

    const record = auditRecordFor(root, 'mutant')
    expect(record['report_status']).toBe('red')
    expect(record['process_status']).toBe('ordinary_nonzero')
    expect(record['classification']).toBe('caught')
  })
})

describe('semantic evidence audit — report status uses every authoritative field', () => {
  /**
   * M1-05D-C1. Report status was derived from assertion results alone. A
   * reviewer set success:false, numFailedTestSuites:1, the file row to failed
   * and added a file-level message, left all 54 assertions passing at exit 0,
   * and the auditor derived green and returned the unchanged checkpoint digest.
   *
   * A suite that dies before its first assertion has no failed assertion to
   * find, so each authoritative field is controlled on its own here: a
   * derivation that consulted only some of them would pass the others.
   *
   * Each control edits ONE field on a genuine green baseline and leaves the
   * ordinary exit 0 in place, so a correct derivation reads red and ordinary
   * concordance then refuses it.
   */
  const redField = (label: string, mutate: (report: Record<string, unknown>) => void): void => {
    it(`${label} makes the report red and fails concordance at exit 0`, () => {
      const root = matrix()
      const dir = dirFor(root, 'baseline')
      const report = readJson(dir, 'vitest-report.json')
      mutate(report)
      writeJson(dir, 'vitest-report.json', report)
      restamp(dir)

      const result = audit(root)
      expect(result.status).not.toBe(0)
      expect(result.codes).toContain('red_report_zero_exit')
      expect(result.output).toContain('report red')
      // Never resolved in favour of the stored verdict.
      expect(result.output).toContain('evidence supports unverifiable')
    })
  }

  redField('A top-level success:false', (report) => { report['success'] = false })

  redField('B numFailedTestSuites > 0', (report) => {
    report['success'] = false
    report['numFailedTestSuites'] = 1
  })

  redField('C a failed file-result status', (report) => {
    report['success'] = false
    const row = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    row['status'] = 'failed'
  })

  redField('D a file-level failure message', (report) => {
    report['success'] = false
    const row = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    row['message'] = 'Error: file-level failure before any test ran'
  })

  redField('E a failed assertion', (report) => {
    report['success'] = false
    const file = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const assertions = file['assertionResults'] as Array<Record<string, unknown>>
    ;(assertions[0] as Record<string, unknown>)['status'] = 'failed'
  })

  it('F refuses a report whose own fields contradict each other', () => {
    // success:true alongside failure counts. The favourable field must not be
    // chosen; the report is not evidence of anything either way.
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    report['success'] = true
    report['numFailedTests'] = 3
    report['numFailedTestSuites'] = 1
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('contradictory_report')
    expect(result.output).toContain('claims success:true while reporting')
    // Fails closed rather than being read as green.
    expect(result.codes).not.toContain('red_report_zero_exit')
  })

  it('reproduces the reviewer\u2019s exact file-level falsification', () => {
    // Every field the reviewer set, together, on genuine green evidence.
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    report['success'] = false
    report['numFailedTestSuites'] = 1
    const file = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    file['status'] = 'failed'
    file['message'] = 'Error: file-level failure before any test ran'
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)

    // Assertions all still pass and the exit code is still an ordinary 0.
    const assertions = (file['assertionResults'] as Array<Record<string, unknown>>)
    expect(assertions.every((a) => a['status'] === 'passed')).toBe(true)
    expect((readJson(dir, 'scoring.json')['process_outcome'] as Record<string, unknown>)['exit_code']).toBe(0)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('red_report_zero_exit')
  })

  it('G accepts a truthful green report at ordinary exit 0', () => {
    const root = matrix()
    expect(audit(root).status).toBe(0)
    const record = auditRecordFor(root, 'baseline')
    expect(record['report_status']).toBe('green')
    expect(record['process_status']).toBe('ordinary_zero')
  })

  it('H accepts a truthful red mutant report at ordinary non-zero exit', () => {
    const root = matrix()
    expect(audit(root).status).toBe(0)
    const record = auditRecordFor(root, 'mutant')
    expect(record['report_status']).toBe('red')
    expect(record['process_status']).toBe('ordinary_nonzero')
  })
})

describe('semantic evidence audit — impossible process outcomes', () => {
  /**
   * M1-05D-C2. Reported with exact codes rather than normalised away: silently
   * repairing an impossible outcome would let falsified evidence pass as merely
   * untidy.
   */
  const impossible = (label: string, code: string, mutate: (outcome: Record<string, unknown>) => void): void => {
    it(`rejects ${label}`, () => {
      const root = matrix()
      const dir = dirFor(root, 'mutant')
      // Both artifacts, so cross-artifact disagreement is not what fires.
      for (const file of ['meta.json', 'scoring.json']) {
        edit(dir, file, (value) => {
          mutate((value['outcome'] ?? value['process_outcome']) as Record<string, unknown>)
        })
      }
      const result = audit(root)
      expect(result.status).not.toBe(0)
      expect(result.codes).toContain(code)
    })
  }

  impossible('a spawn error alongside a started child', 'spawn_error_with_started_child', (o) => {
    o['spawn_error'] = 'ENOENT: no such file or directory'
    o['child_started'] = true
  })

  impossible('a spawn error alongside an ordinary exit code', 'spawn_error_with_exit_code', (o) => {
    o['spawn_error'] = 'ENOENT: no such file or directory'
    o['child_started'] = false
    o['exit_code'] = 1
  })

  impossible('a timeout alongside a successful exit', 'timeout_with_successful_exit', (o) => {
    o['timed_out'] = true
    o['exit_code'] = 0
  })

  impossible('a signal alongside an ordinary exit code', 'signal_with_exit_code', (o) => {
    o['termination_signal'] = 'SIGKILL'
    o['exit_code'] = 1
  })

  impossible('a never-started child that produced a report', 'not_started_with_report', (o) => {
    o['child_started'] = false
    o['exit_code'] = null
    o['started_at'] = null
    o['finished_at'] = null
    o['duration_ms'] = 0
  })

  impossible('a never-started child carrying completion timestamps', 'not_started_with_timestamps', (o) => {
    o['child_started'] = false
    o['exit_code'] = null
    o['duration_ms'] = 0
  })

  impossible('a never-started child that consumed time', 'not_started_with_duration', (o) => {
    o['child_started'] = false
    o['exit_code'] = null
    o['started_at'] = null
    o['finished_at'] = null
    o['duration_ms'] = 4200
  })
})

describe('semantic evidence audit — report structure is proven, not assumed', () => {
  /**
   * C1-STRUCTURE-01. The derivation asked whether a failure indicator was
   * PRESENT and read absence as green. A reviewer removed success, both failed
   * counts, the file status and the file message from a genuine green baseline,
   * rebound the digest truthfully, and the auditor derived green, recomputed
   * baseline_passed, exited 0 and produced the unchanged semantic digest.
   *
   * Absence of evidence is not evidence of absence.
   */
  const MANDATORY_TOP = ['success', 'numFailedTestSuites', 'numFailedTests', 'numTotalTests', 'testResults'] as const
  const MANDATORY_FILE = ['status', 'message', 'name', 'assertionResults'] as const

  const stripAndAudit = (drop: (report: Record<string, unknown>) => void): AuditResult => {
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    drop(report)
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)
    return audit(root)
  }

  it.each([...MANDATORY_TOP])('removing top-level %s makes the report unusable', (field) => {
    const result = stripAndAudit((report) => { delete report[field] })
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('vitest_report_incomplete')
    expect(result.output).toContain(`missing required field \`${field}\``)
    // Never green, and never silently rescued into an ordinary verdict.
    expect(result.output).not.toContain('scoring says baseline_passed, evidence supports baseline_passed')
  })

  it.each([...MANDATORY_FILE])('removing per-file %s makes the report unusable', (field) => {
    const result = stripAndAudit((report) => {
      const file = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
      delete file[field]
    })
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('vitest_report_incomplete')
    expect(result.output).toContain(`missing required field \`${field}\``)
  })

  it('reproduces the reviewer\u2019s exact stripped report', () => {
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    const file = (report['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const assertions = file['assertionResults'] as Array<Record<string, unknown>>
    const before = assertions.length

    delete report['success']
    delete report['numFailedTestSuites']
    delete report['numFailedTests']
    delete file['status']
    delete file['message']
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)

    // Passing rows and the ordinary exit 0 are retained, exactly as reported.
    expect(assertions.length).toBe(before)
    expect(assertions.every((a) => a['status'] === 'passed')).toBe(true)
    expect((readJson(dir, 'scoring.json')['process_outcome'] as Record<string, unknown>)['exit_code']).toBe(0)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('vitest_report_incomplete')
    expect(auditRecordFor(root, 'baseline')['report_status']).toBe('unavailable')
  })

  const malformed = (label: string, mutate: (report: Record<string, unknown>) => void): void => {
    it(`rejects ${label} as malformed`, () => {
      const result = stripAndAudit(mutate)
      expect(result.status).not.toBe(0)
      expect(result.codes).toContain('vitest_report_malformed')
    })
  }

  malformed('a non-boolean success', (r) => { r['success'] = 'true' })
  malformed('a negative failed-suite count', (r) => { r['numFailedTestSuites'] = -1 })
  malformed('a fractional failed-test count', (r) => { r['numFailedTests'] = 1.5 })
  malformed('a string failed-test count', (r) => { r['numFailedTests'] = '0' })
  malformed('a non-array testResults', (r) => { r['testResults'] = {} })
  malformed('an unknown file status', (r) => {
    const file = (r['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    file['status'] = 'weird'
  })
  malformed('a non-array assertion collection', (r) => {
    const file = (r['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    file['assertionResults'] = 'none'
  })
  malformed('a wrong-typed failure authority', (r) => {
    const file = (r['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    file['message'] = { text: 'boom' }
  })
  malformed('an empty file name', (r) => {
    const file = (r['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    file['name'] = '   '
  })

  it('rejects a report reached only through a prototype', () => {
    // A required key must be an OWN property; an inherited authority is not
    // something the reporter wrote.
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    delete report['success']
    // JSON cannot carry a prototype, so the equivalent on-disk shape is simply
    // the missing own property, which must already be refused.
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)
    expect(audit(root).codes).toContain('vitest_report_incomplete')
  })

  it('detects a positive failed-test count at ordinary exit 0 as red, not incomplete', () => {
    // Distinct from the structural controls: the report is COMPLETE, and the
    // count itself is the failure authority.
    const root = matrix()
    const dir = dirFor(root, 'baseline')
    const report = readJson(dir, 'vitest-report.json')
    report['success'] = false
    report['numFailedTests'] = 2
    writeJson(dir, 'vitest-report.json', report)
    restamp(dir)

    const result = audit(root)
    expect(result.status).not.toBe(0)
    expect(result.codes).toContain('red_report_zero_exit')
    expect(result.codes).not.toContain('vitest_report_incomplete')
    expect(auditRecordFor(root, 'baseline')['report_status']).toBe('red')
  })

  it('accepts genuine complete reports on both sides', () => {
    const root = matrix()
    expect(audit(root).status).toBe(0)
    expect(auditRecordFor(root, 'baseline')['report_shape']).toBe('usable_complete')
    expect(auditRecordFor(root, 'mutant')['report_shape']).toBe('usable_complete')
  })
})

describe('semantic evidence audit — fixture shape characterization', () => {
  it('the stub reporter emits the same authority keys and types as real Vitest', () => {
    // The fixture conforms to the installed reporter contract, not the other
    // way round. The reviewer identified the stub as a second source of
    // structurally incomplete reports, and a validator written against the real
    // shape would have rejected the fixture's own output.
    //
    // Shape characterization, not a byte-for-byte golden report: only required
    // keys and their types are compared, never run-specific content.
    const stub = readJson(dirFor(matrix(), 'baseline'), 'vitest-report.json')
    const real = JSON.parse(readFileSync(REAL_REPORT, 'utf8')) as Record<string, unknown>

    const typeOf = (v: unknown): string => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
    const shape = (o: Record<string, unknown>, keys: readonly string[]): Record<string, string> =>
      Object.fromEntries(keys.map((k) => [k, typeOf(o[k])]))

    const TOP = ['success', 'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites',
      'numPendingTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests',
      'numPendingTests', 'numTodoTests', 'testResults']
    expect(shape(stub, TOP)).toEqual(shape(real, TOP))

    const FILE = ['name', 'status', 'message', 'assertionResults']
    const stubFile = (stub['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const realFile = (real['testResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(shape(stubFile, FILE)).toEqual(shape(realFile, FILE))

    const ASSERTION = ['fullName', 'title', 'status', 'ancestorTitles', 'failureMessages']
    const stubRow = (stubFile['assertionResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const realRow = (realFile['assertionResults'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(shape(stubRow, ASSERTION)).toEqual(shape(realRow, ASSERTION))
  })

  it('the validator accepts a real Vitest report unchanged', () => {
    // The other direction: the schema must describe the installed reporter, not
    // merely whatever the fixture happens to emit.
    const real = JSON.parse(readFileSync(REAL_REPORT, 'utf8')) as Record<string, unknown>
    expect(assertUsableVitestJsonReport(real).result).toBe('usable_complete')
  })
})

describe('semantic evidence audit — artifact inventory completeness', () => {
  it('requires every artifact the harness is supposed to write', () => {
    // Enumerated as a control rather than trusted: an audit that silently
    // stopped requiring one of these would look exactly like a passing audit.
    const dir = dirFor(matrix(), 'mutant')
    for (const file of [
      'meta.json', 'command.json', 'suite-identity.json', 'report-identity.json',
      'scoring.json', 'restoration.json', 'stdout.txt', 'stderr.txt', 'display.log',
    ]) {
      const root = matrix()
      rmSync(resolve(dirFor(root, 'mutant'), file), { force: true })
      expect(audit(root).status, `audit accepted a matrix missing ${file}`).not.toBe(0)
    }
    expect(existsSync(resolve(dir, 'vitest-report.json'))).toBe(true)
    expect(statSync(resolve(dir, 'stdout.txt')).isFile()).toBe(true)
  })
})
