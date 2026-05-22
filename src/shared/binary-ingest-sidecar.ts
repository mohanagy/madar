import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { isRecord } from './guards.js'

export interface BinaryIngestSidecarMetadata {
  source_url: string
  captured_at: string
  contributor: string
  ingest_url_type?: 'pdf' | 'image' | 'audio' | 'video'
}

export const BINARY_INGEST_SIDECAR_SUFFIX = '.sadeem-ingest.json'

export function binaryIngestSidecarPath(assetPath: string): string {
  return join(dirname(assetPath), `.${basename(assetPath)}${BINARY_INGEST_SIDECAR_SUFFIX}`)
}

export function writeBinaryIngestSidecar(assetPath: string, metadata: BinaryIngestSidecarMetadata): string {
  const sidecarPath = binaryIngestSidecarPath(assetPath)
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  return sidecarPath
}

export function readBinaryIngestSidecar(assetPath: string): Partial<BinaryIngestSidecarMetadata> | null {
  const sidecarPath = binaryIngestSidecarPath(assetPath)
  if (!existsSync(sidecarPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown
    if (!isRecord(parsed)) {
      return null
    }

    const metadata: Partial<BinaryIngestSidecarMetadata> = {}
    if (typeof parsed.source_url === 'string') {
      metadata.source_url = parsed.source_url
    }
    if (typeof parsed.captured_at === 'string') {
      metadata.captured_at = parsed.captured_at
    }
    if (typeof parsed.contributor === 'string') {
      metadata.contributor = parsed.contributor
    }
    if (parsed.ingest_url_type === 'pdf' || parsed.ingest_url_type === 'image' || parsed.ingest_url_type === 'audio' || parsed.ingest_url_type === 'video') {
      metadata.ingest_url_type = parsed.ingest_url_type
    }

    return Object.keys(metadata).length > 0 ? metadata : null
  } catch {
    return null
  }
}

function normalizedMtimeMs(path: string): number {
  try {
    const modifiedAt = statSync(path).mtimeMs
    return Number.isFinite(modifiedAt) ? Math.round(modifiedAt) : 0
  } catch {
    return 0
  }
}

function fingerprintText(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function sidecarAwareFileFingerprint(filePath: string, fileModifiedAt?: number): number {
  const normalizedFileModifiedAt = Number.isFinite(fileModifiedAt) ? Math.round(fileModifiedAt ?? 0) : normalizedMtimeMs(filePath)
  const normalizedSidecarModifiedAt = normalizedMtimeMs(binaryIngestSidecarPath(filePath))
  return fingerprintText(`${normalizedFileModifiedAt}|${normalizedSidecarModifiedAt}`)
}
