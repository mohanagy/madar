# Auto-refresh and generation policy

## Automatic semantic refresh is not supported

Automatic semantic refresh is not supported in the stable profile. Run ordinary full generation to refresh repository semantics:

```bash
madar generate .
```

Madar's stable profile establishes freshness by data source, not by object identity: semantic generation may read repository inputs, but it may not read persisted semantic results. Every withdrawn path below existed to reconstruct generation inputs from persisted state — a stored generation policy, a prior graph, a watcher snapshot — so none of them can be expressed under that contract.

Withdrawn:

- `madar watch`;
- background automatic refresh and its worker;
- the filesystem watcher, its adaptive reconciliation schedule, and its polling fallback;
- the refresh lease and multi-process refresh contention handling;
- `watcher-state.json` publication, and the `madar_graph_not_ready` request-gating protocol that depended on it.

These entry points remain only to refuse, with a typed `UNSUPPORTED_GENERATION_MODE` error raised before any stored policy or prior graph is read, before a watcher, timer or worker is created, and before anything is written.

## `serve --stdio --auto-refresh`

Installed MCP profiles run `madar serve --stdio --auto-refresh`. That command still works. The flag is accepted for compatibility so existing installed profiles keep serving; it performs no refresh, and the server says so once on stderr at startup:

```
[madar serve] automatic semantic refresh is not supported in the stable profile; run ordinary full generation to refresh repository semantics
```

Graph-backed MCP requests are answered directly from the graph artifact on disk. Because nothing refreshes it in the background, there is no readiness gate: requests no longer wait for reconciliation and `madar_graph_not_ready` is no longer returned. Regenerate with `madar generate .` when the repository has changed.

## Generation-policy preservation

Every generated `graph.madar` and `manifest.json` still contains the same versioned `generation_policy` and SHA-256 fingerprint. The policy covers:

- directed versus legacy undirected graph semantics;
- extraction mode: capability-aware auto, legacy-only, or strict SPI code extraction without unsupported-language fallback;
- Git-ignore enforcement and the active Git/Madar exclusion controls;
- symlink traversal;
- document/non-code inclusion policy;
- extractor cache version; and
- strict indexing thresholds.

The policy remains a *record* of how an artifact was produced, readable by `madar status` and `madar doctor` and usable for comparison and diagnostics. It is no longer replayed to reconstruct generation inputs: a full generation derives its inputs from the repository, not from the stored policy. Pass the options you want explicitly.

## Watcher health

`watcher-state.json` is no longer written, because nothing writes it any more. `madar doctor` and `madar status` still read one if a file left by an earlier version is present beside `graph.madar`, and report it as a diagnostic. A workspace with no such file is normal and healthy.

## Linked worktrees

In a linked worktree, `graph.madar` and its manifests live together in that worktree's isolated external Madar artifact directory under the repository's shared Git data. Run `madar generate .` from the worktree whose semantics you want captured.
