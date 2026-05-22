import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { validateGraphPath } from '../shared/security.js'

export interface GraphFreshnessMetadata {
  graphVersion: string
  graphModifiedMs: number
  graphModifiedAt: string
}

export interface ResourceFreshnessMetadata extends GraphFreshnessMetadata {
  resourceBytes: number
  resourceModifiedMs: number
  resourceModifiedAt: string
  etag: string
}

const VERSION_HASH_LENGTH = 12
const graphVersionCache = new Map<string, { graphVersion: string; mtimeMs: number; size: number }>()

function truncateMtime(mtimeMs: number): number {
  return Math.trunc(mtimeMs)
}

function graphVersionForPath(graphPath: string): { graphVersion: string; mtimeMs: number } {
  const safeGraphPath = validateGraphPath(graphPath)
  const graphStat = statSync(safeGraphPath)
  const truncatedMtime = truncateMtime(graphStat.mtimeMs)
  const cached = graphVersionCache.get(safeGraphPath)

  if (cached && cached.mtimeMs === truncatedMtime && cached.size === graphStat.size) {
    return {
      graphVersion: cached.graphVersion,
      mtimeMs: truncatedMtime,
    }
  }

  const graphVersion = createHash('sha256').update(readFileSync(safeGraphPath)).digest('hex').slice(0, VERSION_HASH_LENGTH)
  graphVersionCache.set(safeGraphPath, {
    graphVersion,
    mtimeMs: truncatedMtime,
    size: graphStat.size,
  })

  return {
    graphVersion,
    mtimeMs: truncatedMtime,
  }
}

export function graphFreshnessMetadata(graphPath: string): GraphFreshnessMetadata {
  const { graphVersion, mtimeMs } = graphVersionForPath(graphPath)

  return {
    graphVersion,
    graphModifiedMs: mtimeMs,
    graphModifiedAt: new Date(mtimeMs).toUTCString(),
  }
}

export function resourceFreshnessMetadata(graphPath: string, resourcePath: string): ResourceFreshnessMetadata {
  const graphFreshness = graphFreshnessMetadata(graphPath)
  const resourceStat = statSync(resourcePath)
  const resourceModifiedMs = truncateMtime(resourceStat.mtimeMs)
  const resourceName = basename(resourcePath)

  return {
    ...graphFreshness,
    resourceBytes: resourceStat.size,
    resourceModifiedMs,
    resourceModifiedAt: new Date(resourceModifiedMs).toUTCString(),
    etag: `W/"sadeem-${graphFreshness.graphVersion}-${resourceName}-${resourceStat.size}-${resourceModifiedMs}"`,
  }
}

export function freshnessAnnotations(metadata: ResourceFreshnessMetadata): Record<string, number | string> {
  return {
    graph_version: metadata.graphVersion,
    graph_modified_ms: metadata.graphModifiedMs,
    graph_modified_at: metadata.graphModifiedAt,
    resource_bytes: metadata.resourceBytes,
    resource_modified_ms: metadata.resourceModifiedMs,
    resource_modified_at: metadata.resourceModifiedAt,
    resource_etag: metadata.etag,
  }
}

export function graphFreshnessHeaders(metadata: GraphFreshnessMetadata): Record<string, string> {
  return {
    'x-sadeem-graph-version': metadata.graphVersion,
    'x-sadeem-graph-modified-ms': String(metadata.graphModifiedMs),
    'x-sadeem-graph-modified-at': metadata.graphModifiedAt,
  }
}

export function resourceFreshnessHeaders(metadata: ResourceFreshnessMetadata): Record<string, string> {
  return {
    ...graphFreshnessHeaders(metadata),
    etag: metadata.etag,
    'last-modified': metadata.resourceModifiedAt,
    'x-sadeem-resource-bytes': String(metadata.resourceBytes),
    'x-sadeem-resource-modified-ms': String(metadata.resourceModifiedMs),
    'x-sadeem-resource-modified-at': metadata.resourceModifiedAt,
  }
}
