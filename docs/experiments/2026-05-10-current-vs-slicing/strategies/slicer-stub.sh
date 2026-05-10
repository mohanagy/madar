#!/usr/bin/env bash
# Strategy 3: task-conditioned program slicing.
# STUB. Intentionally does not run a real slicer — that lands in #73.
#
# This adapter exits with code 78 (EX_CONFIG, "configuration error") and a
# clear message so run.sh can record the stub state in summary.json without
# pretending the slicing strategy was measured.
#
# Replace this script with the real slicer wrapper once #73 ships.

set -euo pipefail
PROMPT="" WORKSPACE="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)    PROMPT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    *) echo "[slicer-stub] unknown arg: $1" >&2; exit 1 ;;
  esac
done
mkdir -p "$OUT"
cat > "$OUT/context.txt" <<'EOF'
[slicer-stub] Task-conditioned slicing strategy is not yet implemented.

Tracking issue: https://github.com/mohanagy/graphify-ts/issues/73
Until #73 ships, this experiment compares strategies 1, 2, and 4 only.
EOF
printf '{ "strategy": "slicer-stub", "duration_ms": 0, "est_tokens": 0, "file_count": 0, "notes": "stub; blocked on #73 prototype" }\n' \
  > "$OUT/meta.json"
echo "[slicer-stub] not implemented; see https://github.com/mohanagy/graphify-ts/issues/73" >&2
exit 78
