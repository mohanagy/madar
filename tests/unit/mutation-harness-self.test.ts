import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  baselineVerdict,
  classifyReportAvailability,
  matchesExpectation,
  parseReportFromText,
  planMutation,
  readSuiteResult,
  scoreMutant,
} from '../../scripts/lib/mutation-scoring.mjs'

/** A Vitest JSON report with the given test outcomes. */
function report(...outcomes: Array<[string, 'passed' | 'failed']>): unknown {
  return {
    testResults: [{
      assertionResults: outcomes.map(([fullName, status]) => ({ fullName, status })),
    }],
  }
}

const usable = (...outcomes: Array<[string, 'passed' | 'failed']>) =>
  readSuiteResult({ raw: '', report: report(...outcomes) })

describe('mutation harness — a run must be usable before it is evidence', () => {
  it('reads failures by exact test identity', () => {
    const result = usable(['suite names the invariant', 'failed'], ['suite does something else', 'passed'])
    expect(result).toEqual({ usable: true, total: 2, failed: ['suite names the invariant'] })
  })

  it('refuses a worker startup failure', () => {
    const result = readSuiteResult({ raw: 'Failed to start forks worker', report: null })
    expect(result).toEqual({ usable: false, why: 'worker startup failure' })
  })

  it('refuses a worker timeout', () => {
    const result = readSuiteResult({ raw: 'Timeout waiting for worker to respond', report: null })
    expect(result.usable).toBe(false)
  })

  it('refuses a run that produced no report', () => {
    expect(readSuiteResult({ raw: '', report: null }))
      .toEqual({ usable: false, why: 'no JSON report produced' })
  })

  it('refuses a non-test crash that executed nothing', () => {
    // A collection error reports a suite with no assertions. Scoring that as
    // green would read a crash as proof the invariant is uncovered.
    expect(readSuiteResult({ raw: '', report: { testResults: [{ assertionResults: [] }] } }))
      .toEqual({ usable: false, why: 'suite did not execute any test' })
  })
})

describe('mutation harness — a mutation must actually be applied', () => {
  const source = 'const a = 1\nconst b = 2\n'

  it('applies a unique anchor', () => {
    const plan = planMutation({ source, from: 'const a = 1', to: 'const a = 9' })
    expect(plan).toEqual({ ok: true, mutated: 'const a = 9\nconst b = 2\n' })
  })

  it('refuses a stale anchor', () => {
    // The original defect: a multi-line anchor that no longer exists was
    // treated as applied, and the suite ran on unmutated source.
    expect(planMutation({ source, from: 'const a = 1\nconst gone = 0', to: 'x' }))
      .toEqual({ ok: false, why: 'anchor not found' })
  })

  it('refuses an ambiguous anchor', () => {
    expect(planMutation({ source: 'x\nx\n', from: 'x', to: 'y' }))
      .toEqual({ ok: false, why: 'anchor is ambiguous' })
  })

  it('scopes the search so a self-targeting mutant is expressible', () => {
    // A mutant on the harness's own source always matches twice: once in the
    // executable code and once in the definition that names it. Scoping past
    // the mutant table is what makes it expressible rather than ambiguous.
    const source = "MUTANTS = [{ from: 'const a = 1' }]\nMARKER\nconst a = 1\n"
    expect(planMutation({ source, from: 'const a = 1', to: 'const a = 9' }))
      .toEqual({ ok: false, why: 'anchor is ambiguous' })
    const scoped = planMutation({ source, from: 'const a = 1', to: 'const a = 9', scopeAfter: 'MARKER' })
    expect(scoped.ok).toBe(true)
    // Only the executable copy is rewritten; the definition is untouched.
    expect(scoped.mutated).toContain("from: 'const a = 1'")
    expect(scoped.mutated).toContain('const a = 9')
  })

  it('refuses a scope marker that does not exist', () => {
    expect(planMutation({ source: 'const a = 1', from: 'a', to: 'b', scopeAfter: 'ABSENT' }).why)
      .toContain('scope marker not found')
  })

  it('refuses a no-op replacement', () => {
    expect(planMutation({ source, from: 'const a = 1', to: 'const a = 1' }))
      .toEqual({ ok: false, why: 'mutation changed nothing' })
  })
})

