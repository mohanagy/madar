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
  strategy: 'git' | 'filesystem'
  generated_at: string
  generated_ms: number
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

export function buildGraphBuildFreshnessMetadata(rootPath: string, sourceFiles: readonly string[]): GraphBuildFreshnessMetadata {
  const generatedMs = Date.now()
  const generatedAt = new Date(generatedMs).toISOString()
  const indexedFiles = indexedSourceFiles(rootPath, sourceFiles)
  const snapshot = readGitSnapshot(rootPath)

  if (snapshot) {
    const indexedFileSet = new Set(indexedFiles)
    const dirtyFiles = snapshot.dirtyFiles.filter((filePath) => indexedFileSet.has(filePath))
    const dirtyFileFingerprints = Object.fromEntries(
      dirtyFiles
        .map((filePath) => {
          const absolutePath = resolve(rootPath, filePath)
          return existsSync(absolutePath)
            ? [filePath, fileContentFingerprint(absolutePath)] as const
            : null
        })
        .filter((entry): entry is readonly [string, string] => entry !== null),
    )

    return {
      strategy: 'git',
      generated_at: generatedAt,
      generated_ms: generatedMs,
      git: {
        head_sha: snapshot.headSha,
        dirty_files: dirtyFiles,
        dirty_file_fingerprints: dirtyFileFingerprints,
      },
    }
  }

  const fileFingerprints = Object.fromEntries(
    indexedFiles
      .map((filePath) => {
        const absolutePath = resolve(rootPath, filePath)
        return existsSync(absolutePath)
          ? [filePath, fileContentFingerprint(absolutePath)] as const
          : null
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  )

  return {
    strategy: 'filesystem',
    generated_at: generatedAt,
    generated_ms: generatedMs,
    filesystem: {
      file_fingerprints: fileFingerprints,
    },
  }
}

export function isGraphBuildFreshnessMetadata(value: unknown): value is GraphBuildFreshnessMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Partial<GraphBuildFreshnessMetadata>
  if (
    (candidate.strategy !== 'git' && candidate.strategy !== 'filesystem')
    || typeof candidate.generated_at !== 'string'
    || typeof candidate.generated_ms !== 'number'
    || !Number.isFinite(candidate.generated_ms)
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
