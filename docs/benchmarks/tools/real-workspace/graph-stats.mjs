#!/usr/bin/env node
/*
 * Reads counts from a canonical v2 graph artifact.
 *
 * The v1-era version of this script JSON.parsed out/graph.json. That path now
 * holds the tombstone, so the old script fails on a current workspace -- and,
 * worse, `wc -c` on the same path returns the tombstone's size, which would be
 * recorded as a graph that had shrunk by three orders of magnitude. This one
 * requires the canonical artifact and refuses anything else by name.
 */

import { readFileSync } from 'node:fs'

const HEADER = 'MADAR_GRAPH_ARTIFACT/2'
const MOVED_PREFIX = 'MADAR_GRAPH_MOVED/'

const artifactPath = process.argv[2]
if (!artifactPath) {
  console.error('usage: graph-stats.mjs <out/graph.madar>')
  process.exit(2)
}

const text = readFileSync(artifactPath, 'utf8')

if (text.startsWith(MOVED_PREFIX)) {
  console.error(
    `${artifactPath} is a moved marker, not a graph. The canonical artifact is out/graph.madar; ` +
    'measuring this file would record the marker\'s size as the graph size.',
  )
  process.exit(1)
}

if (!text.startsWith(`${HEADER}\n`)) {
  console.error(
    `${artifactPath} does not begin with ${HEADER}. A v1 graph.json is not comparable with a v2 ` +
    'artifact; see docs/benchmarks/2026-05-11-spi-vs-legacy for the v1-era measurements.',
  )
  process.exit(1)
}

const payload = text.slice(HEADER.length + 1)
let graph
try {
  graph = JSON.parse(payload)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`failed to parse the artifact payload at ${artifactPath}: ${message}`)
  process.exit(1)
}

// Counted from the v2 shape. `facts` is not `links`: a v1 link was one edge,
// while a fact carries its own evidence, so the two counts are not comparable
// across the cutover and the field name says which one this is.
const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0
const factCount = Array.isArray(graph.facts) ? graph.facts.length : 0

console.log(JSON.stringify({
  artifact_header: HEADER,
  artifact_bytes: Buffer.byteLength(text, 'utf8'),
  node_count: nodeCount,
  fact_count: factCount,
}))
