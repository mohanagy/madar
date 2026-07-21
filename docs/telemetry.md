# Telemetry

Madar ships an **opt-in**, **source-safe**, **local-first** telemetry model for coarse adoption signals.

Telemetry is **disabled by default**. No event is recorded unless you explicitly enable it with `madar telemetry enable` or opt in for the current process with `MADAR_ENABLE_TELEMETRY=1`.

## Controls

```bash
madar telemetry status
madar telemetry enable
madar telemetry disable
madar telemetry clear
madar telemetry report [spool.json ...]
```

- `madar telemetry clear` deletes the local bounded event spool but keeps your persisted opt-in preference unchanged.
- `madar telemetry report [spool.json ...]` prints a local anonymized funnel summary from the current spool plus any extra spool files you pass in.

Environment overrides:

- `MADAR_ENABLE_TELEMETRY=1` — enable telemetry for the current command without changing the persisted preference.
- `MADAR_DISABLE_TELEMETRY=1` — force telemetry off for the current command even if the persisted preference is enabled.
- `DO_NOT_TRACK=1` — force telemetry off for the current command.
- `CI=1` — telemetry stays off in CI to avoid polluting adoption data with automated runs.

## What is collected

Each stored event includes these core fields:

- `command`
- `stage`
- `recorded_at`
- `version`
- `os`
- `node_major`

Optional coarse fields are added only when they help explain adoption drop-off without revealing source-sensitive data:

- `agent_target` — install target such as `claude`, `cursor`, `copilot`, `gemini`, `aider`, `codex`, or `opencode`
- `repo_size_bucket` — coarse file-count bucket
- `graph_size_bucket` — coarse node-count bucket
- `spi_enabled` — schema-compatible signal that strict canonical JS/TS indexing was explicitly selected (the CLI compatibility spelling is `--spi`)
- `failure_bucket` — coarse actionable category such as `usage_error`, `invalid_params`, `missing_graph`, `stale_graph`, `stale_context`, `tool_profile`, `unsupported_corpus`, `install_error`, or `unknown`
- `status_bucket` — coarse doctor/status outcome (`healthy` or `attention_needed`)
- `initial_answerability_bucket` / `final_answerability_bucket` — `ready`, `ready_with_caveat`, `verify_targets`, or `insufficient`
- `recovery_attempts_bucket` — bounded attempt count (`0`, `1`, or `2`)
- `recovery_improvement_bucket` — `not_attempted`, `improved`, or `unchanged`
- `broad_search_fallback_bucket` — `not_needed`, `targeted_only`, `allowed`, or `blocked`

`repo_size_bucket` is intentionally coarse:

- `1-24`
- `25-99`
- `100-499`
- `500-999`
- `1000+`

`graph_size_bucket` is intentionally coarse:

- `1-99`
- `100-499`
- `500-999`
- `1000-4999`
- `5000+`

## Current tracked command surfaces

When telemetry is enabled, Madar records source-safe funnel stages for:

- install flows (`madar install --platform ...`, `madar <agent> install`)
- `madar generate` (`started`, `succeeded`, `failed`)
- `madar pack` (`succeeded`, `failed`)
- `madar prompt` (`succeeded`, `failed`)
- MCP `context_pack` (`succeeded`, `failed`, plus source-safe answerability and recovery buckets on successful parseable responses)
- `madar doctor` and `madar status` (`succeeded`, `failed`, plus `status_bucket`)
- `madar compare` (`succeeded`, `failed`)

## What is excluded

Madar does **not** record:

- prompt text
- answer text
- source paths
- source content
- repository name
- raw snippets
- full file counts
- graph contents

## Storage model

This release stores telemetry locally only:

- persisted opt-in preference under the platform config directory
- bounded event spool under the platform cache directory (`schema_version: 2`)

There is **no cloud upload by default** in this implementation. The goal of this issue is to define the opt-in event model, controls, and source-safe field contract without introducing mandatory network traffic.
