#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ISOLATION_ROOT="${REPO_ROOT}/docs/benchmarks/suite/isolation"
RUNTIME_PROFILE_ROOT="${MADAR_BENCH_ISOLATION_PROFILE_ROOT:-${XDG_STATE_HOME:-${HOME}/.local/state}/madar/benchmark-isolation}"
CLAUDE_CONFIG_DIR="${RUNTIME_PROFILE_ROOT}/.claude"
CURSOR_CONFIG_DIR="${RUNTIME_PROFILE_ROOT}/.cursor"
CURSOR_MCP_PATH="${CURSOR_CONFIG_DIR}/mcp.json"
CLI_PATH="${MADAR_BENCH_CLI_PATH:-${REPO_ROOT}/dist/src/cli/bin.js}"

seed_runtime_profile() {
  mkdir -p "${CLAUDE_CONFIG_DIR}" "${CURSOR_CONFIG_DIR}"
  cp "${ISOLATION_ROOT}/.claude/CLAUDE.md" "${CLAUDE_CONFIG_DIR}/CLAUDE.md"
  cp "${ISOLATION_ROOT}/.claude/settings.json" "${CLAUDE_CONFIG_DIR}/settings.json"
}

claude_auth_status() {
  if [[ $# -eq 0 ]]; then
    env -u CLAUDE_CONFIG_DIR -u CURSOR_CONFIG_DIR claude auth status 2>/dev/null || true
    return
  fi
  env CLAUDE_CONFIG_DIR="$1" CURSOR_CONFIG_DIR="$2" claude auth status 2>/dev/null || true
}

claude_logged_in() {
  local normalized
  normalized="$(printf '%s' "$1" | tr -d '[:space:]')"
  [[ "${normalized}" == *'"loggedIn":true'* ]]
}

ensure_isolated_claude_auth() {
  local default_auth_status isolated_auth_status
  default_auth_status="$(claude_auth_status)"
  isolated_auth_status="$(claude_auth_status "${CLAUDE_CONFIG_DIR}" "${CURSOR_CONFIG_DIR}")"

  if claude_logged_in "${isolated_auth_status}"; then
    return
  fi

  if claude_logged_in "${default_auth_status}"; then
    cat >&2 <<EOF
The default Claude profile is logged in, but the isolated benchmark profile is not.
Published isolated benchmark runs use:
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR}"
  CURSOR_CONFIG_DIR="${CURSOR_CONFIG_DIR}"

Authenticate the isolated profile once, then rerun:
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR}" CURSOR_CONFIG_DIR="${CURSOR_CONFIG_DIR}" claude auth login
EOF
    exit 1
  fi

  cat >&2 <<EOF
The isolated benchmark profile is not authenticated.
Authenticate the runtime isolation profile, then rerun:
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR}" CURSOR_CONFIG_DIR="${CURSOR_CONFIG_DIR}" claude auth login
EOF
  exit 1
}

if [[ ! -f "${CLI_PATH}" ]]; then
  echo "Missing ${CLI_PATH}. Run npm run build first." >&2
  exit 1
fi

seed_runtime_profile

NEEDS_AUTH_CHECK=1
for argument in "$@"; do
  if [[ "${argument}" == "--dry-run" ]]; then
    NEEDS_AUTH_CHECK=0
    break
  fi
done

if [[ "${NEEDS_AUTH_CHECK}" == "1" ]]; then
  ensure_isolated_claude_auth
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
export CURSOR_CONFIG_DIR
export MADAR_BENCH_ISOLATION=1

exec node "${CLI_PATH}" bench:suite "$@"
