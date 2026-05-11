#!/usr/bin/env bash
# Benchmark: graphify-ts generate --spi vs legacy extract() (#130)
#
# Runs three variants on the bundled fixture:
#   1. legacy   — `graphify-ts generate <fixture>`
#   2. spi-cold — `graphify-ts generate <fixture> --spi`   (fresh cache)
#   3. spi-warm — `graphify-ts generate <fixture> --spi`   (cache hit)
#
# For each variant, captures:
#   - build time (wall clock)
#   - graph.json file size
#   - graph node count
#   - per-prompt pack token count (read from `graphify-ts pack --task explain`)
#   - per-prompt matched node count + label list
#
# Writes JSON results under `results/<timestamp>/`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FIXTURE_SRC="${GRAPHIFY_BENCH_FIXTURE:-$HERE/fixture}"
PROMPTS_FILE="${GRAPHIFY_BENCH_PROMPTS:-$HERE/prompts.json}"

# Create a clean copy of the fixture for each variant so cache state and
# graphify-out are independent.
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
RESULTS_DIR="$HERE/results/$TS"
mkdir -p "$RESULTS_DIR"

GRAPHIFY="$ROOT/dist/src/cli/bin.js"
if [[ ! -f "$GRAPHIFY" ]]; then
  echo "[setup] building graphify-ts..."
  (cd "$ROOT" && npm run build > /dev/null)
fi

run_variant() {
  local variant="$1"
  local extra_flag="$2"
  local fixture_copy="$RESULTS_DIR/fixture-$variant"
  cp -R "$FIXTURE_SRC" "$fixture_copy"

  echo "[$variant] generate"
  local t0 t1 elapsed
  t0=$(node -e 'console.log(Date.now())')
  # CodeRabbit follow-up: build args as a quoted array instead of relying
  # on unquoted $extra_flag word-splitting.
  local generate_args=(generate "$fixture_copy" --no-html)
  if [[ -n "$extra_flag" ]]; then
    generate_args+=("$extra_flag")
  fi
  node "$GRAPHIFY" "${generate_args[@]}" > "$RESULTS_DIR/$variant.generate.log" 2>&1
  t1=$(node -e 'console.log(Date.now())')
  elapsed=$((t1 - t0))

  local graph_path="$fixture_copy/graphify-out/graph.json"
  local graph_size
  graph_size=$(wc -c < "$graph_path" | tr -d ' ')
  local node_count
  node_count=$(node -e "const g=require('$graph_path'); console.log(g.nodes.length)")

  echo "  time=${elapsed}ms  graph_size=${graph_size}  nodes=${node_count}"

  # Per-prompt pack runs.
  local prompt_results="["
  local first=1
  local prompt_count
  prompt_count=$(node -e "const p=require('$PROMPTS_FILE'); console.log(p.prompts.length)")
  for ((i = 0; i < prompt_count; i++)); do
    local prompt_id prompt_text
    prompt_id=$(node -e "const p=require('$PROMPTS_FILE'); console.log(p.prompts[$i].id)")
    prompt_text=$(node -e "const p=require('$PROMPTS_FILE'); console.log(p.prompts[$i].text)")
    local pack_out
    # CodeRabbit follow-up: do NOT mask pack failures. Let stderr surface
    # and let set -euo pipefail abort if pack fails — false zero metrics
    # are worse than a loud failure.
    pack_out=$(node "$GRAPHIFY" pack "$prompt_text" --task explain --budget 2000 --graph "$graph_path")
    local pack_tokens pack_nodes
    # Pass pack_out via env var (PACK_OUT) to avoid shell-quote breakage when
    # the JSON contains single quotes. CodeRabbit fix on PR #136.
    pack_tokens=$(PACK_OUT="$pack_out" node -e "let p; try { p=JSON.parse(process.env.PACK_OUT); } catch { p={}; } console.log(p?.pack?.token_count ?? 0)")
    pack_nodes=$(PACK_OUT="$pack_out" node -e "let p; try { p=JSON.parse(process.env.PACK_OUT); } catch { p={}; } console.log(p?.pack?.matched_nodes?.length ?? 0)")
    local matched_labels
    matched_labels=$(PACK_OUT="$pack_out" node -e "let p; try { p=JSON.parse(process.env.PACK_OUT); } catch { p={}; } console.log(JSON.stringify((p?.pack?.matched_nodes ?? []).slice(0, 5).map(n => n.label)))")
    # Pass prompt_text via env var so single quotes / shell metacharacters can't
    # corrupt the JSON encoding. CodeRabbit fix on PR #136.
    local prompt_text_json
    prompt_text_json=$(PROMPT_TEXT="$prompt_text" node -e "console.log(JSON.stringify(process.env.PROMPT_TEXT))")
    if [[ $first -eq 0 ]]; then prompt_results+=","; fi
    first=0
    prompt_results+="{\"id\":\"$prompt_id\",\"text\":$prompt_text_json,\"pack_token_count\":$pack_tokens,\"pack_node_count\":$pack_nodes,\"top_labels\":$matched_labels}"
    echo "  [$prompt_id] tokens=$pack_tokens nodes=$pack_nodes"
  done
  prompt_results+="]"

  cat > "$RESULTS_DIR/$variant.json" <<EOF
{
  "variant": "$variant",
  "build_time_ms": $elapsed,
  "graph_size_bytes": $graph_size,
  "node_count": $node_count,
  "prompts": $prompt_results
}
EOF
}

