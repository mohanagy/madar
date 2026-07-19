import { accessSync, constants, Dirent, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'

import type { IndexingOutcome } from '../contracts/indexing.js'
import { parseGenerationPolicy, type GenerationPolicy } from '../contracts/generation-policy.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { writeTextFileAtomically } from '../shared/atomic-file.js'
import {
  isDiscoveryPathIgnored,
  isIgnoredByPatterns,
  loadMadarignorePatterns,
} from '../shared/source-discovery.js'
import {
  type DiscoveryExclusion,
  isSensitiveDirectoryName,
  localDiscoveryPath,
  sensitiveArtifactReason,
  sensitiveDirectoryReasonForPath,
} from '../shared/discovery-safety.js'

export const FileType = {
  CODE: 'code',
  DOCUMENT: 'document',
  PAPER: 'paper',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
} as const

export type FileTypeValue = (typeof FileType)[keyof typeof FileType]

export interface DetectOptions {
  followSymlinks?: boolean
  /** Restrict discovery to these absolute paths after Madar's own filters. */
  includedFiles?: ReadonlySet<string>
}

export interface DetectResult {
  files: Record<FileTypeValue, string[]>
  total_files: number
  total_words: number
  needs_graph: boolean
  warning: string | null
  /** @deprecated Prefer the structured `exclusions` collection. */
  skipped_sensitive: string[]
  exclusions: DiscoveryExclusion[]
  indexing_outcomes?: IndexingOutcome[]
  madarignore_patterns: number
}

export const CODE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.js',
  '.jsx',
  '.tsx',
  '.go',
  '.rs',
  '.java',
  '.cpp',
  '.cc',
  '.cxx',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.swift',
  '.kt',
  '.kts',
  '.cs',
  '.scala',
  '.php',
  '.lua',
  '.toc',
  '.zig',
  '.ps1',
  '.ex',
  '.exs',
  '.m',
  '.mm',
  '.jl',
])
export const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst'])
export const PAPER_EXTENSIONS = new Set(['.pdf'])
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
export const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav'])
export const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'])
export const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx'])
export const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.bash', '.clj', '.cljs', '.dart', '.elm', '.fs', '.fsx', '.groovy', '.hs', '.r', '.sh', '.sol', '.sql', '.svelte', '.vue',
])

const CORPUS_WARN_THRESHOLD = 50_000
const CORPUS_UPPER_THRESHOLD = 500_000
const FILE_COUNT_UPPER = 200
export const DEFAULT_MANIFEST_PATH = 'out/manifest.json'
export const MANIFEST_METADATA_KEY = '__madar_meta__'

export interface ManifestMetadata {
  total_words?: number
  generation_policy?: GenerationPolicy
}

export interface ManifestSnapshot {
  document: Record<string, number | ManifestMetadata>
  failedPaths: string[]
}

