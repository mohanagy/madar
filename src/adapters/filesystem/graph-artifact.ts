import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { deserializeGraphArtifact, GRAPH_ARTIFACT_REGENERATE_MESSAGE, serializeGraphArtifact } from '../../domain/graph/artifact.js'
import type { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import { readBuildState } from '../../domain/index/build-state.js'
import { writeTextFileAtomically } from '../../shared/atomic-file.js'
import { validateGraphPath } from '../../shared/security.js'
const MAX_GRAPH_BYTES = 100 * 1024 * 1024
const descriptorIdentity = (stats: ReturnType<typeof fstatSync>) => `${stats.dev}:${stats.ino}:${stats.ctimeMs}:${stats.mtimeMs}:${stats.size}`
export function readBoundedUtf8(descriptor: number, maxBytes: number, tooLarge: string): string {
  const chunks: Buffer[] = []; let total = 0
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const count = readSync(descriptor, chunk, 0, chunk.length, null)
    if (count === 0) return Buffer.concat(chunks, total).toString('utf8')
    chunks.push(chunk.subarray(0, count)); total += count
  }
  throw new Error(tooLarge)
}
export interface GraphArtifactReceipt {
  readonly artifact: string; readonly graph: KnowledgeGraph; readonly graphPath: string
  readonly graphSha256: string; readonly graphModifiedMs: number; readonly identity: string
}
export function readGraphArtifactReceipt(graphPath: string, cached?: GraphArtifactReceipt | null): GraphArtifactReceipt {
  const safePath = validateGraphPath(graphPath)
  const descriptor = openSync(safePath, 'r')
  try {
    const stats = fstatSync(descriptor)
    if (stats.size > MAX_GRAPH_BYTES) throw new Error(`Graph file too large: ${safePath}`)
    const identity = descriptorIdentity(stats)
    if (cached?.graphPath === safePath && cached.identity === identity) return cached
    const artifact = readBoundedUtf8(descriptor, MAX_GRAPH_BYTES, `Graph file too large: ${safePath}`)
    if (descriptorIdentity(fstatSync(descriptor)) !== identity) throw new Error(`Graph file changed while being read: ${safePath}`)
    return {
      artifact, graph: parseGraphArtifact(artifact), graphPath: safePath,
      graphSha256: createHash('sha256').update(artifact).digest('hex'),
      graphModifiedMs: Math.trunc(stats.mtimeMs), identity,
    }
  } finally { closeSync(descriptor) }
}
export function readGraphArtifact(graphPath: string): string { return readGraphArtifactReceipt(graphPath).artifact }
export function parseGraphArtifact(artifact: string): KnowledgeGraph {
  const graph = deserializeGraphArtifact(artifact)
  if (graph.graph.canonical_typescript_index === true && !readBuildState(graph)) throw new Error(GRAPH_ARTIFACT_REGENERATE_MESSAGE)
  return graph
}
export function loadGraphArtifact(graphPath: string): KnowledgeGraph { return readGraphArtifactReceipt(graphPath).graph }
export function writeGraphArtifact(graph: KnowledgeGraph, graphPath: string): void { writeTextFileAtomically(graphPath, serializeGraphArtifact(graph)) }
