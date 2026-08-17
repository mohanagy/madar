import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../../src/contracts/graph-artifact.js'

/**
 * Reads a generated graph as a flat, v1-shaped object.
 *
 * Before #705, generation wrote a v1 `graph.json` and tests read it with a
 * plain `JSON.parse`. The cutover makes `graph.madar` the only active artifact,
 * so that parse now hits an artifact header. Rather than restate hundreds of
 * assertions against the v2 layout, this presents the canonical artifact in the
 * shape those assertions already describe.
 *
 * The mapping is mechanical and lossless in both directions that matter here:
 *
 * - v2 nests producer data under `attributes`; v1 flattened it onto the node or
 *   link. This flattens it back, which is why `node.community` and
 *   `link.confidence` keep working.
 * - v2 calls them `facts`; v1 called them `links`. A fact carries `source`,
 *   `target` and `relation` at the top level already.
 * - v2 groups run metadata under `provenance`; v1 had it at the top level.
 *
 * It deliberately does NOT invent anything the artifact does not contain.
 * `root_path` in particular lives only in the machine-local sidecar and is not
 * merged in here -- read it from the sidecar when a test needs it.
 */
export interface GeneratedGraphJson {
  readonly [key: string]: unknown
  readonly nodes: Record<string, unknown>[]
  readonly links: Record<string, unknown>[]
}

interface V2Node {
  readonly id: string
  readonly attributes?: Record<string, unknown>
}

interface V2Fact {
  readonly source: string
  readonly target: string
  readonly attributes?: Record<string, unknown>
  readonly [key: string]: unknown
}

/** Accepts an output directory, a graph.madar path, or a legacy graph.json path. */
function canonicalArtifactPath(target: string): string {
  if (basename(target) === 'graph.madar') return target
  const directory = basename(target) === 'graph.json' ? dirname(target) : target
  return join(directory, 'graph.madar')
}

export function readGeneratedGraphJson(target: string): GeneratedGraphJson {
  const artifactPath = canonicalArtifactPath(target)
  const raw = readFileSync(artifactPath, 'utf8')
  if (!raw.startsWith(GRAPH_ARTIFACT_V2_HEADER)) {
    throw new Error(`${artifactPath} is not a v2 graph artifact`)
  }
  const payload = JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as Record<string, unknown>

  const provenance = (payload.provenance ?? {}) as Record<string, unknown>
  const nodes = (payload.nodes ?? []) as V2Node[]
  const facts = (payload.facts ?? []) as V2Fact[]

  // v2-only keys are dropped, not passed through. `facts` and `occurrences`
  // are already exposed as `links`, and leaving them in made this object claim
  // to be v1-shaped while carrying content that identifies it as v2 -- a
  // legacy reader rejects such a payload outright, so a test that wrote this
  // back as a "graph from an older binary" was seeding something no binary
  // ever produced.
  const { facts: _facts, occurrences: _occurrences, integrity_receipt: _receipt, versions: _versions,
    reserved: _reserved, provenance: _provenance, ...rest } = payload

  return {
    ...rest,
    ...provenance,
    nodes: nodes.map((node) => ({ id: node.id, ...node.attributes })),
    links: facts.map(({ attributes, ...fact }) => ({ ...fact, ...attributes })),
  } as GeneratedGraphJson
}

/** The machine-local sidecar beside a generated artifact, or null when absent. */
export function readGeneratedSidecar(target: string): Record<string, unknown> | null {
  const sidecar = join(dirname(canonicalArtifactPath(target)), 'graph.local.json')
  return existsSync(sidecar)
    ? (JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>)
    : null
}
