#!/bin/bash
# Quick benchmark script — run this in any project to see madar in action
#
# Usage:
#   cd your-project
#   bash path/to/quick-benchmark.sh

set -e

echo "=== madar Quick Benchmark ==="
echo ""

if [ -z "${MADAR_RUNNER:-}" ]; then
  echo "Set MADAR_RUNNER to a prompt runner command template first, for example:"
  echo "  export MADAR_RUNNER='cat {prompt_file} | claude -p'"
  echo "  export MADAR_RUNNER='cat {prompt_file} | gemini -p \"\" --output-format json'"
  exit 1
fi

# Check if madar is installed
if ! command -v madar &> /dev/null; then
  echo "Installing madar..."
  npm install -g madar
fi

# Generate graph
echo "Step 1: Generating knowledge graph..."
madar generate .
echo ""

# Run benchmark
echo "Step 2: Running token reduction benchmark..."
madar benchmark out/graph.json --exec "$MADAR_RUNNER" --yes
echo ""

# Show key stats
echo "Step 3: Graph summary..."
echo ""
head -20 out/GRAPH_REPORT.md
echo ""

# Set up MCP for your agent
echo "Step 4: Setting up AI agent integration..."
echo ""
echo "Run one of these to connect your agent:"
echo "  madar claude install    # Claude Code (.mcp.json)"
echo "  madar cursor install    # Cursor (.cursor/mcp.json)"
echo "  madar copilot install   # Copilot (.vscode/mcp.json)"
echo ""
echo "Then ask your agent:"
echo '  "What is the blast radius of changing [YourMainEntity]?"'
echo '  "How does [feature X] work?"'
echo '  "Is this PR safe to merge?"'
echo ""
echo "=== Done ==="
