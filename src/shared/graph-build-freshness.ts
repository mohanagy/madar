import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { readGitSnapshot } from './git.js'

export interface GraphBuildGitFreshnessMetadata {
  head_sha: string
  dirty_files: string[]
  dirty_file_fingerprints: Record<string, string>
}

export interface GraphBuildFilesystemFreshnessMetadata {
  file_fingerprints: Record<string, string>
}

export interface GraphBuildFreshnessMetadata {
  format_version: 4
  strategy: 'git' | 'filesystem'
  generated_at: string
  generated_ms: number
  supported_receipt_paths: string[]
  unsupported_receipt_paths: string[]
  control_file_fingerprints: Record<string, string>
  follow_symlinks: boolean
  respect_gitignore: boolean
  git?: GraphBuildGitFreshnessMetadata
  filesystem?: GraphBuildFilesystemFreshnessMetadata
}

function normalizeSourceFile(rootPath: string, sourceFile: string): string {
  const trimmed = sourceFile.trim()
  if (trimmed.length === 0) {
    return ''
  }

  if (!isAbsolute(trimmed)) {
    return trimmed.replaceAll('\\', '/')
  }

  const relativePath = relative(resolve(rootPath), resolve(trimmed))
  if (relativePath === '' || relativePath === '.') {
    return ''
  }
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return ''
  }
  return relativePath.replaceAll('\\', '/')
}

export function normalizeFreshnessSourceFile(rootPath: string, sourceFile: string): string {
  return normalizeSourceFile(rootPath, sourceFile)
}

export function fileContentFingerprint(filePath: string): string {
  const stats = statSync(filePath)
  if (!stats.isFile()) {
    return createHash('sha256')
      .update(`non-file:${stats.isDirectory() ? 'dir' : 'other'}:${stats.size}:${stats.mtimeMs}`)
      .digest('hex')
  }
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function indexedSourceFiles(rootPath: string, sourceFiles: readonly string[]): string[] {
  return [...new Set(
    sourceFiles
      .map((sourceFile) => normalizeFreshnessSourceFile(rootPath, sourceFile))
      .filter((sourceFile) => sourceFile.length > 0),
  )].sort((left, right) => left.localeCompare(right))
}

const existingFingerprints = (root: string, paths: readonly string[], includeMissing = false): Record<string, string> => Object.fromEntries(paths.flatMap((path) => existsSync(resolve(root, path)) ? [[path, fileContentFingerprint(resolve(root, path))]] : includeMissing ? [[path, '']] : []))

export function buildGraphBuildFreshnessMetadata(rootPath: string, sourceFiles: readonly string[], options: { supportedReceiptPaths: readonly string[]; unsupportedReceiptPaths: readonly string[]; compilerControlPaths: readonly string[]; followSymlinks?: boolean; respectGitignore?: boolean }): GraphBuildFreshnessMetadata {
  const generatedMs = Date.now()
  const generatedAt = new Date(generatedMs).toISOString()
  const indexedFiles = indexedSourceFiles(rootPath, sourceFiles)
  const supportedReceiptPaths = indexedSourceFiles(rootPath, options.supportedReceiptPaths)
  const unsupportedReceiptPaths = indexedSourceFiles(rootPath, options.unsupportedReceiptPaths)
  const controlFileFingerprints = existingFingerprints(rootPath, [...new Set([...options.compilerControlPaths, '.madarignore'])], true)
  const snapshot = readGitSnapshot(rootPath)
  const common = {
    format_version: 4 as const,
    generated_at: generatedAt,
    generated_ms: generatedMs,
    supported_receipt_paths: supportedReceiptPaths,
    unsupported_receipt_paths: unsupportedReceiptPaths,
    control_file_fingerprints: controlFileFingerprints,
    follow_symlinks: options.followSymlinks === true,
    respect_gitignore: options.respectGitignore === true,
  }

  if (snapshot && common.respect_gitignore) {
    const unsupported = new Set(unsupportedReceiptPaths)
    const relevant = new Set([...supportedReceiptPaths, ...unsupportedReceiptPaths, ...Object.keys(controlFileFingerprints)])
    const dirtyFiles = snapshot.dirtyFiles.filter((filePath) => relevant.has(filePath))
    const dirtyFileFingerprints = existingFingerprints(rootPath, dirtyFiles.filter((path) => !unsupported.has(path)), true)

    return {
      ...common,
      strategy: 'git',
      git: {
        head_sha: snapshot.headSha,
        dirty_files: dirtyFiles,
        dirty_file_fingerprints: dirtyFileFingerprints,
      },
    }
  }

  return {
    ...common,
    strategy: 'filesystem',
    filesystem: {
      file_fingerprints: existingFingerprints(rootPath, indexedFiles),
    },
  }
}

export function isGraphBuildFreshnessMetadata(value: unknown): value is GraphBuildFreshnessMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Partial<GraphBuildFreshnessMetadata>
  if (
    candidate.format_version !== 4 || (candidate.strategy !== 'git' && candidate.strategy !== 'filesystem')
    || typeof candidate.generated_at !== 'string'
    || typeof candidate.generated_ms !== 'number'
    || !Number.isFinite(candidate.generated_ms)
    || !Array.isArray(candidate.supported_receipt_paths) || !candidate.supported_receipt_paths.every((path) => typeof path === 'string')
    || !Array.isArray(candidate.unsupported_receipt_paths) || !candidate.unsupported_receipt_paths.every((path) => typeof path === 'string')
    || !candidate.control_file_fingerprints || typeof candidate.control_file_fingerprints !== 'object' || Array.isArray(candidate.control_file_fingerprints)
    || typeof candidate.follow_symlinks !== 'boolean' || typeof candidate.respect_gitignore !== 'boolean'
  ) {
    return false
  }

  if (candidate.strategy === 'git') {
    return !!candidate.git
      && typeof candidate.git.head_sha === 'string'
      && Array.isArray(candidate.git.dirty_files)
      && !!candidate.git.dirty_file_fingerprints
      && typeof candidate.git.dirty_file_fingerprints === 'object'
      && !Array.isArray(candidate.git.dirty_file_fingerprints)
  }

  return !!candidate.filesystem
    && !!candidate.filesystem.file_fingerprints
    && typeof candidate.filesystem.file_fingerprints === 'object'
    && !Array.isArray(candidate.filesystem.file_fingerprints)
}
