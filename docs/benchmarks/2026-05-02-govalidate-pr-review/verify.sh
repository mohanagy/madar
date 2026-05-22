#!/usr/bin/env bash
# Reproducer for the 2026-05-01 GoValidate PR-review benchmark.
#
# Reads the committed `review-compare` report and prints the headline numbers so
# anyone can independently verify the README claims from the raw artifact.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[madar benchmark] node is required (>= 20)." >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  const print = (key, value) => console.log(`${key.padEnd(24)}: ${value}`);
  print("verbose_prompt_tokens", report.verbose_prompt_tokens);
  print("compact_prompt_tokens", report.compact_prompt_tokens);
  print("prompt_reduction_ratio", report.reduction_ratio.toFixed(3) + "x");
  print("verbose_payload_tokens", report.verbose_payload_tokens);
  print("compact_payload_tokens", report.compact_payload_tokens);
  print("payload_reduction_ratio", report.payload_reduction_ratio.toFixed(3) + "x");
  print("changed_files", report.changed_files.length);
  print("seed_count", report.seed_count);
  print("hotspot_count", report.hotspot_count);
' "$DIR"
