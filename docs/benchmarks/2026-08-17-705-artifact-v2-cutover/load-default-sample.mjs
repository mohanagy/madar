#!/usr/bin/env node
/*
 * One process-isolated DEFAULT-path load sample.
 *
 * Resolves the artifact the way a command with no --graph resolves it, then
 * loads it. This is the path normal current use takes, so it includes workspace
 * classification -- the work #705 added ahead of the load.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const [distRoot, workspaceRoot] = process.argv.slice(2)
const serve = await import(`${distRoot}/src/runtime/serve.js`)
const workspace = await import(`${distRoot}/src/shared/workspace.js`)

const started = process.hrtime.bigint()
const resolved = workspace.graphPathForCommand
  ? workspace.graphPathForCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'default' }, workspaceRoot)
  : workspace.resolveWorkspaceGraphPath('out/graph.json', workspaceRoot)
const graph = serve.loadGraph(resolved)
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

const call = (name) => {
  try { return typeof graph[name] === 'function' ? graph[name]() : null } catch { return null }
}

console.log(JSON.stringify({
  mode: 'default',
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  selected_physical_path: resolved,
  selected_logical_path: workspace.logicalGraphPath ? workspace.logicalGraphPath(resolved, workspaceRoot) : null,
  artifact_bytes: statSync(resolved).size,
  artifact_sha256: createHash('sha256').update(readFileSync(resolved)).digest('hex'),
  node_count: call('numberOfNodes'),
  relationship_count: call('numberOfFacts') ?? call('numberOfLinks') ?? call('numberOfEdges'),
  rss_bytes: process.memoryUsage().rss,
}))
