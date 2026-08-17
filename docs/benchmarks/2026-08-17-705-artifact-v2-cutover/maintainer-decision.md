# Maintainer performance decision — #705 default-load exception

**The 2.64×–2.71× default-path load-latency ratio is accepted for #705.**

This is an explicit exception to the 2.00× review threshold. It is not a claim
that the result is optimal.

## Scope of the decision

| Item | Value |
|---|---|
| Issue / PR | #705 artifact v2 cutover |
| **Accepted production-code head** | **`1fcc8d88fec85b30a22d1729be6d7800cad23bb7`** |
| Branch / docs head at decision | `8585a1d08b0e9338f1626210496b4eebcdecf099` |
| Reference input | the pinned corpus in [`README.md`](./README.md) — `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f`, 1596 files / 619 indexed |
| Toolchain | Node v22.22.3, npm 12.0.2, lockfile `0144eb0d…` |

The contract this accepts: canonical `graph.madar` as the default, full fact and
occurrence identity verification, fail-closed workspace-state resolution, and
bounded artifact reading.

## Accepted measurement

| Session | base | #705 | Ratio |
|---|---:|---:|---:|
| 1 (n=9) | 319.11 ms | 863.91 ms | 2.707× |
| 2 (n=11) | 315.49 ms | 833.73 ms | 2.643× |

**Accepted range: 2.64×–2.71×.**

## Supporting controls

| Control | Result |
|---|---:|
| Explicit canonical load, #705 / base | 2.453×–2.469× |
| Explicit canonical load, #705 / B1 | **1.001×–1.009×** |

The #705 loader is not materially slower than B1's on the same
canonical-artifact path. The default-path increase comes from the cutover
itself:

| Arm | Default resolves to | Bytes loaded |
|---|---|---:|
| B1 | `out/graph.json` — the live v1 mirror | 26,069,288 |
| #705 | `out/graph.madar` — canonical | 47,030,652 |

The final default now exercises the artifact and verification contract that #705
exists to make authoritative.

## Other formal gates at this head

| Metric | Result | Verdict |
|---|---:|---|
| Generation wall | 0.979× | pass |
| Peak RSS | 1.115× | pass |
| Canonical artifact | 1.799× | pass |
| Output directory | 1.546× of base | reported / pass |
| B1 transitional output directory | 2.223× (corrected harness) | context |
| #705 vs B1 output directory | 0.697× | context |

The cutover removes the continuously regenerated live v1 mirror, replacing it
with the 81-byte tombstone, and preserves the immutable backup only in upgraded
workspaces.

## Corrected B1 record

| Item | Value |
|---|---|
| **Accepted B1 load** | **2.256×**, within the reproducible 2.25×–2.29× band |
| Initial pre-optimization failure | 5.183× — **not** the accepted B1 reference |

`5.183×` must not be described as B1's accepted result anywhere in #705 records.
Earlier #705 drafts that did so are corrected; see
[`invalidated-attempts.md`](./invalidated-attempts.md).

## Basis for the decision

- two interleaved sessions with opposite starting orders;
- stable ratios across both;
- the B1 canonical control at 1.001×–1.009×;
- generation, RSS and artifact gates passing;
- the correctness requirement to make canonical v2 the default.

This decision is **not** based on the expectation that an idle host would be
faster. A future quiescent measurement may refine the absolute values; it is not
a prerequisite for this PR.

## What this decision does not establish

- that artifact v2 is load-optimal;
- that the ratio is acceptable at every repository size;
- that large-repository scale is proven;
- that stored identities may be trusted without verification;
- that default state classification may be skipped;
- that the unresolved historical base artifact-size discrepancy is explained.

**#706** remains the non-blocking owner of future artifact-load optimization.

## Performance invalidation rule

The accepted production head is fixed. The exception remains valid across
documentation changes, PR-body changes, issue comments, review replies, and tests
that do not affect runtime behaviour.

A full performance rerun is required when later production code touches any of:
artifact selection; default or explicit path intent; workspace-state
classification; `loadGraph`; artifact parsing or hydration; fact or occurrence
verification; metadata bounds; freshness hashing; time-travel loading; federate
loading; HTTP/MCP raw serving; publication or output generation; canonical
serialization.

When a review requires such a change:

1. freeze the new production head;
2. rerun the affected formal performance receipt;
3. require a new explicit decision when default load remains above 2.00×.

This exception must not be carried silently to a different production head.

## Release authorization

None. This decision authorizes no merge, tag, release, npm publication, MCP
Registry publication or dist-tag change.
