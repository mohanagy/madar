#!/usr/bin/env node
/**
 * Stands in for Vitest inside the mutation harness's controls.
 *
 * It decides pass/fail the way a real suite would: by looking at the source
 * file on disk. When the marker is present the target is mutated, so the named
 * test "fails"; when it is absent the target is pristine, so the suite is
 * green. That is what makes a baseline green and a mutant red in the SAME
 * process, without the control having to pre-declare which invocation is which.
 *
 * Faults are gated on the mutated state for the same reason: injecting them
 * unconditionally would break the baseline too, and a harness that never gets a
 * green baseline never reaches the code the control is trying to exercise.
 *
 * Env:
 *   MADAR_STUB_TARGET     source file to inspect, relative to cwd
 *   MADAR_STUB_MARKER     substring whose presence means "mutated"
 *   MADAR_STUB_TEST_NAME  test identity to report
 *   MADAR_STUB_FAULT      when mutated: no-report | hang | signal | worker-start | chmod-readonly
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const outputArg = args.find((arg) => arg.startsWith('--outputFile='))
const outputFile = outputArg?.slice('--outputFile='.length)
const requested = args.find((arg) => arg.endsWith('.test.ts')) ?? 'unknown.test.ts'

const targetPath = resolve(process.cwd(), process.env['MADAR_STUB_TARGET'] ?? '')
const marker = process.env['MADAR_STUB_MARKER'] ?? '__MUTATED__'
const testName = process.env['MADAR_STUB_TEST_NAME'] ?? 'stub invariant test'
const fault = process.env['MADAR_STUB_FAULT'] ?? null

let source = ''
try {
  source = readFileSync(targetPath, 'utf8')
} catch {
  // A missing target is itself a mutated-looking state; report it as such
  // rather than pretending the suite passed.
  source = marker
}
const mutated = source.includes(marker)

/**
 * Emits the FAITHFUL vitest 4.1.10 report shape.
 *
 * It used to emit only `numTotalTestSuites`, `numTotalTests` and a file row
 * with a name and assertions. That was a second source of structurally
 * incomplete reports, and it is why a validator written against the real shape
 * would have rejected this fixture's own output. The fixture conforms to the
 * reporter contract, not the other way round.
 */
const write = (assertions) => {
  const failed = assertions.filter((a) => a.status === 'failed').length
  const passed = assertions.filter((a) => a.status === 'passed').length
  const pending = assertions.length - failed - passed
  const now = Date.now()
  writeFileSync(outputFile, JSON.stringify({
    numTotalTestSuites: 1,
    numPassedTestSuites: failed > 0 ? 0 : 1,
    numFailedTestSuites: failed > 0 ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: assertions.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: 0,
    snapshot: { added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0, didUpdate: false },
    startTime: now,
    success: failed === 0,
    testResults: [{
      assertionResults: assertions,
      startTime: now,
      endTime: now,
      status: failed > 0 ? 'failed' : 'passed',
      message: '',
      name: requested,
    }],
  }))
}

/** One assertion row in the faithful shape. */
const assertionRow = (name, status) => ({
  ancestorTitles: [],
  fullName: name,
  status,
  title: name,
  duration: 1,
  failureMessages: status === 'failed' ? [`stub: ${name} failed`] : [],
  meta: {},
  tags: [],
})

if (mutated && fault !== null) {
  switch (fault) {
    case 'no-report':
      // Exits cleanly having written nothing: the shape where a "successful"
      // invocation proves nothing at all.
      process.exit(0)
      break
    case 'hang':
      // Never exits. The harness's timeout is what must produce the evidence.
      setInterval(() => {}, 1000)
      break
    case 'signal':
      process.kill(process.pid, 'SIGKILL')
      break
    case 'worker-start':
      process.stderr.write('Failed to start forks worker\n')
      write([assertionRow(testName, 'passed')])
      process.exit(0)
      break
    case 'chmod-readonly':
      // Makes restoration fail: the harness writes the original bytes back and
      // the write is refused, so the mutation survives on disk. That is the
      // exact state the three-state digest record has to tell the truth about.
      write([assertionRow(testName, 'failed')])
      chmodSync(targetPath, 0o444)
      process.exit(1)
      break
    default:
      process.stderr.write(`unknown stub fault: ${fault}\n`)
      process.exit(3)
  }
} else if (mutated) {
  write([assertionRow(testName, 'failed')])
  process.exit(1)
} else {
  write([assertionRow(testName, 'passed')])
  process.exit(0)
}
