#!/usr/bin/env bash
# Aggregator for results bundles produced by run.sh (issue #71).
# Reads summary.json and prints a side-by-side per-prompt comparison across
# every strategy that ran.
#
# Usage:
#   bash aggregate.sh <results/<timestamp>/>

set -euo pipefail
[ $# -ge 1 ] || { echo "Usage: $0 <results-dir>" >&2; exit 1; }
RUN_DIR="$1"
SUMMARY="$RUN_DIR/summary.json"
[ -f "$SUMMARY" ] || { echo "[aggregate] $SUMMARY not found." >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "[aggregate] node is required." >&2; exit 3; }

node -e '
    (() => {
      const fs = require("fs");
      const file = process.argv[1];
      const summary = JSON.parse(fs.readFileSync(file, "utf8"));

      const per = summary.per_prompt || {};
      const promptIds = Object.keys(per);
      if (promptIds.length === 0) { console.log("[aggregate] no prompts in summary."); return; }
      const strategies = [...new Set(promptIds.flatMap((p) => Object.keys(per[p] || {})))].sort();

    function fmtNum(n) { return typeof n === "number" ? n.toLocaleString("en-US") : "—"; }
    function fmtState(s) {
      if (!s) return "missing";
      if (s.exit === 78) return "stub";
      if (s.exit !== null && s.exit !== 0) return `failed (rc=${s.exit})`;
      return "ok";
    }

    const colWidth = 28;
    const promptCol = 30;
    console.log("Strategies: " + strategies.join(", "));
    console.log();

    // Header row.
    const head = ["prompt".padEnd(promptCol)];
    for (const s of strategies) head.push(s.padEnd(colWidth));
    console.log(head.join(""));
    console.log("-".repeat(head.join("").length));

    for (const id of promptIds) {
      const row = [id.padEnd(promptCol)];
      for (const s of strategies) {
        const entry = per[id][s];
        if (!entry) { row.push("—".padEnd(colWidth)); continue; }
        if (entry.exit === 78) { row.push("(stub)".padEnd(colWidth)); continue; }
        const meta = entry.meta || {};
        const tokens = fmtNum(meta.est_tokens);
        const ms = fmtNum(meta.duration_ms);
        const files = fmtNum(meta.file_count);
        row.push(`${tokens}t / ${files}f / ${ms}ms`.padEnd(colWidth));
      }
      console.log(row.join(""));
    }

      console.log();
      console.log("Legend: <est_tokens>t / <file_count>f / <duration_ms>ms");
      console.log("Lower est_tokens at comparable answer quality is what wins. Inspect");
      console.log("context.txt and answer.json side-by-side to judge quality differences.");
    })();
' "$SUMMARY"
