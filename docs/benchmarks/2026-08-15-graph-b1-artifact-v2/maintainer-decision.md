# Maintainer decision — accept the B1 load-latency ratio

Companion to the two measurement receipts in this directory. Neither is
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
