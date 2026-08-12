import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const ROOT = resolve('docs/qualification')
const FREEZE_PATH = join(ROOT, 'freeze.json')
const PRODUCTION_ROOT = resolve('src')
const WRITE = process.argv.includes('--write')

const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function walk(dir) {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full))
    } else {
      entries.push(full)
    }
  }
  return entries
}

const corpus = readJson(join(ROOT, 'corpus.json'))
const tasks = readJson(join(ROOT, 'tasks.json'))
const rubrics = readJson(join(ROOT, 'rubrics.json'))
const tier1 = readJson(join(ROOT, 'tier1.json'))
const tier2 = readJson(join(ROOT, 'tier2-matrix.json'))
const receiptSchema = readJson(join(ROOT, 'receipt-schema.json'))

const CONTRACT_VERSION = corpus.contract_version

// ---------------------------------------------------------------------------
// 1. Contract version agreement
// ---------------------------------------------------------------------------

for (const [name, doc] of [
  ['tasks.json', tasks],
  ['rubrics.json', rubrics],
  ['tier1.json', tier1],
  ['tier2-matrix.json', tier2],
]) {
  if (doc.contract_version !== CONTRACT_VERSION) {
    fail(`${name} declares contract_version ${doc.contract_version}, expected ${CONTRACT_VERSION}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Targets
// ---------------------------------------------------------------------------

const targetsById = new Map(corpus.targets.map((target) => [target.id, target]))
const fixtureTargets = corpus.targets.filter((target) => target.kind === 'fixture')

for (const target of fixtureTargets) {
  try {
    if (!statSync(resolve(target.path)).isDirectory()) {
      fail(`target ${target.id} path ${target.path} is not a directory`)
    }
  } catch {
    fail(`target ${target.id} path ${target.path} does not exist`)
  }
}

for (const target of corpus.targets) {
  if (target.kind === 'git' && !/^[0-9a-f]{40}$/.test(target.source?.ref ?? '')) {
    fail(`git target ${target.id} must pin an immutable 40-character commit SHA`)
  }
  if (target.status === 'pinned_no_truth' && target.tier === 1) {
    fail(`target ${target.id} is Tier 1 but has no independent truth`)
  }
}

// ---------------------------------------------------------------------------
// 3. Tasks, prompts, truth files
// ---------------------------------------------------------------------------

const REQUIRED_CATEGORIES = [
  'architecture-understanding',
  'execution-flow-explanation',
  'impact-analysis',
  'bug-root-cause-investigation',
  'implementation-planning',
  'review-security',
]

const seenCategories = new Set()
const tasksById = new Map()

for (const task of tasks.tasks) {
  tasksById.set(task.id, task)
  seenCategories.add(task.category)

  const target = targetsById.get(task.target)
  if (!target) {
    fail(`task ${task.id} references unknown target ${task.target}`)
    continue
  }

  const actualHash = sha256(task.prompt.text)
  if (actualHash !== task.prompt.sha256) {
    fail(`task ${task.id} prompt hash mismatch: recorded ${task.prompt.sha256}, actual ${actualHash}`)
  }

  const truthPath = join(ROOT, task.truth_ref)
  let truth
  try {
    truth = readJson(truthPath)
  } catch {
    fail(`task ${task.id} truth file ${task.truth_ref} is missing or unreadable`)
    continue
  }

  if (truth.task_id !== task.id) fail(`${task.truth_ref} declares task_id ${truth.task_id}, expected ${task.id}`)
  if (truth.target !== task.target) fail(`${task.truth_ref} declares target ${truth.target}, expected ${task.target}`)
  if (truth.category !== task.category) fail(`${task.truth_ref} declares category ${truth.category}, expected ${task.category}`)
  if (truth.contract_version !== CONTRACT_VERSION) fail(`${task.truth_ref} declares contract_version ${truth.contract_version}`)

  // Independence: truth must not be derived from Madar output.
  for (const provenance of [task.truth_provenance, truth.provenance]) {
    if (provenance.inspected_madar_output_before_freeze !== false) {
      fail(`task ${task.id} truth provenance claims Madar output was inspected before freezing`)
    }
    if (!Array.isArray(provenance.madar_derived_sources_used) || provenance.madar_derived_sources_used.length > 0) {
      fail(`task ${task.id} truth provenance lists Madar-derived sources: ${JSON.stringify(provenance.madar_derived_sources_used)}`)
    }
    if (!provenance.authored_by || !provenance.authored_at) {
      fail(`task ${task.id} truth provenance must record who authored the truth and when`)
    }
    if (!('independent_of_production_rule_author' in provenance)) {
      fail(`task ${task.id} truth provenance must state whether the author is independent of the production-rule author`)
    }
  }

  // Every cited evidence path must exist inside the target workspace.
  const citedPaths = new Set()
  const collect = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collect)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'path' && typeof value === 'string') citedPaths.add(value)
        else collect(value)
      }
    }
  }
  collect(truth)

  for (const cited of citedPaths) {
    const full = resolve(target.path, cited)
    try {
      statSync(full)
    } catch {
      fail(`${task.truth_ref} cites ${cited}, which does not exist in target ${target.id}`)
    }
  }

  const obligations = truth.tier1_obligations
  if (!obligations) {
    fail(`${task.truth_ref} has no tier1_obligations block`)
  } else if (!Array.isArray(obligations.must_not_report_ready_when) || obligations.must_not_report_ready_when.length === 0) {
    fail(`${task.truth_ref} must declare at least one must_not_report_ready_when condition`)
  }

  const rubricMethod = task.scoring.tier2_method
  if (!rubrics.methods[rubricMethod]) {
    fail(`task ${task.id} references unknown rubric method ${rubricMethod}`)
  }
  if (!rubrics.methods[task.scoring.tier1_method]) {
    fail(`task ${task.id} references unknown tier1 method ${task.scoring.tier1_method}`)
  }
}

for (const category of REQUIRED_CATEGORIES) {
  if (!seenCategories.has(category)) {
    fail(`no frozen task covers required category ${category}`)
  }
}

// ---------------------------------------------------------------------------
// 4. Tier 1 subset and negative-trust probes
// ---------------------------------------------------------------------------

for (const cell of tier1.cells) {
  const task = tasksById.get(cell.task_id)
  if (!task) {
    fail(`tier1 cell references unknown task ${cell.task_id}`)
    continue
  }
  if (task.target !== cell.target_id) {
    fail(`tier1 cell ${cell.task_id} targets ${cell.target_id} but the task targets ${task.target}`)
  }
  if (!task.tiers.includes(1)) {
    fail(`tier1 cell ${cell.task_id} refers to a task that does not declare tier 1`)
  }
}

for (const probe of tier1.negative_trust_probes) {
  const actual = sha256(probe.prompt.text)
  if (actual !== probe.prompt.sha256) {
    fail(`negative-trust probe ${probe.id} prompt hash mismatch: recorded ${probe.prompt.sha256}, actual ${actual}`)
  }
  if (!targetsById.has(probe.target_id)) {
    fail(`negative-trust probe ${probe.id} references unknown target ${probe.target_id}`)
  }
}

// ---------------------------------------------------------------------------
// 5. Tier 2 matrix references
// ---------------------------------------------------------------------------

for (const id of tier2.dimensions.targets) {
  if (!targetsById.has(id)) fail(`tier2 matrix references unknown target ${id}`)
}
for (const id of tier2.dimensions.tasks) {
  if (!tasksById.has(id)) fail(`tier2 matrix references unknown task ${id}`)
}
if (tier2.status !== 'planned') {
  fail('tier2-matrix.json must stay planned until its execution prerequisites are met')
}

// ---------------------------------------------------------------------------
// 6. Receipt schema and examples
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validateReceipt = ajv.compile(receiptSchema)

const examplesDir = join(ROOT, 'examples')
for (const path of walk(examplesDir)) {
  const receipt = readJson(path)
  if (!validateReceipt(receipt)) {
    fail(`${relative(process.cwd(), path)} does not satisfy receipt-schema.json: ${ajv.errorsText(validateReceipt.errors)}`)
  }
  if (receipt.validity.status !== 'valid' && receipt.validity.aggregatable !== false) {
    fail(`${relative(process.cwd(), path)} is not valid but is marked aggregatable`)
  }
  for (const [name, score] of Object.entries(receipt.scores)) {
    if (score.measured === false && score.value !== null) {
      fail(`${relative(process.cwd(), path)} score ${name} is not measured but carries a value`)
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Benchmark independence: no qualification literal may reach production code
// ---------------------------------------------------------------------------

const FORBIDDEN_LITERALS = [
  ...corpus.targets.map((target) => target.id),
  ...fixtureTargets.map((target) => target.path),
  ...tasks.tasks.map((task) => task.id),
  ...tasks.tasks.map((task) => task.prompt.text),
  ...tier1.negative_trust_probes.map((probe) => probe.prompt.text),
  'LedgerService',
  'IdempotencyStore',
  'OutboxPublisher',
  'BalanceProjection',
  'assertAccountAccess',
  'CsvExportPlugin',
  'WebhookExportPlugin',
  'runExportLifecycle',
  'builtInPlugins',
]

for (const path of walk(PRODUCTION_ROOT)) {
  const content = readFileSync(path, 'utf8')
  for (const literal of FORBIDDEN_LITERALS) {
    if (content.includes(literal)) {
      fail(`production file ${relative(process.cwd(), path)} contains qualification literal "${literal}"`)
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Freeze digests
// ---------------------------------------------------------------------------

const frozenFiles = walk(ROOT)
  .filter((path) => path !== FREEZE_PATH)
  .map((path) => relative(process.cwd(), path).split('\\').join('/'))
  .sort()

const digests = Object.fromEntries(
  frozenFiles.map((path) => [path, sha256(readFileSync(resolve(path)))]),
)

if (WRITE) {
  const freeze = {
    contract_version: CONTRACT_VERSION,
    frozen_at: corpus.frozen_at,
    algorithm: 'sha256 over raw file bytes',
    note: 'Regenerate deliberately with `npm run qualify:validate -- --write` and say why in the pull request. A silent digest change is a contract change.',
    files: digests,
  }
  writeFileSync(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`)
  console.log(`wrote ${relative(process.cwd(), FREEZE_PATH)} with ${frozenFiles.length} entries`)
} else {
  let freeze
  try {
    freeze = readJson(FREEZE_PATH)
  } catch {
    fail('freeze.json is missing; run `npm run qualify:validate -- --write`')
  }

  if (freeze) {
    if (freeze.contract_version !== CONTRACT_VERSION) {
      fail(`freeze.json declares contract_version ${freeze.contract_version}, expected ${CONTRACT_VERSION}`)
    }
    for (const [path, digest] of Object.entries(digests)) {
      if (!(path in freeze.files)) {
        fail(`${path} is not covered by freeze.json`)
      } else if (freeze.files[path] !== digest) {
        fail(`${path} content changed since it was frozen (expected ${freeze.files[path]}, actual ${digest})`)
      }
    }
    for (const path of Object.keys(freeze.files)) {
      if (!(path in digests)) {
        fail(`freeze.json references ${path}, which no longer exists`)
      }
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`qualification contract validation failed with ${failures.length} problem(s):`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  `qualification contract v${CONTRACT_VERSION} is consistent: ` +
    `${corpus.targets.length} targets, ${tasks.tasks.length} tasks, ` +
    `${tier1.cells.length} Tier 1 cells, ${tier1.negative_trust_probes.length} negative-trust probes, ` +
    `${frozenFiles.length} frozen files.`,
)
