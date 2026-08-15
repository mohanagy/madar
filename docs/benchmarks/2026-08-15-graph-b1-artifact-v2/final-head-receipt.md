# Graph PR B1 — final-head performance receipt

Third measurement, taken because production hot paths changed after the
accepted receipt. Neither earlier receipt is modified.

- Initial failed gate: [`README.md`](./README.md)
- Post-remediation gate: [`post-verification-optimization.md`](./post-verification-optimization.md)
- Maintainer acceptance: [`maintainer-decision.md`](./maintainer-decision.md)

## Why this rerun was required

| Commit | Change inside the invalidating set |
|---|---|
| `5bbdb5ae` | restored `SemanticFactId` iteration order; loader root-path behaviour |
| `b351b416` | v2 node payload now carries `community` |

The acceptance recorded for `b2adeec6` does not carry to a different head, so
the frozen harness `7e8f51ca…` was rerun from scratch against six new pinned
input worktrees, order `a1 → b1 → b2 → a2 → a3 → b3`.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Candidate binary | `b351b41600906c3c248e1c30dcac96c57baaeae5` |
| Harness / resolver SHA-256 | `7e8f51ca…` / `bb54880a…` (unchanged) |
| Node / npm | v22.22.3 / 12.0.2 |

## Raw runs

| Run | Arm | Wall (s) | Peak RSS (MB) | graph.madar (MB) | v1 mirror (MB) | Output dir (MB) |
|---|---|---:|---:|---:|---:|---:|
| a1 | base | 28.49 | 966.3 | — | 20.78 | 33 |
| b1 | candidate | 27.01 | 1150.7 | 39.55 | 20.85 | 72 |
| b2 | candidate | 26.57 | 1093.3 | 39.55 | 20.85 | 72 |
| a2 | base | 27.58 | 985.7 | — | 20.78 | 33 |
| a3 | base | 27.20 | 966.1 | — | 20.78 | 33 |
| b3 | candidate | 26.56 | 1233.1 | 39.55 | 20.85 | 72 |

## Gate

| Metric | Base median | Candidate median | Ratio | At `b2adeec6` | Verdict |
|---|---:|---:|---:|---:|---|
| Generation wall (s) | 27.58 | 26.57 | 0.963× | 0.965× | pass |
| Peak RSS (MB) | 966.30 | 1150.70 | 1.191× | 1.191× | pass |
| Load latency (ms) | 321.36 | 705.94 | 2.197× | 2.196× | accepted exception |
| **Canonical artifact (MB)** | **20.78** | **39.55** | **1.903×** | 1.894× | **pass, near threshold** |

Transitional total output: 33 → 72 MB, 2.182×, disclosed separately.

## The artifact crossed into the near-threshold band

`b351b416` adds a `community` integer to every node payload, so the canonical
artifact grew from 39.35 MB to 39.55 MB and the ratio moved from 1.894× to
**1.903×**. That crosses the ≥1.90× line the gate defines as near-threshold.

It remains under 2.00× and passes, but it should not be reported as simply
"unchanged and passing". The field is not optional: without it a v2 load
returned community-less nodes and retrieval scored them differently, which is
the defect this commit fixes. 0.20 MB buys back correct retrieval.

Anything that adds further per-node fields should expect to be measured against
this number rather than the earlier 1.894×.

## Load latency is unchanged

2.197× against the accepted 2.196× — within run-to-run noise. The accepted
exception recorded in `maintainer-decision.md` therefore still describes this
head, and no new decision is required for it.

## Semantic stability

Identical within each arm across all three runs. Base 12,562 nodes / 17,835
links / 5,615 communities. Candidate 12,562 nodes / 17,940 facts / 17,964
occurrences / 0 unresolved admissions / matrix sum 17,940.

## Attribution controls

All six runs passed: no base run produced a `graph.madar`, every counted file's
mtime fell inside its run window, all six output scopes were distinct, every run
reported `reason=no-cache`, and input worktrees stayed source-clean.
