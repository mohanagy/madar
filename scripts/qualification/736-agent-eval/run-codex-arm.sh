#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-codex-arm.sh \
  --arm native|madar \
  --workspace /history-free/task-snapshot \
  --task-json /path/to/one-task.json \
  --madar-root /path/to/madar-candidate \
  --output-dir /path/to/output

Environment:
  MADAR_736_MODEL              default: gpt-5.6-sol
  MADAR_736_REASONING_EFFORT   default: medium
  SOURCE_CODEX_HOME            default: ${CODEX_HOME:-$HOME/.codex}
EOF
}

ARM=
WORKSPACE=
TASK_JSON=
MADAR_ROOT=
OUTPUT_DIR=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm) ARM=${2:-}; shift 2 ;;
    --workspace) WORKSPACE=${2:-}; shift 2 ;;
    --task-json) TASK_JSON=${2:-}; shift 2 ;;
    --madar-root) MADAR_ROOT=${2:-}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$ARM" != native && "$ARM" != madar ]]; then echo "--arm must be native or madar" >&2; exit 2; fi
for required in WORKSPACE TASK_JSON MADAR_ROOT OUTPUT_DIR; do
  if [[ -z "${!required}" ]]; then echo "missing required argument: $required" >&2; exit 2; fi
done
if [[ ! -d "$WORKSPACE" ]]; then echo "workspace not found: $WORKSPACE" >&2; exit 2; fi
if [[ ! -f "$TASK_JSON" ]]; then echo "task json not found: $TASK_JSON" >&2; exit 2; fi
if [[ ! -f "$MADAR_ROOT/dist/src/cli/evidence-bin.js" ]]; then
  echo "frozen Madar candidate must be built first: missing $MADAR_ROOT/dist/src/cli/evidence-bin.js" >&2
  exit 2
fi
if ! command -v codex >/dev/null 2>&1; then echo "codex CLI is required" >&2; exit 2; fi
if ! command -v node >/dev/null 2>&1; then echo "node is required" >&2; exit 2; fi
if ! command -v python3 >/dev/null 2>&1; then echo "python3 is required" >&2; exit 2; fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCHEMA="$SCRIPT_DIR/output-schema.json"
INSTRUCTIONS="$SCRIPT_DIR/agent-instructions.txt"
MODEL=${MADAR_736_MODEL:-gpt-5.6-sol}
EFFORT=${MADAR_736_REASONING_EFFORT:-medium}
SOURCE_HOME=${SOURCE_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)
WORKSPACE=$(cd "$WORKSPACE" && pwd)
MADAR_ROOT=$(cd "$MADAR_ROOT" && pwd)

TASK_ID=$(node -e 'const v=require(process.argv[1]); if(typeof v.id!=="string"||typeof v.task!=="string") process.exit(2); process.stdout.write(v.id)' "$TASK_JSON")
TASK_TEXT=$(node -e 'const v=require(process.argv[1]); process.stdout.write(v.task)' "$TASK_JSON")

RUN_HOME=$(mktemp -d "${TMPDIR:-/tmp}/madar-736-codex.XXXXXX")
cleanup() {
  chmod -R u+w "$RUN_HOME" 2>/dev/null || true
  rm -rf "$RUN_HOME"
}
trap cleanup EXIT
chmod 700 "$RUN_HOME"
mkdir -p "$RUN_HOME/home" "$RUN_HOME/tmp" "$RUN_HOME/xdg-config" "$RUN_HOME/xdg-cache"
if [[ -f "$SOURCE_HOME/auth.json" ]]; then
  cp "$SOURCE_HOME/auth.json" "$RUN_HOME/auth.json"
  chmod 600 "$RUN_HOME/auth.json"
fi

cat > "$RUN_HOME/config.toml" <<EOF
model = "$MODEL"
model_reasoning_effort = "$EFFORT"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[shell_environment_policy]
inherit = "core"
set = { MADAR_736_EVAL = "1", HOME = "$RUN_HOME/home", TMPDIR = "$RUN_HOME/tmp", XDG_CONFIG_HOME = "$RUN_HOME/xdg-config", XDG_CACHE_HOME = "$RUN_HOME/xdg-cache" }
EOF

