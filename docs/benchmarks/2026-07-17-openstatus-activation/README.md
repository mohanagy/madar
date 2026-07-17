# 2026-07-17 — OpenStatus activation acceptance

This folder records a packed-artifact acceptance run against [`openstatusHQ/openstatus`](https://github.com/openstatusHQ/openstatus) for issues [#564](https://github.com/mohanagy/madar/issues/564) and [#565](https://github.com/mohanagy/madar/issues/565).

The run used the exact cross-layer question that previously made an agent call Madar repeatedly and then fall back to broad repository discovery. It exercised `madar serve --stdio --auto-refresh` from an unchanged detached OpenStatus worktree and sent the first `context_pack` request immediately after MCP initialization.

## Result

- MCP initialization: **586 ms**
- First graph-backed response: **3,893 ms**
- Agent-visible Madar requests: **1**
- Raw repository fallback operations: **0**
- Startup rebuild: **no**
- Serialized response: **1,666 / 1,800 tokens**
- Evidence: **high / strong / complete / ready**
- Agent directive: **`answer_from_pack`**
- Broad-search fallback: **`not_needed`**
- Selected-file precision: **7/7 relevant unique files (100%)**
- Unrelated UI files: **0**

The selected evidence covers the Go checker, workflow incident/notification handling, incident schema, tRPC status computation, and the divergent Connect-RPC status computation. The receipt contains only upstream-relative paths and aggregate graph metadata; it does not contain the external checkout path or source bodies.

## Artifact and repository

- Madar artifact: local `npm pack` of `@lubab/madar@0.31.3`
- Tarball SHA-256: `ea71918c1e74fd7b73609f3054d2f90619f117d9d41bbb57cc167bfca525a645`
- OpenStatus commit: `295e5a72f52c172d326aa950e81043e72a4f20c0`
- OpenStatus worktree state: clean
- Graph: 10,496 nodes, 21,437 edges, 24,446,369 bytes
- Indexing: 2,443 indexed, 0 failed, 73 policy-skipped, 85 unsupported

## Exact prompt

> Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status in this repository. Cite the exact files and symbols involved, identify any inconsistent status-computation paths, and clearly state any remaining uncertainty. This is read-only; do not change files.

## Interpretation boundary

This is implementation acceptance for retrieval and startup behavior, not a release or universal benchmark claim. The issue requires three consecutive Claude trials, three consecutive Codex trials, and human semantic comparison with the direct-search answer before a release claim. Those model trials remain pending and are recorded as such in the JSON receipt.
