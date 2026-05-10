#!/usr/bin/env bash
# Aggregator for results bundles produced by run.sh.
# Reads summary.json and prints a side-by-side comparison of backend-only vs
# monorepo graph results across all prompts in the bundle.
#
# Usage:
#   bash aggregate.sh <results/<timestamp>/>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <results-dir>" >&2
  exit 1
fi

RUN_DIR="$1"
SUMMARY="$RUN_DIR/summary.json"
if [ ! -f "$SUMMARY" ]; then
  echo "[aggregate] $SUMMARY not found." >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[aggregate] node is required (>= 20)." >&2
  exit 3
fi

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const summary = JSON.parse(fs.readFileSync(file, "utf8"));

  function ratio(a, b) {
    if (typeof a !== "number" || typeof b !== "number" || b <= 0) return "—";
    return (a / b).toFixed(2) + "x";
  }
  function fmtNum(n) {
    if (typeof n !== "number") return "—";
    return n.toLocaleString("en-US");
  }

  console.log("Generate-time:");
  for (const k of ["backend", "monorepo"]) {
    const g = summary.generate?.[k];
    if (g) console.log(`  ${k.padEnd(9)} ${fmtNum(g.duration_ms)}ms  (${g.path})`);
    else console.log(`  ${k.padEnd(9)} (no data)`);
  }
  console.log();

  const headers = [
    "prompt".padEnd(30),
    "scope".padEnd(10),
    "turns".padStart(6),
    "latency_ms".padStart(12),
    "input_tokens".padStart(14),
    "Δ tokens vs other scope".padStart(24),
  ];
  console.log(headers.join("  "));
  console.log("-".repeat(headers.join("  ").length));

  for (const [promptId, scopes] of Object.entries(summary.per_prompt ?? {})) {
    const b = scopes.backend?.graphify;
    const m = scopes.monorepo?.graphify;

    for (const [label, run, other] of [["backend", b, m], ["monorepo", m, b]]) {
      const turns = run?.num_turns ?? "—";
      const ms = run?.duration_ms ?? "—";
      const tokens = run?.total_input_tokens ?? null;
      const otherTokens = other?.total_input_tokens ?? null;
      const delta = (tokens && otherTokens) ? ratio(tokens, otherTokens) : "—";
      console.log([
        promptId.padEnd(30),
        label.padEnd(10),
        String(turns).padStart(6),
        String(ms).padStart(12),
        fmtNum(tokens).padStart(14),
        delta.padStart(24),
      ].join("  "));
    }
  }
  console.log();
  console.log("Tip: lower input_tokens / fewer turns is better; the rightmost column shows backend vs monorepo.");
' "$SUMMARY"
