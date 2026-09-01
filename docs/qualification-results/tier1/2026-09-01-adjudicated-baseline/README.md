# Tier 1 baseline under the machine-checkable adjudication contract

The measurement of record. Both arms: **0 pass / 8 fail / 0 invalid**, semantic digest
`251824578ca4cb8daec7aba7435bde3a6d6842fdb6669f5f1b8b6e692c10c886`.

| | |
| --- | --- |
| Madar revision | `72ecb4aa72899c5fa1ba4e2c27795070e74871eb` (`src/**` byte-identical to base) |
| Adjudication contract | `docs/qualification/tier1-adjudication.json`, digest `9f88d294592a355064f92e11238f2ca81841fe04016af09bed7db55c26cc1372` |
| Frozen-input manifest | `36ca51eb5b729bab944db0998e78bb70682da9fa369a8f498c8d614d2e953e23`, identical in both arms |
| Clauses adjudicated | 17 of 17, one typed predicate each |

## Why the totals are not a regression

Two earlier attempts are preserved and classified:
[attempt 1](../2026-09-01-first-baseline/CLASSIFICATION.md)
(`superseded_evaluator_incomplete_evidence_surface`, 2 pass / 6 fail) and the
[provisional corrected attempt](../2026-09-01-corrected-baseline/CLASSIFICATION.md)
(`provisional_untrusted_prose_adjudication`, 0 pass / 8 fail).

None of the three is comparable to another. They used different adjudication procedures, and
the semantic digest now covers the adjudication contract identity so results from different
contracts can never compare equal. The distribution here was not targeted and no expected
distribution was authorised; it is what the frozen contract measures once every prose clause
is decided by a typed predicate.

## What each cell failed on

Six task cells fail on `evidence_obligation_recall` — the frozen `min_critical_fact_recall`
is 1.0 and the packs did not surface the required evidence. One of them,
`impact-hono-drop-router-fallback`, additionally reports **false-ready**: it published
`ready_with_caveat` while all four frozen `affected_set` identities were missing from the
evidence set, the relationship between the construction site and the three router
implementations was absent from all nine relationship edges the artifact does present, and
no typed unresolved record covered any of it.

Both negative probes fail with `missing_required_absence_declaration`. Each frozen probe
requires the artifact to *declare* that the requested behaviour was not found. The product
currently exposes no typed channel that can carry an absence status for a named subject, so
the requirement is unmet. It is reported as **fail**, not `invalid`: the run measured
correctly and the artifact did not provide the required behaviour.

## Run independence

Distinct work directories, and seven of the eight raw Pack artifacts differ between the
arms. The complete set of differing leaves across all eight is timestamps, elapsed times and
`graph_version` — exactly and only where independent execution must differ. Every
evidence-bearing field is identical.

`neg-hono-absent-matcher-persistence` is byte-identical across the arms. That is permitted:
its artifact carries no volatile field at all — no freshness timestamps and no recovery
`elapsed_ms` — so two independent executions have nothing that could differ. Which cell this
happens to be is itself incidental and has varied between runs.

The proof it was re-executed rather than reused is its siblings: `flow-hono-request-dispatch`
and `impact-hono-drop-router-fallback` run against the **same** prepared `hono` target and
**do** differ between the arms, which is only possible if run B cloned, generated and packed
that target again. See each `result.json#/run_independence`.

## What is not claimed

The product does not pass Tier 1. The gate remains inactive
(`tier1.json#/gate/activation.state = pre_baseline`). Per `#/calibration_status` the
thresholds were pre-registered before Madar was ever run against these targets, so eight
failures on first honest execution is a product finding for a maintainer to triage — not a
reason to edit the contract, relax a threshold, or mark a measured failure `not_measured`.
