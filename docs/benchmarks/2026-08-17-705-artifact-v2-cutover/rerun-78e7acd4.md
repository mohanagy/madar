# Performance rerun at production head `78e7acd4`

The accepted exception was scoped to production head
`1fcc8d88fec85b30a22d1729be6d7800cad23bb7`. Repairing the first protected
matrix changed `src/contracts/graph-artifact-selection.ts`, which is on the
invalidation list, so the head moved and the affected receipt was rerun.

**This rerun does not carry the previous acceptance. It requires a new explicit
maintainer decision.**

## What changed in production code

One change, in the refusal-path display helper: logical paths shown in refusal
messages are now forward-slashed on every platform, so a Windows refusal names
`out/graph.madar` rather than `out\graph.madar` and matches the tombstone text a
reader has to reconcile it with. Nothing else in `src/` changed.

## Artifact equivalence

Regenerating at the same workspace path, before and after:

| Top-level key | Identical |
|---|---|
| `nodes`, `facts`, `occurrences`, `integrity_receipt`, `versions`, `reserved` | yes |
| `generated_at` | no — a timestamp |
| `provenance` | no — carries `graph_build_freshness` and `indexing_completeness` |

Node count 12,669 and fact count 17,940 in both. The graph is unchanged; only
generation timestamps and freshness/completeness provenance differ.

## Default-path load at `78e7acd4`

| Session | base | B1 | #705 | **#705/base** | B1/base | #705/B1 |
|---|---:|---:|---:|---:|---:|---:|
| 1 (n=9) | 334.17 ms | 731.07 ms | 913.09 ms | **2.732×** | 2.188× | 1.249× |
| 2 (n=11) | 340.00 ms | 735.13 ms | 896.06 ms | **2.635×** | 2.162× | 1.219× |

Measured range **2.635×–2.732×**, against the accepted band of 2.64×–2.71×.

## Reading

The range is wider than the accepted band by about 0.02× at each end and centred
in the same place (midpoint 2.68× against 2.68×). The B1 control moved similarly
between the two measurements — 2.109×–2.202× before, 2.162×–2.188× now — on a
host that is not quiescent, which is consistent with environmental drift rather
than a change in the candidate.

The changed code is a display helper for refusal messages. Refusals are the path
where no graph is loaded, so it is not reachable from the measured hot path. That
is an argument, not a measurement, and it is recorded as such: the numbers above
are the measurement.

## Gate

Default load remains above 2.00× at the new head, so under the recorded
invalidation rule this requires a **new explicit maintainer decision**. The prior
acceptance is not carried forward.
