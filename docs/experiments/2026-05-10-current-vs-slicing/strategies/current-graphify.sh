#!/usr/bin/env bash
# Strategy 1: current graphify-ts retrieval (`graphify-ts pack`).
# Adapter contract: see ../README.md "Strategy adapter contract".

set -euo pipefail
PROMPT="" TASK="" WORKSPACE="" OUT="" RETRIEVAL_STRATEGY="default"
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)    PROMPT="$2"; shift 2 ;;
    --task)      TASK="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --retrieval-strategy) RETRIEVAL_STRATEGY="$2"; shift 2 ;;
    *) echo "[current-graphify] unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$PROMPT" ] && [ -n "$TASK" ] && [ -n "$WORKSPACE" ] && [ -n "$OUT" ] || {
  echo "[current-graphify] usage: $0 --prompt <text> --task <kind> --workspace <path> --out <dir> [--retrieval-strategy default|slice-v1]" >&2; exit 1; }

mkdir -p "$OUT"
GRAPH="$WORKSPACE/graphify-out/graph.json"
if [ ! -f "$GRAPH" ]; then
  echo "[current-graphify] graph.json missing at $GRAPH — run 'graphify-ts generate .' inside $WORKSPACE first." >&2
  exit 2
fi
if ! command -v graphify-ts >/dev/null 2>&1; then
  echo "[current-graphify] graphify-ts CLI required on PATH." >&2; exit 3
fi

REQUESTED_TASK="$TASK"
PACK_TASK="$TASK"
case "$TASK" in
  debug) PACK_TASK="explain" ;;
  review) PACK_TASK="impact" ;;
esac

START=$(node -e 'process.stdout.write(String(Date.now()))')
( cd "$WORKSPACE" && graphify-ts pack "$PROMPT" --task "$PACK_TASK" --retrieval-strategy "$RETRIEVAL_STRATEGY" ) > "$OUT/pack.json" 2> "$OUT/pack.log" || {
  echo "[current-graphify] graphify-ts pack failed — see $OUT/pack.log" >&2
  echo "" > "$OUT/context.txt"
  END=$(node -e 'process.stdout.write(String(Date.now()))')
  if [ "$RETRIEVAL_STRATEGY" = "slice-v1" ]; then
    STRATEGY_NAME="slice-v1"
  else
    STRATEGY_NAME="current-graphify"
  fi
  printf '{ "strategy": "%s", "duration_ms": %d, "est_tokens": 0, "file_count": 0, "notes": "pack command failed (requested_task=%s, pack_task=%s, retrieval_strategy=%s)" }\n' \
    "$STRATEGY_NAME" \
    "$((END - START))" "$REQUESTED_TASK" "$PACK_TASK" "$RETRIEVAL_STRATEGY" > "$OUT/meta.json"
  exit 0
}
END=$(node -e 'process.stdout.write(String(Date.now()))')

# Render pack.json into a flat context.txt by concatenating every text-bearing
# entry (claims, snippets, expandable refs). Falls back to the raw JSON if the
# shape doesn't match the expected pack contract — we never silently emit
# nothing.
node -e '
  (() => {
    const fs = require("fs");
    const path = require("path");
    const out = process.argv[1];
    const packPath = path.join(out, "pack.json");
    const txt = path.join(out, "context.txt");
    let pack;
    try { pack = JSON.parse(fs.readFileSync(packPath, "utf8")); }
    catch {
      fs.writeFileSync(txt, fs.readFileSync(packPath, "utf8"));
      return;
    }

    const lines = [];
    function pushSnippet(s) {
      if (!s) return;
      if (typeof s === "string") { lines.push(s); return; }
      if (typeof s.text === "string") { lines.push(s.text); return; }
      if (typeof s.content === "string") { lines.push(s.content); return; }
    }
    function walk(o) {
      if (o == null) return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o === "object") {
        if (o.snippet || o.snippets || o.body || o.claim || o.text) {
          pushSnippet(o.snippet ?? o.body ?? o.claim ?? o.text);
          if (Array.isArray(o.snippets)) o.snippets.forEach(pushSnippet);
        }
        for (const [key, value] of Object.entries(o)) {
          if (key === "snippet" || key === "snippets" || key === "body" || key === "claim" || key === "text") {
            continue;
          }
          walk(value);
        }
      }
    }
    walk(pack);
    if (lines.length === 0) {
      fs.writeFileSync(txt, JSON.stringify(pack, null, 2));
    } else {
      fs.writeFileSync(txt, lines.join("\n\n---\n\n"));
    }
  })();
' "$OUT"

EST_TOKENS=$(node -e '
  const fs = require("fs"), path = require("path");
  try {
    const { encode } = require("gpt-tokenizer");
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(encode(text).length));
  } catch (e) {
    process.stderr.write("[current-graphify] gpt-tokenizer unavailable; using char/4 estimate\n");
    const text = fs.readFileSync(path.join(process.argv[1], "context.txt"), "utf8");
    process.stdout.write(String(Math.ceil(text.length / 4)));
  }
' "$OUT")
FILE_COUNT=$(jq -r '[.. | objects | .file? // .file_path? // .source_file? // empty] | unique | length' "$OUT/pack.json" 2>/dev/null || echo 0)

if [ "$RETRIEVAL_STRATEGY" = "slice-v1" ]; then
  STRATEGY_NAME="slice-v1"
else
  STRATEGY_NAME="current-graphify"
fi

printf '{ "strategy": "%s", "duration_ms": %d, "est_tokens": %s, "file_count": %s, "notes": "requested_task=%s, pack_task=%s, retrieval_strategy=%s" }\n' \
  "$STRATEGY_NAME" "$((END - START))" "$EST_TOKENS" "$FILE_COUNT" "$REQUESTED_TASK" "$PACK_TASK" "$RETRIEVAL_STRATEGY" > "$OUT/meta.json"
