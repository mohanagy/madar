# Telemetry

Madar telemetry is opt-in, source-safe, local-first, and disabled by default.

No event is recorded unless you enable it with `madar telemetry enable` or set `MADAR_ENABLE_TELEMETRY=1` for the current process.

## Controls

```bash
madar telemetry status
madar telemetry enable
madar telemetry disable
madar telemetry clear
madar telemetry report [spool.json ...]
```

- `clear` removes the bounded local spool without changing the persisted opt-in preference.
- `report` prints an anonymized local funnel summary.

Environment overrides:

- `MADAR_ENABLE_TELEMETRY=1` enables telemetry for the current process.
- `MADAR_DISABLE_TELEMETRY=1` forces telemetry off.
- `DO_NOT_TRACK=1` forces telemetry off.
- `CI=1` keeps telemetry off in CI.

## Collected fields

Every stored event contains:

- `command`
- `stage`
- `recorded_at`
- `version`
- `os`
- `node_major`

Optional coarse fields include:

- `agent_target`
- `repo_size_bucket`
- `graph_size_bucket`
- `failure_bucket`
- `status_bucket`

Repository and graph sizes are stored only as buckets. Failure values are coarse operational categories such as `usage_error`, `invalid_params`, `missing_graph`, `stale_graph`, `unsupported_corpus`, `install_error`, or `unknown`.

Current CLI funnel events cover agent install, `generate`, `doctor`, `status`, and `compare`. The one-query contract does not require source text or question text in telemetry.

## Excluded data

Madar does not record:

- question or prompt text
- answer text
- source paths
- source content
- repository name
- raw snippets
- graph contents
- credentials or environment values

## Storage

This implementation stores telemetry locally:

- the opt-in preference under the platform config directory
- a bounded event spool under the platform cache directory

There is no default cloud upload.
