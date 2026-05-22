#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
BUNDLE_DIR="${SADEEM_BENCH_REAL_RESULTS_DIR:-$HERE/results/real-workspaces/$TS}"
PROMPTS_FILE="${SADEEM_BENCH_REAL_PROMPTS:-$HERE/prompts.real-workspace.example.json}"

if [[ ! -f "$PROMPTS_FILE" ]]; then
  echo "SADEEM_BENCH_REAL_PROMPTS must point to an existing prompts JSON file: $PROMPTS_FILE" >&2
  exit 2
fi

run_workspace() {
  local workspace_name="$1"
  local workspace_path="$2"
  local workspace_var_name="$3"
  if [[ -z "$workspace_path" ]]; then
    return
  fi
  if [[ ! -d "$workspace_path" ]]; then
    echo "$workspace_var_name must point to an existing workspace directory: $workspace_path" >&2
    exit 2
  fi

  mkdir -p "$BUNDLE_DIR/$workspace_name"
  echo "[real-workspace] $workspace_name -> $workspace_path"
  SADEEM_BENCH_FIXTURE="$workspace_path" \
  SADEEM_BENCH_PROMPTS="$PROMPTS_FILE" \
  SADEEM_BENCH_RESULTS_DIR="$BUNDLE_DIR/$workspace_name" \
  bash "$HERE/run.sh"
}

if [[ -z "${SADEEM_BENCH_BACKEND:-}" && -z "${SADEEM_BENCH_MONOREPO:-}" ]]; then
  echo "Set SADEEM_BENCH_BACKEND and/or SADEEM_BENCH_MONOREPO before running." >&2
  exit 2
fi

mkdir -p "$BUNDLE_DIR"
run_workspace "backend" "${SADEEM_BENCH_BACKEND:-}" "SADEEM_BENCH_BACKEND"
run_workspace "monorepo" "${SADEEM_BENCH_MONOREPO:-}" "SADEEM_BENCH_MONOREPO"

node "$HERE/summarize-real-workspaces.mjs" "$BUNDLE_DIR" > "$BUNDLE_DIR/real-workspaces.summary.json"
cat "$BUNDLE_DIR/real-workspaces.summary.json"
