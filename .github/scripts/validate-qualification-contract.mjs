import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const ROOT = resolve('docs/qualification')
const FREEZE_PATH = join(ROOT, 'freeze.json')
const PRODUCTION_ROOT = resolve('src')
const WRITE = process.argv.includes('--write')
const VERIFY_CORPUS = process.argv.includes('--verify-corpus')

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
// 2. Targets must be natural and pinned
// ---------------------------------------------------------------------------

const targetsById = new Map(corpus.targets.map((target) => [target.id, target]))

if (!Array.isArray(corpus.proxy_targets)) {
  fail('corpus.json must declare a proxy_targets list, even when empty')
}

for (const target of corpus.targets) {
  if (target.kind === 'sealed') {
    if (target.status !== 'unsatisfied') {
      fail(`sealed target ${target.id} must stay unsatisfied until a second person fills it`)
    }
    continue
  }

  if (target.natural !== true) {
    fail(`target ${target.id} is not marked natural; a fixture proxy must be declared in proxy_targets, not in targets`)
  }
  if (!/^[0-9a-f]{40}$/.test(target.source?.ref ?? '')) {
    fail(`target ${target.id} must pin an immutable 40-character commit SHA`)
  }
  if (!target.source?.url?.startsWith('https://')) {
    fail(`target ${target.id} must record an https repository URL`)
  }
  if (!target.license) {
    fail(`target ${target.id} must record a license`)
  }
  if (!Array.isArray(target.prepare) || target.prepare.length === 0) {
    fail(`target ${target.id} must record reproducible prepare steps`)
  }
  if (!target.dependency_lock) {
    fail(`target ${target.id} must record a dependency lock policy`)
  }
  if (!target.cited_blobs || Object.keys(target.cited_blobs).length === 0) {
    fail(`target ${target.id} must record cited_blobs so truth citations can be checked offline`)
  }
  for (const [path, blob] of Object.entries(target.cited_blobs ?? {})) {
    if (!/^[0-9a-f]{40}$/.test(blob)) {
      fail(`target ${target.id} cited_blobs["${path}"] is not a git blob SHA`)
    }
  }

  if (target.kind === 'git_patched') {
    const base = targetsById.get(target.base_target)
    if (!base) {
      fail(`patched target ${target.id} references unknown base_target ${target.base_target}`)
    } else if (base.source.ref !== target.source.ref) {
      fail(`patched target ${target.id} must pin the same commit as its base target`)
    }

    const patchPath = join(ROOT, target.patch ?? '')
    let patch
    try {
      patch = readFileSync(patchPath, 'utf8')
    } catch {
      fail(`patched target ${target.id} references missing patch ${target.patch}`)
    }

    if (patch) {
      // Parse against normalized text so a CRLF checkout cannot capture a stray
      // carriage return into a path. The digest check further down still reads raw
      // bytes; only this structural parse is representation-independent.
      const patchText = patch.replace(/\r\n/g, '\n')

      if (!patchText.startsWith('diff --git ')) {
        fail(`patch ${target.patch} is not a unified git diff`)
      }
      if (patch.includes('\r\n')) {
        fail(`patch ${target.patch} contains CRLF line endings; it must stay LF so \`git apply\` accepts it`)
      }
      const touched = [...patchText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1])
      if (touched.length === 0) {
        fail(`patch ${target.patch} does not modify any file`)
      }
      for (const path of touched) {
        if (!(path in (target.cited_blobs ?? {}))) {
          fail(`patch ${target.patch} touches ${path}, which is not recorded in ${target.id} cited_blobs`)
        }
      }
    }
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
    if (!Array.isArray(provenance.derived_from) || provenance.derived_from.length === 0) {
      fail(`task ${task.id} truth provenance must record what the truth was derived from`)
    }
    if (!('independent_of_production_rule_author' in provenance)) {
      fail(`task ${task.id} truth provenance must state whether the author is independent of the production-rule author`)
    }
  }

  // Every cited evidence path must be recorded in the target's frozen blob map.
  // `new_path` is used for files a plan proposes creating and is intentionally exempt.
  const citedPaths = new Set()
  const collect = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collect)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'path' && typeof value === 'string') citedPaths.add(value)
        else if (key !== 'new_path') collect(value)
      }
    }
  }
  collect(truth)

  for (const cited of citedPaths) {
    if (!(cited in (target.cited_blobs ?? {}))) {
      fail(`${task.truth_ref} cites ${cited}, which is not recorded in target ${target.id} cited_blobs`)
    }
  }

  const obligations = truth.tier1_obligations
  if (!obligations) {
    fail(`${task.truth_ref} has no tier1_obligations block`)
  } else if (!Array.isArray(obligations.must_not_report_ready_when) || obligations.must_not_report_ready_when.length === 0) {
    fail(`${task.truth_ref} must declare at least one must_not_report_ready_when condition`)
  }

  if (!rubrics.methods[task.scoring.tier2_method]) {
    fail(`task ${task.id} references unknown rubric method ${task.scoring.tier2_method}`)
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

for (const path of walk(join(ROOT, 'examples'))) {
  const receipt = readJson(path)
  const label = relative(process.cwd(), path)

  if (!validateReceipt(receipt)) {
    fail(`${label} does not satisfy receipt-schema.json: ${ajv.errorsText(validateReceipt.errors)}`)
  }
  if (receipt.validity.status !== 'valid' && receipt.validity.aggregatable !== false) {
    fail(`${label} is not valid but is marked aggregatable`)
  }
  for (const [name, score] of Object.entries(receipt.scores)) {
    if (score.measured === false && score.value !== null) {
      fail(`${label} score ${name} is not measured but carries a value`)
    }
  }

  const task = tasksById.get(receipt.task_id)
  if (!task) {
    fail(`${label} references unknown task ${receipt.task_id}`)
  } else if (receipt.identity.prompts.user_prompt_sha256 !== task.prompt.sha256) {
    fail(`${label} records a prompt hash that does not match the frozen prompt for ${receipt.task_id}`)
  }
}

// ---------------------------------------------------------------------------
// 7. Benchmark independence: no qualification literal may reach production code
// ---------------------------------------------------------------------------

// Bare target ids are deliberately NOT forbidden. A target id may legitimately equal the
// name of a framework Madar declares generic support for — `hono` is one — and banning the
// word would confuse a declared adapter with a benchmark-specific special case. Those
// couplings are disclosed per target in corpus.json#/targets/*/production_coupling instead.
// What is forbidden here is every literal that could only have come from this contract.
//
// `_`-prefixed keys in forbidden_target_symbols are documentation, not symbols. Folding a
// prose note into this list would make the guard fail production files the moment that note
// were shortened to something short or common, so the keys are skipped and every remaining
// entry is required to be an array of plausible identifiers.
const targetSymbols = []
for (const [key, value] of Object.entries(corpus.forbidden_target_symbols ?? {})) {
  if (key.startsWith('_')) {
    continue
  }
  if (!Array.isArray(value)) {
    fail(`corpus.json forbidden_target_symbols["${key}"] must be an array of symbols`)
    continue
  }
  for (const symbol of value) {
    if (typeof symbol !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
      fail(`corpus.json forbidden_target_symbols["${key}"] contains ${JSON.stringify(symbol)}, which is not an identifier`)
      continue
    }
    targetSymbols.push(symbol)
  }
  if (!targetsById.has(key)) {
    fail(`corpus.json forbidden_target_symbols["${key}"] does not name a corpus target`)
  }
}

const FORBIDDEN_LITERALS = [
  ...corpus.targets.flatMap((target) => (target.source?.url ? [target.source.url, target.source.ref] : [])),
  ...tasks.tasks.map((task) => task.id),
  ...tasks.tasks.map((task) => task.prompt.text),
  ...tier1.negative_trust_probes.map((probe) => probe.prompt.text),
  ...targetSymbols,
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
// 8. Optional network verification of the pinned corpus
// ---------------------------------------------------------------------------

if (VERIFY_CORPUS) {
  for (const target of corpus.targets) {
    if (target.kind === 'sealed') {
      continue
    }

    const dir = mkdtempSync(join(tmpdir(), `qualify-${target.id}-`))
    try {
      const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

      execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' })
      git('remote', 'add', 'origin', target.source.url)
      git('fetch', '--quiet', '--depth', '1', 'origin', target.source.ref)
      git('checkout', '--quiet', 'FETCH_HEAD')

      const head = git('rev-parse', 'HEAD')
      if (head !== target.source.ref) {
        fail(`corpus verification: ${target.id} resolved to ${head}, expected ${target.source.ref}`)
      }

      for (const [path, blob] of Object.entries(target.cited_blobs)) {
        const actual = git('rev-parse', `HEAD:${path}`)
        if (actual !== blob) {
          fail(`corpus verification: ${target.id} ${path} blob is ${actual}, expected ${blob}`)
        }
      }

      if (target.kind === 'git_patched') {
        execFileSync('git', ['-C', dir, 'apply', '--check', join(ROOT, target.patch)], { stdio: 'pipe' })
      }

      console.log(`corpus verification: ${target.id} ok`)
    } catch (error) {
      fail(`corpus verification failed for ${target.id}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Freeze digests
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
        const crlf = readFileSync(resolve(path)).includes('\r\n')
        const hint = crlf
          ? ' — the file contains CRLF, so this is a checkout line-ending problem, not a content change.'
            + ' Fix the checkout (see `docs/qualification/** text eol=lf` in .gitattributes); do NOT regenerate freeze.json.'
          : ''
        fail(`${path} content changed since it was frozen (expected ${freeze.files[path]}, actual ${digest})${hint}`)
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

const naturalTargets = corpus.targets.filter((target) => target.kind !== 'sealed')

console.log(
  `qualification contract v${CONTRACT_VERSION} is consistent: ` +
    `${naturalTargets.length} pinned natural targets, ${corpus.proxy_targets.length} proxy targets, ` +
    `${tasks.tasks.length} tasks, ${tier1.cells.length} Tier 1 cells, ` +
    `${tier1.negative_trust_probes.length} negative-trust probes, ${frozenFiles.length} frozen files.`,
)
