# Auto-refresh and generation policy

Installed MCP profiles run `madar serve --stdio --auto-refresh`. The server starts a recursive filesystem listener before its initial graph reconciliation, marks the graph pending as soon as a relevant event arrives, and performs an authoritative source snapshot before publishing the graph as usable again.

Filesystem events provide low-latency invalidation; they are not the correctness boundary. Madar also performs full reconciliations on an adaptive schedule. Idle intervals back off from 30 seconds to at most 5 minutes when recursive events are available. Platforms without recursive events use adaptive polling from 1 second to at most 30 seconds. The lower-level `pollIntervalMs` option is an internal/test override rather than a CLI setting.

There is no file-count cutoff. A reconciliation scans every supported candidate and relevant control file. If a directory cannot be read, a followed symlink cannot be inspected, or the scan exceeds its 2-minute safety bound, watcher coverage becomes `failed`; Madar does not silently answer from the possibly stale graph.

## Generation-policy preservation

Every generated `graph.json` and `manifest.json` contains the same versioned `generation_policy` and SHA-256 fingerprint. The policy covers:

- directed versus legacy undirected graph semantics;
- SPI versus the built-in extraction pipeline;
- Git-ignore enforcement and the active Git/Madar exclusion controls;
- symlink traversal;
- document/non-code inclusion policy;
- extractor cache version; and
- strict indexing thresholds.

Automatic refresh reconstructs these inputs from the stored policy. An explicit policy override or a change to `.madarignore`, applicable `.gitignore` files, `.git/info/exclude`, or `core.excludesFile` forces a full rebuild instead of incremental reuse.

Graphs created before this contract cannot prove which discovery options produced them. Migrate once before relying on auto-refresh:

```bash
madar generate . --update
```

## Watcher health

The local `watcher-state.json` beside `graph.json` is written atomically and includes:

- `status`: `starting`, `idle`, `pending`, `reconciling`, `failed`, or `stopped`;
- coverage and event mode;
- last reconciliation time, duration, file/directory counts, and next interval;
- pending/failure details; and
- stored/current policy fingerprints and match state.

`madar doctor` and `madar status` render those fields. During an auto-refresh MCP session, graph-backed prompts, resources, completions, and tool calls are refused while state is pending, reconciling, failed, incomplete, or policy-mismatched. Retry after the state returns to `idle`; if it remains failed, run `madar generate . --update` and inspect `madar status`.

The refresh lease serializes multiple MCP processes that target the same workspace. Graph, source-manifest, indexing-manifest, report, and watcher-state publications use same-filesystem atomic renames. A post-build reconciliation detects edits made while generation was running and queues another rebuild before the state can return to `idle`.

## Linked worktrees

Auto-refresh watches the source worktree selected when the MCP server starts. In a linked worktree, `graph.json`, manifests, and `watcher-state.json` live together in that worktree's isolated external Madar artifact directory under the repository's shared Git data. Reconnect the MCP server after switching to a different worktree.
