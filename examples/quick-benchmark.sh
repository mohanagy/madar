#!/bin/bash
# Quick local evidence check. This is not a comparative benchmark receipt.
#
# Usage:
#   cd your-project
#   MADAR_QUESTION='How does authentication work?' bash path/to/quick-benchmark.sh

set -eu

if [ -z "${MADAR_QUESTION:-}" ]; then
  echo "Set MADAR_QUESTION to one repository question."
  exit 1
fi

if ! command -v madar >/dev/null 2>&1; then
  echo "Install Madar first: npm install -g @lubab/madar"
  exit 1
fi

echo "Step 1: generate the canonical graph"
madar generate .

echo "Step 2: inspect the byte-identical CLI retrieval"
madar query "$MADAR_QUESTION"

echo "Step 3: inspect graph and supported client registrations"
madar status

echo "Optional client registration:"
echo "  madar install claude"
echo "  madar install codex"
echo "Other MCP clients can register command 'madar', args ['mcp'], and this exact cwd."
