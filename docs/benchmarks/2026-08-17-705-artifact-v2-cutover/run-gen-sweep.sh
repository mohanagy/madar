#!/usr/bin/env bash
# Interleaved generation sweep: every arm once per round, medians over rounds.
#
# One sweep at a time, enforced. Two concurrent sweeps generate graphs
# simultaneously and append to the same file, which roughly doubles every wall
# time and leaves the arms with uneven sample counts. That happened once and
# the whole sweep had to be discarded, so the lock is part of the harness
# rather than a note in the runbook.
#
# Arm binaries are supplied, never inferred from whatever dist is on this
# machine. No apostrophes in the messages below: bash parses a single quote
# inside "${VAR:?...}" as opening a quote even within the double quotes, and
# the script then fails to parse as a whole.
set -uo pipefail
: "${ARM_BASE_CLI:?set ARM_BASE_CLI to the base binary dist/src/cli/bin.js}"
: "${ARM_B1_CLI:?set ARM_B1_CLI to the B1 binary dist/src/cli/bin.js}"
: "${ARM_HEAD_CLI:?set ARM_HEAD_CLI to the candidate binary dist/src/cli/bin.js}"
export ARM_BASE_CLI ARM_B1_CLI ARM_HEAD_CLI

SP="${1:?usage: run-gen-sweep.sh <scratch-dir> [rounds]}"
ROUNDS="${2:-4}"
HERE="$(cd "$(dirname "$0")" && pwd)"

exec 9>"$SP/gen-sweep.lock"
if ! flock -n 9 2>/dev/null; then
  if ! shlock -f "$SP/gen-sweep.pid" -p $$; then
    echo "another sweep holds the lock; refusing to start" >&2
    exit 3
  fi
fi

rm -f "$SP/rr-gen.done"
: > "$SP/rr-gen.jsonl"
for ((i = 1; i <= ROUNDS; i += 1)); do
  for arm in base b1 head; do
    bash "$HERE/gen-run.sh" "$SP" "$arm" "$i" >> "$SP/rr-gen.jsonl"
    echo "round $i arm $arm done" >&2
  done
done
touch "$SP/rr-gen.done"
echo "GEN SWEEP COMPLETE" >&2
