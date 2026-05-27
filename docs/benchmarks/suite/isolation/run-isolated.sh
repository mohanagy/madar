#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ISOLATION_ROOT="${REPO_ROOT}/docs/benchmarks/suite/isolation"
CLAUDE_CONFIG_DIR="${ISOLATION_ROOT}/.claude"
CURSOR_CONFIG_DIR="${ISOLATION_ROOT}/.cursor"
CURSOR_MCP_PATH="${CURSOR_CONFIG_DIR}/mcp.json"
CLI_PATH="${REPO_ROOT}/dist/src/cli/bin.js"

if [[ ! -f "${CLI_PATH}" ]]; then
  echo "Missing ${CLI_PATH}. Run npm run build first." >&2
  exit 1
fi

mkdir -p "${CURSOR_CONFIG_DIR}"

cat > "${CURSOR_MCP_PATH}" <<JSON
{
  "mcpServers": {
    "madar": {
      "command": "node",
      "args": [
        "${CLI_PATH}",
        "serve",
        "--stdio",
        "out/graph.json"
      ],
      "env": {
        "MADAR_TOOL_PROFILE": "core"
      }
    }
  }
}
JSON

export CLAUDE_CONFIG_DIR
export MADAR_BENCH_ISOLATION=1

exec node "${CLI_PATH}" bench:suite "$@"
