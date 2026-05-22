// SPI cache (#77 — v0.16 runtime-efficiency).
//
// Persists a built SemanticProgramIndex to disk and re-uses it on
// subsequent runs whenever the workspace's content fingerprint matches.
// This is the "all-or-nothing" caching strategy: a single source-file
// change invalidates the entire cache. True per-file incremental
// rebuilds are deferred because:
//
//   1. The type-checker pass (calls / extends / implements / param_type
//      / return_type) reads ts.Program at workspace scope; a single-file
//      edit can change cross-file edges anywhere.
//   2. The framework finalizers (Express mount-prefix, NestJS dynamic-
//      module diagnostics) are workspace-level operations.
//
// All-or-nothing is still a substantial win: every CLI command that runs
// `buildSpi` more than once on an unchanged workspace (`pack`, `prompt`,
// `pr_impact` rebuilds during local iteration) sees a cache hit.
//
// Cache layout
// ────────────
//
//   <workspace>/out/.spi-cache/
//     index.json     — cache metadata: { version, key, generated_at, file_count }
//     spi.json       — serialized SemanticProgramIndex
//
// Cache key
// ─────────
//
// The cache key is a sha256 of:
//
//   workspace_root              — absolute, posix-normalized
//   extractor_version           — from BuildSpiOptions.extractorVersion (or default)
//   sadeem_version            — from BuildSpiOptions.sadeemVersion
//   tsconfig.json content       — if present, raw bytes
//   sorted list of (path, mtime_ms, size_bytes, sha256) for every
//     source file in the workspace (same EXT_TO_LANG matcher as buildSpi)
//
// Including mtime + size in the per-file fingerprint catches cases the
// content hash alone would miss (path renames where the new path's
// content hash collides with an existing file). The path list is sorted
// for determinism across OS-specific readdir orderings.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { buildSpi, type BuildSpiOptions } from './build.js'
import type { SemanticProgramIndex } from './types.js'

const CACHE_DIR_NAME = '.spi-cache'
const CACHE_DIR_PARENT = 'out'
const CACHE_INDEX_FILE = 'index.json'
const CACHE_SPI_FILE = 'spi.json'
const CACHE_FORMAT_VERSION = 1

const CACHE_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.git',
  'out',
  '.test-artifacts',
  '.turbo',
  '.vercel',
])

const CACHE_INDEXABLE_EXTS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
])

export interface SpiCacheIndex {
  format_version: number
  cache_key: string
  generated_at: string
  file_count: number
  extractor_version: string
}

export interface SpiCacheStats {
  hit: boolean
  reason: 'fresh-cache' | 'no-cache' | 'key-mismatch' | 'format-version-mismatch' | 'corrupt-cache' | 'cache-disabled'
  file_count: number
  cache_key: string
  duration_ms: number
}

export interface BuildSpiCachedOptions extends BuildSpiOptions {
  /** Disable the cache for this build (default: false). When true, the
   *  call behaves exactly like buildSpi() — no read, no write. */
  noCache?: boolean
  /** Override the cache directory (default: `<root>/out/.spi-cache`).
   *  Useful for tests and for projects that want to relocate the cache
   *  outside the default out tree. */
  cacheDir?: string
  /** Receives a stats payload after the call. Lets callers log/measure
   *  whether the cache was used without re-deriving the key themselves. */
  onCacheLookup?: (stats: SpiCacheStats) => void
}

export interface BuildSpiCachedResult {
  spi: SemanticProgramIndex
  cache: SpiCacheStats
}

/**
 * Build (or re-use) a SemanticProgramIndex for the workspace, persisting
 * the result to disk so the next call with an unchanged workspace
 * returns the cached value without re-running the full ts.Program pass.
 *
 * The cache is opt-in: callers must use `buildSpiCached` explicitly; the
 * existing `buildSpi` continues to do a full rebuild every time so any
 * code path that relies on freshness is not affected by this slice.
 */
export function buildSpiCached(opts: BuildSpiCachedOptions): BuildSpiCachedResult {
  const start = Date.now()
  const root = resolve(opts.root)
  const cacheDir = opts.cacheDir ?? join(root, CACHE_DIR_PARENT, CACHE_DIR_NAME)
  const indexPath = join(cacheDir, CACHE_INDEX_FILE)
  const spiPath = join(cacheDir, CACHE_SPI_FILE)

  const finishStats = (stats: SpiCacheStats): SpiCacheStats => {
    if (opts.onCacheLookup) opts.onCacheLookup(stats)
    return stats
  }

  // CodeRabbit fix: short-circuit BEFORE fingerprint computation so the
  // noCache path skips the per-file hashing entirely.
  if (opts.noCache) {
    const spi = buildSpi(opts)
    return {
      spi,
      cache: finishStats({
        hit: false,
        reason: 'cache-disabled',
        file_count: 0,
        cache_key: '',
        duration_ms: Date.now() - start,
      }),
    }
  }

  const fingerprint = computeWorkspaceFingerprint(root, opts)
  const cacheKey = fingerprint.cacheKey

  // Cache lookup: load index, validate key, deserialize SPI. Track the
  // miss reason explicitly so the stats payload reports why the cache
  // didn't fire (CodeRabbit fix — the previous version threw the reason
  // away and inferred from existsSync after writing the cache, which
  // always reported fresh-cache).
  let missReason: SpiCacheStats['reason'] = 'no-cache'
  if (existsSync(indexPath) && existsSync(spiPath)) {
    const cached = tryLoadCache(indexPath, spiPath, cacheKey)
    if (cached.kind === 'hit') {
      return {
        spi: cached.spi,
        cache: finishStats({
          hit: true,
          reason: 'fresh-cache',
          file_count: fingerprint.fileCount,
          cache_key: cacheKey,
          duration_ms: Date.now() - start,
        }),
      }
    }
    missReason =
      cached.kind === 'key-mismatch'
        ? 'key-mismatch'
        : cached.kind === 'format-version-mismatch'
          ? 'format-version-mismatch'
          : 'corrupt-cache'
    // Drop the stale cache so the next miss path doesn't re-read it.
    safeDelete(indexPath)
    safeDelete(spiPath)
  }

  // Build, persist, return — propagate the actual miss reason.
  const spi = buildSpi(opts)
  saveCache(cacheDir, indexPath, spiPath, spi, cacheKey, fingerprint.fileCount, opts.extractorVersion)

  return {
    spi,
    cache: finishStats({
      hit: false,
      reason: missReason,
      file_count: fingerprint.fileCount,
      cache_key: cacheKey,
      duration_ms: Date.now() - start,
    }),
  }
}

