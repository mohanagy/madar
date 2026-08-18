#!/usr/bin/env bash
# Maintained real-workspace measurement for the canonical v2 graph artifact.
#
# This replaces the v1-era runner under
# docs/benchmarks/2026-05-11-spi-vs-legacy/, which measured `out/graph.json`
# with `wc -c`. After the artifact cutover that path holds the tombstone, so the
# old runner would have recorded the marker's size as the graph size instead of
# failing. The record it produced stays where it is; this is the tool to use for
# any new measurement.
#
# For each workspace it captures:
#   - generate wall clock
#   - canonical artifact bytes, node count and fact count
#   - per-prompt pack token and node counts
#
# Writes metrics.json (schema_version 2) under results/<timestamp>/.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

MADAR_BENCH_MODE="${MADAR_BENCH_MODE:-current}"
if [[ "$MADAR_BENCH_MODE" != "current" ]]; then
  echo "This runner measures the current artifact contract and only accepts MADAR_BENCH_MODE=current." >&2
  echo "For the v1-era procedure see docs/benchmarks/2026-05-11-spi-vs-legacy/README.md." >&2
  exit 2
fi

FIXTURE_SRC="${MADAR_BENCH_FIXTURE:-$HERE/fixture}"
PROMPTS_FILE="${MADAR_BENCH_PROMPTS:-$HERE/prompts.json}"
TS="${MADAR_BENCH_TIMESTAMP:-$(date -u +%Y-%m-%dT%H%M%SZ)}"
RESULTS_DIR="${MADAR_BENCH_RESULTS_DIR:-$HERE/results/$TS}"

if [[ ! -d "$FIXTURE_SRC" ]]; then
  echo "MADAR_BENCH_FIXTURE must point to an existing workspace directory: $FIXTURE_SRC" >&2
  exit 2
fi
if [[ ! -f "$PROMPTS_FILE" ]]; then
  echo "MADAR_BENCH_PROMPTS must point to an existing prompts JSON file: $PROMPTS_FILE" >&2
  exit 2
fi

mkdir -p "$RESULTS_DIR"

MADAR="${MADAR_BENCH_CLI:-$ROOT/dist/src/cli/bin.js}"
if [[ ! -f "$MADAR" ]]; then
  echo "[setup] building madar..."
  (cd "$ROOT" && npm run build > /dev/null)
fi

EXPECTED_TOMBSTONE="$RESULTS_DIR/expected-tombstone"
printf 'MADAR_GRAPH_MOVED/2\nUse out/graph.madar with Madar >= the v2-supporting version.\n' \
  > "$EXPECTED_TOMBSTONE"

fixture_copy="$RESULTS_DIR/workspace"
cp -R "$FIXTURE_SRC" "$fixture_copy"

echo "[generate] $fixture_copy"
t0=$(node -e 'process.stdout.write(String(Date.now()))')
node "$MADAR" generate "$fixture_copy" --no-html > "$RESULTS_DIR/generate.log" 2>&1
t1=$(node -e 'process.stdout.write(String(Date.now()))')
BUILD_TIME_MS=$((t1 - t0))

ARTIFACT_PATH="$fixture_copy/out/graph.madar"

# The measurement is only valid if generation actually cut the workspace over.
# Without these two checks a run against a stale or half-published workspace
# would still emit a complete-looking metrics file.
if [[ ! -s "$ARTIFACT_PATH" ]]; then
  echo "generate produced no canonical artifact at $ARTIFACT_PATH" >&2
  exit 1
fi
if ! cmp -s "$fixture_copy/out/graph.json" "$EXPECTED_TOMBSTONE"; then
  echo "out/graph.json is not the exact tombstone; the workspace is not cut over" >&2
  exit 1
fi

GRAPH_STATS=$(node "$HERE/graph-stats.mjs" "$ARTIFACT_PATH")
ARTIFACT_BYTES=$(GRAPH_STATS="$GRAPH_STATS" node -e "process.stdout.write(String(JSON.parse(process.env.GRAPH_STATS).artifact_bytes))")
NODE_COUNT=$(GRAPH_STATS="$GRAPH_STATS" node -e "process.stdout.write(String(JSON.parse(process.env.GRAPH_STATS).node_count))")
FACT_COUNT=$(GRAPH_STATS="$GRAPH_STATS" node -e "process.stdout.write(String(JSON.parse(process.env.GRAPH_STATS).fact_count))")

