// Runs the real Madar generation and task-to-context paths, then reads the
// resulting artifact. Nothing here interprets truth; it only observes.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GENERATE_TIMEOUT_MS = 900_000
const PACK_TIMEOUT_MS = 600_000

/**
 * Strip machine-specific absolute paths from anything we retain.
 *
 * The Madar CLI legitimately prints absolute output paths, and durable Phase-1
 * evidence must contain no absolute local path and no username. Redaction runs
 * at write time so the committed artefact is exactly what the script produces —
 * sanitising afterwards would make the evidence unreproducible.
 */
export function redact(text, { targetDir, root } = {}) {
  let output = String(text)
  if (targetDir) output = output.split(targetDir).join('<target>')
  if (root) output = output.split(root).join('<repo>')
  output = output.replace(/\/(?:Users|home)\/[^/\s"'`)\]]+/g, '<home>')
  output = output.replace(/[A-Za-z]:\\Users\\[^\\\s"'`)\]]+/g, '<home>')
  return output
}

/**
 * Answerability states, ordered from most to least confident.
 * `ready` and `ready_with_caveat` both assert the pack is answerable, so both
 * count as "reporting a ready state" for the frozen negative-trust probes.
 */
export const ANSWERABILITY_ORDER = ['insufficient', 'verify_targets', 'ready_with_caveat', 'ready']
export const READY_STATES = new Set(['ready', 'ready_with_caveat'])

export function answerabilityRank(state) {
  const index = ANSWERABILITY_ORDER.indexOf(state)
  return index === -1 ? Number.NaN : index
}

export function runGenerate({ cliPath, targetDir, logPath }) {
  const started = Date.now()
  let stdout = ''
  let ok = true
  let detail = null
  try {
    stdout = execFileSync(process.execPath, [cliPath, 'generate', '.', '--no-html'], {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: GENERATE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, MADAR_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    })
  } catch (error) {
    ok = false
    detail = (error.stderr ?? error.message ?? '').toString().trim() || 'generate failed'
    stdout = (error.stdout ?? '').toString()
  }
  if (logPath) writeFileSync(logPath, redact(stdout, { targetDir, root: process.cwd() }))
  return { ok, detail: detail === null ? null : redact(detail, { targetDir, root: process.cwd() }), durationMs: Date.now() - started }
}

export function runPack({ cliPath, targetDir, prompt, logPath }) {
  const started = Date.now()
  let stdout = ''
  let ok = true
  let detail = null
  try {
    stdout = execFileSync(process.execPath, [cliPath, 'pack', prompt, '--format', 'json'], {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: PACK_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, MADAR_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    })
  } catch (error) {
    ok = false
    detail = (error.stderr ?? error.message ?? '').toString().trim() || 'pack failed'
    stdout = (error.stdout ?? '').toString()
  }
  if (logPath) writeFileSync(logPath, redact(stdout, { targetDir, root: process.cwd() }))
  if (!ok) return { ok, detail: redact(detail, { targetDir, root: process.cwd() }), artifact: null, durationMs: Date.now() - started }
  try {
    return { ok: true, detail: null, artifact: JSON.parse(stdout), durationMs: Date.now() - started }
  } catch (error) {
    return { ok: false, detail: `pack output is not JSON: ${error.message}`, artifact: null, durationMs: Date.now() - started }
  }
}

/** Graph identity: the artifact header, version block and node/fact counts. */
export function readGraphIdentity(graphPath) {
  const raw = readFileSync(graphPath, 'utf8')
  const newline = raw.indexOf('\n')
  const header = raw.slice(0, newline)
  const body = JSON.parse(raw.slice(newline + 1))
  return {
    header,
    generation_mode: body.generation_mode ?? null,
    node_count: Array.isArray(body.nodes) ? body.nodes.length : null,
    fact_count: Array.isArray(body.facts) ? body.facts.length : null,
    community_count: body.community_labels ? Object.keys(body.community_labels).length : null,
    integrity_receipt_present: Boolean(body.integrity_receipt),
    // `generated_at` and absolute source_file paths are deliberately excluded:
    // they are volatile and machine-specific, and must not enter any digest.
    identity_digest: createHash('sha256').update(JSON.stringify({
      header,
      generation_mode: body.generation_mode ?? null,
      nodes: Array.isArray(body.nodes) ? body.nodes.length : null,
      facts: Array.isArray(body.facts) ? body.facts.length : null,
    })).digest('hex'),
  }
}

function addPath(set, value) {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  // Absolute paths must never enter the evidence set or any durable output.
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return
  set.add(trimmed.split('\\').join('/'))
}

function addPathish(set, value) {
  if (typeof value === 'string') addPath(set, value)
  else if (value && typeof value === 'object') {
    addPath(set, value.path)
    addPath(set, value.source_file)
    addPath(set, value.file)
  }
}

function addLabel(set, value) {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed) set.add(trimmed)
}

/**
 * Extract the evidence set the artifact presents as supporting material.
 *
 * Two sets are produced deliberately:
 *   `strict`   — material the pack selected and presents as its evidence;
 *   `generous` — strict plus everything the pack merely points at (recommended
 *                reads, verification targets, workflow owners, hints).
 *
 * The verdict uses `generous`, which gives the product the maximum benefit of
 * the doubt: a cell that fails under the generous set cannot be dismissed as an
 * artefact of a narrow extraction rule. Both are recorded so the sensitivity of
 * the result to that choice is visible rather than hidden.
 */
export function extractEvidence(artifact) {
  const strictPaths = new Set()
  const strictSymbols = new Set()
  const generousPaths = new Set()
  const generousSymbols = new Set()

  const pack = artifact.pack ?? {}
  addPath(strictPaths, pack.target_file)
  addLabel(strictSymbols, pack.target ?? artifact.target)
  for (const key of ['direct_dependents', 'transitive_dependents']) {
    for (const entry of pack[key] ?? []) {
      addPath(strictPaths, entry.source_file)
      addLabel(strictSymbols, entry.label)
    }
  }
  for (const file of pack.affected_files ?? []) addPath(strictPaths, file)
  for (const entry of artifact.recommended_first_read ?? []) addPathish(strictPaths, entry)
  for (const claim of artifact.claims ?? []) {
    for (const label of claim.node_labels ?? []) addLabel(strictSymbols, label)
  }

  for (const value of strictPaths) generousPaths.add(value)
  for (const value of strictSymbols) generousSymbols.add(value)

  for (const entry of artifact.recommended_first_read ?? []) addLabel(generousSymbols, entry.label)
  for (const owner of artifact.evidence?.covered_workflow_owners ?? []) addPathish(generousPaths, owner)
  for (const target of artifact.evidence?.answerability?.verification_targets ?? []) {
    for (const file of target.focus_files ?? []) addPath(generousPaths, file)
  }
  for (const key of ['likely_edit_files', 'likely_test_files', 'public_contracts', 'risk_boundaries']) {
    for (const entry of artifact[key] ?? []) {
      addPathish(generousPaths, entry)
      if (entry && typeof entry === 'object') addLabel(generousSymbols, entry.label ?? entry.symbol ?? entry.name)
    }
  }
  for (const center of artifact.workflow_centers ?? []) addLabel(generousSymbols, center.label)

  const sorted = (set) => [...set].sort()
  return {
    strict: { paths: sorted(strictPaths), symbols: sorted(strictSymbols) },
    generous: { paths: sorted(generousPaths), symbols: sorted(generousSymbols) },
  }
}

/**
 * Normalise a symbol for obligation comparison, exactly as
 * rubrics.json#/methods/evidence_obligation_recall prescribes: compare the LAST
 * dot-separated segment, case-sensitively, after stripping a leading '#'.
 */
export function normaliseSymbol(symbol) {
  const segments = String(symbol).split('.')
  const last = segments[segments.length - 1] ?? ''
  return last.startsWith('#') ? last.slice(1) : last
}

export function readAnswerability(artifact) {
  return artifact.evidence?.answerability?.state
    ?? artifact.governance?.directive?.answerability
    ?? null
}
