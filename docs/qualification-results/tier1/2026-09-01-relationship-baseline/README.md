# Tier 1 baseline — adjudication contract v2 (relationship semantics)

The measurement of record. Both arms: **0 pass / 8 fail / 0 invalid**, semantic digest
`d8afb8edd5bf291cf469aa081ac46ec08b2d850d159dae29b42b988a55930960`.

| | |
| --- | --- |
| Madar revision | `72ecb4aa…` — `src/**` byte-identical to base |
| Adjudication contract | `tier1-adjudication.json` v**2**, digest `cc64f9b01db15f80fff402a539e16559eb838acda86d0f0f0f568789598ebfaf` |
| Relationship requirements | 6, all bound to frozen truth entries |
| Relationship channels | 3, each carrying explicit source, target and relation kind |
| Clauses adjudicated | 17 of 17, one typed predicate each |

## What v2 fixed

The v1 relationship predicate decided a relationship from its endpoints alone. It ignored
edge direction and relation kind, treated the impact clause's three routers as any-one, and
looked up a synthetic `from->to` unresolved subject the contract never declared. See
[`../2026-09-01-adjudicated-baseline/CLASSIFICATION.md`](../2026-09-01-adjudicated-baseline/CLASSIFICATION.md).

v2 enforces, per relationship: **endpoint identity** (each edge endpoint resolved to a node
record and compared on path *and* symbol, so a same-named symbol in another file does not
count), **direction** (`forward` only), **relation kind** (an explicit allowlist), and
**group cardinality** (`all_required`). Only a typed record naming the exact relationship id
may declare one unresolved, and only where the frozen clause offers that alternative — the
root-cause clause offers none, so none is accepted.

Adjacency proves nothing. Consecutive execution-slice steps, community path adjacency, and
dependants without an explicit source endpoint are excluded by construction; they remain part
of general evidence recall but cannot establish a relationship.

## Result

| Cell | State | Answerability | Paths | Symbols | Relationships (req/present/missing/uncovered) | false-ready |
| --- | --- | --- | --- | --- | --- | --- |
| `arch-unstorage-driver-seam@unstorage` | fail | verify_targets | 1/4 | 0/4 | 1 / 0 / 1 / 0 | — |
| `flow-hono-request-dispatch@hono` | fail | verify_targets | 0/5 | 0/5 | 1 / 0 / 1 / 0 | — |
| `impact-hono-drop-router-fallback@hono` | fail | ready_with_caveat | 0/4 | 0/4 | **3 / 0 / 3 / 3** | **yes** |
| `neg-hono-absent-matcher-persistence` | fail | verify_targets | — | — | — | — |
| `neg-unstorage-absent-encryption` | fail | verify_targets | — | — | — | — |
| `plan-unstorage-add-driver@unstorage` | fail | verify_targets | 1/4 | 1/3 | — | — |
| `review-hono-error-handling@…` | fail | verify_targets | 2/3 | 2/3 | — | — |
| `rootcause-hono-middleware-rerun@…` | fail | verify_targets | 0/2 | 0/2 | 1 / 0 / 1 / 0 | — |

A relationship is reported missing wherever it is genuinely absent, but a
`must_not_report_ready_when` clause only bites when the artifact is in a ready state. Only
`impact-hono-drop-router-fallback` publishes one (`ready_with_caveat`), so only there does a
missing relationship become uncovered and produce false-ready — all three router edges absent
from every declared relationship channel, none declared unresolved.

Both probes fail with `missing_required_absence_declaration`: the product exposes no typed
channel carrying an absence status for a named subject. That is a **fail**, not `invalid` —
the run measured correctly and the artifact did not provide the required behaviour.

## Run independence

Distinct work directories; all eight raw Pack artifacts differ between the arms. The complete
set of differing leaves is timestamps, elapsed times and `graph_version` — exactly and only
where independent execution must differ.

## Preserved predecessors

| Directory | Result | Status |
| --- | --- | --- |
| `2026-09-01-first-baseline` | 2 pass / 6 fail | `superseded_evaluator_incomplete_evidence_surface` |
| `2026-09-01-corrected-baseline-run1` | 0 pass / 8 fail | `provisional_untrusted_prose_adjudication` (recovered from git) |
| `2026-09-01-corrected-baseline` | 0 pass / 8 fail | `provisional_untrusted_prose_adjudication` |
| `2026-09-01-adjudicated-baseline` | 0 pass / 8 fail | `superseded_relationship_predicate_unfaithful` |

None is comparable to another: the semantic digest covers the adjudication contract identity,
so results from different contracts can never compare equal. The runner now refuses to write
into a non-empty output directory, so a superseded result cannot be regenerated in place.

## What is not claimed

The product does not pass Tier 1. The gate remains inactive. Per
`tier1.json#/calibration_status` the thresholds were pre-registered before Madar was ever run
against these targets, so eight failures is a product finding for a maintainer to triage —
not a reason to edit the contract or relax a threshold. No distribution was targeted.
