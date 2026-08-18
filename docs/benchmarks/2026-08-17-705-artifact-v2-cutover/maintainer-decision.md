# Maintainer performance decisions — #705 default-load exception

Three decisions, in order. Each is scoped to **one production head** and is
never extended forward. All are retained; none is rewritten. An earlier
decision is superseded by a later production head, which is a statement about
scope — not that the earlier measurement or decision was wrong.

| Decision | Production head | Accepted band | Status |
|---|---|---|---|
| 3 (in force) | **`a8a94a8c396d2283dcae27e806eb707b24f80d54`** | **2.640×–2.678×** | in force |
| 2 | `78e7acd4b3724adcc78fe034d94c33526054ae8a` | 2.635×–2.732× | superseded by production head `a8a94a8c` |
| 1 | `1fcc8d88fec85b30a22d1729be6d7800cad23bb7` | 2.64×–2.71× | superseded by production head `78e7acd4` |

---

# Decision 3 — accepted for production head `a8a94a8c`

**The 2.640×–2.678× default-path load-latency band is accepted for production
head `a8a94a8c396d2283dcae27e806eb707b24f80d54` only.**

An explicit maintainer exception to the 2.00× review threshold, narrowly
scoped. Recorded after three rounds of CodeRabbit remediation moved the
production head three times, each onto the load path, voiding every earlier
acceptance.

| Item | Value |
|---|---|
| **Accepted production head** | **`a8a94a8c396d2283dcae27e806eb707b24f80d54`** |
| Accepted measured band | **2.640×–2.678×** |
| Receipt | [`rerun-a8a94a8c.md`](./rerun-a8a94a8c.md) |
| Scope | the exact pinned corpus and recorded toolchain in that receipt |

## Supporting measurements

| Metric | Result | Verdict |
|---|---:|---|
| Generation wall | 1.007× | pass |
| Peak RSS | 1.219× | pass |
| Canonical v2 artifact vs base v1 artifact | 1.799× | pass |
| Output directory | 1.546× of base | reported |
| **Default-path load** | **2.640×–2.678×** | **accepted exception** |
| Same byte-identical artifact, #705 loader vs B1 loader | 1.009×–1.010× | control |

## Why it is accepted

- The band is stable across multiple production heads and reruns.
- The same-artifact loader comparison shows no material #705 loader regression
  relative to B1.
- Every other formal performance gate passes.
- Canonical v2 is the final authoritative default.
- Restoring the live v1 mirror as the default would reverse the cutover.
- #706 already owns future artifact-load optimization.

## What causes the gap

The larger canonical artifact is a major contributor. Default-path artifact
selection and workspace classification also contribute. The controlled
same-artifact result shows the #705 loader itself is within approximately 1% of
B1 on identical bytes.

This is deliberately not stated as "artifact size alone". An earlier draft of
these receipts made that stronger claim from a comparison of two *different*
artifacts; the controlled measurement replaced it, and the attribution is
correspondingly narrower.

## What this acceptance does not establish

- Load optimization is complete.
- Every repository size has the same acceptable ratio.
- Large-repository scalability is proven.
- Repeated full-artifact parses are acceptable forever.
- Corruption validation may be weakened.
- The unexplained historical base-artifact-size discrepancy is resolved.

## Deferred to #706

The measured remaining parse duplication, which this PR does not address:

| Path | Full JSON parses |
|---|---:|
| Canonical load | 2 |
| Tombstone load | 3 |
| Metadata | 2 |

## Contract this acceptance is bound to

Canonical `graph.madar` default; bounded reads; full v2 structural validation;
fail-closed workspace-state classification; explicit/default intent preserved;
no automatic legacy-backup fallback.

## Invalidation

Any later production change touching artifact selection, default/explicit
intent, workspace-state classification, `loadGraph`, stdio cache selection,
metadata resolution, freshness, artifact parsing or hydration, v2 structural
validation, bounded reading, generation or publication, activation, time
travel, federate, HTTP/MCP artifact serving, or canonical serialization
invalidates this acceptance and requires a rerun and a fresh decision.

Documentation, PR-body, issue-comment and receipt-only changes do not move the
production head and do not invalidate it.

---

# Decision 2 — accepted for production head `78e7acd4` (superseded)

**The 2.635×–2.732× default-path load-latency band is accepted for production
head `78e7acd4b3724adcc78fe034d94c33526054ae8a` only.**

An explicit exception to the 2.00× review threshold, narrowly scoped. It
supersedes decision 1 and is **not** silently extended to any later production
head.

| Item | Value |
|---|---|
| **Accepted production head** | **`78e7acd4b3724adcc78fe034d94c33526054ae8a`** |
| Accepted measured band | **2.635×–2.732×** |
| Observed midpoint | approximately 2.68× |
| Artifact size | 12,669 nodes / 17,940 facts |
| Artifact equivalence vs `1fcc8d88` | semantic content equivalent; only approved generation and provenance timestamps differ |
| Scope | the exact pinned corpus and recorded toolchain in [`README.md`](./README.md) |
| Invalidation | the same thirteen-area production-head rule, retained unchanged |

Measured sessions, and the reasoning behind the band, are in
[`rerun-78e7acd4.md`](./rerun-78e7acd4.md).

The production change that moved the head is a single refusal-path display
helper: user-facing logical artifact paths are slash-normalized on every
platform so they stay consistent with the tombstone text. That normalization is
retained deliberately.

The thirteen-area invalidation rule below applies unchanged to this decision.

---

# Decision 1 — superseded, retained for history

Accepted for production head `1fcc8d88` at a band of 2.64×–2.71×. Superseded by
decision 2 when the head moved. Preserved below exactly as recorded.

**The 2.64×–2.71× default-path load-latency ratio is accepted for #705.**

This was an explicit exception to the 2.00× review threshold. It is not a claim
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
