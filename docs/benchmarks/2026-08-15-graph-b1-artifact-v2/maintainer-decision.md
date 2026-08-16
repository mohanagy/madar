# Maintainer decision — accept the B1 load-latency ratio

> **Superseded for the final head.** The decision below applied to `b2adeec6`
> and was carried to `61f3609c`. It does **not** apply to the production code
> head this PR ships. See
> [Superseding decision for `c4f65972`](#superseding-decision-for-c4f65972) at
> the end of this file. The earlier text is kept verbatim as record.

Companion to the measurement receipts in this directory. Neither is
modified by this decision; the raw numbers stand as recorded.

- Initial failed gate: [`README.md`](./README.md)
- Post-remediation gate: [`post-verification-optimization.md`](./post-verification-optimization.md)

## Decision

**The 2.192× process-isolated load-latency ratio is accepted for PR B1.**

This is an explicitly reviewed exception to the 2× target. It is not a finding
that the regression is invisible, negligible, or ideal.

| | Value |
|---|---:|
| Base median | 308.19 ms |
| Candidate median | 675.69 ms |
| Absolute difference | 367.50 ms |
| Ratio | 2.192× |
| Accepted candidate | `b2adeec669f09c697d477a8401a42fb03e030dfe` |

## Why the exception is accepted

Every other formal gate passes, and the residual cost is attributable to work
the base never performed rather than to a redundant loop:

| Property | Value |
|---|---|
| Generation wall | 0.995× — at parity |
| Peak RSS | 1.160× |
| Canonical artifact size | 1.894× |
| Load per artifact byte | ~1.157× |
| Fact IDs verified | exactly once each |
| Occurrence IDs verified | exactly once each |
| Receipt validation | exactly one pass |
| Blind stored-ID trust | absent |
| Semantic counts | stable across all accepted runs |
| Attribution | six fresh input worktrees, resolver-derived paths |

The candidate loads 12,562 nodes, 17,940 semantic facts and 17,964 evidence
occurrences, verifying content-addressed identity for every fact and every
occurrence. v1 verified none of it.

Four profiling rounds found and removed every redundancy: duplicate receipt
accumulation, duplicate fact and occurrence identity derivation, eager
duplicate-payload serialization, canonical-comparator allocation, and a
deterministic sort recomputed once per community during generation. The load
profile is now flat, with no dominant hotspot.

## Scope of the exception

The acceptance is limited to:

- PR B1;
- the frozen reference corpus at `ee2115a2`;
- the recorded host and toolchain (Node v22.22.3, npm 12.0.2);
- the current artifact-v2 identity-verification contract.

It explicitly does **not** establish that:

- 2.192× is acceptable for every repository;
- load performance is solved;
- the artifact format is optimally compact;
- the transitional total footprint is release-ready;
- large-repository scalability is proven.

## Integrity constraints that remain binding

The following may not be added: `trustStoredIds`, `skipIdentityVerification`,
`verifyIds: false`, sampled verification, qualification-only verification, or
totals-only receipt validation.

The following may not be removed: fact and occurrence hash/payload
verification, duplicate-ID payload checks, receipt matrix checks, reason
checks, admission-summary checks, or endpoint qualification checks.

No future optimization may buy latency with any of them.

## Follow-up

Artifact-load latency is owned by #706, a non-blocking issue covering
compaction, lazy hydration, layout and load reuse. It does not block B1 review,
B1 merge, #705, #658 or #659, but it must be resolved or explicitly bounded
before any broad scale or load-performance claim.

## Remeasurement requirement

This acceptance does not travel across relevant code changes. A production
change touching artifact parsing or loading, identity verification, receipt
validation, graph hydration, generation hot paths, serialization, workspace
output resolution, or endpoint-pair enumeration invalidates the receipt and
requires a new candidate SHA, a complete fresh six-run A/B sequence, a new
receipt, and a new decision if any ratio exceeds 2×.

## Remeasurement at the final head

`61f3609c` changed `graph-artifact.ts` (v2 load now restores graph-level
provenance) and `relation-discriminator.ts` (three consumed relations
registered). Both sit inside the invalidating set above, so the harness was
re-run from scratch rather than carrying the acceptance across them.

Same frozen harness `7e8f51ca…`, six new input worktrees, order
`a1 → b1 → b2 → a2 → a3 → b3`.

| Metric | Base median | Candidate median | Ratio | At `b2adeec6` |
|---|---:|---:|---:|---:|
| Generation wall (s) | 27.75 | 26.77 | 0.965× | 0.995× |
| Peak RSS (MB) | 961.20 | 1144.90 | 1.191× | 1.160× |
| Load latency (ms) | 306.01 | 672.03 | **2.196×** | 2.192× |
| Canonical artifact (MB) | 20.78 | 39.35 | 1.894× | 1.894× |
| Transitional total output (MB) | 33 | 72 | 2.182× | 2.182× |

Load moved from 2.192× to 2.196× — within run-to-run noise, no material
change. Semantic counts identical within each arm, attribution controls
passed, no base run produced a `graph.madar`.

**The acceptance recorded above stands at `61f3609c`.**

---

## Superseding decision for `c4f65972`

The remediation batch changed semantic identity, graph construction, artifact
loading, metadata loading, publication and snapshots -- all inside the
invalidating set above -- so the acceptance recorded earlier in this file does
not travel to this head. The experiment was re-run from scratch and a new
decision taken.

### Heads

| Role | SHA |
|---|---|
| Base | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Head the exception was accepted at | `c4f65972a19ae272e37d9e9dcfd3e93bfb32d619` |
| **Current production code head** | **`677ba81d498c1d23dd74285e2515917df4448cc8`** |
| Branch/documentation head | recorded in the PR body; documentation-only commits follow the code head and do not re-open this decision |

The production code head and the branch head are deliberately separate. Only
the former is what this decision accepts.

### Accepted measurement

Two independent sessions, interleaved, behind the quiescence gate:

| Session | Base median | Candidate median | Ratio |
|---|---:|---:|---:|
| 1 (n=9) | 298.98 ms | 673.92 ms | 2.254× |
| 2 (n=11) | 296.99 ms | 679.46 ms | 2.288× |

**Accepted range: 2.25×–2.29×.** The sessions agree to within about 1.5%, so
the exception is reproducible rather than a single unlucky sample. A range is
recorded instead of one decimal because the instrument does not support more
precision than that.

Absolute candidate medians: **673.92 ms** and **679.46 ms**.

The other formal ratios at this head pass: generation 0.980×, peak RSS 1.250×,
canonical artifact 1.899×, transitional total output 2.212× (disclosure).

### The remediation did not cause this

Both binaries were pointed at the same 41,545,432-byte artifact and interleaved:

| Binary | Median |
|---|---:|
| `8bd76f39` pre-remediation | 682.74 ms |
| `c4f65972` final | 678.18 ms |
| **final / pre-remediation** | **0.993×** |

The batch is flat on load. The residual cost is the standing B1 cost of parsing
a larger canonical artifact, verifying every semantic fact identity, verifying
every evidence occurrence identity, and preserving the exact receipt and
collision invariants.

### Scope

Accepted **only** for: PR B1 / #707, production code head `c4f65972`, the frozen
reference corpus, the recorded Node/npm/lockfile environment, the current
artifact-v2 identity-verification contract, and the recorded process-isolated
load protocol.

It establishes none of the following: that artifact v2 is load-optimal; that
the ratio holds at any other repository size; that large-repository scalability
is proven; that identity verification may be skipped; that stored ids may be
trusted blindly; or that the transitional dual-artifact footprint is
release-ready.

### Constraints that remain binding

Identity and receipt verification stay **mandatory**. Every fact and every
occurrence derives its canonical payload on load and must reproduce its stored
id exactly, in the default path. There is no sampling, no `trustStoredIds`, and
no qualification-only mode. The receipt matrix remains an exact partition.

**#705 remains required** before #657 can complete and before any prerelease.
The transitional dual-artifact state is permitted on `next` only.

**#706** remains the non-blocking owner of load optimization.

### Re-measurement rule at this head

Documentation, PR-body text, issue comments, review replies, and tests that do
not change runtime behaviour do **not** invalidate this decision.

A new full six-run experiment **is** required before declaring the PR ready if a
later production change touches semantic identity, graph construction or
hydration, artifact parsing or loading, receipt validation, canonical
serialization, metadata loading, publication, generation hot paths, or
endpoint-pair caching. If a review finding forces such a change, the rule
applies before any ready claim.

### Carried to `677ba81d`

The CodeRabbit re-review required production fixes to metadata loading, which
is inside the invalidating set above, so the experiment was re-run rather than
this acceptance being assumed to carry. See
[`review-fix-head-receipt.md`](./review-fix-head-receipt.md).

| Metric | Ratio at `677ba81d` | Ratio at `c4f65972` |
|---|---:|---:|
| Generation wall | 0.988× | 0.980× |
| Peak RSS | 1.350× | 1.250× |
| Canonical artifact | 1.899× | 1.899× |
| **Load latency** | **2.256×** | 2.25×–2.29× |
| Transitional output | 2.212× | 2.212× |

**Load measures 2.256×, inside the accepted range, so the exception describes
this head.** It carries because the measurement falls within what was accepted,
not because acceptance was treated as travelling with the branch.

Peak RSS moved from 1.250× to 1.350×. It passes either way and is not caused by
the review fixes -- witness scoping, the only plausible mechanism, landed before
`c4f65972`, and the delta between the two heads is one string field and a cache
key. This run's candidate arm spread is 1.6% against 12.5% previously, so
1.350× is the better-supported figure. RSS is approximate throughout these
receipts; the validator gates wall time only.
