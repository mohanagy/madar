#!/usr/bin/env bash
# One generation run for one arm, with process-tree peak RSS and wall time.
set -euo pipefail
S="$1"; ARM="$2"; IDX="$3"
# Every arm's CLI is supplied, never inferred from whatever dist happens to be
# on this machine. A hard-coded workstation path made the head arm runnable in
# exactly one place and left the receipt unreplayable.
: "${ARM_BASE_CLI:?set ARM_BASE_CLI to the base binary's dist/src/cli/bin.js}"
: "${ARM_B1_CLI:?set ARM_B1_CLI to the B1 binary's dist/src/cli/bin.js}"
: "${ARM_HEAD_CLI:?set ARM_HEAD_CLI to the candidate binary's dist/src/cli/bin.js}"
case "$ARM" in
  base) CLI="$ARM_BASE_CLI" ;;
  b1)   CLI="$ARM_B1_CLI" ;;
  head) CLI="$ARM_HEAD_CLI" ;;
  *) echo "unknown arm: $ARM" >&2; exit 2 ;;
esac
if [ ! -f "$CLI" ]; then echo "no CLI for arm $ARM at $CLI" >&2; exit 2; fi
WS="$S/gen-$ARM-$IDX"
rm -rf "$WS"; cp -R "$S/repo-fixture" "$WS" 2>/dev/null
rm -rf "$WS/.git" "$WS/out"
LOAD_BEFORE=$(uptime | sed 's/.*load averages: //' | awk '{print $1}')
T0=$(node -e 'process.stdout.write(String(Date.now()))')
RSS=$(node "$S/rss-sampler.mjs" node "$CLI" generate "$WS" --no-html)
T1=$(node -e 'process.stdout.write(String(Date.now()))')
LOAD_AFTER=$(uptime | sed 's/.*load averages: //' | awk '{print $1}')
CANON=0; [ -f "$WS/out/graph.madar" ] && CANON=$(stat -f %z "$WS/out/graph.madar")
LEG=0;   [ -f "$WS/out/graph.json" ]  && LEG=$(stat -f %z "$WS/out/graph.json")
OUTKB=$(du -sk "$WS/out" | cut -f1)
echo "{\"arm\":\"$ARM\",\"idx\":$IDX,\"wall_ms\":$((T1-T0)),\"load_before\":$LOAD_BEFORE,\"load_after\":$LOAD_AFTER,\"canonical_bytes\":$CANON,\"legacy_bytes\":$LEG,\"out_dir_kb\":$OUTKB,\"rss\":$RSS}"
rm -rf "$WS"
