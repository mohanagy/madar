#!/usr/bin/env node
/**
 * Standalone semantic audit of a mutation-evidence directory.
 *
 * Runs without re-running anything, so a matrix can be audited long after the
 * fact and by someone who did not produce it. The audit re-derives suite
 * attribution, scoring class and restoration truth from the raw artifacts; a
 * stored conclusion that the evidence does not support is a failure, not a
 * detail.
 *
 * Usage:
 *   node scripts/audit-mutation-evidence.mjs <artifact-root>
 *     [--expect-mutants N] [--expect-baselines N] [--run-id ID]
 *     [--source-root DIR] [--json OUT]
 *
 * Exit 0 only when the evidence is complete, self-consistent and semantically
 * supported.
 */
import { writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { auditEvidence } from './lib/evidence-audit.mjs'

const ROOT = process.cwd()
const argv = process.argv.slice(2)

const usage = (message) => {
  console.error(`audit-mutation-evidence.mjs: ${message}`)
  console.error('usage: audit-mutation-evidence.mjs <artifact-root> [--expect-mutants N] [--expect-baselines N]')
  process.exit(2)
}

/**
 * A flag's value, or null when the flag was not given.
 *
 * A flag written last on the command line has no following argument, and
 * `argv[index + 1]` is then `undefined`. Every downstream check compares
 * against `=== null`, so `undefined` slipped past all of them: an absent value
 * was neither treated as "not supplied" nor rejected. `--expect-mutants` with
 * nothing after it reached `Number(undefined)` and became NaN, and a NaN
 * expectation compares false against every real count, so the audit could not
 * confirm or deny the number it was asked about.
 *
 * A flag given without a value is a usage error, not a silent default.
 */
const flag = (name) => {
  const index = argv.indexOf(name)
  if (index < 0) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) usage(`${name} requires a value`)
  return value
}

const number = (name) => {
  const value = flag(name)
  if (value === null) return null
  const parsed = Number(value)
  // NaN would silently disable the very expectation the caller asked for.
  if (!Number.isFinite(parsed)) usage(`${name} expects a number, got ${JSON.stringify(value)}`)
  return parsed
}

// The first bare argument, skipping any value that belongs to a flag.
let target
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index].startsWith('--')) { index += 1; continue }
  target = argv[index]
  break
}

if (target === undefined) {
  console.error('usage: audit-mutation-evidence.mjs <artifact-root> [--expect-mutants N] [--expect-baselines N]')
  process.exit(2)
}

const root = resolve(ROOT, target)
const result = auditEvidence({
  root,
  sourceRoot: resolve(ROOT, flag('--source-root') ?? '.'),
  expectedMutants: number('--expect-mutants'),
  expectedBaselines: number('--expect-baselines'),
  runId: flag('--run-id'),
})

const jsonOut = flag('--json')
if (jsonOut !== null) {
  // Run-specific: identities and paths belong here, not in the semantic digest.
  writeFileSync(resolve(ROOT, jsonOut), `${JSON.stringify({
    artifact_root: relative(ROOT, root),
    invocations: result.invocations,
    problems: result.problems,
    semantic_audit_digest: result.semanticDigest,
  }, null, 2)}\n`)
}

if (result.problems.length > 0) {
  console.error(`SEMANTIC AUDIT FAILED (${result.problems.length} problem(s)):`)
  for (const problem of result.problems) {
    console.error(`  [${problem.code}] ${problem.invocation ?? '(matrix)'}: ${problem.detail}`)
  }
  process.exit(1)
}

console.log(`semantic audit OK: ${result.invocations.length} invocations `
  + `(${result.mutants} mutants, ${result.baselines} baselines)`)
console.log(`semantic audit digest  ${result.semanticDigest}`)
process.exit(0)