const PAPER_SIGNALS = [
  /\barxiv\b/i,
  /\bdoi\s*:/i,
  /\babstract\b/i,
  /\bproceedings\b/i,
  /\bjournal\b/i,
  /\bpreprint\b/i,
  /\\cite\{/,
  /\[\d+\]/,
  /\[\n\d+\n\]/,
  /eq\.\s*\d+|equation\s+\d+/i,
  /\d{4}\.\d{4,5}/,
  /\bwe propose\b/i,
  /\bliterature\b/i,
]
const PAPER_SIGNAL_THRESHOLD = 3

const ASSET_DIR_MARKERS = ['.imageset', '.xcassets', '.appiconset', '.colorset', '.launchimage']
const SKIP_DIRS = new Set([
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  'target',
  'site-packages',
  'lib64',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.eggs',
  'storybook-static',
])

const NOISE_FILE_PATTERNS: RegExp[] = [
  /\.stories\.(ts|tsx|js|jsx)$/i,
]

function isNoiseFile(name: string): boolean {
  return NOISE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function isPotentialIndexingCandidate(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return CODE_EXTENSIONS.has(extension)
    || DOC_EXTENSIONS.has(extension)
    || PAPER_EXTENSIONS.has(extension)
    || IMAGE_EXTENSIONS.has(extension)
    || AUDIO_EXTENSIONS.has(extension)
    || VIDEO_EXTENSIONS.has(extension)
    || OFFICE_EXTENSIONS.has(extension)
    || UNSUPPORTED_SOURCE_EXTENSIONS.has(extension)
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function isNoiseDir(part: string): boolean {
  return SKIP_DIRS.has(part) || part.endsWith('_venv') || part.endsWith('_env') || part.endsWith('.egg-info')
}

function sensitiveReasonForFile(path: string, root: string) {
  return sensitiveArtifactReason(path, root, {
    isSourceFile: CODE_EXTENSIONS.has(extname(path).toLowerCase()),
  })
}

export function _looksLikePaper(path: string): boolean {
  try {
    const text = readFileSync(path, 'utf8').slice(0, 3_000)
    const hits = PAPER_SIGNALS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
    return hits >= PAPER_SIGNAL_THRESHOLD
  } catch {
    return false
  }
}

export function classifyFile(path: string): FileTypeValue | null {
  const extension = extname(path).toLowerCase()
  if (CODE_EXTENSIONS.has(extension)) {
    return FileType.CODE
  }
  if (PAPER_EXTENSIONS.has(extension)) {
    const pathParts = toPosixPath(path).split('/')
    if (pathParts.some((part) => ASSET_DIR_MARKERS.some((marker) => part.endsWith(marker)))) {
      return null
    }
    return FileType.PAPER
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return FileType.IMAGE
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return FileType.AUDIO
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return FileType.VIDEO
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return _looksLikePaper(path) ? FileType.PAPER : FileType.DOCUMENT
  }
  if (OFFICE_EXTENSIONS.has(extension)) {
    return FileType.DOCUMENT
  }
  return null
}

function countWordsOrNull(path: string): number | null {
  try {
    const extension = extname(path).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension) || PAPER_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) {
      return 0
    }
    return readFileSync(path, 'utf8').split(/\s+/).filter(Boolean).length
  } catch {
    return null
  }
}

export function countWords(path: string): number {
  return countWordsOrNull(path) ?? 0
}

export function _loadMadarignore(root: string): string[] {
  return loadMadarignorePatterns(root)
}

export function _isIgnored(path: string, root: string, patterns: string[]): boolean {
  return isIgnoredByPatterns(path, root, patterns)
}

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rootPrefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`
  return candidateRealPath === rootRealPath || candidateRealPath.startsWith(rootPrefix)
}

function visitDirectory(
  directory: string,
  root: string,
  followSymlinks: boolean,
  ignorePatterns: string[],
  ancestorRealPaths: string[],
  rootRealPath: string,
  files: string[],
  exclusions: DiscoveryExclusion[],
  indexingOutcomes: IndexingOutcome[],
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    exclusions.push({
      path: localDiscoveryPath(root, directory),
      kind: 'unreadable',
      reason: 'unreadable_directory',
    })
    return
  }

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name)
    const normalizedEntryPath = toPosixPath(entryPath)

    if (isDiscoveryPathIgnored(entryPath, root, ignorePatterns)) {
      const ignoredByMadarignore = isIgnoredByPatterns(entryPath, root, ignorePatterns)
      if (ignoredByMadarignore || (!entry.isDirectory() && isPotentialIndexingCandidate(entryPath))) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: entry.isDirectory() ? 'directory' : 'file',
          status: 'skipped_by_policy',
          reason: ignoredByMadarignore ? 'madarignore' : 'hard_ignored',
          capability: null,
        })
      }
      continue
    }

    if (isNoiseFile(entry.name)) {
      indexingOutcomes.push({
        path: localDiscoveryPath(root, entryPath),
        kind: 'file',
        status: 'skipped_by_policy',
        reason: 'noise_path',
        capability: null,
      })
      continue
    }

    let stats
    try {
      stats = lstatSync(entryPath)
    } catch {
      exclusions.push({
        path: localDiscoveryPath(root, entryPath),
        kind: 'unreadable',
        reason: 'unreadable_path',
      })
      continue
    }

    if (stats.isDirectory()) {
      if (entry.name.startsWith('.')) {
        if (isSensitiveDirectoryName(entry.name)) {
          const directoryReason = sensitiveDirectoryReasonForPath(entryPath, root) ?? 'sensitive_directory'
          exclusions.push({
            path: localDiscoveryPath(root, entryPath),
            kind: 'sensitive',
            reason: directoryReason,
          })
        } else {
          indexingOutcomes.push({
            path: localDiscoveryPath(root, entryPath),
            kind: 'directory',
            status: 'skipped_by_policy',
            reason: 'hidden_path',
            capability: null,
          })
        }
        continue
      }
      if (isNoiseDir(entry.name)) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'noise_path',
          capability: null,
        })
        continue
      }
      visitDirectory(entryPath, root, followSymlinks, ignorePatterns, ancestorRealPaths, rootRealPath, files, exclusions, indexingOutcomes)
      continue
    }

    if (stats.isSymbolicLink()) {
      const sensitiveReason = sensitiveReasonForFile(entryPath, root)
      if (sensitiveReason) {
        exclusions.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'sensitive',
          reason: sensitiveReason,
        })
        continue
      }
      if (entry.name.startsWith('.')) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'hidden_path',
          capability: null,
        })
        continue
      }
      if (!followSymlinks) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'symlink_disabled',
          capability: null,
        })
        continue
      }

      let realTarget: string
      try {
        realTarget = realpathSync(entryPath)
      } catch {
        exclusions.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'unreadable',
          reason: 'unreadable_path',
        })
        continue
      }

      if (ancestorRealPaths.includes(realTarget)) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'symlink_cycle',
          capability: null,
        })
        continue
      }
      if (!isWithinRoot(rootRealPath, realTarget)) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'symlink_outside_root',
          capability: null,
        })
        continue
      }

      let targetStats
      try {
        targetStats = lstatSync(realTarget)
      } catch {
        exclusions.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'unreadable',
          reason: 'unreadable_path',
        })
        continue
      }

      const targetDirectoryReason = targetStats.isDirectory()
        ? sensitiveDirectoryReasonForPath(realTarget, rootRealPath)
        : null
      if (targetDirectoryReason) {
        exclusions.push({
          path: localDiscoveryPath(root, entryPath),
          kind: 'sensitive',
          reason: targetDirectoryReason,
        })
        continue
      }
      if (targetStats.isFile()) {
        const targetSensitiveReason = sensitiveReasonForFile(realTarget, rootRealPath)
        if (targetSensitiveReason) {
          exclusions.push({
            path: localDiscoveryPath(root, entryPath),
            kind: 'sensitive',
            reason: targetSensitiveReason,
          })
          continue
        }
      }

      if (targetStats.isDirectory()) {
        const nextAncestors = [...ancestorRealPaths, realTarget]
        visitDirectory(entryPath, root, followSymlinks, ignorePatterns, nextAncestors, rootRealPath, files, exclusions, indexingOutcomes)
      } else if (targetStats.isFile()) {
        files.push(normalizedEntryPath)
      }
      continue
    }

    if (stats.isFile()) {
      if (entry.name.startsWith('.')) {
        const sensitiveReason = sensitiveReasonForFile(entryPath, root)
        if (sensitiveReason) {
          exclusions.push({
            path: localDiscoveryPath(root, entryPath),
            kind: 'sensitive',
            reason: sensitiveReason,
          })
        } else if (isPotentialIndexingCandidate(entryPath)) {
          indexingOutcomes.push({
            path: localDiscoveryPath(root, entryPath),
            kind: 'file',
            status: 'skipped_by_policy',
            reason: 'hidden_path',
            capability: null,
          })
        }
        continue
      }
      files.push(normalizedEntryPath)
    }
  }
}

function collectFiles(root: string, followSymlinks: boolean, ignorePatterns: string[]): {
  files: string[]
  exclusions: DiscoveryExclusion[]
  indexingOutcomes: IndexingOutcome[]
} {
  const resolvedRoot = resolve(root)
  mkdirSync(resolvedRoot, { recursive: true })

  const files: string[] = []
  const exclusions: DiscoveryExclusion[] = []
  const indexingOutcomes: IndexingOutcome[] = []
  let rootRealPath = resolvedRoot
  try {
    rootRealPath = realpathSync(resolvedRoot)
  } catch {
    rootRealPath = resolvedRoot
  }

  visitDirectory(
    resolvedRoot,
    resolvedRoot,
    followSymlinks,
    ignorePatterns,
    [rootRealPath],
    rootRealPath,
    files,
    exclusions,
    indexingOutcomes,
  )

  return {
    files: [...new Set(files)].sort(),
    exclusions,
    indexingOutcomes,
  }
}

function inferOutputBase(outputPath: string): string {
  const resolvedPath = resolve(outputPath)
  const parts = resolvedPath.split(sep)
  const madarOutIndex = parts.lastIndexOf('out')

  if (madarOutIndex >= 0) {
    const baseParts = parts.slice(0, madarOutIndex + 1)
    if (baseParts[0] === '') {
      return `${sep}${baseParts.slice(1).join(sep)}`
    }
    return baseParts.join(sep)
  }

  return resolve('out')
}

function validateManifestPath(manifestPath: string): string {
  const resolvedPath = resolve(manifestPath)
  const resolvedBase = inferOutputBase(manifestPath)
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Manifest path must stay within out/: ${manifestPath}`)
  }
  return resolvedPath
}

