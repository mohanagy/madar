#!/usr/bin/env node
// Compare two independently prepared Tier 1 baseline runs.
//
//   node scripts/qualify-tier1-compare.mjs <run-a-dir> <run-b-dir>
//
// Exit 0 when the two runs are semantically identical; exit 1 otherwise, naming
// the SMALLEST differing field so a disagreement can be localised rather than
// merely reported. Declared-volatile fields are excluded by construction: the
// semantic digest never covers them.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [aDir, bDir] = process.argv.slice(2)
if (!aDir || !bDir) {
  console.error('usage: qualify-tier1-compare.mjs <run-a-dir> <run-b-dir>')
  process.exit(1)
}

const load = (dir) => JSON.parse(readFileSync(join(resolve(dir), 'result.json'), 'utf8'))
const a = load(aDir)
const b = load(bDir)

const differences = []

function compare(path, left, right) {
  if (JSON.stringify(left) === JSON.stringify(right)) return
  const bothObjects = left && right && typeof left === 'object' && typeof right === 'object'
    && Array.isArray(left) === Array.isArray(right)
  if (bothObjects) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    for (const key of keys) compare(`${path}.${key}`, left[key], right[key])
    return
  }
  differences.push({ field: path, run_a: left, run_b: right })
}

// Cell population and per-cell semantics.
const cellIds = (result) => result.cells.map((cell) => cell.cell_id).sort()
compare('cell_population', cellIds(a), cellIds(b))

const byId = (result) => Object.fromEntries(result.cells.map((cell) => [cell.cell_id, cell]))
const aCells = byId(a)
const bCells = byId(b)
for (const id of cellIds(a)) {
  const left = aCells[id]
  const right = bCells[id]
  if (!right) { differences.push({ field: `cells.${id}`, run_a: 'present', run_b: 'absent' }); continue }
  for (const field of ['state', 'expected', 'observed', 'metrics', 'reasons', 'target_sha', 'patch_digest', 'prompt_sha256', 'truth_version']) {
    compare(`cells.${id}.${field}`, left[field], right[field])
  }
  compare(`cells.${id}.graph_identity.identity_digest`, left.graph_identity?.identity_digest, right.graph_identity?.identity_digest)
}

compare('totals', a.totals, b.totals)
compare('frozen_input_manifest.digest', a.frozen_input_manifest.digest, b.frozen_input_manifest.digest)
compare('semantic_digest', a.semantic_digest, b.semantic_digest)

console.log(`run A: pass ${a.totals.pass} / fail ${a.totals.fail} / invalid ${a.totals.invalid}  digest ${a.semantic_digest}`)
console.log(`run B: pass ${b.totals.pass} / fail ${b.totals.fail} / invalid ${b.totals.invalid}  digest ${b.semantic_digest}`)

if (differences.length === 0) {
  console.log('runs are semantically identical: yes')
  process.exit(0)
}
console.error(`runs are semantically identical: NO — ${differences.length} differing field(s)`)
// Smallest differing field first: the deepest path is the most localised.
differences.sort((x, y) => y.field.split('.').length - x.field.split('.').length || x.field.localeCompare(y.field))
for (const difference of differences.slice(0, 20)) {
  console.error(`  ${difference.field}\n    A: ${JSON.stringify(difference.run_a)}\n    B: ${JSON.stringify(difference.run_b)}`)
}
console.error(`smallest differing field: ${differences[0].field}`)
process.exit(1)
