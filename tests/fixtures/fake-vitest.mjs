#!/usr/bin/env node
/**
 * Stands in for Vitest so the exact-manifest runner's failure paths can be
 * driven deterministically.
 *
 * Reached through the repository's existing `VITEST_GUARD_EXEC_OVERRIDE` seam,
 * so the controls exercise the real guarded path rather than a parallel one.
 * Each mode reproduces one way a run can look successful while having proved
 * nothing -- which is precisely the class of defect the runner exists to catch.
 */
import { rmSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env['MADAR_FAKE_VITEST_MODE'] ?? 'ok'
const outputArg = args.find((arg) => arg.startsWith('--outputFile='))
const outputFile = outputArg?.slice('--outputFile='.length)
const requested = args.find((arg) => arg.endsWith('.test.ts')) ?? 'unknown.test.ts'

const report = (name, assertions) => JSON.stringify({
  numTotalTestSuites: 1,
  numTotalTests: assertions.length,
  testResults: [{ name, assertionResults: assertions }],
})

const passing = [{ fullName: 'fake passing test', status: 'passed', title: 'fake passing test' }]

switch (mode) {
  case 'ok':
    writeFileSync(outputFile, report(requested, passing))
    process.exit(0)
    break

  case 'no-report':
    // Exits cleanly having written nothing at all.
    process.exit(0)
    break

  case 'unreadable':
    writeFileSync(outputFile, '{ this is not valid json')
    process.exit(0)
    break

  case 'empty':
    // A report that ran the right module but discovered no tests.
    writeFileSync(outputFile, report(requested, []))
    process.exit(0)
    break

  case 'wrong-module':
    writeFileSync(outputFile, report('tests/unit/some-other-file.test.ts', passing))
    process.exit(0)
    break

  case 'extra-module':
    writeFileSync(outputFile, JSON.stringify({
      numTotalTestSuites: 2,
      testResults: [
        { name: requested, assertionResults: passing },
        { name: 'tests/unit/injected-extra.test.ts', assertionResults: passing },
      ],
    }))
    process.exit(0)
    break

  case 'exit0-no-module':
    // The shape that matters most: success, no module, no complaint.
    writeFileSync(outputFile, JSON.stringify({ numTotalTestSuites: 0, testResults: [] }))
    process.exit(0)
    break

  case 'worker-start':
    process.stderr.write('Failed to start forks worker\n')
    writeFileSync(outputFile, report(requested, passing))
    process.exit(0)
    break

  case 'handshake':
    process.stderr.write('Timeout waiting for worker to respond\n')
    writeFileSync(outputFile, report(requested, passing))
    process.exit(0)
    break

  case 'duplicate-module':
    // Two result rows naming the SAME requested module. Set equality cannot
    // see this: every requested module ran, none unrequested did, and the
    // module still ran twice.
    writeFileSync(outputFile, JSON.stringify({
      numTotalTestSuites: 2,
      testResults: [
        { name: requested, assertionResults: passing },
        { name: requested, assertionResults: passing },
      ],
    }))
    process.exit(0)
    break

  case 'delete-after-write':
    // Written, then removed: distinct from never writing one, and the shape a
    // racing cleanup produces.
    writeFileSync(outputFile, report(requested, passing))
    rmSync(outputFile, { force: true })
    process.exit(0)
    break

  case 'clean-report-nonzero-exit':
    // The mirror of failed-but-exit0: the report claims success, the process
    // says otherwise. One of the two is lying either way.
    writeFileSync(outputFile, report(requested, passing))
    process.exit(4)
    break

  case 'failed-but-exit0':
    writeFileSync(outputFile, report(requested, [
      { fullName: 'fake failing test', status: 'failed', title: 'fake failing test' },
    ]))
    process.exit(0)
    break

  default:
    process.stderr.write(`unknown fake mode: ${mode}\n`)
    process.exit(3)
}
