#!/usr/bin/env node
/**
 * #660-A — behavioural half of the grader boundary (control G14).
 *
 *   npm run build && npm run verify:grader-boundary-runtime
 *
 * The module-graph guard proves normal product CONSTRUCTION modules cannot
 * reach grader truth. It says nothing about the CLI process as a whole, because
 * one binary legitimately hosts the compare, benchmark and eval commands. This
 * runs the real normal paths with grader truth poisoned and requires their
 * output to be unchanged, which is the property that actually matters.
 *
 * Separate from `verify:grader-boundary-controls` because it needs `dist/`.
 */
import { runGraderTruthNoReadProof } from './lib/grader-boundary-runtime-proof.mjs'

console.log('Grader truth no-read proof for normal product commands:')
const result = await runGraderTruthNoReadProof()

if (!result.ok) {
  console.error('\nNormal product commands did not survive the grader-truth poison. This is terminal for #660-A.')
  process.exit(1)
}

console.log('\nNormal product commands read no grader truth.')
process.exit(0)
