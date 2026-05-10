#!/usr/bin/env bash
# Current retrieval vs task-conditioned slicing experiment harness (issue #71).
#
# For each prompt in prompts.json, runs each enabled strategy adapter to
# produce a context pack, then optionally pipes the pack through an --exec
# runner to capture a model answer + provider usage. Writes a per-run bundle
# under results/<timestamp>/.

set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $0 --workspace <path> --strategies <csv> [--exec <runner>] [--prompt-ids <csv>] [--out-dir <path>]

Required:
  --workspace   Path to the repo under test (must contain graphify-out/graph.json
                if you include the current-graphify strategy).
  --strategies  Comma-separated list of strategy names (matching scripts in strategies/).
                Examples:
                  current-graphify,lexical-baseline,full-context
                  current-graphify,lexical-baseline,slicer-stub,full-context

Optional:
  --exec        Runner template for piping the strategy's context.txt through a
                model, e.g. 'cat {prompt_file} | claude -p --output-format json'.
                The {prompt_file} placeholder is replaced with the per-strategy
                merged-prompt file. Omit to skip model answers entirely.
  --prompt-ids  Comma-separated prompt ids to limit the run to. Default: all.
  --out-dir     Override the results directory (default: alongside this script).

Notes:
  - Without --exec, this is local-only (no model spend).
  - With --exec, you spend tokens for every prompt × every strategy. Be deliberate.
USAGE
  exit 1
}

WORKSPACE="" STRATEGIES="" EXEC="" PROMPT_IDS=""
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_BASE="$HERE/results"

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace)   WORKSPACE="$2"; shift 2 ;;
    --strategies)  STRATEGIES="$2"; shift 2 ;;
    --exec)        EXEC="$2"; shift 2 ;;
    --prompt-ids)  PROMPT_IDS="$2"; shift 2 ;;
    --out-dir)     OUT_BASE="$2"; shift 2 ;;
    -h|--help)     usage ;;
    *) echo "[harness] unknown arg: $1" >&2; usage ;;
  esac
done

if [ -z "$WORKSPACE" ] || [ -z "$STRATEGIES" ]; then usage; fi
if [ ! -d "$WORKSPACE" ]; then echo "[harness] workspace not found: $WORKSPACE" >&2; exit 2; fi
for tool in node jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[harness] $tool is required" >&2; exit 3
  fi
done

PROMPTS_FILE="$HERE/prompts.json"
[ -f "$PROMPTS_FILE" ] || { echo "[harness] prompts.json missing alongside run.sh" >&2; exit 4; }

# Validate every requested strategy script exists before spending any time.
IFS=',' read -ra STRAT_ARR <<< "$STRATEGIES"
for s in "${STRAT_ARR[@]}"; do
  if [ ! -x "$HERE/strategies/$s.sh" ]; then
    echo "[harness] strategy not found or not executable: strategies/$s.sh" >&2; exit 5
  fi
done

if [ -n "$PROMPT_IDS" ]; then
  IFS=',' read -ra ID_ARR <<< "$PROMPT_IDS"
else
  mapfile -t ID_ARR < <(jq -r '.prompts[].id' "$PROMPTS_FILE")
fi

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_DIR="$OUT_BASE/$TS"
mkdir -p "$RUN_DIR/prompts"

jq -n \
  --arg ts "$TS" \
  --arg workspace "$WORKSPACE" \
  --arg strategies "$STRATEGIES" \
  --arg exec "$EXEC" \
  --arg version "$(graphify-ts --version 2>/dev/null || echo unknown)" \
  '{
    timestamp: $ts,
    workspace: $workspace,
    strategies: ($strategies | split(",")),
    exec: ($exec // ""),
    graphify_version: $version
  }' > "$RUN_DIR/manifest.json"

echo "[harness] results bundle: $RUN_DIR"
echo "[harness] strategies: $STRATEGIES"
echo "[harness] prompts: ${#ID_ARR[@]}"
echo "[harness] exec: ${EXEC:-<none, context-only>}"
echo

run_strategy_for_prompt() {
  local prompt_id=$1 prompt_text=$2 strategy=$3
  local outdir="$RUN_DIR/prompts/$prompt_id/$strategy"
  mkdir -p "$outdir"
  echo "[harness]   $strategy"

  set +e
  "$HERE/strategies/$strategy.sh" \
    --prompt    "$prompt_text" \
    --workspace "$WORKSPACE" \
    --out       "$outdir" \
    > "$outdir/strategy.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$outdir/strategy.exit"

  # If the strategy explicitly stubbed out (rc == 78), skip the model call.
  if [ "$rc" -eq 78 ]; then return 0; fi
  if [ "$rc" -ne 0 ]; then
    echo "[harness]     strategy exited rc=$rc (see $outdir/strategy.log)"
    return 0
  fi

  if [ -n "$EXEC" ] && [ -f "$outdir/context.txt" ]; then
    # Build a single combined prompt for the runner: question + context.
    {
      printf 'Question:\n%s\n\nContext:\n' "$prompt_text"
      cat "$outdir/context.txt"
    } > "$outdir/merged-prompt.txt"
    local runner="${EXEC//\{prompt_file\}/$outdir/merged-prompt.txt}"
    set +e
    bash -c "$runner" > "$outdir/answer.json" 2> "$outdir/answer.log"
    local arc=$?
    set -e
    echo "$arc" > "$outdir/answer.exit"
  fi
}

for prompt_id in "${ID_ARR[@]}"; do
  prompt_text=$(jq -r --arg id "$prompt_id" '.prompts[] | select(.id == $id) | .text' "$PROMPTS_FILE")
  if [ -z "$prompt_text" ] || [ "$prompt_text" = "null" ]; then
    echo "[harness] prompt id '$prompt_id' missing in prompts.json — skipping"
    continue
  fi
  echo "[harness] prompt: $prompt_id"
  for s in "${STRAT_ARR[@]}"; do
    run_strategy_for_prompt "$prompt_id" "$prompt_text" "$s"
  done
done

# Build summary.json.
node -e '
  (() => {
    const fs = require("fs");
    const path = require("path");
    const runDir = process.argv[1];
    const promptsRoot = path.join(runDir, "prompts");
    const out = { per_prompt: {} };
    if (fs.existsSync(promptsRoot)) {
      for (const promptId of fs.readdirSync(promptsRoot)) {
        const promptDir = path.join(promptsRoot, promptId);
        if (!fs.statSync(promptDir).isDirectory()) continue;
        out.per_prompt[promptId] = {};
        for (const strategy of fs.readdirSync(promptDir)) {
          const sDir = path.join(promptDir, strategy);
          if (!fs.statSync(sDir).isDirectory()) continue;
          const metaPath = path.join(sDir, "meta.json");
          const exitPath = path.join(sDir, "strategy.exit");
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
          const exit = fs.existsSync(exitPath) ? Number(fs.readFileSync(exitPath, "utf8").trim()) : null;
          out.per_prompt[promptId][strategy] = { meta, exit };
        }
      }
    }
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(out, null, 2));
    console.log("[harness] wrote summary.json");
  })();
' "$RUN_DIR"

echo
echo "[harness] DONE."
echo "[harness] Inspect:    $RUN_DIR/summary.json"
echo "[harness] Aggregate:  bash $HERE/aggregate.sh $RUN_DIR"
