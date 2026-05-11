#!/usr/bin/env node
// Aggregate the per-variant JSON files into a single summary.json.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const resultsDir = process.argv[2]
if (!resultsDir) {
  console.error('usage: summarize.mjs <results-dir>')
  process.exit(2)
}

const variants = ['legacy', 'spi-cold', 'spi-warm']
const results = {}
for (const variant of variants) {
  const path = join(resultsDir, `${variant}.json`)
  if (!existsSync(path)) continue
  results[variant] = JSON.parse(readFileSync(path, 'utf8'))
}

// Extract spi-warm time from its log via wall-clock — captured separately in the bash script.
const summary = {
  timestamp_iso: new Date().toISOString(),
  variants: results,
  analysis: {},
  comparison: {},
}

const analysisPath = join(resultsDir, 'spi-cold.analysis.json')
if (existsSync(analysisPath)) {
  summary.analysis['spi-cold'] = JSON.parse(readFileSync(analysisPath, 'utf8'))
}

if (results.legacy && results['spi-cold']) {
  const legacy = results.legacy
  const spi = results['spi-cold']
  summary.comparison = {
    build_time_delta_ms: spi.build_time_ms - legacy.build_time_ms,
    build_time_delta_pct: legacy.build_time_ms === 0 ? null : ((spi.build_time_ms - legacy.build_time_ms) / legacy.build_time_ms * 100).toFixed(1),
    graph_size_delta_bytes: spi.graph_size_bytes - legacy.graph_size_bytes,
    graph_size_delta_pct: legacy.graph_size_bytes === 0 ? null : ((spi.graph_size_bytes - legacy.graph_size_bytes) / legacy.graph_size_bytes * 100).toFixed(1),
    node_count_delta: spi.node_count - legacy.node_count,
    // CodeRabbit fix: pair prompts by id, not by array index. If a prompt
    // is missing from one side, surface it as `missing_on: 'spi' | 'legacy'`
    // rather than silently mis-pairing the remaining entries.
    per_prompt: (() => {
      // CodeRabbit follow-up: guard against missing/malformed prompts
      // arrays so summarize.mjs doesn't throw if a variant ran with no
      // pack evaluations (e.g., legacy-only or spi-only manual runs).
      const legacyPrompts = Array.isArray(legacy?.prompts) ? legacy.prompts : []
      const spiPrompts = Array.isArray(spi?.prompts) ? spi.prompts : []
      const spiById = new Map(spiPrompts.map((p) => [p.id, p]))
      const legacyById = new Map(legacyPrompts.map((p) => [p.id, p]))
      const allIds = Array.from(new Set([...legacyPrompts.map((p) => p.id), ...spiPrompts.map((p) => p.id)]))
      return allIds.map((id) => {
        const legacyPrompt = legacyById.get(id)
        const spiPrompt = spiById.get(id)
        if (!legacyPrompt) return { id, missing_on: 'legacy', spi_tokens: spiPrompt?.pack_token_count ?? 0 }
        if (!spiPrompt) return { id, missing_on: 'spi', legacy_tokens: legacyPrompt.pack_token_count }
        return {
          id,
          legacy_tokens: legacyPrompt.pack_token_count,
          spi_tokens: spiPrompt.pack_token_count,
          token_delta: spiPrompt.pack_token_count - legacyPrompt.pack_token_count,
          legacy_nodes: legacyPrompt.pack_node_count,
          spi_nodes: spiPrompt.pack_node_count,
          legacy_top_labels: legacyPrompt.top_labels,
          spi_top_labels: spiPrompt.top_labels,
        }
      })
    })(),
  }
}

console.log(JSON.stringify(summary, null, 2))