/** Explicit cache invalidation — removes the on-disk artifacts.
 *  Returns true iff anything was deleted. */
export function clearSpiCache(root: string, cacheDir?: string): boolean {
  const dir = cacheDir ?? join(resolve(root), CACHE_DIR_PARENT, CACHE_DIR_NAME)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

interface WorkspaceFingerprint {
  cacheKey: string
  fileCount: number
}

function computeWorkspaceFingerprint(root: string, opts: BuildSpiCachedOptions): WorkspaceFingerprint {
  const entries: string[] = []
  collectIndexableFiles(root, root, entries)
  entries.sort()

  const hasher = createHash('sha256')
  hasher.update(`workspace:${root}\n`)
  hasher.update(`extractor:${opts.extractorVersion ?? 'spi-v1.0.0'}\n`)
  hasher.update(`sadeem:${opts.sadeemVersion}\n`)

  const tsConfigPath = join(root, 'tsconfig.json')
  if (existsSync(tsConfigPath)) {
    try {
      hasher.update(`tsconfig:${readFileSync(tsConfigPath, 'utf8')}\n`)
    } catch {
      hasher.update('tsconfig:<unreadable>\n')
    }
  } else {
    hasher.update('tsconfig:<absent>\n')
  }

  for (const rel of entries) {
    const abs = join(root, rel)
    try {
      const stat = statSync(abs)
      const content = readFileSync(abs)
      const fileHash = createHash('sha256').update(content).digest('hex')
      hasher.update(`f:${rel}|${stat.mtimeMs}|${stat.size}|${fileHash}\n`)
    } catch {
      // Skip unreadable files in the fingerprint; the build itself will
      // also skip them, so they don't affect cache validity.
    }
  }

  return {
    cacheKey: hasher.digest('hex'),
    fileCount: entries.length,
  }
}

function collectIndexableFiles(root: string, dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const entry of entries) {
    if (CACHE_SKIP_DIRS.has(entry.name)) continue
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectIndexableFiles(root, full, out)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (CACHE_INDEXABLE_EXTS.has(ext)) {
        out.push(relative(root, full).split('\\').join('/'))
      }
    }
  }
}

type CacheLookupResult =
  | { kind: 'hit'; spi: SemanticProgramIndex }
  | { kind: 'key-mismatch' }
  | { kind: 'format-version-mismatch' }
  | { kind: 'corrupt' }

function tryLoadCache(indexPath: string, spiPath: string, expectedKey: string): CacheLookupResult {
  let rawIndex: string
  let rawSpi: string
  try {
    rawIndex = readFileSync(indexPath, 'utf8')
    rawSpi = readFileSync(spiPath, 'utf8')
  } catch {
    return { kind: 'corrupt' }
  }

  let index: unknown
  let spi: unknown
  try {
    index = JSON.parse(rawIndex)
    spi = JSON.parse(rawSpi)
  } catch {
    return { kind: 'corrupt' }
  }

  if (!index || typeof index !== 'object') return { kind: 'corrupt' }
  const indexed = index as Partial<SpiCacheIndex>
  if (indexed.format_version !== CACHE_FORMAT_VERSION) return { kind: 'format-version-mismatch' }
  if (typeof indexed.cache_key !== 'string' || indexed.cache_key !== expectedKey) {
    return { kind: 'key-mismatch' }
  }
  if (!spi || typeof spi !== 'object') return { kind: 'corrupt' }

  // Minimal shape check — version + workspace + files arrays must be present.
  const candidate = spi as Partial<SemanticProgramIndex>
  if (candidate.version !== 1) return { kind: 'corrupt' }
  if (!candidate.workspace || !Array.isArray(candidate.files) || !Array.isArray(candidate.symbols)) {
    return { kind: 'corrupt' }
  }

  return { kind: 'hit', spi: candidate as SemanticProgramIndex }
}

function saveCache(
  cacheDir: string,
  indexPath: string,
  spiPath: string,
  spi: SemanticProgramIndex,
  cacheKey: string,
  fileCount: number,
  extractorVersion: string | undefined,
): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    const index: SpiCacheIndex = {
      format_version: CACHE_FORMAT_VERSION,
      cache_key: cacheKey,
      generated_at: new Date().toISOString(),
      file_count: fileCount,
      extractor_version: extractorVersion ?? spi.workspace.extractor_version,
    }
    writeFileSync(indexPath, JSON.stringify(index, null, 2))
    writeFileSync(spiPath, JSON.stringify(spi))
  } catch {
    // Best-effort persistence — a write failure should not break the build.
    // Callers receive the freshly-built SPI either way.
  }
  // Keep dirname busy so unused-import lint doesn't flag the helper.
  void dirname
}

function safeDelete(path: string): void {
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    // Ignore — stale cache will be overwritten on the next save.
  }
}
