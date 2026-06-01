# Telemetry

Madar ships an **opt-in**, **source-safe**, **local-first** telemetry model for coarse adoption signals.

Telemetry is **disabled by default**. No event is recorded unless you explicitly enable it with `madar telemetry enable` or opt in for the current process with `MADAR_ENABLE_TELEMETRY=1`.

## Controls

```bash
madar telemetry status
madar telemetry enable
madar telemetry disable
```

Environment overrides:

- `MADAR_ENABLE_TELEMETRY=1` — enable telemetry for the current command without changing the persisted preference.
- `MADAR_DISABLE_TELEMETRY=1` — force telemetry off for the current command even if the persisted preference is enabled.
- `DO_NOT_TRACK=1` — force telemetry off for the current command.
- `CI=1` — telemetry stays off in CI to avoid polluting adoption data with automated runs.

## What is collected

The current implementation records only these coarse success events:

- `install_success`
- `generate_success`
- `pack_success`
- `compare_success`

Each stored event can include:

- `event`
- `recorded_at`
- `version`
- `os`
- `install_platform` (only for install flows)
- `repo_size_bucket` (only for repo-scoped flows such as `generate`, `pack`, and `compare`)

`repo_size_bucket` is intentionally coarse:

- `1-24`
- `25-99`
- `100-499`
- `500-999`
- `1000+`

## What is excluded

Madar does **not** record:

- prompt text
- answer text
- source paths
- source content
- raw snippets
- full file counts
- graph contents

## Storage model

This release stores telemetry locally only:

- persisted opt-in preference under the platform config directory
- bounded event spool under the platform cache directory

There is **no cloud upload by default** in this implementation. The goal of this issue is to define the opt-in event model, controls, and source-safe field contract without introducing mandatory network traffic.

## Current tracked command surfaces

When telemetry is enabled, Madar records a coarse success event after these CLI flows complete successfully:

- `madar install --platform <platform>`
- `madar <agent> install`
- `madar generate`
- `madar pack`
- `madar compare`
