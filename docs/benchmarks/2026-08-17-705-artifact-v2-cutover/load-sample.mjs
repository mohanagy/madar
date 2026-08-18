#!/usr/bin/env node
/*
 * One process-isolated load sample.
 *
 * Times `loadGraph(path)` from one arm's own dist in a fresh process, so no
 * module cache, JIT state or heap from a previous arm carries into the next.
 * The import is timed separately and excluded: it measures module loading, not
 * graph loading, and differs between arms for reasons unrelated to the artifact.
 *
 * Prints one JSON line so the driver never has to parse prose.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const [distPath, artifactPath, mode] = process.argv.slice(2)
if (!distPath || !artifactPath) {
  console.error('usage: load-sample.mjs <dist/src/runtime/serve.js> <artifact> [explicit|default]')
  process.exit(2)
}

const serve = await import(distPath)
if (typeof serve.loadGraph !== 'function') {
  console.error(`${distPath} exports no loadGraph`)
  process.exit(2)
}

// Read once before timing so the page cache state is the same for every arm;
// this measures loader work, not cold disk.
const bytes = statSync(artifactPath).size
const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')

const started = process.hrtime.bigint()
const graph = serve.loadGraph(artifactPath)
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

// Semantic counts prove the arms loaded comparable graphs rather than one arm
// silently loading less.
// The base arm predates facts, so it reports links; both are counted through
// whichever accessor the arm's own KnowledgeGraph provides.
const call = (name) => {
  try {
    return typeof graph[name] === 'function' ? graph[name]() : null
  } catch {
    return null
  }
}
const nodeCount = call('numberOfNodes')
const relationshipCount = call('numberOfFacts') ?? call('numberOfLinks') ?? call('numberOfEdges')

console.log(JSON.stringify({
  mode: mode ?? 'explicit',
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  artifact_bytes: bytes,
  artifact_sha256: digest,
  node_count: nodeCount,
  relationship_count: relationshipCount,
  rss_bytes: process.memoryUsage().rss,
}))