function indexingOutcomeFromDiscoveryExclusion(root: string, exclusion: DiscoveryExclusion): IndexingOutcome {
  let directory = exclusion.reason === 'unreadable_directory'
  if (!directory) {
    try {
      directory = statSync(resolve(root, exclusion.path)).isDirectory()
    } catch {
      directory = false
    }
  }
  return {
    path: exclusion.path,
    kind: directory ? 'directory' : 'file',
    status: exclusion.kind === 'unreadable' ? 'failed' : 'skipped_by_policy',
    reason: exclusion.reason,
    capability: null,
  }
}

export function detect(root: string, options: DetectOptions = {}): DetectResult {
  const followSymlinks = options.followSymlinks ?? false
  const ignorePatterns = _loadMadarignore(root)
  const files: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
    [FileType.AUDIO]: [],
    [FileType.VIDEO]: [],
  }

  let totalWords = 0
  const collected = collectFiles(root, followSymlinks, ignorePatterns)
  const exclusions: DiscoveryExclusion[] = [...collected.exclusions]
  const indexingOutcomes: IndexingOutcome[] = [...collected.indexingOutcomes]

  for (const filePath of collected.files) {
    if (options.includedFiles && !options.includedFiles.has(resolve(filePath))) {
      if (isPotentialIndexingCandidate(filePath)) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, filePath),
          kind: 'file',
          status: 'skipped_by_policy',
          reason: 'gitignored',
          capability: null,
        })
      }
      continue
    }
    const sensitiveReason = sensitiveReasonForFile(filePath, root)
    if (sensitiveReason) {
      exclusions.push({
        path: localDiscoveryPath(root, filePath),
        kind: 'sensitive',
        reason: sensitiveReason,
      })
      continue
    }

    const fileType = classifyFile(filePath)
    if (!fileType) {
      if (isPotentialIndexingCandidate(filePath)) {
        indexingOutcomes.push({
          path: localDiscoveryPath(root, filePath),
          kind: 'file',
          status: 'unsupported',
          reason: 'unsupported_file_type',
          capability: null,
        })
      }
      continue
    }

    try {
      accessSync(filePath, constants.R_OK)
    } catch {
      exclusions.push({
        path: localDiscoveryPath(root, filePath),
        kind: 'unreadable',
        reason: 'unreadable_path',
      })
      continue
    }

    const wordCount = countWordsOrNull(filePath)
    if (wordCount === null) {
      exclusions.push({
        path: localDiscoveryPath(root, filePath),
        kind: 'unreadable',
        reason: 'unreadable_path',
      })
      continue
    }

    files[fileType].push(filePath)
    totalWords += wordCount
  }

  indexingOutcomes.push(...exclusions.map((exclusion) => indexingOutcomeFromDiscoveryExclusion(root, exclusion)))

  const totalFiles = Object.values(files).reduce((count, group) => count + group.length, 0)
  const needsGraph = totalWords >= CORPUS_WARN_THRESHOLD

  let warning: string | null = null
  if (!needsGraph) {
    warning = `Corpus is ~${totalWords.toLocaleString()} words - fits in a single context window. You may not need a graph.`
  } else if (totalWords >= CORPUS_UPPER_THRESHOLD || totalFiles >= FILE_COUNT_UPPER) {
    warning = `Large corpus: ${totalFiles} files · ~${totalWords.toLocaleString()} words. Graph generation will take longer and produce larger artifacts. Consider running on a subfolder first, or targeting a smaller high-value slice of the repo.`
  }

  return {
    files,
    total_files: totalFiles,
    total_words: totalWords,
    needs_graph: needsGraph,
    warning,
    skipped_sensitive: exclusions.filter((entry) => entry.kind === 'sensitive').map((entry) => entry.path),
    exclusions,
    indexing_outcomes: indexingOutcomes,
    madarignore_patterns: ignorePatterns.length,
  }
}

