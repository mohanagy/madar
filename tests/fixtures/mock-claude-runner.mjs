#!/usr/bin/env node
// Mock `claude --output-format json` runner used by the compare native_agent
// smoke test. Emits a deterministic JSON object on stdout that conforms to the
// shape madar's parser expects (top-level `usage`, `num_turns`, `duration_ms`,
// `total_cost_usd`, and a `result` text body).
//
// Numeric fixtures are loaded from the public benchmark artifact at
// docs/benchmarks/2026-04-30-govalidate/{baseline,madar}-session.json so
// the mock and the artifact stay in sync automatically. If the artifact is
// missing or malformed, falls back to deterministic inline defaults so smoke
// tests still run on a fresh checkout without the docs/ tree.
//
// Usage:
//   mock-claude-runner.mjs <prompt-file>
//
// Behavior:
// - MADAR_MOCK_MODE=baseline → emits the baseline numbers.
// - Anything else (or unset)    → emits the madar numbers.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const benchmarkDir = resolve(here, '..', '..', 'docs', 'benchmarks', '2026-04-30-govalidate')

const FALLBACK_BASELINE = {
  duration_ms: 96368,
  duration_api_ms: 95000,
  num_turns: 9,
  session_id: 'mock-baseline-session',
  total_cost_usd: 0.62,
  usage: {
    input_tokens: 14,
    cache_creation_input_tokens: 40648,
    cache_read_input_tokens: 574528,
    output_tokens: 3152,
  },
}

const FALLBACK_MADAR = {
  duration_ms: 34744,
  duration_api_ms: 34000,
  num_turns: 3,
  session_id: 'mock-madar-session',
  total_cost_usd: 0.7,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 92833,
    cache_read_input_tokens: 140662,
    output_tokens: 1893,
  },
}

function loadArtifactOrFallback(filename, fallback) {
  const path = resolve(benchmarkDir, filename)
  if (!existsSync(path)) {
    return fallback
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.usage &&
      typeof parsed.num_turns === 'number' &&
      typeof parsed.duration_ms === 'number'
    ) {
      return parsed
    }
  } catch {
    // fall through to defaults
  }
  return fallback
}

const promptPath = process.argv[2] ?? null
const prompt = promptPath !== null && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : ''
const mode = process.env.MADAR_MOCK_MODE === 'baseline' ? 'baseline' : 'madar'

const baselineSource = loadArtifactOrFallback('baseline-session.json', FALLBACK_BASELINE)
const madarSource = loadArtifactOrFallback('madar-session.json', FALLBACK_MADAR)

const baseline = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: baselineSource.duration_ms,
  duration_api_ms: baselineSource.duration_api_ms ?? FALLBACK_BASELINE.duration_api_ms,
  num_turns: baselineSource.num_turns,
  result: `mock baseline answer for prompt of length ${prompt.length}`,
  session_id: baselineSource.session_id ?? FALLBACK_BASELINE.session_id,
  total_cost_usd: baselineSource.total_cost_usd ?? FALLBACK_BASELINE.total_cost_usd,
  usage: baselineSource.usage,
}

const madar = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: madarSource.duration_ms,
  duration_api_ms: madarSource.duration_api_ms ?? FALLBACK_MADAR.duration_api_ms,
  num_turns: madarSource.num_turns,
  result: `mock madar answer for prompt of length ${prompt.length}`,
  session_id: madarSource.session_id ?? FALLBACK_MADAR.session_id,
  total_cost_usd: madarSource.total_cost_usd ?? FALLBACK_MADAR.total_cost_usd,
  usage: madarSource.usage,
}

const payload = mode === 'baseline' ? baseline : madar
process.stdout.write(`${JSON.stringify(payload)}\n`)
