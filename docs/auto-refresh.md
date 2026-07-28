# Freshness and generation policy

`madar mcp` starts stdio immediately for the exact current repository or linked worktree. It answers initialization and `tools/list` before loading reconciliation code. After `tools/list`, one process-local controller starts the existing canonical reconciler.

`madar generate . --watch` uses that same reconciler. There is no standalone watch command, updater, incremental index, fallback engine, or retained session cache.

## Reconcile behavior

Each reconcile scans one source catalog containing supported files, compiler and control inputs, recognized unsupported files, and policy outcomes.

| Caller | State | Behavior |
| --- | --- | --- |
| `madar generate . --update` | Accepted source snapshot unchanged | Cold no-op; parse zero files and do not republish. |
| `madar generate . --update` | Source or controls changed | Fully reconcile the supported JavaScript/TypeScript index. |
| `madar generate . --watch` or `madar mcp` | Snapshot unchanged | Parse zero files and do not republish. |
| `madar generate . --watch` or `madar mcp` | Source, controls, or policy changed | Fully reconcile the same canonical index. |

A short-lived exclusive build lock prevents two processes from publishing the same workspace at once. `graph.json` is the authoritative artifact and atomic commit marker; derived diagnostics publish before it.

## First-call freshness

The MCP server does not advertise a stale artifact as ready. A first `retrieve` call waits at most 25 seconds for the one reconciler to accept the current workspace build. If acceptance does not complete, the call returns the canonical `unavailable` result. It does not add a retry instruction or widen the timeout.

After a build is accepted, retrieval checks both the build identity and exact workspace root. Authenticated excerpts must still match current source hashes and ranges.

## Recommended use

For a one-off refresh:

```bash
madar generate . --update
```

For active local development:

```bash
madar generate . --watch
```

For MCP, register `madar mcp` with the exact workspace as `cwd`. Claude Code and Codex registration can be managed with `madar install claude` or `madar install codex`.
