import { Dirent, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import {
  isDiscoveryPathIgnored,
  isIgnoredByPatterns,
  loadGraphifyignorePatterns,
} from '../shared/source-discovery.js'

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
}

export interface DetectResult {
  files: Record<FileTypeValue, string[]>
  total_files: number
  total_words: number
  needs_graph: boolean
  warning: string | null
  skipped_sensitive: string[]
  graphifyignore_patterns: number
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

const CORPUS_WARN_THRESHOLD = 50_000
const CORPUS_UPPER_THRESHOLD = 500_000
const FILE_COUNT_UPPER = 200
export const DEFAULT_MANIFEST_PATH = 'graphify-out/manifest.json'
export const MANIFEST_METADATA_KEY = '__graphify_meta__'

export interface ManifestMetadata {
  total_words?: number
}

const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /(credential|secret|passwd|password|token|private_key)/i,
  /(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(\.netrc|\.pgpass|\.htpasswd)$/i,
  /(aws_credentials|gcloud_credentials|service.account)/i,
]

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

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function isNoiseDir(part: string): boolean {
  return SKIP_DIRS.has(part) || part.endsWith('_venv') || part.endsWith('_env') || part.endsWith('.egg-info')
}

function isSensitive(path: string): boolean {
  const name = basename(path)
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name) || pattern.test(path))
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

export function countWords(path: string): number {
  try {
    const extension = extname(path).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension) || PAPER_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) {
      return 0
    }
    return readFileSync(path, 'utf8').split(/\s+/).filter(Boolean).length
  } catch {
    return 0
  }
}

export function _loadGraphifyignore(root: string): string[] {
  return loadGraphifyignorePatterns(root)
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
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name)
    const normalizedEntryPath = toPosixPath(entryPath)

    if (entry.name.startsWith('.')) {
      continue
    }

    if (isDiscoveryPathIgnored(entryPath, root, ignorePatterns)) {
      continue
    }

    if (isNoiseFile(entry.name)) {
      continue
    }

    let stats
    try {
      stats = lstatSync(entryPath)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      if (isNoiseDir(entry.name)) {
        continue
      }
      visitDirectory(entryPath, root, followSymlinks, ignorePatterns, ancestorRealPaths, rootRealPath, files)
      continue
    }

    if (stats.isSymbolicLink()) {
      if (!followSymlinks) {
        continue
      }

      let realTarget: string
      try {
        realTarget = realpathSync(entryPath)
      } catch {
        continue
      }

      if (ancestorRealPaths.includes(realTarget)) {
        continue
      }
      if (!isWithinRoot(rootRealPath, realTarget)) {
        continue
      }

      let targetStats
      try {
        targetStats = lstatSync(realTarget)
      } catch {
        continue
      }

      if (targetStats.isDirectory()) {
        const nextAncestors = [...ancestorRealPaths, realTarget]
        visitDirectory(entryPath, root, followSymlinks, ignorePatterns, nextAncestors, rootRealPath, files)
      } else if (targetStats.isFile()) {
        files.push(normalizedEntryPath)
      }
      continue
    }

    if (stats.isFile()) {
      files.push(normalizedEntryPath)
    }
  }
}

function collectFiles(root: string, followSymlinks: boolean, ignorePatterns: string[]): string[] {
  const resolvedRoot = resolve(root)
  mkdirSync(resolvedRoot, { recursive: true })

  const files: string[] = []
  let rootRealPath = resolvedRoot
  try {
    rootRealPath = realpathSync(resolvedRoot)
  } catch {
    rootRealPath = resolvedRoot
  }

  visitDirectory(resolvedRoot, resolvedRoot, followSymlinks, ignorePatterns, [rootRealPath], rootRealPath, files)

  return [...new Set(files)].sort()
}

function inferOutputBase(outputPath: string): string {
  const resolvedPath = resolve(outputPath)
  const parts = resolvedPath.split(sep)
  const graphifyOutIndex = parts.lastIndexOf('graphify-out')

  if (graphifyOutIndex >= 0) {
    const baseParts = parts.slice(0, graphifyOutIndex + 1)
    if (baseParts[0] === '') {
      return `${sep}${baseParts.slice(1).join(sep)}`
    }
    return baseParts.join(sep)
  }

  return resolve('graphify-out')
}

function validateManifestPath(manifestPath: string): string {
  const resolvedPath = resolve(manifestPath)
  const resolvedBase = inferOutputBase(manifestPath)
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Manifest path must stay within graphify-out/: ${manifestPath}`)
  }
  return resolvedPath
}

export function detect(root: string, options: DetectOptions = {}): DetectResult {
  const followSymlinks = options.followSymlinks ?? false
  const ignorePatterns = _loadGraphifyignore(root)
  const files: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
    [FileType.AUDIO]: [],
    [FileType.VIDEO]: [],
  }

  let totalWords = 0
  const skippedSensitive: string[] = []

  for (const filePath of collectFiles(root, followSymlinks, ignorePatterns)) {
    if (isSensitive(filePath)) {
      skippedSensitive.push(filePath)
      continue
    }

    const fileType = classifyFile(filePath)
    if (!fileType) {
      continue
    }

    files[fileType].push(filePath)
    totalWords += countWords(filePath)
  }

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
    skipped_sensitive: skippedSensitive,
    graphifyignore_patterns: ignorePatterns.length,
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
  return typeof totalWords === 'number' && Number.isFinite(totalWords) && totalWords >= 0 ? { total_words: totalWords } : {}
}

export function saveManifest(
  files: Record<string, string[]>,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  metadata: ManifestMetadata = {},
): void {
  const manifest: Record<string, number | ManifestMetadata> = {}

  for (const fileList of Object.values(files)) {
    for (const filePath of fileList) {
      try {
        const modifiedAt = statSync(filePath).mtimeMs
        if (Number.isFinite(modifiedAt)) {
          manifest[filePath] = sidecarAwareFileFingerprint(filePath, modifiedAt)
        }
      } catch {
        // Ignore files deleted between detect() and manifest write.
      }
    }
  }

  if (typeof metadata.total_words === 'number' && Number.isFinite(metadata.total_words) && metadata.total_words >= 0) {
    manifest[MANIFEST_METADATA_KEY] = { total_words: metadata.total_words }
  }

  const safeManifestPath = validateManifestPath(manifestPath)
  mkdirSync(dirname(safeManifestPath), { recursive: true })
  writeFileSync(safeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
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
