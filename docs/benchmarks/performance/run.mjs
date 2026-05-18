#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import { runGeneratePerformanceBenchmark } from '../../../dist/src/infrastructure/benchmark/generate-performance.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const timestamp = new Date().toISOString().replace(/:/g, '-')
const fixtureRoot = resolve(process.env.GRAPHIFY_PERF_FIXTURE ?? join(here, 'fixture'))
const workDir = resolve(process.env.GRAPHIFY_PERF_RESULTS_DIR ?? join(here, 'results', timestamp))

const summary = runGeneratePerformanceBenchmark({
  fixtureRoot,
  workDir,
})

console.log(JSON.stringify(summary, null, 2))
