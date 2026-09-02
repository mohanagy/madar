import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const [regressionPath, holdoutPath, outputPath] = process.argv.slice(2)
if (!regressionPath || !holdoutPath || !outputPath) {
  throw new Error('usage: node merge-task-manifests.mjs <regression.json> <holdout.json> <output.json>')
}

const regression = JSON.parse(readFileSync(regressionPath, 'utf8'))
const holdout = JSON.parse(readFileSync(holdoutPath, 'utf8'))
if (regression.status === 'DO_NOT_RUN_UNTIL_FILLED_FROM_ORIGINAL_FROZEN_MD') {
  throw new Error('regression manifest is still the placeholder; recover the original FROZEN.md task text first')
}
if (!Array.isArray(regression.tasks) || regression.tasks.length !== 3) throw new Error('regression manifest must contain exactly three tasks')
if (!Array.isArray(holdout.tasks) || holdout.tasks.length !== 3) throw new Error('holdout manifest must contain exactly three tasks')
for (const task of regression.tasks) {
  if (typeof task.task !== 'string' || task.task.includes('__COPY_EXACT_TASK_TEXT')) {
    throw new Error(`regression task ${task.id ?? 'unknown'} is not populated from the original freeze`)
  }
}

const tasks = [...regression.tasks, ...holdout.tasks]
const ids = new Set()
for (const task of tasks) {
  if (!task || typeof task.id !== 'string' || typeof task.repository !== 'string' || typeof task.revision !== 'string' || typeof task.task !== 'string') {
    throw new Error('every task needs id, repository, revision, and task')
  }
  if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
  ids.add(task.id)
}

const armOrder = { ...regression.arm_order, ...holdout.arm_order }
for (const task of tasks) {
  const order = armOrder[task.id]
  if (!Array.isArray(order) || order.length !== 2 || new Set(order).size !== 2 || !order.includes('native') || !order.includes('madar')) {
    throw new Error(`invalid arm order for ${task.id}`)
  }
}

const canonical = JSON.stringify({ tasks, arm_order: armOrder })
const payload = {
  schema_version: 1,
  candidate_sha: holdout.candidate_sha,
  evaluation_classification: holdout.evaluation_classification,
  regression_source: regression.required_source ?? null,
  arm_order: armOrder,
  tasks,
  manifest_digest: createHash('sha256').update(canonical).digest('hex'),
}
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
console.log(payload.manifest_digest)