function loadManifestDocument(manifestPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(validateManifestPath(manifestPath), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function loadManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): Record<string, number> {
  return Object.fromEntries(
    Object.entries(loadManifestDocument(manifestPath)).filter(
      (entry): entry is [string, number] => entry[0] !== MANIFEST_METADATA_KEY && typeof entry[1] === 'number',
    ),
  )
}

export function loadManifestMetadata(manifestPath: string = DEFAULT_MANIFEST_PATH): ManifestMetadata {
  const metadata = loadManifestDocument(manifestPath)[MANIFEST_METADATA_KEY]
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }

  const totalWords = (metadata as { total_words?: unknown }).total_words
  const generationPolicy = parseGenerationPolicy((metadata as { generation_policy?: unknown }).generation_policy)
  return {
    ...(typeof totalWords === 'number' && Number.isFinite(totalWords) && totalWords >= 0 ? { total_words: totalWords } : {}),
    ...(generationPolicy ? { generation_policy: generationPolicy } : {}),
  }
}

export function createManifestSnapshot(
  files: Record<string, string[]>,
  metadata: ManifestMetadata = {},
): ManifestSnapshot {
  const manifest: Record<string, number | ManifestMetadata> = {}
  const failedPaths: string[] = []

  for (const fileList of Object.values(files)) {
    for (const filePath of fileList) {
      try {
        const modifiedAt = statSync(filePath).mtimeMs
        if (Number.isFinite(modifiedAt)) {
          manifest[filePath] = sidecarAwareFileFingerprint(filePath, modifiedAt)
        }
      } catch {
        failedPaths.push(filePath)
      }
    }
  }

  const manifestMetadata: ManifestMetadata = {
    ...(typeof metadata.total_words === 'number' && Number.isFinite(metadata.total_words) && metadata.total_words >= 0
      ? { total_words: metadata.total_words }
      : {}),
    ...(metadata.generation_policy ? { generation_policy: metadata.generation_policy } : {}),
  }
  if (Object.keys(manifestMetadata).length > 0) {
    manifest[MANIFEST_METADATA_KEY] = manifestMetadata
  }

  return { document: manifest, failedPaths }
}

