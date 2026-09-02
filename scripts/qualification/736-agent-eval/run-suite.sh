#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-suite.sh \
  --manifest /path/to/merged-six-task-manifest.json \
  --output-root /path/to/evaluation-output \
  [--madar-source /local/madar-or-mohanagy/madar]

Optional local source repositories (avoid network cloning when set):
  MADAR_736_SOURCE_GOVALIDATE=/path/to/govalidate-backend
  MADAR_736_SOURCE_NEST=/path/to/nest
  MADAR_736_SOURCE_TYPEORM=/path/to/typeorm

Codex model controls:
  MADAR_736_MODEL=gpt-5.6-sol
  MADAR_736_REASONING_EFFORT=medium

This runner uses history-free source snapshots, fresh ephemeral Codex sessions, the
same instructions/output schema in both arms, and only adds `madar_evidence` MCP to
Arm B. It stops before editing; any workspace mutation invalidates the arm.
EOF
}

MANIFEST=
OUTPUT_ROOT=
MADAR_SOURCE=mohanagy/madar
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST=${2:-}; shift 2 ;;
    --output-root) OUTPUT_ROOT=${2:-}; shift 2 ;;
    --madar-source) MADAR_SOURCE=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
if [[ -z "$MANIFEST" || -z "$OUTPUT_ROOT" ]]; then usage; exit 2; fi
if [[ ! -f "$MANIFEST" ]]; then echo "manifest not found: $MANIFEST" >&2; exit 2; fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREPARE="$SCRIPT_DIR/prepare-snapshot.sh"
RUN_ARM="$SCRIPT_DIR/run-codex-arm.sh"
CANDIDATE_SHA=736fe89603822a3003da11cfa2cc96983af8f30b
MODEL=${MADAR_736_MODEL:-gpt-5.6-sol}
EFFORT=${MADAR_736_REASONING_EFFORT:-medium}
mkdir -p "$OUTPUT_ROOT"
OUTPUT_ROOT=$(cd "$OUTPUT_ROOT" && pwd)

node - "$MANIFEST" "$CANDIDATE_SHA" <<'NODE'
const manifest = require(process.argv[2])
const expected = process.argv[3]
if (manifest.candidate_sha !== expected) throw new Error(`candidate mismatch: ${manifest.candidate_sha} != ${expected}`)
if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== 6) throw new Error('manifest must contain exactly six tasks')
for (const task of manifest.tasks) {
  if (typeof task.task !== 'string' || task.task.includes('__COPY_EXACT_TASK_TEXT')) throw new Error(`unfrozen task text: ${task.id}`)
  const order = manifest.arm_order?.[task.id]
  if (!Array.isArray(order) || order.length !== 2 || !order.includes('native') || !order.includes('madar')) throw new Error(`invalid arm order: ${task.id}`)
}
NODE

SOURCE_FOR_REPO() {
  case "$1" in
    mohanagy/govalidate-backend) printf '%s\n' "${MADAR_736_SOURCE_GOVALIDATE:-$1}" ;;
    nestjs/nest) printf '%s\n' "${MADAR_736_SOURCE_NEST:-$1}" ;;
    typeorm/typeorm) printf '%s\n' "${MADAR_736_SOURCE_TYPEORM:-$1}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

CANDIDATE_ROOT="$OUTPUT_ROOT/_candidate"
if [[ ! -f "$CANDIDATE_ROOT/dist/src/cli/evidence-bin.js" ]]; then
  echo "Preparing frozen Madar candidate $CANDIDATE_SHA"
  "$PREPARE" "$MADAR_SOURCE" "$CANDIDATE_SHA" "$CANDIDATE_ROOT"
  (
    cd "$CANDIDATE_ROOT"
    npm ci --ignore-scripts
    npm run build
  )
fi

if [[ $(cat "$CANDIDATE_ROOT/.git/HEAD") != "$CANDIDATE_SHA" ]]; then
  echo "candidate snapshot identity mismatch" >&2
  exit 2
fi

CODEX_VERSION=$(codex --version 2>&1 || true)
NODE_VERSION=$(node --version)
MANIFEST_DIGEST=$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST")
cat > "$OUTPUT_ROOT/suite-meta.json" <<EOF
{
  "schema_version": 1,
  "candidate_sha": "$CANDIDATE_SHA",
  "manifest_file_sha256": "$MANIFEST_DIGEST",
  "model": "$MODEL",
  "reasoning_effort": "$EFFORT",
  "codex_version": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$CODEX_VERSION"),
  "node_version": "$NODE_VERSION"
}
EOF

