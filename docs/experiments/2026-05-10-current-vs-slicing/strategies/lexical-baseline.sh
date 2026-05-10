#!/usr/bin/env bash
# Strategy 2: lexical baseline. ripgrep on prompt-derived terms, expand each
# match to a context window, concatenate up to a fixed character budget. The
# dumb-but-fast strawman every smarter retrieval strategy needs to beat.
# Adapter contract: see ../README.md "Strategy adapter contract".

set -euo pipefail
PROMPT="" WORKSPACE="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)    PROMPT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    *) echo "[lexical-baseline] unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$PROMPT" ] && [ -n "$WORKSPACE" ] && [ -n "$OUT" ] || {
  echo "[lexical-baseline] usage: $0 --prompt <text> --workspace <path> --out <dir>" >&2; exit 1; }
command -v rg >/dev/null 2>&1 || { echo "[lexical-baseline] ripgrep (rg) is required (brew install ripgrep)." >&2; exit 2; }

mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Pull "significant" tokens from the prompt: words >= 4 chars, alphanumeric,
# strip a small stopword set. This is intentionally crude — the baseline is
# meant to be unflattering on purpose.
STOPWORDS=" the and that this how does what when where which from with into are for has have not but its only also more most other same these those some they them their our your you can will would could should about which list trace identify "
node -e '
  const stop = new Set(process.argv[1].split(" ").filter(Boolean));
  const prompt = process.argv[2].toLowerCase();
  const terms = (prompt.match(/[a-z][a-z0-9_-]{3,}/g) || [])
    .filter((t) => !stop.has(t));
  const uniq = [...new Set(terms)].slice(0, 8);
  process.stdout.write(uniq.join("\n"));
' "$STOPWORDS" "$PROMPT" > "$TMP/terms"

START=$(node -e 'process.stdout.write(String(Date.now()))')
CHAR_BUDGET=20000   # rough proxy for ~5K cl100k_base tokens; pessimistic on purpose
WINDOW=20           # lines of context around each match
TOTAL_CHARS=0
> "$OUT/context.txt"
FILES_SEEN=()

while IFS= read -r term; do
  [ -z "$term" ] && continue
  # 5 best file matches per term, each expanded with WINDOW lines around the hit.
  rg --no-heading --line-number --max-count 5 --type ts --type js \
     --context "$WINDOW" --color never -- "$term" "$WORKSPACE" 2>/dev/null \
    | head -c $((CHAR_BUDGET - TOTAL_CHARS)) >> "$OUT/context.txt" || true
  TOTAL_CHARS=$(wc -c < "$OUT/context.txt" | tr -d ' ')
  if [ "$TOTAL_CHARS" -ge "$CHAR_BUDGET" ]; then break; fi
done < "$TMP/terms"
END=$(node -e 'process.stdout.write(String(Date.now()))')

EST_TOKENS=$(node -e '
  const fs = require("fs"), path = require("path");
  try {
    const { encode } = require("gpt-tokenizer");
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(encode(text).length));
  } catch {
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(Math.ceil(text.length / 4)));
  }
' "$OUT")
FILE_COUNT=$(grep -E '^[^[:space:]].*:[0-9]+:' "$OUT/context.txt" | awk -F: '{print $1}' | sort -u | wc -l | tr -d ' ')

printf '{ "strategy": "lexical-baseline", "duration_ms": %d, "est_tokens": %s, "file_count": %s, "notes": "char_budget=%d, window=%d" }\n' \
  "$((END - START))" "$EST_TOKENS" "$FILE_COUNT" "$CHAR_BUDGET" "$WINDOW" > "$OUT/meta.json"
