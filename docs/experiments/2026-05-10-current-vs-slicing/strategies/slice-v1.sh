#!/usr/bin/env bash
# Strategy 3: slice-v1 retrieval through the shipped graphify-ts pack command.
# Adapter contract: see ../README.md "Strategy adapter contract".

set -euo pipefail
PROMPT="" TASK="" WORKSPACE="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)    PROMPT="$2"; shift 2 ;;
    --task)      TASK="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    *) echo "[slice-v1] unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$PROMPT" ] && [ -n "$TASK" ] && [ -n "$WORKSPACE" ] && [ -n "$OUT" ] || {
  echo "[slice-v1] usage: $0 --prompt <text> --task <kind> --workspace <path> --out <dir>" >&2; exit 1; }

"$(cd "$(dirname "$0")" && pwd)/current-graphify.sh" \
  --prompt "$PROMPT" \
  --task "$TASK" \
  --workspace "$WORKSPACE" \
  --out "$OUT" \
  --retrieval-strategy slice-v1
