# #736 paired Native-vs-Madar agent evaluation

This directory is **qualification-only**. It is intentionally not part of prototype candidate `736fe89603822a3003da11cfa2cc96983af8f30b`.

It exists to run the final six-task gate from #736 without turning the evaluation into a manual, non-reproducible conversation.

## What is frozen already

- Prototype candidate: `736fe89603822a3003da11cfa2cc96983af8f30b`
- Protected candidate CI: 6/6 green
- GoValidate exact-anchor gate: 3/3 green
- Holdout exact-anchor gate: 3/3 green
- Holdout canonical digest: stable across three repetitions in each of `C` and `C.UTF-8`
- Holdout task text/truth: frozen before implementation

The remaining gate is **agent outcome**, not resolver correctness.

## Integrity blocker: recover the original GoValidate freeze

Do **not** reconstruct the old three GoValidate task prompts from source or from the new resolver output.

The previous checkpoint reported an original file named `FROZEN.md` with SHA-256 beginning `a45f2562`. The regression task texts must come from that artifact.

Try:

```bash
bash scripts/qualification/736-agent-eval/find-original-freeze.sh "$HOME/Desktop/projects"
```

If the file is outside that tree, pass a wider safe search root.

Copy `regression-tasks.REQUIRED.example.json` to a private evaluation location, replace the three placeholder task strings with the **exact task text** from the matching `FROZEN.md`, record the full source digest, and change `status` away from `DO_NOT_RUN_UNTIL_FILLED_FROM_ORIGINAL_FROZEN_MD`.

Do not add ground-truth file/symbol lists to the public task manifest or agent workspace.

## Build the six-task public manifest

```bash
node scripts/qualification/736-agent-eval/merge-task-manifests.mjs \
  /private/path/regression-tasks.frozen.json \
  scripts/qualification/736-agent-eval/holdout-tasks.public.json \
  /private/path/six-tasks.public.json
```

The merger refuses the placeholder regression manifest.

## Agent environment

The runner expects the Codex CLI to already be authenticated through the user's existing ChatGPT/Codex login. It copies only the authentication file into a temporary `CODEX_HOME`; it does not reuse the user's config, history, sessions, skills, or memories.

Defaults:

```text
model: gpt-5.6-sol
reasoning effort: medium
web search: disabled
network in agent sandbox: disabled
history: ephemeral
```

Both arms use the same model, prompt, output schema and workspace permissions.

Arm N receives ordinary Codex shell/file tools only.

Arm B receives the same environment plus one stdio MCP server, `madar_evidence`, pointing at the frozen #736 candidate and the exact task snapshot.

The prompt is identical in both arms and says: if the MCP server exists, use it as the primary acquisition path; otherwise investigate natively.

### Why `workspace-write` is used

The runner deliberately gives Codex the same `workspace-write` sandbox in both arms, but each run operates on a disposable history-free snapshot. The prompt prohibits edits. The runner hashes the complete source tree before and after, records Codex `file_change` events, and invalidates the arm if anything changes.

This avoids relying on model/CLI-specific read-only tool provisioning while preserving the evaluation's stop-before-edit contract.

## History leakage prevention

Each target is materialized with `git archive <pinned SHA>`. The agent does not receive repository objects, refs, tags, branches, future fixes, or pull-request merge commits.

The snapshot contains only a minimal `.git/HEAD` carrying the pinned SHA so Madar can report repository provenance. There is no usable Git history for the agent to inspect.

The prompt also explicitly prohibits remote/history/PR/issue lookup.

## Run the complete paired experiment

Optional local source repositories avoid network cloning during setup:

```bash
export MADAR_736_SOURCE_GOVALIDATE="$HOME/Desktop/projects/govalidate-backend"
export MADAR_736_SOURCE_NEST="$HOME/Desktop/projects/nest"       # optional
export MADAR_736_SOURCE_TYPEORM="$HOME/Desktop/projects/typeorm" # optional
```

If Nest/TypeORM paths are omitted, setup uses authenticated `gh repo clone` before agent execution. Agent network remains disabled.

Run:

```bash
bash scripts/qualification/736-agent-eval/run-suite.sh \
  --manifest /private/path/six-tasks.public.json \
  --output-root /private/path/madar-736-agent-eval \
  --madar-source "$HOME/Desktop/projects/works/madar"
```

The frozen per-task order is counterbalanced:

```text
R1 Madar -> Native
R2 Native -> Madar
R3 Madar -> Native
H1 Native -> Madar
H2 Madar -> Native
H3 Native -> Madar
```

Every arm is a fresh `codex exec --ephemeral` session.

## Evidence retained per arm

```text
prompt.txt
events.jsonl
stderr.log
final.json
event-summary.json
run-meta.json
```

`events.jsonl` preserves completed shell/MCP tool calls and token usage. `run-meta.json` records:

- model/reasoning effort;
- Codex exit code;
- wall time;
- source-tree digest before/after;
- command call count;
- MCP call count and tools;
- web searches;
- file-change events;
- token usage;
- validity/refusal reasons.

The suite also writes `raw-suite-summary.json`.

## Fail-closed execution rules

Stop before spending more agent runs when an arm is invalid because of:

- non-zero Codex exit;
- workspace mutation;
- Codex file-change event;
- web search;
- missing/invalid structured final response.

A valid Madar arm with zero MCP use is **not** silently repaired. It remains evidence for attribution scoring; if critical evidence was found only through broad native exploration, the task can fail the #736 Madar-attribution gate.

## Scoring happens after all runs

Do not put the sealed truth into the agent workspaces.

After all 12 arms complete, score `final.json` + raw tool evidence against the already frozen truth. The final #736 contract remains:

- exact anchor resolution 6/6;
- regression critical-file availability 100%;
- holdout critical-file recall >=90% aggregate and no holdout <80%;
- critical-symbol recall >=90% aggregate;
- zero critical wrong definition/reference claims;
- zero critical misleading relationships;
- source/range citation validity 100%;
- plan correctness non-inferior to Native on all six tasks;
- measurable navigation benefit on >=4/6 tasks;
- overall task pass >=5/6;
- representative deterministic result hash identical across locales/repetitions.

Measurable benefit requires >=25% fewer initial repository-exploration calls **or** >=20% less wall time to the first correct plan. Across all tasks, the median primary efficiency metric must improve >=25% while the other metric regresses no more than 5%.

If the final result is <=4/6 or contains any critical misleading claim, #735 says **pause Madar**. Do not open another ranking/context-compiler architecture issue automatically.