if [[ "$ARM" == madar ]]; then
  cat >> "$RUN_HOME/config.toml" <<EOF

[mcp_servers.madar_evidence]
command = "node"
args = ["$MADAR_ROOT/dist/src/cli/evidence-bin.js", "--root", "$WORKSPACE"]
EOF
fi

PROMPT_FILE="$OUTPUT_DIR/prompt.txt"
{
  cat "$INSTRUCTIONS"
  printf '\nTASK ID: %s\n\nTASK:\n%s\n' "$TASK_ID" "$TASK_TEXT"
} > "$PROMPT_FILE"

EVENTS="$OUTPUT_DIR/events.jsonl"
STDERR_LOG="$OUTPUT_DIR/stderr.log"
FINAL_JSON="$OUTPUT_DIR/final.json"
EVENT_SUMMARY="$OUTPUT_DIR/event-summary.json"
RUN_META="$OUTPUT_DIR/run-meta.json"

BEFORE=$(node "$SCRIPT_DIR/tree-digest.mjs" "$WORKSPACE")
START_NS=$(python3 -c 'import time; print(time.time_ns())')
set +e
HOME="$RUN_HOME/home" \
TMPDIR="$RUN_HOME/tmp" \
XDG_CONFIG_HOME="$RUN_HOME/xdg-config" \
XDG_CACHE_HOME="$RUN_HOME/xdg-cache" \
CODEX_HOME="$RUN_HOME" \
codex --ask-for-approval never exec \
  --sandbox workspace-write \
  --ephemeral \
  --skip-git-repo-check \
  -C "$WORKSPACE" \
  --json \
  --output-schema "$SCHEMA" \
  --output-last-message "$FINAL_JSON" \
  - < "$PROMPT_FILE" > "$EVENTS" 2> "$STDERR_LOG"
CODEX_RC=$?
set -e
END_NS=$(python3 -c 'import time; print(time.time_ns())')
AFTER=$(node "$SCRIPT_DIR/tree-digest.mjs" "$WORKSPACE")
WALL_MS=$(python3 - "$START_NS" "$END_NS" <<'PY'
import sys
print((int(sys.argv[2]) - int(sys.argv[1])) // 1_000_000)
PY
)

node "$SCRIPT_DIR/summarize-events.mjs" "$EVENTS" "$EVENT_SUMMARY"

node - "$TASK_ID" "$ARM" "$MODEL" "$EFFORT" "$CODEX_RC" "$WALL_MS" "$BEFORE" "$AFTER" "$EVENT_SUMMARY" "$FINAL_JSON" > "$RUN_META" <<'NODE'
const fs = require('node:fs')
const [taskId, arm, model, effort, rcRaw, wallRaw, before, after, summaryPath, finalPath] = process.argv.slice(2)
const events = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
const invalidReasons = []
const rc = Number(rcRaw)
if (rc !== 0) invalidReasons.push(`codex_exit_${rc}`)
if (before !== after) invalidReasons.push('workspace_mutated')
if (events.file_changes > 0) invalidReasons.push('agent_file_change_event')
if (events.web_searches > 0) invalidReasons.push('web_search_used')
if (!fs.existsSync(finalPath)) invalidReasons.push('missing_final_json')
else {
  try { JSON.parse(fs.readFileSync(finalPath, 'utf8')) } catch { invalidReasons.push('invalid_final_json') }
}
const payload = {
  schema_version: 1,
  task_id: taskId,
  arm,
  model,
  reasoning_effort: effort,
  codex_exit_code: rc,
  wall_ms: Number(wallRaw),
  workspace_digest_before: before,
  workspace_digest_after: after,
  command_calls: events.command_calls,
  mcp_calls: events.mcp_calls,
  mcp_calls_by_tool: events.mcp_calls_by_tool,
  web_searches: events.web_searches,
  file_changes: events.file_changes,
  usage: events.usage,
  event_errors: events.errors,
  madar_mcp_used: events.mcp_calls > 0,
  valid: invalidReasons.length === 0,
  invalid_reasons: invalidReasons,
}
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
NODE

cat "$RUN_META"
if [[ $(node -e 'const v=require(process.argv[1]); process.stdout.write(v.valid?"yes":"no")' "$RUN_META") != yes ]]; then
  exit 1
fi
