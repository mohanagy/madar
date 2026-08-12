# Evidence categories

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655).

Madar's repository already contains several kinds of artifact that look like measurement.
They are not interchangeable. Every published statement must name the category of evidence
it rests on.

## Categories

### E1 — Product outcome evidence

A real agent, on a pinned target, answering a frozen prompt, scored against independent
truth by a blinded reviewer, with a valid receipt.

Only E1 supports a statement about what Madar does for a user.

**Currently held: none.** No artifact in this repository meets E1.

### E2 — Context sufficiency evidence

Deterministic measurement of whether the evidence needed to answer was present in the
context artifact, and whether readiness was correctly refused. No agent runs.

This is what [`tier1.json`](./tier1.json) produces. E2 supports statements about retrieval
and context quality. It **does not** support any statement about answer quality, token
cost, or user outcome.

**Currently held: none executed.** The Tier 1 subset is frozen but has never been run;
see `tier1.json#/calibration_status`.

### E3 — Controlled profile-assisted measurement

A real agent run where the prompt, the grader, or the retrieval path was assisted by
task-specific expectations authored alongside the product.

The June 10 2026 receipts under `docs/benchmarks/suite/results/` are E3: the answering
prompts included proof checklists and the checkout could load expected files and functions
from `docs/benchmarks/suite/runtime-proof.json`. They are genuine measurements of the setup
they describe. They are **not** evidence of untuned behaviour, and they are **not** E1.

### E4 — Synthetic or fixture receipts

Checked-in deterministic bundles with fixture-anchored timings and tool-call counts, such
as `docs/benchmarks/suite/results/2026-05-31T12-00-00/`.

E4 proves the reporting pipeline works. It is never agent-outcome evidence. Identical
counts across trials in an E4 bundle are a property of the fixture, not a finding.

### E5 — Package and parity checks

`npm run verify:pack-parity`, `npm pack --dry-run`, Registry validation, release
verification.

E5 proves that the packed artifact behaves like the checkout and that the release is
well-formed. It says nothing about retrieval quality or agent outcome.

### E6 — Adoption and instrumentation observations

Counts of attributable Madar calls, trace availability, tool permission failures,
environment drift.

E6 explains why a run is invalid. It is reported in its own column. An adoption failure is
**not** a quality loss, and an adoption success is **not** a quality win. The July 15 2026
receipts are largely E6: four of six rows recorded no attributable Madar call at all.

## Required labelling

Every table, README line, or release note derived from this corpus states its category.
The permitted phrasings are:

- E1 — "measured agent outcome"
- E2 — "context sufficiency, no agent"
- E3 — "controlled, profile-assisted"
- E4 — "synthetic fixture receipt"
- E5 — "package parity check"
- E6 — "adoption observation"

## Prohibited combinations

- E2, E3, E4, E5, or E6 must never be described as a product outcome, a win, a loss, or a
  superiority result.
- E3 must never be presented without the word *controlled* and a pointer to what assisted it.
- E4 must never appear in the same table as E1 or E3 without a category column.
- An E6 adoption failure must never be aggregated as a quality loss, and its cost figures
  must never be cited.
- No category may be upgraded by repetition. Running an E4 bundle a hundred times produces
  E4.
