import { readFileSync, statSync } from 'node:fs'
import { deserializeGraphArtifact, serializeGraphArtifact } from '../../domain/graph/artifact.js'
import type { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import { writeTextFileAtomically } from '../../shared/atomic-file.js'
import { validateGraphPath } from '../../shared/security.js'
const MAX_GRAPH_BYTES = 100 * 1024 * 1024
export function readGraphArtifact(graphPath: string): string {
  const safePath = validateGraphPath(graphPath)
  if (statSync(safePath).size > MAX_GRAPH_BYTES) throw new Error(`Graph file too large: ${safePath}`)
  return readFileSync(safePath, 'utf8')
}
export function loadGraphArtifact(graphPath: string): KnowledgeGraph { return deserializeGraphArtifact(readGraphArtifact(graphPath)) }
export function writeGraphArtifact(graph: KnowledgeGraph, graphPath: string): void { writeTextFileAtomically(graphPath, serializeGraphArtifact(graph)) }
