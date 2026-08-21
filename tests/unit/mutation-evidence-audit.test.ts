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

describe('semantic evidence audit — completeness', () => {
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
