import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, basename } from 'node:path'

import { binaryIngestSidecarPath } from '../shared/binary-ingest-sidecar.js'
import { MAX_FETCH_BYTES } from '../shared/security.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'

function appendBinaryIngestSidecarHash(hash: ReturnType<typeof createHash>, filePath: string): void {
  const sidecarPath = binaryIngestSidecarPath(filePath)
  if (!existsSync(sidecarPath)) {
    return
  }

  hash.update('\0')
  hash.update(readFileSync(sidecarPath))
  hash.update('\0')
  hash.update(resolve(sidecarPath))
}

export function fileHash(filePath: string): string {
  const stats = statSync(filePath)
  const hash = createHash('sha256')
  if (stats.size > MAX_FETCH_BYTES) {
    hash.update(resolve(filePath))
    hash.update('\0')
    hash.update(String(stats.size))
    hash.update('\0')
    hash.update(String(stats.mtimeMs))
    appendBinaryIngestSidecarHash(hash, filePath)
    return hash.digest('hex')
  }

  hash.update(readFileSync(filePath))
  hash.update('\0')
  hash.update(resolve(filePath))
  appendBinaryIngestSidecarHash(hash, filePath)
  return hash.digest('hex')
}

export function cacheDir(root: string = '.', ...segments: string[]): string {
  const directory = join(resolveMadarOutputDirectory(root), 'cache', ...segments)
  mkdirSync(directory, { recursive: true })
  return directory
}

export function loadCached(filePath: string, root: string = '.'): Record<string, unknown> | null {
  try {
    const hash = fileHash(filePath)
    const entryPath = join(cacheDir(root), `${hash}.json`)
    const text = readFileSync(entryPath, 'utf8')
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export function saveCached(filePath: string, result: Record<string, unknown>, root: string = '.'): void {
  let hash: string
  try {
    hash = fileHash(filePath)
  } catch {
    return
  }
  const directory = cacheDir(root)
  const entryPath = join(directory, `${hash}.json`)
  const tempPath = join(directory, `${hash}.${process.pid}.${randomUUID()}.json.tmp`)

  try {
    writeFileSync(tempPath, JSON.stringify(result))
    renameSync(tempPath, entryPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

export function cachedFiles(root: string = '.'): string[] {
  const directory = cacheDir(root)
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => basename(entry, '.json'))
    .sort()
}

export function clearCache(root: string = '.'): void {
  const directory = cacheDir(root)
  for (const entry of readdirSync(directory)) {
    if (entry.endsWith('.json')) {
      rmSync(join(directory, entry), { force: true })
    }
  }
}