echo "graphify-ts SPI benchmark — $TS"
echo "fixture: $FIXTURE_SRC"
echo "results: $RESULTS_DIR"
echo

run_variant "legacy" ""
run_variant "spi-cold" "--spi"
# Re-run with same fixture-copy to test cache. Easiest: re-run on the
# spi-cold fixture (cache survived).
echo "[spi-warm] generate (cache hit)"
SPI_WARM_FIXTURE="$RESULTS_DIR/fixture-spi-cold"
t0=$(node -e 'console.log(Date.now())')
node "$GRAPHIFY" generate "$SPI_WARM_FIXTURE" --spi --no-html > "$RESULTS_DIR/spi-warm.generate.log" 2>&1
t1=$(node -e 'console.log(Date.now())')
SPI_WARM_ELAPSED=$((t1 - t0))
# CodeRabbit follow-up: capture graph_size_bytes + node_count alongside
# build_time_ms so spi-warm has schema parity with legacy / spi-cold.
SPI_WARM_GRAPH_PATH="$SPI_WARM_FIXTURE/graphify-out/graph.json"
SPI_WARM_GRAPH_SIZE=$(wc -c < "$SPI_WARM_GRAPH_PATH" | tr -d ' ')
SPI_WARM_NODE_COUNT=$(node -e "const g=require('$SPI_WARM_GRAPH_PATH'); console.log(g.nodes.length)")
echo "  time=${SPI_WARM_ELAPSED}ms  graph_size=${SPI_WARM_GRAPH_SIZE}  nodes=${SPI_WARM_NODE_COUNT}"

cat > "$RESULTS_DIR/spi-warm.json" <<EOF
{
  "variant": "spi-warm",
  "build_time_ms": $SPI_WARM_ELAPSED,
  "graph_size_bytes": $SPI_WARM_GRAPH_SIZE,
  "node_count": $SPI_WARM_NODE_COUNT,
  "note": "Same fixture as spi-cold, re-run to measure cache-hit path. Prompts not re-evaluated; pack tokens match spi-cold."
}
EOF

# Summary.
echo "[spi-cold] probe selection_strategy + retrieval_level"
node "$HERE/probe.mjs" "$RESULTS_DIR/fixture-spi-cold/graphify-out/graph.json" "$PROMPTS_FILE" > "$RESULTS_DIR/spi-cold.analysis.json"

node "$HERE/summarize.mjs" "$RESULTS_DIR" > "$RESULTS_DIR/summary.json"
cat "$RESULTS_DIR/summary.json"

echo
echo "Done. Artifacts at $RESULTS_DIR/"
