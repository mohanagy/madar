import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  CANONICAL_INDEX_FORMAT_VERSION,
  createGenerationPolicy,
  createSourceSnapshot,
  sourceSnapshotsEqual,
  type GenerationPolicy,
  type IndexingOutcome,
  type IndexingStrictThresholds,
  type SourceRootIdentity,
  type SourceSnapshot,
  type SourceSnapshotEntry,
} from '../../domain/index/build-state.js'
import {
  type DiscoveryExclusion,
  buildDiscoverySafetyMetadata,
  isSensitiveDirectoryName,
  localDiscoveryPath,
  sensitiveArtifactReason,
  sensitiveDirectoryReasonForPath,
  type DiscoverySafetyMetadata,
} from '../../shared/discovery-safety.js'
import { collectGitVisibleFiles } from '../../shared/git.js'
import { resolveMadarWorkspace } from '../../shared/workspace.js'

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
export const RECOGNIZED_UNSUPPORTED_EXTENSIONS = new Set([
  '.py', '.go', '.rs', '.java', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.rb', '.swift', '.kt', '.kts',
  '.cs', '.scala', '.php', '.lua', '.zig', '.ps1', '.ex', '.exs', '.m', '.mm', '.jl', '.bash', '.clj',
  '.cljs', '.dart', '.elm', '.fs', '.fsx', '.groovy', '.hs', '.r', '.sh', '.sol', '.sql', '.svelte', '.vue',
  '.md', '.mdx', '.txt', '.rst', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.docx', '.xlsx',
])
const HARD_IGNORED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.jj', '.repo', '.worktrees', 'worktrees', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.madar', 'madar-cache', 'madar-report', '.next', '.nuxt', '.svelte-kit',
  '.astro', '.vite', '.turbo', '.nx', '.parcel-cache', '.cache', '.serverless', '.vercel', '.netlify',
  '.nyc_output', '.test-artifacts', 'logs', 'tmp', 'temp', 'venv', '.venv', '__pycache__', 'target',
])
const CONTROL_FILE = /^(?:package\.json|(?:ts|js)config(?:\..+)?\.json|\.madarignore|\.gitignore)$/i
const NOISE_FILE = /\.stories\.(?:ts|tsx|js|jsx)$/i
const GENERATED_FILE = /(?:\.min\.(?:js|css)|\.map|\.tsbuildinfo|\.d\.ts\.map|\.log)$/i
const MANAGED_INSTRUCTIONS = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
const INDEX_CAPABILITY: Record<string, string> = {
  '.ts': 'builtin:index:typescript', '.tsx': 'builtin:index:tsx',
  '.js': 'builtin:index:javascript', '.jsx': 'builtin:index:jsx',
}

export interface SourceCatalogOptions {
  followSymlinks?: boolean
  respectGitignore?: boolean
  indexingStrict?: IndexingStrictThresholds
}

