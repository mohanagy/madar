// Frozen-input inventory for the Tier 1 qualification contract.
//
// Every referenced file is DERIVED by following references out of the contract
// documents, never read from a hand-maintained list: a list can silently drift
// from what the contract actually points at, and the drift is exactly what this
// manifest exists to detect.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const CONTRACT_DIR = 'docs/qualification'

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function relPath(root, path) {
  return relative(root, path).split('\\').join('/')
}

export function readJson(root, rel) {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8'))
}

/**
 * Build the frozen-input manifest.
 *
 * Returns { files, contractVersion, referencedIds, crossReference, digest, problems }.
 * `problems` is non-empty when the frozen inputs are internally inconsistent; the
 * caller must refuse to measure rather than repairing the contract.
 */
export function buildFrozenManifest(root) {
  const problems = []
  const contractRoot = resolve(root, CONTRACT_DIR)

  const corpus = readJson(root, `${CONTRACT_DIR}/corpus.json`)
  const tasks = readJson(root, `${CONTRACT_DIR}/tasks.json`)
  const rubrics = readJson(root, `${CONTRACT_DIR}/rubrics.json`)
  const tier1 = readJson(root, `${CONTRACT_DIR}/tier1.json`)
  const freeze = readJson(root, `${CONTRACT_DIR}/freeze.json`)

  const contractVersion = corpus.contract_version
  for (const [label, doc] of [['tasks.json', tasks], ['rubrics.json', rubrics], ['tier1.json', tier1]]) {
    if (doc.contract_version !== contractVersion) {
      problems.push(`${label} declares contract_version ${doc.contract_version}, corpus declares ${contractVersion}`)
    }
  }

  // ---- Derive referenced files -------------------------------------------
  // Start from the documents themselves, then follow every reference they make.
  const referenced = new Set([
    `${CONTRACT_DIR}/corpus.json`,
    `${CONTRACT_DIR}/tasks.json`,
    `${CONTRACT_DIR}/rubrics.json`,
    `${CONTRACT_DIR}/tier1.json`,
    `${CONTRACT_DIR}/freeze.json`,
  ])

  // corpus.json -> patches (resolved against patch_path_base, per corpus.json)
  const patchBase = corpus.patch_path_base ?? `${CONTRACT_DIR}/`
  for (const target of corpus.targets) {
    if (target.patch) referenced.add(`${patchBase}${target.patch}`.replace(/\/+/g, '/'))
  }

  // tier1.json -> the machine-checkable adjudication companion
  if (tier1.adjudication_ref) referenced.add(`${CONTRACT_DIR}/${tier1.adjudication_ref}`)

  // tasks.json -> truth files (resolved against the contract dir)
  for (const task of tasks.tasks) {
    if (task.truth_ref) referenced.add(`${CONTRACT_DIR}/${task.truth_ref}`)
  }

  // ---- ID resolution ------------------------------------------------------
  const targetsById = new Map()
  for (const target of corpus.targets) {
    if (targetsById.has(target.id)) problems.push(`duplicate target id ${target.id}`)
    targetsById.set(target.id, target)
  }
  const tasksById = new Map()
  for (const task of tasks.tasks) {
    if (tasksById.has(task.id)) problems.push(`duplicate task id ${task.id}`)
    tasksById.set(task.id, task)
  }

  for (const task of tasks.tasks) {
    if (!targetsById.has(task.target)) problems.push(`task ${task.id} references unknown target ${task.target}`)
    const method = task.scoring?.tier1_method
    if (method && !rubrics.methods[method]) problems.push(`task ${task.id} references unknown tier1 method ${method}`)
  }

  for (const target of corpus.targets) {
    if (target.base_target && !targetsById.has(target.base_target)) {
      problems.push(`target ${target.id} references unknown base_target ${target.base_target}`)
    }
  }

  // ---- Tier 1 cell population --------------------------------------------
  const cells = []
  const seenCells = new Set()
  for (const cell of tier1.cells) {
    const key = `${cell.task_id}@${cell.target_id}`
    if (seenCells.has(key)) problems.push(`duplicate tier1 cell ${key}`)
    seenCells.add(key)
    const task = tasksById.get(cell.task_id)
    if (!task) { problems.push(`tier1 cell references unknown task ${cell.task_id}`); continue }
    if (!targetsById.has(cell.target_id)) { problems.push(`tier1 cell references unknown target ${cell.target_id}`); continue }
    if (!rubrics.methods[cell.method]) problems.push(`tier1 cell ${key} references unknown method ${cell.method}`)
    cells.push({ ...cell, cell_id: key })
  }

  const probes = []
  const seenProbes = new Set()
  for (const probe of tier1.negative_trust_probes) {
    if (seenProbes.has(probe.id)) problems.push(`duplicate negative probe id ${probe.id}`)
    seenProbes.add(probe.id)
    if (!targetsById.has(probe.target_id)) problems.push(`negative probe ${probe.id} references unknown target ${probe.target_id}`)
    probes.push(probe)
  }

  // Orphan check: a frozen task carrying a tier-1 scoring method but no cell.
  for (const task of tasks.tasks) {
    if (!task.tiers?.includes(1)) continue
    if (!cells.some((cell) => cell.task_id === task.id)) {
      problems.push(`orphaned tier1 task ${task.id}: declares tier 1 but no tier1.json cell references it`)
    }
  }

  // ---- Prompt hashes ------------------------------------------------------
  for (const cell of cells) {
    const task = tasksById.get(cell.task_id)
    const actual = sha256(Buffer.from(task.prompt.text, 'utf8'))
    if (actual !== task.prompt.sha256) {
      problems.push(`task ${task.id} prompt hash changed (recorded ${task.prompt.sha256}, actual ${actual})`)
    }
  }
  for (const probe of probes) {
    const actual = sha256(Buffer.from(probe.prompt.text, 'utf8'))
    if (actual !== probe.prompt.sha256) {
      problems.push(`negative probe ${probe.id} prompt hash changed (recorded ${probe.prompt.sha256}, actual ${actual})`)
    }
  }

  // ---- Truth files --------------------------------------------------------
  const truthByTask = new Map()
  for (const cell of cells) {
    const task = tasksById.get(cell.task_id)
    const rel = `${CONTRACT_DIR}/${task.truth_ref}`
    let truth
    try {
      truth = readJson(root, rel)
    } catch (error) {
      problems.push(`truth file ${rel} for task ${task.id} could not be read: ${error.message}`)
      continue
    }
    if (truth.task_id !== task.id) problems.push(`truth ${rel} declares task_id ${truth.task_id}, expected ${task.id}`)
    if (truth.contract_version !== contractVersion) {
      problems.push(`truth ${rel} declares contract_version ${truth.contract_version}, expected ${contractVersion}`)
    }
    if (!truth.tier1_obligations) problems.push(`truth ${rel} has no tier1_obligations`)
    truthByTask.set(task.id, { truth, path: rel })
  }

  // ---- Frozen digests (the whole contract directory) ----------------------
  const files = []
  const onDisk = walk(contractRoot).map((path) => relPath(root, path)).sort()
  for (const rel of onDisk) {
    files.push({ path: rel, sha256: sha256(readFileSync(resolve(root, rel))) })
  }

  // Every derived reference must exist on disk.
  for (const rel of [...referenced].sort()) {
    if (!onDisk.includes(rel)) problems.push(`referenced file ${rel} does not exist`)
  }

  // Cross-check against the contract's own freeze map: this is what proves the
  // frozen bytes are unchanged. We never write it.
  const freezePath = `${CONTRACT_DIR}/freeze.json`
  if (freeze.contract_version !== contractVersion) {
    problems.push(`freeze.json declares contract_version ${freeze.contract_version}, expected ${contractVersion}`)
  }
  for (const entry of files) {
    if (entry.path === freezePath) continue
    const recorded = freeze.files?.[entry.path]
    if (recorded === undefined) problems.push(`${entry.path} is not covered by freeze.json`)
    else if (recorded !== entry.sha256) {
      problems.push(`${entry.path} content changed since it was frozen (expected ${recorded}, actual ${entry.sha256})`)
    }
  }
  for (const path of Object.keys(freeze.files ?? {})) {
    if (!files.some((entry) => entry.path === path)) problems.push(`freeze.json references ${path}, which no longer exists`)
  }

  const manifest = {
    contract_version: contractVersion,
    file_count: files.length,
    files,
    derived_references: [...referenced].sort(),
    referenced_ids: {
      target_ids: [...targetsById.keys()].sort(),
      task_ids: [...tasksById.keys()].sort(),
      tier1_cell_ids: cells.map((cell) => cell.cell_id).sort(),
      negative_probe_ids: probes.map((probe) => probe.id).sort(),
      rubric_methods: Object.keys(rubrics.methods).sort(),
    },
    cross_reference_valid: problems.length === 0,
  }
  // The manifest digest covers the frozen bytes and the resolved id graph, so a
  // changed threshold, prompt, pinned ref or prohibited claim moves it.
  manifest.digest = sha256(Buffer.from(JSON.stringify({
    contract_version: contractVersion,
    files,
    referenced_ids: manifest.referenced_ids,
  }), 'utf8'))

  return { manifest, problems, corpus, tasks, rubrics, tier1, cells, probes, targetsById, tasksById, truthByTask }
}