echo "  time=${BUILD_TIME_MS}ms  artifact_bytes=${ARTIFACT_BYTES}  nodes=${NODE_COUNT}  facts=${FACT_COUNT}"

prompt_results="["
first=1
prompt_count=$(PROMPTS_FILE="$PROMPTS_FILE" node -e "
  const { readFileSync } = require('node:fs')
  const p = JSON.parse(readFileSync(process.env.PROMPTS_FILE, 'utf8'))
  process.stdout.write(String(p.prompts.length))
")
for ((i = 0; i < prompt_count; i++)); do
  prompt_id=$(PROMPTS_FILE="$PROMPTS_FILE" INDEX="$i" node -e "
    const { readFileSync } = require('node:fs')
    const p = JSON.parse(readFileSync(process.env.PROMPTS_FILE, 'utf8'))
    process.stdout.write(String(p.prompts[Number(process.env.INDEX)].id))
  ")
  prompt_text=$(PROMPTS_FILE="$PROMPTS_FILE" INDEX="$i" node -e "
    const { readFileSync } = require('node:fs')
    const p = JSON.parse(readFileSync(process.env.PROMPTS_FILE, 'utf8'))
    process.stdout.write(String(p.prompts[Number(process.env.INDEX)].text))
  ")

  # A pack failure must abort, and so must a response this tool cannot measure.
  # A zero recorded as a measurement is worse than a loud failure.
  pack_metrics=$(node "$MADAR" pack "$prompt_text" --task explain --budget 2000 --graph "$ARTIFACT_PATH" \
    | node "$HERE/pack-metrics.mjs")
  pack_tokens=$(PACK_METRICS="$pack_metrics" node -e "process.stdout.write(String(JSON.parse(process.env.PACK_METRICS).serialized_token_count))")
  pack_nodes=$(PACK_METRICS="$pack_metrics" node -e "process.stdout.write(String(JSON.parse(process.env.PACK_METRICS).matched_node_count))")
  top_labels=$(PACK_METRICS="$pack_metrics" node -e "process.stdout.write(JSON.stringify(JSON.parse(process.env.PACK_METRICS).top_labels))")
  prompt_text_json=$(PROMPT_TEXT="$prompt_text" node -e "process.stdout.write(JSON.stringify(process.env.PROMPT_TEXT))")
  # The ID comes from a caller-supplied prompts file and can carry quotes,
  # backslashes or newlines. Interpolating it raw produced invalid metrics.json.
  prompt_id_json=$(PROMPT_ID="$prompt_id" node -e "process.stdout.write(JSON.stringify(process.env.PROMPT_ID))")

  if [[ $first -eq 0 ]]; then prompt_results+=","; fi
  first=0
  prompt_results+="{\"id\":$prompt_id_json,\"text\":$prompt_text_json,\"serialized_token_count\":$pack_tokens,\"matched_node_count\":$pack_nodes,\"top_labels\":$top_labels}"
  echo "  [$prompt_id] serialized_tokens=$pack_tokens nodes=$pack_nodes"
done
prompt_results+="]"

# schema_version 2. Two field names changed deliberately: the size field is not
# called graph_size_bytes, because the v1-era schema used that name for the JSON
# file at out/graph.json and a reader comparing it with a v2 artifact would be
# comparing two formats; and the per-prompt count is serialized_token_count
# rather than pack_token_count, because the v1-era field was absent on one
# retrieval path and defaulted to zero.
cat > "$RESULTS_DIR/metrics.json" <<EOF
{
  "schema_version": 2,
  "mode": "current",
  "artifact": {
    "path": "out/graph.madar",
    "header": "MADAR_GRAPH_ARTIFACT/2",
    "bytes": $ARTIFACT_BYTES,
    "legacy_path": "tombstone"
  },
  "build_time_ms": $BUILD_TIME_MS,
  "node_count": $NODE_COUNT,
  "fact_count": $FACT_COUNT,
  "prompts": $prompt_results
}
EOF

rm -f "$EXPECTED_TOMBSTONE"

cat "$RESULTS_DIR/metrics.json"
echo
echo "Done. Artifacts at $RESULTS_DIR/"