export interface SourceCatalog {
  rootPath: string
  supportedFiles: string[]
  snapshot: SourceSnapshot
  policy: GenerationPolicy
  sourceRoot: SourceRootIdentity
  outcomes: IndexingOutcome[]
  discoverySafety: DiscoverySafetyMetadata
  totalWords: number
  warning: string | null
  scannedFiles: number
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalize(path: string): string {
  return path.split(sep).join('/')
}

function localPath(root: string, path: string): string {
  return normalize(relative(root, path)).replace(/^\.\//, '')
}

function withinRoot(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function isHardIgnored(path: string, root: string): boolean {
  const local = localPath(root, path)
  const parts = local.split('/').filter(Boolean)
  if (parts.some((part) => HARD_IGNORED_SEGMENTS.has(part))) return true
  return GENERATED_FILE.test(local) || /(?:^|\/)\.DS_Store$/i.test(local)
}

function globRegex(pattern: string): RegExp {
  const trimmed = pattern.replace(/^!/, '').replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed.length > 512 || (trimmed.match(/\*/g)?.length ?? 0) > 32) return /^$/
  const globstarSegment = '\u0000'
  const globstar = '\u0001'
  const value = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, globstarSegment).replace(/\*\*/g, globstar)
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replaceAll(globstarSegment, '(?:.*/)?').replaceAll(globstar, '.*')
  return new RegExp(`^(?:${value}|.*/${value})$`)
}

function loadIgnorePatterns(root: string): string[] {
  try {
    return readFileSync(resolve(root, '.madarignore'), 'utf8').split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch { return [] }
}

function ignoredByPatterns(path: string, root: string, patterns: readonly string[]): boolean {
  const local = localPath(root, path)
  let ignored = false
  for (const pattern of patterns) {
    if (globRegex(pattern).test(local) || globRegex(pattern).test(basename(path))) ignored = !pattern.startsWith('!')
  }
  return ignored
}

function sensitiveReason(path: string, root: string) {
  return sensitiveArtifactReason(path, root, { isSourceFile: SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()) })
}

function outcome(path: string, kind: 'file' | 'directory', status: IndexingOutcome['status'], reason: IndexingOutcome['reason']): IndexingOutcome {
  return { path, kind, status, reason, capability: null }
}

function readEntry(
  path: string,
  root: string,
  exclusions: DiscoveryExclusion[],
  outcomes: IndexingOutcome[],
  capability: string | null = null,
): SourceSnapshotEntry | null {
  try {
    accessSync(path, constants.R_OK)
    return { path: localPath(root, path), hash: sha256(readFileSync(path)) }
  } catch {
    const local = localDiscoveryPath(root, path)
    exclusions.push({ path: local, kind: 'unreadable', reason: 'unreadable_path' })
    outcomes.push({ ...outcome(local, 'file', 'failed', 'unreadable_path'), capability })
    return null
  }
}

function sourceRootIdentity(root: string): SourceRootIdentity {
  const workspace = resolveMadarWorkspace(root)
  const scope = workspace.worktreeRoot
    ? normalize(relative(realpathSync(workspace.worktreeRoot), realpathSync(workspace.rootPath))) || '.'
    : '.'
  return {
    kind: workspace.isLinkedWorktree ? 'linked_worktree' : workspace.worktreeRoot ? 'primary_worktree' : 'directory',
    root_path: workspace.rootPath,
    worktree_root: workspace.worktreeRoot,
    scope,
  }
}

function scanTree(root: string, options: SourceCatalogOptions, gitVisible: ReadonlySet<string> | null) {
  const supported: SourceSnapshotEntry[] = []
  const controls: SourceSnapshotEntry[] = []
  const unsupported: SourceSnapshotEntry[] = []
  const exclusions: DiscoveryExclusion[] = []
  const outcomes: IndexingOutcome[] = []
  const patterns = loadIgnorePatterns(root)
  const visited = new Set<string>()
  let scannedFiles = 0
  let totalWords = 0
  const rootReal = realpathSync(root)

  const visit = (directory: string): void => {
    let directoryReal: string
    try { directoryReal = realpathSync(directory) } catch {
      const path = localDiscoveryPath(root, directory)
      exclusions.push({ path, kind: 'unreadable', reason: 'unreadable_directory' })
      outcomes.push(outcome(path, 'directory', 'failed', 'unreadable_directory'))
      return
    }
    if (visited.has(directoryReal)) return
    visited.add(directoryReal)
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch {
      const path = localDiscoveryPath(root, directory)
      exclusions.push({ path, kind: 'unreadable', reason: 'unreadable_directory' })
      outcomes.push(outcome(path, 'directory', 'failed', 'unreadable_directory'))
      return
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const local = localDiscoveryPath(root, path)
      if (isHardIgnored(path, root)) {
        if (!entry.isDirectory()) outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'hard_ignored'))
        continue
      }
      if (ignoredByPatterns(path, root, patterns)) {
        outcomes.push(outcome(local, entry.isDirectory() ? 'directory' : 'file', 'skipped_by_policy', 'madarignore'))
        continue
      }
      let stats
      try { stats = lstatSync(path) } catch {
        exclusions.push({ path: local, kind: 'unreadable', reason: 'unreadable_path' })
        outcomes.push(outcome(local, 'file', 'failed', 'unreadable_path'))
        continue
      }
      if (stats.isSymbolicLink()) {
        if (!options.followSymlinks) {
          outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'symlink_disabled'))
          continue
        }
        let target
        try { target = realpathSync(path) } catch {
          exclusions.push({ path: local, kind: 'unreadable', reason: 'unreadable_path' })
          outcomes.push(outcome(local, 'file', 'failed', 'unreadable_path'))
          continue
        }
        if (!withinRoot(rootReal, target)) {
          outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'symlink_outside_root'))
          continue
        }
        const targetStats = statSync(target)
        if (targetStats.isDirectory()) visit(path)
        else if (targetStats.isFile()) processFile(path)
        continue
      }
      if (stats.isDirectory()) {
        if (entry.name.startsWith('.')) {
          const reason = sensitiveDirectoryReasonForPath(path, root)
          if (reason || isSensitiveDirectoryName(entry.name)) {
            exclusions.push({ path: local, kind: 'sensitive', reason: reason ?? 'sensitive_directory' })
          } else outcomes.push(outcome(local, 'directory', 'skipped_by_policy', 'hidden_path'))
          continue
        }
        visit(path)
      } else if (stats.isFile()) processFile(path)
    }
  }

  const processFile = (path: string): void => {
    scannedFiles += 1
    const local = localDiscoveryPath(root, path)
    const extension = extname(path).toLowerCase()
    if (basename(path).startsWith('.') && !CONTROL_FILE.test(basename(path))) {
      const reason = sensitiveReason(path, root)
      if (reason) exclusions.push({ path: local, kind: 'sensitive', reason })
      else if (SUPPORTED_EXTENSIONS.has(extension) || RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
        outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'hidden_path'))
      }
      return
    }
    if (MANAGED_INSTRUCTIONS.has(basename(path)) || NOISE_FILE.test(path)) {
      if (NOISE_FILE.test(path)) outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'noise_path'))
      return
    }
    const reason = sensitiveReason(path, root)
    if (reason) {
      exclusions.push({ path: local, kind: 'sensitive', reason })
      return
    }
    if (gitVisible && !gitVisible.has(resolve(path))) {
      if (SUPPORTED_EXTENSIONS.has(extension) || RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
        outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'gitignored'))
      }
      return
    }
    if (CONTROL_FILE.test(basename(path))) {
      const entry = readEntry(path, root, exclusions, outcomes)
      if (entry) controls.push(entry)
      return
    }
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      const entry = readEntry(path, root, exclusions, outcomes, INDEX_CAPABILITY[extension] ?? null)
      if (!entry) return
      supported.push(entry)
      try { totalWords += readFileSync(path, 'utf8').split(/\s+/).filter(Boolean).length } catch { /* readEntry recorded */ }
      outcomes.push({ path: entry.path, kind: 'file', status: 'indexed', reason: 'indexed', capability: INDEX_CAPABILITY[extension] ?? null })
      return
    }
    if (RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
      const entry = readEntry(path, root, exclusions, outcomes)
      // Unsupported inputs are inventory only. Their path identity matters for
      // add/delete/rename receipts, but content edits cannot stale a JS/TS index.
      if (entry) unsupported.push({ ...entry, hash: sha256(`unsupported:${entry.path}`) })
      outcomes.push(outcome(local, 'file', 'unsupported', 'unsupported_file_type'))
    }
  }

  visit(root)
  return { supported, controls, unsupported, exclusions, outcomes, totalWords, scannedFiles, patterns }
}

