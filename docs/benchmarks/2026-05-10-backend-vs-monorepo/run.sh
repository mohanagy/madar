#!/usr/bin/env bash
# Backend-only vs monorepo context-quality spike harness (issue #69).
#
# For each prompt in prompts.json, runs `madar compare --baseline-mode
# native_agent` once against a graph built from the backend-only path and once
# against a graph built from the full monorepo path. Both runs use the same
# model `--exec` and the same prompt, so the only varying factor is the
# scope of the graph that grounds the agent.
#
# Output bundle:
#   results/<timestamp>/
#     manifest.json
#     summary.json
#     generate-backend.log
#     generate-monorepo.log
#     prompts/<prompt_id>/
#       backend/   <- contents of `out/compare/<ts>/` for the backend run
#       monorepo/  <- same, for the monorepo run
#
# Requires: madar (>= 0.13.3) on PATH, jq, an --exec runner you trust to
# spend tokens (e.g. `cat {prompt_file} | claude -p --output-format json`).

set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $0 --backend-path <path> --monorepo-path <path> --exec <runner> [--quick] [--out-dir <path>]

Required:
  --backend-path   Path to the backend-only folder (e.g. apps/backend).
  --monorepo-path  Path to the full monorepo root.
  --exec           Compare runner template, e.g. 'cat {prompt_file} | claude -p --output-format json'.

Optional:
  --quick          Run only the prompts listed in prompts.json -> quick_subset (3 prompts).
  --out-dir        Override the results directory (default: alongside this script).

Notes:
  - This will spend real model tokens. The full set is ~12 prompts × 2 scopes × 2 runs = 48 model calls.
  - --quick is recommended for the first dry pass to validate the harness end-to-end.
USAGE
  exit 1
}

QUICK=0
BACKEND=""
MONOREPO=""
EXEC=""
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_BASE="$HERE/results"

while [ $# -gt 0 ]; do
  case "$1" in
    --backend-path)  BACKEND="$2"; shift 2 ;;
    --monorepo-path) MONOREPO="$2"; shift 2 ;;
    --exec)          EXEC="$2"; shift 2 ;;
    --quick)         QUICK=1; shift ;;
    --out-dir)       OUT_BASE="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "[harness] unknown arg: $1" >&2; usage ;;
  esac
done

if [ -z "$BACKEND" ] || [ -z "$MONOREPO" ] || [ -z "$EXEC" ]; then
  usage
fi
if [ ! -d "$BACKEND" ];  then echo "[harness] backend path not found: $BACKEND" >&2; exit 2; fi
if [ ! -d "$MONOREPO" ]; then echo "[harness] monorepo path not found: $MONOREPO" >&2; exit 2; fi
for tool in madar jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[harness] $tool is required (install: $tool)" >&2; exit 3
  fi
done

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_DIR="$OUT_BASE/$TS"
mkdir -p "$RUN_DIR/prompts"

PROMPTS_FILE="$HERE/prompts.json"
if [ ! -f "$PROMPTS_FILE" ]; then
  echo "[harness] prompts.json missing alongside run.sh." >&2; exit 4
fi

if [ "$QUICK" = "1" ]; then
  PROMPT_IDS=$(jq -r '.quick_subset[]' "$PROMPTS_FILE")
else
  PROMPT_IDS=$(jq -r '.prompts[].id' "$PROMPTS_FILE")
fi

# Manifest captures everything needed to interpret the results bundle later.
jq -n \
  --arg ts "$TS" \
  --arg backend "$BACKEND" \
  --arg monorepo "$MONOREPO" \
  --arg exec "$EXEC" \
  --arg quick "$QUICK" \
  --arg version "$(madar --version 2>/dev/null || echo unknown)" \
  '{
    timestamp: $ts,
    backend_path: $backend,
    monorepo_path: $monorepo,
    exec: $exec,
    quick_subset: ($quick == "1"),
    madar_version: $version
  }' > "$RUN_DIR/manifest.json"

echo "[harness] results bundle: $RUN_DIR"
echo "[harness] madar version: $(jq -r .madar_version "$RUN_DIR/manifest.json")"
echo

# --- 1. Generate graphs once per scope ---
generate_one() {
  local label=$1 path=$2 logfile=$3
  echo "[harness] generating graph for $label scope: $path"
  local start=$(node -e 'process.stdout.write(String(Date.now()))')
  ( cd "$path" && madar generate . ) > "$logfile" 2>&1
  local end=$(node -e 'process.stdout.write(String(Date.now()))')
  local ms=$((end - start))
  jq -n --arg label "$label" --arg path "$path" --arg ms "$ms" \
    '{label: $label, path: $path, duration_ms: ($ms | tonumber)}' \
    > "$RUN_DIR/generate-$label.json"
  echo "[harness]   generated in ${ms}ms"
}

