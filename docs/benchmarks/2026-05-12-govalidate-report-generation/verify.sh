#!/usr/bin/env bash
# Reproducer for the 2026-05-12 GoValidate report-generation compare benchmark.
#
# Drop the compare report.json from:
#   out/compare/2026-05-12T19-18-26/report.json
# into this directory, then run this script to recompute the published totals.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$DIR/report.json"

if [ ! -f "$REPORT" ]; then
  echo "[madar benchmark] $REPORT not found." >&2
  echo "[madar benchmark] Drop report.json from your" >&2
  echo "[madar benchmark] out/compare/2026-05-12T19-18-26/ here." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[madar benchmark] node is required (>= 20)." >&2
  exit 1
fi

node - <<'NODE' "$REPORT"
const fs = require('fs')

const reportPath = process.argv[2]
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

function pickRun(key) {
  const run = report?.[key]
  if (!run || typeof run !== 'object') {
    throw new Error(`Missing ${key} run in report.json`)
  }
  return run
}

function totalInputTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    throw new Error('Missing Anthropic usage block in report.json')
  }
  return Number(usage.input_tokens ?? 0)
    + Number(usage.cache_creation_input_tokens ?? 0)
    + Number(usage.cache_read_input_tokens ?? 0)
}

function formatPercent(saved, baseline) {
  return Number(((saved / baseline) * 100).toFixed(1))
}

function formatRatio(baseline, madar) {
  return Number((baseline / madar).toFixed(2))
}

const baseline = pickRun('baseline')
const madar = pickRun('madar')

if (baseline.kind !== 'succeeded' || madar.kind !== 'succeeded') {
  throw new Error('Expected succeeded baseline/madar runs in report.json')
}

const baselineTokens = totalInputTokens(baseline.usage)
const madarTokens = totalInputTokens(madar.usage)
const savedTokens = baselineTokens - madarTokens
const savedTurns = baseline.num_turns - madar.num_turns
const savedLatency = baseline.duration_ms - madar.duration_ms

console.log(`report_path: ${reportPath}`)
console.log(`input_tokens: baseline ${baselineTokens} -> madar ${madarTokens}`)
console.log(`input_tokens_saved: ${savedTokens}`)
console.log(`input_token_reduction_percent: ${formatPercent(savedTokens, baselineTokens)}%`)
console.log(`input_token_ratio: ${formatRatio(baselineTokens, madarTokens)}x less`)
console.log(`turns: baseline ${baseline.num_turns} -> madar ${madar.num_turns}`)
console.log(`turns_saved: ${savedTurns}`)
console.log(`turn_reduction_percent: ${formatPercent(savedTurns, baseline.num_turns)}%`)
console.log(`turn_ratio: ${formatRatio(baseline.num_turns, madar.num_turns)}x fewer`)
console.log(`latency_ms: baseline ${baseline.duration_ms} -> madar ${madar.duration_ms}`)
console.log(`latency_saved_ms: ${savedLatency}`)
console.log(`latency_reduction_percent: ${formatPercent(savedLatency, baseline.duration_ms)}%`)
console.log(`latency_ratio: ${formatRatio(baseline.duration_ms, madar.duration_ms)}x faster`)
NODE

echo
echo "Expected 2026-05-12 benchmark values:"
echo "  input_tokens  : 1653307 -> 498280 (1155027 saved, ~69.9% reduction, 3.32x less)"
echo "  turns         : 19 -> 8 (11 saved, ~57.9% reduction, 2.38x fewer)"
echo "  latency_ms    : 116029 -> 67454 (48575 saved, ~41.9% reduction, 1.72x faster)"
