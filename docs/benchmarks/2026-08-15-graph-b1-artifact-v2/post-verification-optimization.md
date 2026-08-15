# Graph PR B1 — post-remediation performance receipt

Re-measurement after removing redundant verification work. Companion to the
initial failed gate in [`README.md`](./README.md), which remains unmodified.

**Verdict: three of four formal gates pass. Load latency remains at 2.192× and
requires a human decision.**

## What changed between receipts

| Commit | Change |
|---|---|
| `3aa9b996` | one-pass receipt validation; verify-once/hydrate-once; canonical comparator fast path; deferred duplicate-payload serialization |
| `b2adeec6` | memoized the deterministic endpoint-pair ordering |

No identity verification was weakened. Every fact and every occurrence still
derives its canonical payload and must reproduce the stored id, in the default
path. There is no flag that skips it.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Candidate binary | `b2adeec669f09c697d477a8401a42fb03e030dfe` |
| Pinned input (six fresh roots) | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Harness SHA-256 | `7e8f51cad68183674698b747aa971a0a859b79005eadccb4d1bcafcf5284fdc4` (unchanged) |
| Resolver SHA-256 | `bb54880aa80184903d3bc0b8e186eac80bdcb70a5ce4fc8a6f37d9c7096d0cff` (unchanged) |
| Node / npm | v22.22.3 / 12.0.2 |
| Run order | `a1 → b1 → b2 → a2 → a3 → b3` |

Same harness as the initial receipt, so the two are directly comparable.

## Raw runs

| Run | Arm | Wall (s) | Peak RSS (MB) | graph.madar (MB) | v1 mirror (MB) | Output dir (MB) |
|---|---|---:|---:|---:|---:|---:|
| a1 | base | 28.18 | 956.6 | — | 20.78 | 33 |
| b1 | candidate | 27.27 | 1149.5 | 39.35 | 20.85 | 72 |
| b2 | candidate | 28.67 | 1082.2 | 39.35 | 20.85 | 72 |
| a2 | base | 28.80 | 950.0 | — | 20.78 | 33 |
| a3 | base | 29.60 | 930.3 | — | 20.78 | 33 |
| b3 | candidate | 28.66 | 1102.1 | 39.35 | 20.85 | 72 |

## Gate

| Metric | Base median | Candidate median | Ratio | Initial | Verdict |
|---|---:|---:|---:|---:|---|
| Generation wall (s) | 28.80 | 28.66 | **0.995×** | 2.133× | pass |
| Peak RSS (MB) | 950.00 | 1102.10 | 1.160× | 1.024× | pass |
| Load latency (ms) | 308.19 | 675.69 | **2.192×** | 5.183× | **human decision** |
| Canonical artifact (MB) | 20.78 | 39.35 | 1.894× | 1.894× | pass |

Within-arm candidate variability: wall 4.9%, RSS 6.1%, load 12.3%, artifact 0.0%.

Generation is now at parity with the base while retaining 105 more
relationships, because the dominant cost was never the multigraph — it was a
sort being recomputed 5,609 times.

## Disclosure — transitional total footprint

| Metric | Base | Candidate | Ratio |
|---|---:|---:|---:|
| Total output directory (MB) | 33 | 72 | 2.182× |

Not a formal gate. B1 writes both `graph.madar` and a temporary v1 mirror;
#705 removes the mirror and must re-measure.

## Why load is still above 2×

Final profile of an 853 ms sampled load, with no dominant hotspot remaining:

| Cost | % |
|---|---:|
| Garbage collector | 15.8 |
| `parseGraphArtifactV2` | 11.0 |
| `compareUnicodeCodePoints` | 8.8 |
| `normalizeCanonicalJson` | 7.4 |
| UTF-8 `decode` | 6.8 |
| `serializeNormalizedCanonicalJson` | 3.8 |
| `validateEndpoint` | 3.7 |
| `loadGraphArtifactV2` | 3.7 |
| `indexVerifiedFact` | 2.8 |

What is left divides into two inherent costs:

1. **The artifact is 1.894× larger**, so decode and parse move proportionally
   more bytes. Those two alone are ~18% of load.
2. **36k canonical derivations that v1 never performed** — one per fact and one
   per occurrence — are the remaining canonical-JSON time (~20%).

Load cost per byte is therefore *better* than v1: a 2.192× load over a 1.894×
artifact is 1.157× per byte, and that includes verification work v1 did not do
at all. The absolute gap is 368 ms.

Every redundancy identified across four profiling rounds has been removed.
Reducing this further needs either a smaller wire format or skipping
verification, and skipping verification is excluded by the maintainer decision.

## Semantic stability

Identical within each arm across all three runs.

| Arm | Nodes | Relationships | Occurrences | Unresolved admissions | Matrix sum | Communities |
|---|---:|---:|---:|---:|---:|---:|
| base | 12562 | 17835 links | — | — | — | 5615 |
| candidate | 12562 | 17940 facts | 17964 | 0 | 17940 | 5609 |

## Attribution controls

All six runs passed: no base run produced a `graph.madar`, every counted file's
mtime fell inside its run window, all six output scopes were distinct, every
run reported `reason=no-cache`, and input worktrees stayed source-clean.
