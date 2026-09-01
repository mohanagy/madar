// Runs the real Madar generation and task-to-context paths, then reads the
// resulting artifact. Nothing here interprets truth; it only observes.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { EVIDENCE_CHANNELS, channelFor, stringLeaves } from './channels.mjs'

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

/**
 * A repository-relative path, normalised for comparison against the frozen
 * obligations. Absolute paths must never enter the evidence set or any durable
 * output, so they are dropped rather than rewritten.
 */
function normalisePath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return null
  return trimmed.split('\\').join('/')
}

function normaliseLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Extract the evidence set the artifact presents as supporting material.
 *
 * Every string channel is resolved through the declared registry in
 * channels.mjs. A channel the registry does not classify is returned in
 * `unclassified`; the caller must refuse to measure rather than guess, because
 * a silently dropped channel is exactly how a symbol the product did surface
 * gets scored as missing.
 *
 * Two sets are produced deliberately:
 *   `strict`   — material the pack selected and presents as its evidence;
 *   `generous` — strict plus everything the pack merely points at.
 *
 * The verdict uses `generous`, which gives the product the maximum benefit of
 * the doubt. Both are recorded so the sensitivity of the result to that choice
 * is visible rather than hidden.
 *
 * Snippets are recorded, never mined: substring-matching retained source text
 * for symbol names is the fuzzy matching the frozen rubric forbids. Any effect
 * mining them WOULD have is reported separately by `snippetSymbolSightings`.
 */