export function writeManifestSnapshot(
  snapshot: ManifestSnapshot,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): void {
  const safeManifestPath = validateManifestPath(manifestPath)
  mkdirSync(dirname(safeManifestPath), { recursive: true })
  writeTextFileAtomically(safeManifestPath, `${JSON.stringify(snapshot.document, null, 2)}\n`)
}

export function saveManifest(
  files: Record<string, string[]>,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  metadata: ManifestMetadata = {},
): string[] {
  const snapshot = createManifestSnapshot(files, metadata)
  writeManifestSnapshot(snapshot, manifestPath)
  return snapshot.failedPaths
}

export function detectIncremental(
  root: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  options: DetectOptions = {},
): DetectResult & {
  incremental: true
  new_files: Record<FileTypeValue, string[]>
  unchanged_files: Record<FileTypeValue, string[]>
  new_total: number
  deleted_files: string[]
} {
  const full = detect(root, options)
  const manifest = loadManifest(manifestPath)

  if (Object.keys(manifest).length === 0) {
    return {
      ...full,
      incremental: true,
      new_files: full.files,
      unchanged_files: {
        [FileType.CODE]: [],
        [FileType.DOCUMENT]: [],
        [FileType.PAPER]: [],
        [FileType.IMAGE]: [],
        [FileType.AUDIO]: [],
        [FileType.VIDEO]: [],
      },
      new_total: full.total_files,
      deleted_files: [],
    }
  }

  const newFiles: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
    [FileType.AUDIO]: [],
    [FileType.VIDEO]: [],
  }
  const unchangedFiles: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
    [FileType.AUDIO]: [],
    [FileType.VIDEO]: [],
  }

  for (const [fileType, fileList] of Object.entries(full.files) as Array<[FileTypeValue, string[]]>) {
    for (const filePath of fileList) {
      let currentFingerprint = 0
      try {
        currentFingerprint = sidecarAwareFileFingerprint(filePath, statSync(filePath).mtimeMs)
      } catch {
        currentFingerprint = 0
      }

      const storedFingerprint = manifest[filePath]
      if (storedFingerprint === undefined || currentFingerprint !== storedFingerprint) {
        newFiles[fileType].push(filePath)
      } else {
        unchangedFiles[fileType].push(filePath)
      }
    }
  }

  const currentFiles = new Set(Object.values(full.files).flat())
  const deletedFiles = Object.keys(manifest).filter((filePath) => !currentFiles.has(filePath))

  return {
    ...full,
    incremental: true,
    new_files: newFiles,
    unchanged_files: unchangedFiles,
    new_total: Object.values(newFiles).reduce((count, fileList) => count + fileList.length, 0),
    deleted_files: deletedFiles,
  }
}
