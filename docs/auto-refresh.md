# Auto-refresh and generation policy

Installed MCP profiles run `madar serve --stdio --auto-refresh`. The stdio transport becomes available immediately while automatic refresh runs in a background worker. Before that worker starts, Madar publishes a `starting` watcher state so graph-backed requests cannot read an unvalidated graph. The worker starts a recursive filesystem listener and takes an authoritative source snapshot. When the existing graph has matching generation policy, complete indexing outcomes, fresh source fingerprints, no added or deleted candidates, and no newer control files, Madar publishes it as usable without rebuilding it. Root-level `AGENTS.md` and `CLAUDE.md` files managed by an agent installer are execution guidance, not graph evidence, so their installation or later edits do not force a refresh. Any uncertainty or detected source change keeps the existing rebuild-and-reconcile path.

Filesystem events provide low-latency invalidation; they are not the correctness boundary. Madar also performs full reconciliations on an adaptive schedule. Idle intervals back off from 30 seconds to at most 5 minutes when recursive events are available. Platforms without recursive events use adaptive polling from 1 second to at most 30 seconds. The lower-level `pollIntervalMs` option is an internal/test override rather than a CLI setting.

There is no file-count cutoff. A reconciliation scans every supported candidate and relevant control file. If a directory cannot be read, a followed symlink cannot be inspected, or the scan exceeds its 2-minute safety bound, watcher coverage becomes `failed`; Madar does not silently answer from the possibly stale graph.

## Generation-policy preservation

Every generated `graph.json` and `manifest.json` contains the same versioned `generation_policy` and SHA-256 fingerprint. The policy covers:

- extraction mode: capability-aware auto, legacy-only, or strict canonical JS/TS indexing (selected by the compatibility `--spi` flag) without unsupported-language fallback;
- Git-ignore enforcement and the active Git/Madar exclusion controls;
- symlink traversal;
- document/non-code inclusion policy;
- legacy companion extractor/cache version (retained as a policy compatibility guard); and
- strict indexing thresholds.

Automatic refresh reconstructs these inputs from the stored policy. In particular, a graph generated with `--legacy` or `--spi` keeps that strict mode during refresh; an auto graph keeps its capability-aware partition. An explicit policy override or a change to `.madarignore`, applicable `.gitignore` files, `.git/info/exclude`, or `core.excludesFile` forces a full rebuild instead of incremental reuse.

Graphs created before the current extraction-mode policy cannot prove which discovery options produced them. Migrate once before relying on auto-refresh:

```bash
madar generate . --update
```

## Watcher health

The local `watcher-state.json` beside `graph.json` is written atomically and includes:

- `status`: `starting`, `idle`, `pending`, `reconciling`, `failed`, or `stopped`;
- coverage and event mode;
- last reconciliation time, duration, file/directory counts, and next interval;
- pending/failure details; and
- stored/current policy fingerprints and match state; and
- the requested extraction mode plus the current aggregate extraction-strategy receipt.

`madar doctor` and `madar status` render those fields. During an auto-refresh MCP session, graph-backed prompts, resources, completions, and tool calls remain fail-closed until the watcher is `idle` with matching published policy. A request that arrives while the graph is transiently `starting`, `pending`, or `reconciling` waits for readiness for up to 25 seconds by default. If reconciliation finishes, that same request completes against the ready graph; the agent does not need to issue it again. If the bounded wait expires, Madar returns `madar_graph_not_ready` with `retryable: true`, the measured `waited_ms`, `retry_after_ms: 1000`, and `suggested_action: "retry_same_request"`. Terminal `failed`, incomplete, and policy-mismatched states return immediately with `retryable: false` and `suggested_action: "repair_graph"`; inspect `madar status`, then run `madar generate . --update` when repair is required.

MCP initialization, ping, and list/discovery requests remain responsive while a graph-backed request is waiting during `starting` and `reconciling`. This lets an agent connect and inspect capabilities without waiting for a cold large-repository build while preserving the same freshness boundary for every graph answer.

The refresh lease serializes multiple MCP processes that target the same workspace. If the recorded owner process is dead, Madar reclaims the lease immediately. If another live process owns it, auto-refresh remains in a retryable reconciliation state and waits with bounded backoff until the lease is released or the server shuts down; contention does not permanently fail the watcher. Graph, source-manifest, indexing-manifest, report, and watcher-state publications use same-filesystem atomic renames. A post-build reconciliation detects edits made while generation was running and queues another rebuild before the state can return to `idle`.

## Linked worktrees

Auto-refresh watches the source worktree selected when the MCP server starts. In a linked worktree, `graph.json`, manifests, and `watcher-state.json` live together in that worktree's isolated external Madar artifact directory under the repository's shared Git data. Reconnect the MCP server after switching to a different worktree.