generate_one backend  "$BACKEND"  "$RUN_DIR/generate-backend.log"
generate_one monorepo "$MONOREPO" "$RUN_DIR/generate-monorepo.log"

# --- 2. For each prompt, run compare against both scopes ---
run_compare_for_scope() {
  local prompt_id=$1 prompt_text=$2 scope_label=$3 scope_path=$4
  local outdir="$RUN_DIR/prompts/$prompt_id/$scope_label"
  mkdir -p "$outdir"

  echo "[harness]   compare ($scope_label): $prompt_id"
  ( cd "$scope_path" && madar compare "$prompt_text" \
      --graph "$scope_path/out/graph.json" \
      --baseline-mode native_agent \
      --exec "$EXEC" \
      --yes ) > "$outdir/compare.log" 2>&1 || {
        echo "[harness]   compare failed for $prompt_id ($scope_label) — see compare.log"
        return 0
      }

  # The compare command writes to <scope_path>/out/compare/<ts>/.
  # Pick the most recent compare run and snapshot it into our results bundle.
  local latest
  latest=$(ls -1dt "$scope_path/out/compare"/*/ 2>/dev/null | head -n 1 || true)
  if [ -z "$latest" ]; then
    echo "[harness]   no compare output dir found for $prompt_id ($scope_label)"
    return 0
  fi
  cp -R "$latest"/* "$outdir/" 2>/dev/null || true
}

for prompt_id in $PROMPT_IDS; do
  prompt_text=$(jq -r --arg id "$prompt_id" '.prompts[] | select(.id == $id) | .text' "$PROMPTS_FILE")
  if [ -z "$prompt_text" ] || [ "$prompt_text" = "null" ]; then
    echo "[harness] prompt id '$prompt_id' missing in prompts.json — skipping"; continue
  fi
  echo "[harness] prompt: $prompt_id"
  run_compare_for_scope "$prompt_id" "$prompt_text" backend  "$BACKEND"
  run_compare_for_scope "$prompt_id" "$prompt_text" monorepo "$MONOREPO"
done

# --- 3. Build a side-by-side summary.json by walking the captured report.json files ---
node -e '
  const fs = require("fs");
  const path = require("path");
  const runDir = process.argv[1];
  const promptsDir = path.join(runDir, "prompts");
  if (!fs.existsSync(promptsDir)) { console.log("no prompts/ to summarize"); process.exit(0); }

  function readReport(dir) {
    const file = path.join(dir, "report.json");
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  function totalInput(usage) {
    if (!usage) return null;
    const i = usage.input_tokens ?? 0;
    const cc = usage.cache_creation_input_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? 0;
    const t = i + cc + cr;
    return t > 0 ? t : (usage.total_input_tokens ?? null);
  }
  function findRun(report, label) {
    if (!report || typeof report !== "object") return null;
    if (report[label]) return report[label];
    if (report.runs?.[label]) return report.runs[label];
    return null;
  }
  function pickRunMetrics(run) {
    if (!run) return null;
    const usage = run.usage ?? run.anthropic_usage;
    return {
      num_turns: run.num_turns ?? run.turns ?? null,
      duration_ms: run.duration_ms ?? run.latency_ms ?? null,
      total_input_tokens: totalInput(usage),
      usage: usage ?? null,
    };
  }

  const summary = { generate: {}, per_prompt: {} };
  for (const f of ["generate-backend.json", "generate-monorepo.json"]) {
    const p = path.join(runDir, f);
    if (fs.existsSync(p)) Object.assign(summary.generate, JSON.parse(fs.readFileSync(p, "utf8")).label
      ? { [JSON.parse(fs.readFileSync(p, "utf8")).label]: JSON.parse(fs.readFileSync(p, "utf8")) } : {});
  }

  for (const promptId of fs.readdirSync(promptsDir)) {
    const promptDir = path.join(promptsDir, promptId);
    if (!fs.statSync(promptDir).isDirectory()) continue;
    summary.per_prompt[promptId] = {};
    for (const scope of ["backend", "monorepo"]) {
      const scopeDir = path.join(promptDir, scope);
      const report = readReport(scopeDir);
      summary.per_prompt[promptId][scope] = {
        baseline: pickRunMetrics(findRun(report, "baseline")),
        madar: pickRunMetrics(findRun(report, "madar")),
      };
    }
  }
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("[harness] wrote summary.json");
' "$RUN_DIR"

echo
echo "[harness] DONE."
echo "[harness] Inspect:    $RUN_DIR/summary.json"
echo "[harness] Aggregate:  bash docs/benchmarks/2026-05-10-backend-vs-monorepo/aggregate.sh $RUN_DIR"
