#!/bin/bash
# Quick benchmark script — run this in any project to see sadeem in action
#
# Usage:
#   cd your-project
#   bash path/to/quick-benchmark.sh

set -e

echo "=== sadeem Quick Benchmark ==="
echo ""

if [ -z "${SADEEM_RUNNER:-}" ]; then
  echo "Set SADEEM_RUNNER to a prompt runner command template first, for example:"
  echo "  export SADEEM_RUNNER='cat {prompt_file} | claude -p'"
  echo "  export SADEEM_RUNNER='cat {prompt_file} | gemini -p \"\" --output-format json'"
  exit 1
fi

# Check if sadeem is installed
if ! command -v sadeem &> /dev/null; then
  echo "Installing sadeem..."
  npm install -g sadeem
fi

# Generate graph
echo "Step 1: Generating knowledge graph..."
sadeem generate .
echo ""

# Run benchmark
echo "Step 2: Running token reduction benchmark..."
sadeem benchmark out/graph.json --exec "$SADEEM_RUNNER" --yes
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
echo "  sadeem claude install    # Claude Code (.mcp.json)"
echo "  sadeem cursor install    # Cursor (.cursor/mcp.json)"
echo "  sadeem copilot install   # Copilot (.vscode/mcp.json)"
echo ""
echo "Then ask your agent:"
echo '  "What is the blast radius of changing [YourMainEntity]?"'
echo '  "How does [feature X] work?"'
echo '  "Is this PR safe to merge?"'
echo ""
echo "=== Done ==="
