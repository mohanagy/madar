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

const write = (assertions) => writeFileSync(outputFile, JSON.stringify({
  numTotalTestSuites: 1,
  numTotalTests: assertions.length,
  testResults: [{ name: requested, assertionResults: assertions }],
}))

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
      write([{ fullName: testName, status: 'passed', title: testName }])
      process.exit(0)
      break
    case 'chmod-readonly':
      // Makes restoration fail: the harness writes the original bytes back and
      // the write is refused, so the mutation survives on disk. That is the
      // exact state the three-state digest record has to tell the truth about.
      write([{ fullName: testName, status: 'failed', title: testName }])
      chmodSync(targetPath, 0o444)
      process.exit(1)
      break
    default:
      process.stderr.write(`unknown stub fault: ${fault}\n`)
      process.exit(3)
  }
} else if (mutated) {
  write([{ fullName: testName, status: 'failed', title: testName }])
  process.exit(1)
} else {
  write([{ fullName: testName, status: 'passed', title: testName }])
  process.exit(0)
}