TASK_COUNT=$(node -e 'const v=require(process.argv[1]);process.stdout.write(String(v.tasks.length))' "$MANIFEST")
for ((index=0; index<TASK_COUNT; index+=1)); do
  TASK_ID=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.tasks[Number(process.argv[2])].id)' "$MANIFEST" "$index")
  REPO=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.tasks[Number(process.argv[2])].repository)' "$MANIFEST" "$index")
  REVISION=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.tasks[Number(process.argv[2])].revision)' "$MANIFEST" "$index")
  SOURCE=$(SOURCE_FOR_REPO "$REPO")
  TASK_DIR="$OUTPUT_ROOT/tasks/$TASK_ID"
  SNAPSHOT="$OUTPUT_ROOT/_snapshots/$TASK_ID"
  mkdir -p "$TASK_DIR" "$(dirname "$SNAPSHOT")"

  node - "$MANIFEST" "$index" > "$TASK_DIR/task.json" <<'NODE'
const manifest = require(process.argv[2])
const task = manifest.tasks[Number(process.argv[3])]
process.stdout.write(`${JSON.stringify({ id: task.id, task: task.task }, null, 2)}\n`)
NODE

  if [[ ! -f "$SNAPSHOT/.git/HEAD" ]]; then
    echo "Preparing $TASK_ID from $REPO@$REVISION"
    "$PREPARE" "$SOURCE" "$REVISION" "$SNAPSHOT"
  fi
  if [[ $(cat "$SNAPSHOT/.git/HEAD") != "$REVISION" ]]; then
    echo "snapshot revision mismatch for $TASK_ID" >&2
    exit 2
  fi
  SNAPSHOT_DIGEST=$(node "$SCRIPT_DIR/tree-digest.mjs" "$SNAPSHOT")
  printf '%s\n' "$SNAPSHOT_DIGEST" > "$TASK_DIR/source-tree.sha256"

  for order_index in 0 1; do
    ARM=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.arm_order[process.argv[2]][Number(process.argv[3])])' "$MANIFEST" "$TASK_ID" "$order_index")
    ARM_DIR="$TASK_DIR/$ARM"
    WORKSPACE="$OUTPUT_ROOT/_work/$TASK_ID/$ARM"
    rm -rf "$WORKSPACE"
    mkdir -p "$WORKSPACE" "$ARM_DIR"
    (cd "$SNAPSHOT" && tar -cf - .) | (cd "$WORKSPACE" && tar -xf -)
    COPY_DIGEST=$(node "$SCRIPT_DIR/tree-digest.mjs" "$WORKSPACE")
    if [[ "$COPY_DIGEST" != "$SNAPSHOT_DIGEST" ]]; then
      echo "workspace copy mismatch for $TASK_ID/$ARM" >&2
      exit 2
    fi

    echo "Running $TASK_ID / $ARM"
    if ! MADAR_736_MODEL="$MODEL" MADAR_736_REASONING_EFFORT="$EFFORT" \
      "$RUN_ARM" \
        --arm "$ARM" \
        --workspace "$WORKSPACE" \
        --task-json "$TASK_DIR/task.json" \
        --madar-root "$CANDIDATE_ROOT" \
        --output-dir "$ARM_DIR"; then
      echo "INVALID ARM: $TASK_ID/$ARM — stop before spending further agent runs" >&2
      exit 1
    fi
  done
done

node - "$OUTPUT_ROOT" "$MANIFEST" > "$OUTPUT_ROOT/raw-suite-summary.json" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const manifest = require(process.argv[3])
const tasks = []
for (const task of manifest.tasks) {
  const arms = {}
  for (const arm of ['native', 'madar']) {
    arms[arm] = JSON.parse(fs.readFileSync(path.join(root, 'tasks', task.id, arm, 'run-meta.json'), 'utf8'))
  }
  tasks.push({ id: task.id, repository: task.repository, revision: task.revision, arms })
}
process.stdout.write(`${JSON.stringify({ schema_version: 1, candidate_sha: manifest.candidate_sha, tasks }, null, 2)}\n`)
NODE

printf '\nRaw paired-agent execution complete. Do not compute PASS/KILL until outputs are scored against the independently frozen truth.\n'
