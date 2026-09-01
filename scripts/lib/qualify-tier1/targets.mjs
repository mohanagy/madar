// Target preparation and identity verification.
//
// A preparation failure is never a product result: it yields `invalid` with an
// exact validity reason drawn from docs/qualification/validity-rules.md.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const GIT_TIMEOUT_MS = 600_000

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function mirrorDirName(url) {
  const slug = url.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/[^a-zA-Z0-9]+/g, '-')
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return `${slug}-${hash}.git`
}

/**
 * Ensure a bare mirror of `url` exists in `cacheDir` and contains `ref`.
 *
 * A cache is only a transport optimisation: the caller still verifies the
 * checked-out revision and every cited blob, so a warm cache cannot change a
 * result. Network is used only when the cache cannot satisfy the pinned ref.
 */
export function ensureMirror(cacheDir, url, ref, { allowNetwork = true } = {}) {
  mkdirSync(cacheDir, { recursive: true })
  const dir = join(cacheDir, mirrorDirName(url))
  const has = () => {
    try { return git(['-C', dir, 'cat-file', '-t', ref]) === 'commit' } catch { return false }
  }
  if (existsSync(dir) && has()) return { dir, fetched: false }
  if (!allowNetwork) {
    throw new Error(`mirror for ${url} does not contain ${ref} and network is disabled`)
  }
  if (!existsSync(dir)) git(['clone', '--mirror', url, dir])
  else git(['-C', dir, 'fetch', '--all', '--tags', '--prune'])
  if (!has()) throw new Error(`pinned ref ${ref} is absent from ${url} after fetch`)
  return { dir, fetched: true }
}

/**
 * Prepare one target into `destDir` and verify its identity.
 *
 * Returns a receipt: { target_id, ref, head, patch_digest, cited_blobs_verified,
 * cited_blobs_total, valid, invalid_reason, detail }.
 */
export function prepareTarget({ target, baseTarget, contractRoot, cacheDir, destDir, allowNetwork = true }) {
  const receipt = {
    target_id: target.id,
    kind: target.kind,
    url: target.source.url,
    ref: target.source.ref,
    head: null,
    patch: target.patch ?? null,
    patch_digest: null,
    patch_applied: false,
    cited_blobs_total: Object.keys(target.cited_blobs ?? {}).length,
    cited_blobs_verified: 0,
    cited_blob_mismatches: [],
    valid: false,
    invalid_reason: null,
    detail: null,
  }

  try {
    const { dir: mirror } = ensureMirror(cacheDir, target.source.url, target.source.ref, { allowNetwork })
    mkdirSync(resolve(destDir, '..'), { recursive: true })
    git(['clone', '--quiet', '--no-checkout', mirror, destDir])
    git(['-C', destDir, 'checkout', '--quiet', '--detach', target.source.ref])
    receipt.head = git(['-C', destDir, 'rev-parse', 'HEAD'])
  } catch (error) {
    receipt.invalid_reason = 'target_revision_mismatch'
    receipt.detail = `clone/checkout failed: ${error.message}`
    return receipt
  }

  if (receipt.head !== target.source.ref) {
    receipt.invalid_reason = 'target_revision_mismatch'
    receipt.detail = `checked out ${receipt.head}, corpus pins ${target.source.ref}`
    return receipt
  }

  // Cited blobs are verified against the UNPATCHED pinned tree: corpus.json
  // records them that way for git_patched targets and says so explicitly.
  const cited = target.cited_blobs ?? (baseTarget?.cited_blobs ?? {})
  for (const [path, expected] of Object.entries(cited)) {
    let actual = null
    try { actual = git(['-C', destDir, 'rev-parse', `HEAD:${path}`]) } catch { actual = null }
    if (actual === expected) receipt.cited_blobs_verified += 1
    else receipt.cited_blob_mismatches.push({ path, expected, actual })
  }
  if (receipt.cited_blob_mismatches.length > 0) {
    receipt.invalid_reason = 'target_revision_mismatch'
    receipt.detail = `${receipt.cited_blob_mismatches.length} cited blob digest(s) do not match the pinned tree`
    return receipt
  }

  if (target.patch) {
    const patchPath = resolve(contractRoot, '..', '..', target.patch.startsWith('patches/')
      ? `docs/qualification/${target.patch}`
      : target.patch)
    let patchBytes
    try {
      patchBytes = readFileSync(patchPath)
    } catch (error) {
      receipt.invalid_reason = 'patch_application_failure'
      receipt.detail = `patch file unreadable: ${error.message}`
      return receipt
    }
    receipt.patch_digest = createHash('sha256').update(patchBytes).digest('hex')
    try {
      // No fuzz: --3way is deliberately NOT used. validity-rules.md invalidates a
      // patch that "applied with fuzz", so only an exact application counts.
      git(['-C', destDir, 'apply', '--whitespace=nowarn', patchPath])
      receipt.patch_applied = true
    } catch (error) {
      receipt.invalid_reason = 'patch_application_failure'
      receipt.detail = `git apply failed: ${(error.stderr ?? error.message).toString().trim()}`
      return receipt
    }
  }

  receipt.valid = true
  return receipt
}

/** True when `path` exists in the prepared working tree. */
export function pathExistsInTarget(destDir, path) {
  return existsSync(resolve(destDir, path))
}

/**
 * Every identifier token that occurs in the prepared target's source, plus
 * every file basename. Built once per target directory.
 *
 * This answers ONE question: is a symbol the artifact printed actually present
 * in the pinned target, or was it invented? It is never used for recall —
 * matching an obligation against source text would be the fuzzy matching the
 * frozen rubric forbids. Fabrication and recall are different questions and are
 * measured differently on purpose.
 */
const TOKEN_INDEX = new Map()

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.md'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage'])

function collectTokens(dir, tokens, depth = 0) {
  if (depth > 24) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectTokens(join(dir, entry.name), tokens, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    tokens.add(entry.name)
    tokens.add(entry.name.replace(/\.[^.]+$/, ''))
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue
    let text
    try { text = readFileSync(join(dir, entry.name), 'utf8') } catch { continue }
    for (const token of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) tokens.add(token)
  }
}

export function targetTokenIndex(destDir) {
  const key = resolve(destDir)
  const cached = TOKEN_INDEX.get(key)
  if (cached) return cached
  const tokens = new Set()
  collectTokens(key, tokens)
  TOKEN_INDEX.set(key, tokens)
  return tokens
}

/**
 * True when `symbol` is grounded in the pinned target: the printed label, its
 * bare identifier form, or a file basename it names occurs in the source.
 * Deliberately generous — a false fabrication report would be worse than a
 * missed one, because fabrication is an accusation.
 */
export function symbolExistsInTarget(destDir, symbol) {
  const tokens = targetTokenIndex(destDir)
  const raw = String(symbol).trim()
  if (!raw) return true
  if (tokens.has(raw)) return true
  const withoutCall = raw.replace(/\s*\([^)]*\)\s*$/, '')
  if (tokens.has(withoutCall)) return true
  for (const part of withoutCall.split(/[.#]/)) {
    const piece = part.trim()
    if (piece && tokens.has(piece)) return true
  }
  return false
}