describe('mutation harness — only a named expected failure counts as caught', () => {
  const expected = ['names the invariant']

  it('scores an expected failure as caught', () => {
    const score = scoreMutant({ expect: expected, result: usable(['suite names the invariant', 'failed']) })
    expect(score.kind).toBe('caught')
  })

  it('never scores an unrelated failure as caught', () => {
    // The exact misattribution the review found: red for some other reason is
    // not evidence about this mutant.
    const score = scoreMutant({ expect: expected, result: usable(['suite tests something else', 'failed']) })
    expect(score.kind).toBe('SKIPPED')
    expect(score.detail).toContain('only unrelated tests failed')
  })

  it('scores a green suite as uncaught', () => {
    const score = scoreMutant({ expect: expected, result: usable(['suite names the invariant', 'passed']) })
    expect(score.kind).toBe('UNCAUGHT')
  })

  it('refuses to score a mutant with no expectation declared', () => {
    const score = scoreMutant({ expect: [], result: usable(['anything', 'failed']) })
    expect(score.kind).toBe('SKIPPED')
    expect(score.detail).toBe('no expected test declared')
  })

  it('never scores an unusable run as caught or uncaught', () => {
    const score = scoreMutant({ expect: expected, result: { usable: false, why: 'worker startup failure' } })
    expect(score.kind).toBe('SKIPPED')
  })

  it('matches by substring and by regex', () => {
    expect(matchesExpectation('a suite names the invariant here', ['names the invariant'])).toBe(true)
    expect(matchesExpectation('a suite names the invariant here', [/^a suite.*here$/])).toBe(true)
    expect(matchesExpectation('unrelated', ['names the invariant'])).toBe(false)
  })
})

describe('mutation harness — restoration is proven, not assumed', () => {
  it('declares a restore that verifies the file came back', () => {
    // A run killed while blocked in a synchronous child can leave a mutation on
    // disk: the signal handler queues behind the blocking call and never runs
    // if the process group dies. That happened. The surviving mutation was
    // invisible to `git status` because the file was untracked -- git showed it
    // as a new file, which is exactly what it was meant to be.
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    expect(source).toContain('FAILED TO RESTORE')
    expect(source).toContain('function assertNoResidualMutation()')
  })

  it('refuses to report a tally when a mutation survives', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    const guard = source.indexOf('const residual = assertNoResidualMutation()')
    expect(guard).toBeGreaterThan(-1)
    const tally = source.indexOf('caught=${caught}')
    // The refusal comes before the number, so a corrupted tree cannot produce
    // a result at all.
    expect(guard).toBeLessThan(tally)
    expect(source.slice(guard, tally)).toContain('process.exit(1)')
  })
})

describe('mutation harness — an already-red suite attributes nothing', () => {
  it('accepts a green baseline', () => {
    expect(baselineVerdict(usable(['a', 'passed']))).toBeNull()
  })

  it('refuses a baseline that is already red', () => {
    expect(baselineVerdict(usable(['a', 'failed']))).toContain('baseline already red')
  })

  it('refuses an unusable baseline', () => {
    expect(baselineVerdict({ usable: false, why: 'worker startup failure' }))
      .toContain('baseline unusable')
  })
})

/**
 * These two drive the real harness as a subprocess, and the harness writes to
 * production source while it runs. Nothing else may be reading those files at
 * the time, so they are opt-in rather than part of the parallel suite --
 * `npm run verify:integrity-mutations` sets the flag and runs them alone, after
 * the mutants themselves. Running them inside the parallel suite corrupted
 * concurrent workers, which is exactly the hazard they exist to guard against.
 */
const HARNESS_E2E = process.env['MADAR_MUTATION_HARNESS_E2E'] === '1'

describe('mutation harness — the working tree survives a run', () => {
  it('declares every mutant with a focused suite and an expectation', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    const names = source.match(/^ {4}name: '/gm) ?? []
    const tests = source.match(/^ {4}test: /gm) ?? []
    const expects = source.match(/^ {4}expect: \[/gm) ?? []
    expect(names.length).toBeGreaterThan(0)
    expect(tests).toHaveLength(names.length)
    expect(expects).toHaveLength(names.length)
  })

  it.runIf(HARNESS_E2E)('restores every mutated file, leaving the tree clean', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    execFileSync('node', ['scripts/verify-integrity-mutations.mjs', '--filter', 'R3-05'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
    })
    expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })).toBe(before)
  }, 600_000)

  it.runIf(HARNESS_E2E)('restores the tree even when interrupted', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    // Start a run, kill it mid-flight, and require the tree to come back. The
    // handler is the only thing standing between an interrupted run and a
    // repository left holding mutated production source.
    execFileSync('bash', ['-c',
      'node scripts/verify-integrity-mutations.mjs --filter R3-05 >/dev/null 2>&1 & '
      + 'pid=$!; sleep 8; kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null; exit 0',
    ], { encoding: 'utf8', timeout: 120_000 })
    expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })).toBe(before)
  }, 180_000)
})

