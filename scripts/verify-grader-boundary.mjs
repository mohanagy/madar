#!/usr/bin/env node
/**
 * #660-A — CLI wrapper for the structural grader/runtime boundary.
 *
 *   npm run verify:grader-boundary
 *
 * The same engine runs as a vitest control (tests/unit/grader-boundary.test.ts)
 * so the boundary is enforced on every protected CI lane, not only on the lane
 * that happens to run extra scripts.
 */
import { analyzeGraderBoundary, formatGraderBoundaryReport } from './lib/grader-boundary.mjs'
import { runGraderBoundarySelfTest } from './lib/grader-boundary-selftest.mjs'

const selfTest = process.argv.includes('--self-test')

const result = analyzeGraderBoundary()
const report = formatGraderBoundaryReport(result)

if (!result.ok) {
  console.error(report)
  process.exit(1)
}

console.log(report)

if (!selfTest) {
  process.exit(0)
}

// Falsifiability: a boundary that has never been shown to fail proves nothing.
console.log('\nGrader boundary falsifiability controls:')
const self = runGraderBoundarySelfTest()
if (!self.ok) {
  console.error('\nGrader boundary controls FAILED. The boundary check is not trustworthy until these pass.')
  process.exit(1)
}
console.log('\nAll grader boundary controls passed.')
process.exit(0)
