#!/usr/bin/env node
/**
 * #660-B -- CLI wrapper for the production independence scan.
 *
 *   npm run verify:forbidden-knowledge
 *   npm run verify:forbidden-knowledge-controls   (adds the falsifiability run)
 *
 * The same engine runs as a vitest control (tests/unit/forbidden-knowledge.test.ts)
 * so the boundary is enforced on every protected CI lane, not only on the lane
 * that happens to run extra scripts.
 */
import { analyzeForbiddenKnowledge, formatForbiddenKnowledgeReport } from './lib/forbidden-knowledge.mjs'
import { runForbiddenKnowledgeSelfTest } from './lib/forbidden-knowledge-selftest.mjs'
import { runSemanticIndependenceSelfTest } from './lib/semantic-independence-selftest.mjs'

const selfTest = process.argv.includes('--self-test')

const result = analyzeForbiddenKnowledge()
const report = formatForbiddenKnowledgeReport(result)

if (!result.ok) {
  console.error(report)
  process.exit(1)
}

console.log(report)

if (!selfTest) {
  process.exit(0)
}

// Falsifiability: a guard that has never been shown to fail proves nothing.
console.log('\nProduction independence falsifiability controls:')
const self = runForbiddenKnowledgeSelfTest()
if (!self.ok) {
  console.error('\nLiteral-scan controls FAILED. The scan is not trustworthy until these pass.')
  process.exit(1)
}

// The scanner cannot see task-phrase or forced-selection contamination, so the
// behavioural tests that DO own it have to be shown to fail when it returns.
console.log('\nSemantic independence falsifiability controls:')
const semantic = runSemanticIndependenceSelfTest()
if (!semantic.ok) {
  console.error('\nSemantic controls FAILED. The behavioural tests do not own the contamination they claim to.')
  process.exit(1)
}

console.log('\nAll production independence controls passed.')
process.exit(0)