describe('M1-05 — a report that never reached disk still yields evidence', () => {
  const valid = JSON.stringify({
    numTotalTestSuites: 1,
    testResults: [{ assertionResults: [{ fullName: 'names the invariant', status: 'failed' }] }],
  })

  it('prefers the report file when it is present and parseable', () => {
    const { report, source } = classifyReportAvailability({ fileExists: true, fileText: valid, stdout: '' })
    expect(source).toBe('file')
    expect(readSuiteResult({ report }).failed).toEqual(['names the invariant'])
  })

  it('recovers the report from stdout when the file never appeared', () => {
    // The exact defect: vitest flushes its JSON reporter as the process exits,
    // and under load that flush lost the race. The same JSON was still in
    // captured stdout, so the evidence existed and was being thrown away.
    const { report, source } = classifyReportAvailability({
      fileExists: false,
      stdout: `RUN v4
${valid}
`,
    })
    expect(source).toContain('file missing')
    expect(readSuiteResult({ report }).failed).toEqual(['names the invariant'])
  })

  it('recovers from stdout when the file is truncated mid-write', () => {
    const { report, source } = classifyReportAvailability({
      fileExists: true,
      fileText: valid.slice(0, 40),
      stdout: valid,
    })
    expect(source).toContain('file was unparseable')
    expect(report).not.toBeNull()
  })

  it('classifies a wholly missing report as infrastructure failure, never caught', () => {
    const { report, source } = classifyReportAvailability({ fileExists: false, stdout: 'progress only' })
    expect(report).toBeNull()
    expect(source).toBe('no JSON report produced')
    const score = scoreMutant({
      expect: ['names the invariant'],
      result: readSuiteResult({ report }),
    })
    expect(score.kind).toBe('SKIPPED')
  })

  it('treats a partial report as no report rather than as a result', () => {
    expect(parseReportFromText(valid.slice(0, 30))).toBeNull()
  })

  it('finds the report inside carriage-return-heavy output', () => {
    // Progress rendering overwrote rows in a captured log and destroyed a
    // mutant's identity once already.
    const noisy = `\r  progress\r  more progress\r${valid}`
    expect(parseReportFromText(noisy)).not.toBeNull()
  })

  it('rejects non-string input rather than throwing', () => {
    expect(parseReportFromText(undefined)).toBeNull()
    expect(parseReportFromText(null)).toBeNull()
  })
})

describe('M1-05 — invocation artifacts are unique and durable', () => {
  const whole = () => readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')

  /**
   * Only the executable section, never the mutant table.
   *
   * The mutant literals deliberately mirror the defective code they
   * reintroduce, so a plain text search finds the mutant's copy of a defect and
   * reports the defect as present. Two of these assertions failed exactly that
   * way before being scoped.
   */
  const source = (): string => {
    const text = whole()
    const executable = text.lastIndexOf('===== executable section; nothing below is mutant data =====')
    expect(executable, 'could not locate the executable section').toBeGreaterThan(-1)
    return text.slice(executable)
  }

  it('gives every invocation its own report path', () => {
    // One shared --outputFile across every mutant was the root cause. Asserted
    // on the assignment rather than on the string: the string also appears
    // inside the mutant literal whose whole job is to reintroduce it.
    const text = source()
    expect(text).toContain('function invocationDirectory(')
    expect(text).toContain("const reportPath = resolve(artifactDir, 'vitest-report.json')")
    expect(text).not.toContain('const reportPath = resolve(ROOT,')
  })

  it('writes raw output before attempting to parse it', () => {
    const text = source()
    const wroteStdout = text.indexOf("writeFileSync(resolve(artifactDir, 'stdout.txt')")
    const parsed = text.indexOf('classifyReportAvailability(')
    expect(wroteStdout).toBeGreaterThan(-1)
    // Evidence exists even when parsing finds nothing to read.
    expect(wroteStdout).toBeLessThan(parsed)
  })

  it('names the artifact directory when a mutant cannot be scored', () => {
    expect(source()).toContain('result.artifactDir')
  })

  it('stops the matrix immediately when restoration fails', () => {
    const text = source()
    const abort = text.indexOf('RESTORATION FAILED after')
    expect(abort).toBeGreaterThan(-1)
    const block = text.slice(abort, abort + 600)
    expect(block).toContain('Evidence retained in')
    expect(block).toContain('process.exit(1)')
  })
})

