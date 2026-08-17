#!/usr/bin/env bash
# One generation run for one arm, with process-tree peak RSS and wall time.
set -euo pipefail
S="$1"; ARM="$2"; IDX="$3"
case "$ARM" in
  base) CLI="$S/base-ee2115a2/dist/src/cli/bin.js" ;;
  b1)   CLI="$S/b1-5bfdb869/dist/src/cli/bin.js" ;;
  head) CLI="/Users/mohammednaji/Desktop/projects/works/madar-705/dist/src/cli/bin.js" ;;
esac
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