export function buildSourceCatalog(rootPath = '.', options: SourceCatalogOptions = {}): SourceCatalog {
  const root = resolve(rootPath)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Workspace root not found: ${root}`)
  const visible = options.respectGitignore ? collectGitVisibleFiles(root) : null
  const scanned = scanTree(root, options, visible ? new Set(visible.map((path) => resolve(path))) : null)
  const supportedFiles = scanned.supported.map((entry) => resolve(root, entry.path))
  const snapshot = createSourceSnapshot({
    supported: scanned.supported,
    controls: scanned.controls,
    unsupported: scanned.unsupported,
  })
  const policySettings = {
    index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
    respect_gitignore: options.respectGitignore === true,
    follow_symlinks: options.followSymlinks === true,
    exclusion_rules_fingerprint: sha256(JSON.stringify({
      hard_ignored: [...HARD_IGNORED_SEGMENTS].sort(),
      patterns: scanned.patterns,
    })),
    indexing_strict: options.indexingStrict
      ? { max_failed: options.indexingStrict.maxFailed, max_unsupported: options.indexingStrict.maxUnsupported }
      : null,
  } as const
  const fileCount = scanned.supported.length
  const warning = scanned.totalWords < 50_000
    ? `Corpus is ~${scanned.totalWords.toLocaleString()} words - fits in a single context window. You may not need a graph.`
    : scanned.totalWords >= 500_000 || fileCount >= 200
      ? `Large corpus: ${fileCount} files · ~${scanned.totalWords.toLocaleString()} words. Graph generation will take longer and produce larger artifacts.`
      : null
  return {
    rootPath: root,
    supportedFiles,
    snapshot,
    policy: createGenerationPolicy(policySettings),
    sourceRoot: sourceRootIdentity(root),
    outcomes: scanned.outcomes,
    discoverySafety: buildDiscoverySafetyMetadata(scanned.exclusions),
    totalWords: scanned.totalWords,
    warning,
    scannedFiles: scanned.scannedFiles,
  }
}

/** Re-scan through the same catalog contract immediately before publication. */
export function sourceCatalogStillCurrent(catalog: SourceCatalog, options: SourceCatalogOptions = {}): boolean {
  const current = buildSourceCatalog(catalog.rootPath, options)
  return current.policy.fingerprint === catalog.policy.fingerprint
    && current.sourceRoot.kind === catalog.sourceRoot.kind
    && current.sourceRoot.scope === catalog.sourceRoot.scope
    && sourceSnapshotsEqual(current.snapshot, catalog.snapshot)
}

export function readSourceFileHash(path: string): string | null {
  try { return sha256(readFileSync(path)) } catch { return null }
}
