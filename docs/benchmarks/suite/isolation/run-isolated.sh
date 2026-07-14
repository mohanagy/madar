#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ISOLATION_ROOT="${REPO_ROOT}/docs/benchmarks/suite/isolation"
RUNTIME_PROFILE_ROOT="${MADAR_BENCH_ISOLATION_PROFILE_ROOT:-${XDG_STATE_HOME:-${HOME}/.local/state}/madar/benchmark-isolation}"
CLAUDE_CONFIG_DIR="${RUNTIME_PROFILE_ROOT}/.claude"
CURSOR_CONFIG_DIR="${RUNTIME_PROFILE_ROOT}/.cursor"
CURSOR_MCP_PATH="${CURSOR_CONFIG_DIR}/mcp.json"
PACKED_ARTIFACT_ROOT="${MADAR_BENCH_PACKED_ARTIFACT_ROOT:-${RUNTIME_PROFILE_ROOT}/packed-artifact}"
CLI_PATH="${MADAR_BENCH_CLI_PATH:-}"

prepare_packed_cli() {
  if [[ -n "${CLI_PATH}" ]]; then
    export MADAR_BENCH_RUNTIME_SOURCE="cli_override"
    return
  fi

  rm -rf "${PACKED_ARTIFACT_ROOT}"
  mkdir -p "${PACKED_ARTIFACT_ROOT}"
  (
    cd "${REPO_ROOT}"
    npm pack --silent --pack-destination "${PACKED_ARTIFACT_ROOT}" >/dev/null
  )

  local tarballs=("${PACKED_ARTIFACT_ROOT}"/*.tgz)
  if [[ ${#tarballs[@]} -ne 1 || ! -f "${tarballs[0]}" ]]; then
    echo "Expected exactly one npm pack tarball under ${PACKED_ARTIFACT_ROOT}." >&2
    exit 1
  fi

  tar -xzf "${tarballs[0]}" -C "${PACKED_ARTIFACT_ROOT}"
  if [[ -e "${PACKED_ARTIFACT_ROOT}/package/docs" ]]; then
    echo "Packed benchmark artifact unexpectedly contains checkout-only docs." >&2
    exit 1
  fi
  (
    cd "${PACKED_ARTIFACT_ROOT}/package"
    npm install --ignore-scripts --omit=optional --no-package-lock --no-audit --no-fund --silent
  )
  CLI_PATH="${PACKED_ARTIFACT_ROOT}/package/dist/src/cli/bin.js"
  export MADAR_BENCH_RUNTIME_SOURCE="npm_pack"
  export MADAR_BENCH_PACKAGE_TARBALL="${tarballs[0]}"
  export MADAR_BENCH_PACKAGE_VERSION
  MADAR_BENCH_PACKAGE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "${PACKED_ARTIFACT_ROOT}/package/package.json")"
}

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

prepare_packed_cli

if [[ ! -f "${CLI_PATH}" ]]; then
  echo "Missing benchmark CLI at ${CLI_PATH}." >&2
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

echo "Benchmark runtime source: ${MADAR_BENCH_RUNTIME_SOURCE}" >&2
if [[ "${MADAR_BENCH_RUNTIME_SOURCE}" == "npm_pack" ]]; then
  echo "Benchmark package: @lubab/madar ${MADAR_BENCH_PACKAGE_VERSION} (${MADAR_BENCH_PACKAGE_TARBALL})" >&2
else
  echo "Benchmark CLI override: ${CLI_PATH} (not valid for published receipts)" >&2
fi

exec node "${CLI_PATH}" bench:suite "$@"
