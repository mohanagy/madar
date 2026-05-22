#!/usr/bin/env bash
# Reproducer for the 2026-04-30 govalidate benchmark.
#
# Reads the committed `claude --output-format json` outputs and reports the
# computed totals so anyone can verify the headline numbers in the README and
# in madar's marketing copy independently.
#
# Requires: jq, node.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  echo "[madar benchmark] jq is required (brew install jq / apt-get install jq)." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[madar benchmark] node is required (>= 20)." >&2
  exit 1
fi

echo "Baseline usage (no madar):"
jq '.usage' "$DIR/baseline-session.json"
echo
echo "Madar usage (core profile):"
jq '.usage' "$DIR/madar-session.json"
echo
echo "Computed totals:"
node -e '
  const fs = require("fs");
  const dir = process.argv[1];
  const baseline = JSON.parse(fs.readFileSync(dir + "/baseline-session.json", "utf8"));
  const madar = JSON.parse(fs.readFileSync(dir + "/madar-session.json", "utf8"));
  const total = (u) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const b = total(baseline.usage);
  const g = total(madar.usage);
  const round2 = (n) => Number(n.toFixed(2));
  console.log("baseline_total_input_tokens :", b);
  console.log("madar_total_input_tokens :", g);
  console.log("input_token_reduction        :", round2(b / g) + "x");
  console.log("num_turns_reduction          :", round2(baseline.num_turns / madar.num_turns) + "x");
  console.log("latency_reduction            :", round2(baseline.duration_ms / madar.duration_ms) + "x");
  console.log("baseline_total_cost_usd      : $" + baseline.total_cost_usd.toFixed(2));
  console.log("madar_total_cost_usd      : $" + madar.total_cost_usd.toFixed(2));
' "$DIR"
