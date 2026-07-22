# Auto-refresh and generation policy

Installed MCP profiles run `madar serve --stdio --auto-refresh`. The stdio transport starts immediately, while a process-local controller reconciles the active workspace before graph-backed requests become available. `madar watch` uses the same reconciliation controller.

Madar does not retain an AST, per-file extraction facts, dependency closures, or a compiler session in memory or on disk. It also does not persist a watcher owner or watcher-health record. The running process holds only coordination and readiness state. A short-lived exclusive build lock prevents two processes from publishing the same workspace at once; it is released when that build attempt finishes.

## Unchanged no-op and changed reconcile behavior

Each reconciliation scans one source catalog containing supported files, compiler/control inputs, recognized unsupported files, and policy outcomes.

| Caller | State | Behavior |
| --- | --- | --- |
| `madar generate . --update` | Accepted source snapshot unchanged | Scan only; parse zero files and do not republish. |
| `madar generate . --update` | Source or controls changed | Fully reconcile the supported JavaScript/TypeScript index. |
| `madar watch` or MCP auto-refresh | Source snapshot unchanged | Parse zero files and do not republish. |
| `madar watch` or MCP auto-refresh | Source, compiler controls, or policy changed | Fully reconcile the same canonical index. |

A newly started MCP process can accept an unchanged current graph without parsing it. Every later changed update performs a full reconcile; repeated changes do not enable a partial-update path.

Filesystem events provide low-latency triggers. A five-minute polling pass is a backstop for missed or unavailable recursive events. Both paths run the same source-catalog comparison; the event stream is never treated as the source of truth. If files change during a build, that candidate build is rejected and the controller reconciles again before returning to `idle`.

## Generation-policy preservation

The authoritative `graph.json` embeds a versioned generation policy and SHA-256 fingerprint covering:

- the canonical JavaScript/TypeScript index format;
- Git-ignore and Madar exclusion controls;
- symlink traversal; and
- explicit strict-indexing thresholds.

The graph also embeds the accepted source snapshot and source-root identity. Changes to compiler controls such as `tsconfig.json` or `jsconfig.json`, exclusion controls such as `.madarignore` and applicable Git ignore files, symlink policy, or strict thresholds force a full reconcile.

Root-level `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` files managed by agent installers are execution guidance rather than graph evidence, so editing them does not invalidate the code index.

## Readiness and publication

The controller's `starting`, `pending`, `reconciling`, `idle`, `failed`, and `stopped` states exist only in the running process. There is no authoritative `watcher-state.json`.

Graph-backed MCP requests remain fail-closed until the controller is `idle` and its accepted build id matches the authenticated build id in `graph.json`. Initialization, ping, and list/discovery requests remain responsive during reconciliation. A graph request can wait for a bounded interval; if reconciliation is still active, Madar returns `madar_graph_not_ready` with `retryable: true`, `retry_after_ms: 1000`, and `suggested_action: "retry_same_request"`. A terminal failure returns `retryable: false` and `suggested_action: "repair_graph"`.

Publication writes derived outputs first and commits `graph.json` last:

1. `GRAPH_REPORT.md` is attempted.
2. `indexing-manifest.json` and `indexing-manifest.share-safe.json` are attempted.
3. The authenticated `graph.json` is atomically committed.

The report and manifests are best-effort diagnostics. Their write failure is reported as a warning but does not block an otherwise valid graph. Consumers ignore derived diagnostics that are absent, unreadable, or carry a different build id. The graph is the sole authoritative index artifact and commit marker.

## Upgrading existing workspaces

Graphs from the predecessor generation/watch design do not contain the current authenticated build state. Regenerate once, then restart or reconnect the agent's MCP session:

```bash
madar generate . --update
```

Old `manifest.json`, `watcher-state.json`, failed-attempt manifests, and persistent extraction caches are retired outputs. Madar does not load them through a compatibility adapter.

## Linked worktrees

Auto-refresh watches the worktree selected when the MCP server starts. Each linked worktree has an isolated external artifact directory under the repository's shared Git data, containing its authoritative `graph.json` and any derived diagnostics. Reconnect the MCP server after switching worktrees so the process-local session follows the new source root.