export function extractEvidence(artifact) {
  const strictPaths = new Set()
  const strictSymbols = new Set()
  const generousPaths = new Set()
  const generousSymbols = new Set()
  const snippets = []
  const unclassified = []
  const guarded = []
  const basenameReferences = new Set()
  const observedChannels = new Map()

  for (const leaf of stringLeaves(artifact)) {
    const entry = channelFor(leaf.channel)
    if (!entry) {
      unclassified.push({ schema_path: leaf.schemaPath, channel: leaf.channel, value: leaf.value })
      continue
    }
    if (!observedChannels.has(leaf.channel)) observedChannels.set(leaf.channel, { channel: leaf.channel, role: entry.role, tier: entry.tier, count: 0, sample: leaf.value })
    observedChannels.get(leaf.channel).count += 1

    if (entry.guard && !entry.guard(leaf.parent)) {
      guarded.push({ schema_path: leaf.schemaPath, channel: leaf.channel, value: leaf.value })
      continue
    }
    if (entry.role === 'path') {
      const value = normalisePath(leaf.value)
      if (!value) continue
      // A value with no separator names a file but does not locate it. It can
      // never satisfy a repository-relative obligation, and calling it
      // fabricated because it does not resolve from the target root would be an
      // artefact of this normalisation, not a product defect.
      if (!value.includes('/')) { basenameReferences.add(value); continue }
      generousPaths.add(value)
      if (entry.tier === 'strict') strictPaths.add(value)
    } else if (entry.role === 'symbol') {
      const value = normaliseLabel(leaf.value)
      if (!value) continue
      generousSymbols.add(value)
      if (entry.tier === 'strict') strictSymbols.add(value)
    } else if (entry.role === 'snippet') {
      snippets.push({ schema_path: leaf.schemaPath, channel: leaf.channel, text: leaf.value })
    }
  }

  const sorted = (set) => [...set].sort()
  return {
    strict: { paths: sorted(strictPaths), symbols: sorted(strictSymbols) },
    generous: { paths: sorted(generousPaths), symbols: sorted(generousSymbols) },
    basename_references: sorted(basenameReferences),
    snippets,
    unclassified,
    guarded,
    channels: [...observedChannels.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
  }
}

/**
 * Which of `symbols` appear as a token inside a retained snippet.
 *
 * REPORTED ONLY. A sighting here never enters observed symbols and never moves
 * a verdict: the frozen rubric compares symbol entries the artifact enumerates,
 * not source text it happens to include. Recording it makes the size of that
 * distinction visible instead of leaving it to be argued about.
 */
export function snippetSymbolSightings(evidence, symbols) {
  const sightings = []
  for (const symbol of symbols) {
    const token = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`)
    for (const snippet of evidence.snippets ?? []) {
      if (token.test(snippet.text)) {
        sightings.push({ symbol, schema_path: snippet.schema_path })
        break
      }
    }
  }
  return sightings
}

/** The registry itself, for reports and controls. */
export function declaredChannels() {
  return EVIDENCE_CHANNELS.map((entry) => ({ channel: entry.channel, role: entry.role, tier: entry.tier ?? null, reason: entry.reason ?? null }))
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

/**
 * Channels in which an artifact can say that something is absent, missing, or
 * unresolved.
 *
 * These overlap the `ignored` evidence classifications on purpose. A caveat is
 * not evidence ABOUT the target — counting it as evidence would let a pack earn
 * recall by describing its own gaps — but it is exactly where a declaration of
 * absence belongs. The two readings are separate and both are recorded.
 */
export const DECLARATION_CHANNELS = [
  '.evidence.answerability.caveats[]',
  '.evidence.answerability.missing_obligations[]',
  '.evidence.answerability.verification_targets[].reason',
  '.evidence.coverage_detail.missing_obligations[]',
  '.evidence.confidence_reasons[]',
  '.evidence.missing_phases[]',
  '.governance.directive.missing_phases[]',
  '.pack.answer_contract.uncertainty_notes[]',
  '.pack.answer_contract.missing_phases[]',
  '.pack.answer_contract.do_not_claim[]',
  '.pack.execution_slice.phase_coverage.missing[]',
  '.pack.execution_slice.boundary_reason',
  '.pack.execution_slice.primary_path.boundary_reason',
  '.negative_guidance[]',
  '.missing_context[]',
  '.missing_semantic[]',
  '.claims[].text',
  '.why_explanation[]',
]

const DECLARATION_CHANNEL_SET = new Set(DECLARATION_CHANNELS)

/**
 * Everything the artifact says about what it did NOT establish, with the exact
 * schema path it said it at. Nothing is interpreted here.
 */
export function extractDeclarations(artifact) {
  const declarations = []
  for (const leaf of stringLeaves(artifact)) {
    if (!DECLARATION_CHANNEL_SET.has(leaf.channel)) continue
    const text = leaf.value.trim()
    if (text) declarations.push({ schema_path: leaf.schemaPath, channel: leaf.channel, text })
  }
  // Verification targets name a file the artifact says still needs checking,
  // which is a declaration that the matter is unresolved as well as a pointer.
  for (const target of artifact.evidence?.answerability?.verification_targets ?? []) {
    for (const file of target.focus_files ?? []) {
      if (typeof file === 'string' && file.trim()) {
        declarations.push({ schema_path: '.evidence.answerability.verification_targets[].focus_files[]', channel: '.evidence.answerability.verification_targets[].focus_files[]', text: file.trim() })
      }
    }
  }
  return declarations
}

/**
 * Markers that make a sentence a statement of ABSENCE rather than of presence.
 *
 * Mentioning the subject is not declaring it missing. `claims[].text` and
 * `why_explanation[]` are declaration-bearing channels but are affirmative by
 * nature: "supporting evidence for the route matcher cache" names the subject
 * while asserting the opposite of what the frozen probe requires. A declaration
 * must therefore carry negation, not merely the topic.
 */
const ABSENCE_MARKERS = [
  /\bno\b/i, /\bnot\b/i, /\bnone\b/i, /\bnever\b/i, /\bnothing\b/i,
  /\babsent\b/i, /\babsence\b/i, /\bmissing\b/i, /\bunresolved\b/i,
  /\bunsupported\b/i, /\bunobserved\b/i, /\bunknown\b/i,
  /\blacks?\b/i, /\blacking\b/i, /\bwithout\b/i, /\bcannot\b/i,
  /\bdoes\s+not\b/i, /\bdo\s+not\b/i, /\bdoesn't\b/i, /\bdon't\b/i,
  /\bis\s+n\/a\b/i, /\bnot\s+found\b/i, /\binsufficient\b/i,
]

/** True when `text` asserts that something is absent, missing or unestablished. */
export function assertsAbsence(text) {
  return ABSENCE_MARKERS.some((marker) => marker.test(String(text)))
}

/** Whole-word, case-insensitive containment. Never a substring match. */
export function mentionsToken(text, token) {
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, 'i').test(text)
}

const GENERIC_PROMPT_WORDS = new Set([
  'about', 'after', 'again', 'against', 'along', 'already', 'also', 'although', 'always', 'among',
  'another', 'anything', 'around', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'could', 'describe', 'design', 'does', 'doing', 'during', 'each', 'either', 'else', 'enough',
  'every', 'explain', 'from', 'further', 'given', 'happens', 'have', 'here', 'however', 'into',
  'itself', 'library', 'might', 'more', 'most', 'much', 'must', 'name', 'need', 'never', 'other',
  'over', 'part', 'people', 'project', 'repository', 'same', 'should', 'since', 'some', 'such',
  'system', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'this',
  'those', 'through', 'under', 'until', 'using', 'value', 'values', '什么', 'what', 'when', 'where',
  'whether', 'which', 'while', 'will', 'with', 'within', 'would', 'your',
])

/**
 * The distinguishing subject terms of a frozen probe prompt.
 *
 * Derived from the frozen bytes by a fixed rule so the same prompt always
 * yields the same terms: content tokens of five characters or more that are not
 * generic English. The terms are recorded in the result, so the judgement a
 * verdict rests on is inspectable rather than implicit.
 */
export function probeSubjectTerms(promptText) {
  const tokens = String(promptText).toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? []
  const terms = new Set()
  for (const token of tokens) {
    if (token.length < 5) continue
    if (GENERIC_PROMPT_WORDS.has(token)) continue
    terms.add(token)
  }
  return [...terms].sort()
}
