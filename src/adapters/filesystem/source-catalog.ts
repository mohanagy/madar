import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
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
import { compareCodeUnits } from '../../domain/graph/canonical-json.js'
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
  '.md', '.mdx', '.txt', '.rst', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm',
  '.docx', '.xlsx',
])
const HARD_IGNORED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.jj', '.repo', '.worktrees', 'worktrees', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.madar', 'madar-cache', 'madar-report', '.next', '.nuxt', '.svelte-kit',
  '.astro', '.vite', '.turbo', '.nx', '.parcel-cache', '.cache', '.serverless', '.vercel', '.netlify',
  '.nyc_output', '.test-artifacts', 'logs', 'tmp', 'temp', 'venv', '.venv', 'env', '__pycache__', 'target',
  'site-packages', 'lib64', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.eggs', 'storybook-static',
])
const CONTROL_FILE = /^(?:package\.json|(?:ts|js)config(?:\..+)?\.json|\.madarignore|\.gitignore)$/i
const PROJECT_CONFIG = /^(?:ts|js)config(?:\..+)?\.json$/i
const NOISE_FILE = /\.stories\.(?:ts|tsx|js|jsx)$/i
const GENERATED_FILE = /(?:\.min\.(?:js|css)|\.map|\.tsbuildinfo|\.d\.ts\.map|\.log)$/i
const MANAGED_INSTRUCTIONS = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
const INDEX_CAPABILITY: Record<string, string> = {
  '.ts': 'builtin:index:typescript', '.tsx': 'builtin:index:tsx',
  '.js': 'builtin:index:javascript', '.jsx': 'builtin:index:jsx',
}
export interface SourceCatalogOptions {
  followSymlinks?: boolean; respectGitignore?: boolean; indexingStrict?: IndexingStrictThresholds
}
export interface SourceCatalog {
  rootPath: string; supportedFiles: string[]; snapshot: SourceSnapshot; policy: GenerationPolicy
  sourceRoot: SourceRootIdentity; outcomes: IndexingOutcome[]; discoverySafety: DiscoverySafetyMetadata
  totalWords: number; warning: string | null; scannedFiles: number
}
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function normalize(path: string): string { return path.split(sep).join('/') }
function localPath(root: string, path: string): string { return normalize(relative(root, path)).replace(/^\.\//, '') }
function withinRoot(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}
function isHardIgnored(path: string, root: string): boolean {
  const local = localPath(root, path)
  const parts = local.split('/').filter(Boolean)
  if (parts.some((part) => HARD_IGNORED_SEGMENTS.has(part.toLowerCase()))) return true
  return GENERATED_FILE.test(local) || /(?:^|\/)\.DS_Store$/i.test(local)
}
function isHiddenPath(path: string, root: string): boolean { return localPath(root, path).split('/').some((part) => part.startsWith('.')) }
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
    const path = resolve(root, '.madarignore'); const stats = lstatSync(path); if (!stats.isFile() || stats.size > 1_000_000) return []
    return readFileSync(path, 'utf8').split(/\r?\n/)
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
function sensitiveReason(path: string, root: string) { return sensitiveArtifactReason(path, root, { isSourceFile: SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()) }) }
const outcome = (path: string, kind: 'file' | 'directory', status: IndexingOutcome['status'],
  reason: IndexingOutcome['reason']): IndexingOutcome => ({ path, kind, status, reason, capability: null })
function readEntry(
  readPath: string,
  root: string,
  exclusions: DiscoveryExclusion[],
  outcomes: IndexingOutcome[],
  capability: string | null = null,
  snapshotPath = readPath,
): { entry: SourceSnapshotEntry; contents: Buffer } | null {
  try {
    const contents = readFileSync(readPath)
    return { entry: { path: localPath(root, snapshotPath), hash: sha256(contents) }, contents }
  } catch {
    const local = localDiscoveryPath(root, snapshotPath)
    exclusions.push({ path: local, kind: 'unreadable', reason: 'unreadable_path' })
    outcomes.push({ ...outcome(local, 'file', 'failed', 'unreadable_path'), capability })
    return null
  }
}
function configDependencySnapshotPath(root: string, path: string, contents: Buffer): string {
  const canonical = canonicalPath(path)
  if (withinRoot(canonicalPath(root), canonical)) return localPath(canonicalPath(root), canonical)
  const parts = normalize(canonical).split('/').filter(Boolean)
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  const portableIdentity = nodeModulesIndex >= 0
    ? `package:${parts.slice(nodeModulesIndex + 1).join('/')}`
    : `external:${normalize(relative(canonicalPath(root), canonical))}`
  return `.madar-config-dependencies/${sha256(portableIdentity)}-${sha256(contents)}.json`
}
function compilerControlDependencies(root: string, controls: readonly SourceSnapshotEntry[]): SourceSnapshotEntry[] {
  const configPaths = controls.filter((entry) => PROJECT_CONFIG.test(basename(entry.path))).map((entry) => resolve(root, entry.path))
  const sourceRoot = canonicalPath(root), boundary = canonicalPath(resolveMadarWorkspace(root).worktreeRoot ?? root)
  const allowed = (path: string) => {
    const canonical = canonicalPath(path), marker = canonical.toLowerCase().lastIndexOf(`${sep}node_modules${sep}`)
    const packageRoot = marker >= 0 ? canonical.slice(0, marker) : null, policyRoot = packageRoot ?? boundary
    return (withinRoot(boundary, canonical) || (!!packageRoot && withinRoot(packageRoot, sourceRoot)))
      && !sensitiveDirectoryReasonForPath(canonical, policyRoot) && !sensitiveReason(canonical, policyRoot)
  }
  const checked = (path: string) => {
    const canonical = canonicalPath(path)
    if (!allowed(canonical)) throw new Error(`Refusing compiler configuration outside the workspace safety boundary: ${path}`)
    return canonical
  }
  const captured = new Map<string, Buffer>()
  const read = (path: string): string | undefined => {
    const canonical = checked(path)
    const cached = captured.get(canonical)
    if (cached) return cached.toString('utf8')
    try {
      const contents = readFileSync(path)
      captured.set(canonical, contents)
      return contents.toString('utf8')
    } catch { return undefined }
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (path) => ts.sys.fileExists(path) && Boolean(checked(path)),
    readFile: read,
    readDirectory: () => [],
  }
  configPaths.sort(compareCodeUnits)
  for (let index = 0; index < configPaths.length; index += 1) {
    const configPath = configPaths[index]!
    const contents = read(configPath)
    if (contents === undefined) continue
    const parsed = ts.parseConfigFileTextToJson(configPath, contents)
    if (!parsed.config) continue
    const config = ts.parseJsonConfigFileContent(parsed.config, host, dirname(configPath), undefined, configPath)
    for (const reference of config.projectReferences ?? []) {
      const referenced = checked(ts.resolveProjectReferencePath(reference))
      if (!configPaths.includes(referenced)) configPaths.push(referenced)
    }
  }
  return [...captured].map(([path, contents]) => ({ path: configDependencySnapshotPath(root, path, contents), hash: sha256(contents) }))
}
function sourceRootIdentity(root: string): SourceRootIdentity {
  const workspace = resolveMadarWorkspace(root)
  const worktreeRoot = workspace.worktreeRoot
  return {
    kind: workspace.isLinkedWorktree ? 'linked_worktree' : worktreeRoot ? 'primary_worktree' : 'directory',
    root_path: workspace.rootPath,
    worktree_root: worktreeRoot,
    scope: worktreeRoot ? normalize(relative(realpathSync(worktreeRoot), realpathSync(workspace.rootPath))) || '.' : '.',
  }
}
function canonicalPath(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }
export function sourceRootIdentitiesEqual(left: SourceRootIdentity, right: SourceRootIdentity): boolean {
  const sameWorktree = left.worktree_root === null || right.worktree_root === null
    ? left.worktree_root === right.worktree_root
    : canonicalPath(left.worktree_root) === canonicalPath(right.worktree_root)
  return left.kind === right.kind
    && left.scope === right.scope
    && canonicalPath(left.root_path) === canonicalPath(right.root_path)
    && sameWorktree
}
function inventorySnapshot(outcomes: readonly IndexingOutcome[],
  exclusions: readonly DiscoveryExclusion[]): SourceSnapshotEntry[] {
  const entries: Array<readonly [string, string]> = [
    ...outcomes.filter((entry) => entry.status !== 'indexed' && entry.status !== 'unsupported')
      .map((entry) => [entry.path, `outcome:${entry.kind}:${entry.status}:${entry.reason}:${entry.capability ?? ''}`] as const),
    ...exclusions.map((entry) => [entry.path, `exclusion:${entry.kind}:${entry.reason}`] as const),
  ].sort(([leftPath, left], [rightPath, right]) => compareCodeUnits(leftPath, rightPath) || compareCodeUnits(left, right))
  const receipts = new Map<string, string>()
  for (const [path, value] of entries) receipts.set(path, `${receipts.get(path) ?? ''}${value}\n`)
  return [...receipts].map(([path, value]) => ({ path, hash: sha256(value) }))
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
  const unreadable = (path: string, kind: 'file' | 'directory', reason: 'unreadable_path' | 'unreadable_directory') => {
    exclusions.push({ path, kind: 'unreadable', reason })
    outcomes.push({
      ...outcome(path, kind, 'failed', reason),
      capability: kind === 'file' ? INDEX_CAPABILITY[extname(path).toLowerCase()] ?? null : null,
    })
  }
  const excludeSensitive = (path: string, reason: DiscoveryExclusion['reason']) => exclusions.push({ path, kind: 'sensitive', reason })
  const skip = (path: string, kind: 'file' | 'directory', reason: IndexingOutcome['reason']) => outcomes.push(outcome(path, kind, 'skipped_by_policy', reason))
  const visit = (directory: string, followedSymlink = false, gitVisibilityAnchor: string | null = null): void => {
    let directoryReal: string
    try { directoryReal = realpathSync(directory) } catch {
      unreadable(localDiscoveryPath(root, directory), 'directory', 'unreadable_directory')
      return
    }
    if (!withinRoot(rootReal, directoryReal)) { skip(localDiscoveryPath(root, directory), 'directory', 'symlink_outside_root'); return }
    if (visited.has(directoryReal)) return
    visited.add(directoryReal)
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name)) } catch {
      unreadable(localDiscoveryPath(root, directory), 'directory', 'unreadable_directory')
      return
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const physicalPath = resolve(directoryReal, entry.name)
      const local = localDiscoveryPath(root, path)
      const controlFile = CONTROL_FILE.test(entry.name)
      if (/^\.(?:claude|codex|cursor|gemini|opencode|vscode)$/.test(entry.name)) continue
      if (isHardIgnored(path, root) || isHardIgnored(physicalPath, rootReal)) {
        if (!entry.isDirectory()) skip(local, 'file', 'hard_ignored')
        continue
      }
      if ((!controlFile && ignoredByPatterns(path, root, patterns))
        || (followedSymlink && ignoredByPatterns(physicalPath, rootReal, patterns))) {
        skip(local, entry.isDirectory() ? 'directory' : 'file', 'madarignore')
        continue
      }
      let stats
      try { stats = lstatSync(path) } catch {
        unreadable(local, 'file', 'unreadable_path')
        continue
      }
      if (stats.isSymbolicLink()) {
        if (!options.followSymlinks) { skip(local, 'file', 'symlink_disabled'); continue }
        let target
        try { target = realpathSync(path) } catch {
          unreadable(local, 'file', 'unreadable_path')
          continue
        }
        if (!withinRoot(rootReal, target)) { skip(local, 'file', 'symlink_outside_root'); continue }
        const targetStats = statSync(target)
        const targetKind = targetStats.isDirectory() ? 'directory' : 'file'
        const targetPolicyReason = isHardIgnored(target, rootReal) ? 'hard_ignored'
          : ignoredByPatterns(target, rootReal, patterns) ? 'madarignore' : null
        if (targetPolicyReason) { skip(local, targetKind, targetPolicyReason); continue }
        const targetSensitiveReason = sensitiveDirectoryReasonForPath(target, rootReal)
          ?? (targetStats.isFile() ? sensitiveReason(target, rootReal) : null)
        if (targetSensitiveReason) { excludeSensitive(local, targetSensitiveReason); continue }
        if (isHiddenPath(target, rootReal)) { skip(local, targetKind, 'hidden_path'); continue }
        const inheritedGitAnchor = gitVisibilityAnchor ?? path
        if (gitVisible && (!gitVisible.has(resolve(inheritedGitAnchor)) || !gitVisible.has(resolve(root, localPath(rootReal, physicalPath))))) {
          skip(local, targetKind, 'gitignored'); continue
        }
        if (targetStats.isDirectory()) visit(path, true, inheritedGitAnchor)
        else if (targetStats.isFile()) processFile(path, target, true, inheritedGitAnchor)
        continue
      }
      if (stats.isDirectory()) {
        if (entry.name.startsWith('.')) {
          const reason = sensitiveDirectoryReasonForPath(path, root)
          if (reason || isSensitiveDirectoryName(entry.name)) excludeSensitive(local, reason ?? 'sensitive_directory')
          else skip(local, 'directory', 'hidden_path')
          continue
        }
        visit(path, followedSymlink, gitVisibilityAnchor)
      } else if (stats.isFile()) processFile(path, physicalPath, followedSymlink, gitVisibilityAnchor)
    }
  }
  const processFile = (path: string, physicalPath = path, followedSymlink = false, gitVisibilityAnchor: string | null = null): void => {
    scannedFiles += 1
    const local = localDiscoveryPath(root, path)
    const extension = extname(path).toLowerCase()
    const name = basename(path)
    const physicalName = basename(physicalPath)
    if ((name.startsWith('.') && !CONTROL_FILE.test(name))
      || (followedSymlink && isHiddenPath(physicalPath, rootReal))) {
      const reason = sensitiveReason(path, root) ?? sensitiveReason(physicalPath, rootReal)
      if (reason) excludeSensitive(local, reason)
      else if (SUPPORTED_EXTENSIONS.has(extension) || RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
        skip(local, 'file', 'hidden_path')
      }
      return
    }
    const noise = NOISE_FILE.test(path) || NOISE_FILE.test(physicalPath)
    if (MANAGED_INSTRUCTIONS.has(name) || MANAGED_INSTRUCTIONS.has(physicalName) || noise) {
      if (noise) outcomes.push(outcome(local, 'file', 'skipped_by_policy', 'noise_path'))
      return
    }
    const reason = sensitiveReason(path, root)
      ?? sensitiveDirectoryReasonForPath(physicalPath, rootReal)
      ?? sensitiveReason(physicalPath, rootReal)
    if (reason) {
      excludeSensitive(local, reason)
      return
    }
    const controlFile = CONTROL_FILE.test(name)
    const logicalGitVisible = gitVisible?.has(resolve(gitVisibilityAnchor ?? path)) === true
    const physicalGitVisible = gitVisible?.has(resolve(root, localPath(rootReal, physicalPath))) === true
    if (gitVisible && ((!controlFile && !logicalGitVisible)
      || (followedSymlink && (!logicalGitVisible || !physicalGitVisible)))) {
      if (SUPPORTED_EXTENSIONS.has(extension) || RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
        skip(local, 'file', 'gitignored')
      }
      return
    }
    if (controlFile) {
      const captured = readEntry(physicalPath, root, exclusions, outcomes, null, path)
      if (captured) controls.push(captured.entry)
      return
    }
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      const captured = readEntry(physicalPath, root, exclusions, outcomes, INDEX_CAPABILITY[extension] ?? null, path)
      if (!captured) return
      supported.push(captured.entry)
      totalWords += captured.contents.toString('utf8').split(/\s+/).filter(Boolean).length
      outcomes.push({ path: captured.entry.path, kind: 'file', status: 'indexed', reason: 'indexed', capability: INDEX_CAPABILITY[extension] ?? null })
      return
    }
    if (RECOGNIZED_UNSUPPORTED_EXTENSIONS.has(extension)) {
      unsupported.push({ path: local, hash: sha256(`unsupported:${local}`) })
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
  const controlsByPath = new Map(scanned.controls.map((entry) => [entry.path, entry]))
  for (const entry of compilerControlDependencies(root, scanned.controls)) controlsByPath.set(entry.path, entry)
  const supportedFiles = scanned.supported.map((entry) => resolve(root, entry.path))
  const snapshot = createSourceSnapshot({
    supported: scanned.supported,
    controls: [...controlsByPath.values()],
    unsupported: scanned.unsupported,
    inventory: inventorySnapshot(scanned.outcomes, scanned.exclusions),
  })
  const policySettings = {
    index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
    respect_gitignore: options.respectGitignore === true,
    follow_symlinks: options.followSymlinks === true,
    exclusion_rules_fingerprint: sha256(JSON.stringify({
      hard_ignored: [...HARD_IGNORED_SEGMENTS].sort(),
      patterns: scanned.patterns,
    })),
    indexing_strict: options.indexingStrict ? { max_failed: options.indexingStrict.maxFailed, max_unsupported: options.indexingStrict.maxUnsupported } : null,
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
export function sourceCatalogStillCurrent(catalog: SourceCatalog, options: SourceCatalogOptions = {}): boolean {
  const current = buildSourceCatalog(catalog.rootPath, options)
  return current.policy.fingerprint === catalog.policy.fingerprint
    && sourceRootIdentitiesEqual(current.sourceRoot, catalog.sourceRoot)
    && sourceSnapshotsEqual(current.snapshot, catalog.snapshot)
}
export function readSourceFileHash(path: string): string | null { try { return sha256(readFileSync(path)) } catch { return null } }