describe('M1-05D — the artifact audit is executable, not asserted', () => {
  const HARNESS = resolve(process.cwd(), 'scripts/verify-integrity-mutations.mjs')
  const scratch: string[] = []

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A complete, valid artifact directory for one mutant and one baseline. */
  function buildArtifacts(): string {
    const root = mkdtempSync(join(tmpdir(), 'madar-audit-'))
    scratch.push(root)
    const invocation = 'run1-001'
    for (const [name, extra] of [
      ['001-mutant', { mutant_id: 'demo mutant' }],
      ['001-baseline', { baseline_identity: 'tests/unit/demo.test.ts' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      for (const file of ['meta.json', 'stdout.txt', 'stderr.txt', 'display.log', 'suite-identity.json']) {
        writeFileSync(join(dir, file), file.endsWith('.json') ? '{}' : 'output')
      }
      const id = `${invocation}-${name}`
      writeFileSync(join(dir, 'scoring.json'), JSON.stringify({ invocation_id: id, ...extra }))
      writeFileSync(join(dir, 'restoration.json'), JSON.stringify({ invocation_id: id }))
    }
    return root
  }

  function audit(root: string): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [
        HARNESS, '--audit', root, '--expect-mutants', '1', '--expect-baselines', '1',
      ], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
      return { status: 0, output: stdout }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  it('passes on a complete artifact set', () => {
    // The positive control: without it, every failure below could pass because
    // the audit always fails.
    const { status, output } = audit(buildArtifacts())
    expect(status).toBe(0)
    expect(output).toContain('artifact audit OK')
  })

  it.each([
    'scoring.json', 'restoration.json', 'suite-identity.json',
    'meta.json', 'stdout.txt', 'stderr.txt', 'display.log',
  ])('fails when %s is missing', (artifact) => {
    const root = buildArtifacts()
    rmSync(join(root, '001-mutant', artifact), { force: true })
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain(`missing ${artifact}`)
  })

  it('fails when scoring.json is corrupt', () => {
    const root = buildArtifacts()
    writeFileSync(join(root, '001-mutant', 'scoring.json'), '{ not json')
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('scoring.json unreadable')
  })

  it('fails when restoration.json is corrupt', () => {
    const root = buildArtifacts()
    writeFileSync(join(root, '001-mutant', 'restoration.json'), '{ not json')
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('restoration.json unreadable')
  })

  it('fails when scoring and restoration name different invocations', () => {
    const root = buildArtifacts()
    writeFileSync(join(root, '001-mutant', 'restoration.json'), JSON.stringify({ invocation_id: 'someone-else' }))
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('name different invocations')
  })

  it('fails when an invocation identifies neither a mutant nor a baseline', () => {
    const root = buildArtifacts()
    writeFileSync(join(root, '001-mutant', 'scoring.json'), JSON.stringify({ invocation_id: 'run1-001-001-mutant' }))
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('identifies neither a mutant nor a baseline')
  })

  it('fails when an unexpected extra invocation directory is present', () => {
    // A stale directory from an earlier run would otherwise pad the count.
    const root = buildArtifacts()
    const extra = join(root, '002-stale')
    mkdirSync(extra, { recursive: true })
    for (const file of ['meta.json', 'stdout.txt', 'stderr.txt', 'display.log', 'suite-identity.json']) {
      writeFileSync(join(extra, file), '{}')
    }
    writeFileSync(join(extra, 'scoring.json'), JSON.stringify({ invocation_id: 'stale-1', mutant_id: 'stale' }))
    writeFileSync(join(extra, 'restoration.json'), JSON.stringify({ invocation_id: 'stale-1' }))
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('scored 2 mutants, expected 1')
  })

  it('fails when a mutant invocation is absent entirely', () => {
    const root = buildArtifacts()
    rmSync(join(root, '001-mutant'), { recursive: true, force: true })
    const { status, output } = audit(root)
    expect(status).not.toBe(0)
    expect(output).toContain('scored 0 mutants, expected 1')
  })
})
