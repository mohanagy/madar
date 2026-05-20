#!/usr/bin/env bash
# Strategy 4: full-context baseline. Concatenate every TS/JS file under the
# workspace, truncate to a generous character budget. Represents the "what
# could the agent have known if context were free" upper bound.
# Adapter contract: see ../README.md "Strategy adapter contract".

set -euo pipefail
PROMPT="" TASK="" WORKSPACE="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)    PROMPT="$2"; shift 2 ;;
    --task)      TASK="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    *) echo "[full-context] unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$PROMPT" ] && [ -n "$TASK" ] && [ -n "$WORKSPACE" ] && [ -n "$OUT" ] || {
  echo "[full-context] usage: $0 --prompt <text> --task <kind> --workspace <path> --out <dir>" >&2; exit 1; }

mkdir -p "$OUT"
CHAR_BUDGET=400000   # ~100K cl100k_base tokens — large but bounded.

START=$(node -e 'process.stdout.write(String(Date.now()))')
# Walk TS/JS files outside node_modules/dist/build/coverage, prefix each with a
# header so the model can attribute snippets back to files.
> "$OUT/context.txt"
TOTAL_CHARS=0
COUNT=0
while IFS= read -r f; do
  if [ "$TOTAL_CHARS" -ge "$CHAR_BUDGET" ]; then break; fi
  rel="${f#$WORKSPACE/}"
  printf '\n// === %s ===\n' "$rel" >> "$OUT/context.txt"
  remaining=$((CHAR_BUDGET - TOTAL_CHARS))
  head -c "$remaining" "$f" >> "$OUT/context.txt" || true
  TOTAL_CHARS=$(wc -c < "$OUT/context.txt" | tr -d ' ')
  COUNT=$((COUNT + 1))
done < <(find "$WORKSPACE" \
  -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/build/*" \
  -not -path "*/.next/*" \
  -not -path "*/coverage/*" \
  -not -path "*/.test-artifacts/*" \
  -not -path "*/graphify-out/*" \
  | sort)
END=$(node -e 'process.stdout.write(String(Date.now()))')

EST_TOKENS=$(node -e '
  const fs = require("fs"), path = require("path");
  try {
    const { encode } = require("gpt-tokenizer");
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(encode(text).length));
  } catch {
    process.stderr.write("[full-context] gpt-tokenizer unavailable; using char/4 estimate\n");
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(Math.ceil(text.length / 4)));
  }
' "$OUT")

printf '{ "strategy": "full-context", "duration_ms": %d, "est_tokens": %s, "file_count": %d, "notes": "task=%s, char_budget=%d (truncated)" }\n' \
  "$((END - START))" "$EST_TOKENS" "$COUNT" "$TASK" "$CHAR_BUDGET" > "$OUT/meta.json"
