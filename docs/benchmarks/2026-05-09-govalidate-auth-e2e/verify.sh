#!/usr/bin/env bash
# Reproducer for the 2026-05-09 govalidate auth-e2e compare benchmark.
#
# Reads `report.json` produced by `sadeem compare ... --baseline-mode
# native_agent` and prints the headline reductions for human inspection.
#
# To publish this benchmark, drop the report.json from
#   out/compare/2026-05-09T23-21-35/report.json
# (and ideally the paired prompt/answer files) into this directory.
#
# Requires: jq, node.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$DIR/report.json"

if [ ! -f "$REPORT" ]; then
  echo "[sadeem benchmark] $REPORT not found." >&2
  echo "[sadeem benchmark] Drop report.json from your" >&2
  echo "[sadeem benchmark] out/compare/2026-05-09T23-21-35/ here." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[sadeem benchmark] jq is required (brew install jq / apt-get install jq)." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[sadeem benchmark] node is required (>= 20)." >&2
  exit 1
fi

echo "Report path: $REPORT"
echo

# sadeem compare reports nest the per-run usage under a few possible
# shapes depending on version. Walk the JSON for both runs and pull
# num_turns / duration_ms / Anthropic usage block from each.
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const report = JSON.parse(fs.readFileSync(path, "utf8"));

  function findRun(obj, label) {
    if (obj == null || typeof obj !== "object") return null;
    if (obj.label === label || obj.kind === label || obj.run === label) return obj;
    if (obj[label] && typeof obj[label] === "object") return obj[label];
    for (const v of Object.values(obj)) {
      const hit = findRun(v, label);
      if (hit) return hit;
    }
    return null;
  }

  function pickNum(obj, ...keys) {
    for (const key of keys) {
      const v = obj?.[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  }

  function totalInput(usage) {
    if (!usage) return null;
    const i = pickNum(usage, "input_tokens") ?? 0;
    const cc = pickNum(usage, "cache_creation_input_tokens") ?? 0;
    const cr = pickNum(usage, "cache_read_input_tokens") ?? 0;
    const total = i + cc + cr;
    return total > 0 ? total : pickNum(usage, "total_input_tokens");
  }

  const baseline = findRun(report, "baseline") ?? report.baseline ?? report.runs?.baseline;
  const sadeem = findRun(report, "sadeem") ?? report.sadeem ?? report.runs?.sadeem;

  if (!baseline || !sadeem) {
    console.log("[verify] could not locate baseline+sadeem run blocks in report.json.");
    console.log("[verify] dumping the top-level report keys for debugging:");
    console.log(Object.keys(report));
    process.exit(2);
  }

  const bTurns = pickNum(baseline, "num_turns", "turns");
  const gTurns = pickNum(sadeem, "num_turns", "turns");
  const bMs = pickNum(baseline, "duration_ms", "latency_ms", "elapsed_ms");
  const gMs = pickNum(sadeem, "duration_ms", "latency_ms", "elapsed_ms");
  const bUsage = baseline.usage ?? baseline.anthropic_usage;
  const gUsage = sadeem.usage ?? sadeem.anthropic_usage;
  const bTokens = totalInput(bUsage);
  const gTokens = totalInput(gUsage);

  const round2 = (n) => Number(n.toFixed(2));

  if (bTurns && gTurns) {
    console.log("num_turns_reduction     :", round2(bTurns / gTurns) + "x  (" + bTurns + " -> " + gTurns + ")");
  }
  if (bMs && gMs) {
    console.log("latency_reduction       :", round2(bMs / gMs) + "x  (" + bMs + "ms -> " + gMs + "ms)");
  }
  if (bTokens && gTokens) {
    console.log("input_token_reduction   :", round2(bTokens / gTokens) + "x  (" + bTokens + " -> " + gTokens + ")");
  }
  if (bUsage && gUsage) {
    console.log();
    console.log("Anthropic usage (baseline):", JSON.stringify(bUsage, null, 2));
    console.log("Anthropic usage (sadeem):", JSON.stringify(gUsage, null, 2));
  }
' "$REPORT"

echo
echo "Expected reductions captured 2026-05-09T23-21-35Z:"
echo "  num_turns     : 31 -> 14 (2.21x fewer)"
echo "  latency_ms    : 169998 -> 107464 (1.58x faster)"
echo "  input_tokens  : 2811682 -> 532021 (5.28x less)"
