# Evidence categories

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655).

Madar's repository already contains several kinds of artifact that look like measurement.
They are not interchangeable. Every published statement must name the category of evidence
it rests on.

## Target naturalness qualifies the evidence

An evidence class says how a measurement was produced. It does not say what the measurement
was produced against, and both matter.

- **Natural target** — a real, externally authored project pinned at an immutable commit,
  optionally with a recorded seeded-defect patch. Every target in
  [`corpus.json`](./corpus.json) is natural.
- **Proxy target** — a workspace authored inside this repository to stand in for one.

A result measured against a proxy can support a regression statement and nothing more. It
can never support a statement about behaviour on real repositories, because a proxy is
shaped by the same hands as the production rules it is meant to test.

Recorded finding, 2026-08-12, measured against
[`docs/benchmarks/suite/repos.json`](../benchmarks/suite/repos.json) at
`06b373a447acfce895412ac10eb4e5228c5df0b7`: of eleven rows, **five are in-repo proxies**
keyed by `path` — `ts-small` (`examples/sample-workspace`), `nestjs-mid` and
`ts-monorepo-large` (both `tests/fixtures/pack-quality/**/workspace`), `python-service` and
`go-service` (both fixture directories under the suite). The other **six are git-backed and
do pin a URL together with an immutable commit SHA** — `documenso`, `formbricks`, `dub`,
`twenty`, `cal-diy`, `novu`.

So the existing corpus is mixed, not entirely proxy-based. What matters for evidence
labelling is that the five proxy rows are the ones backing the checked-in deterministic
fixture bundles, and any citation of those receipts must be labelled proxy-target as well
as E4.

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

Open enforcement gap in E3, recorded 2026-08-12 and not addressed here:
`docs/benchmarks/suite/runtime-proof.json` carries per-repository expected symbols and
paths — for example `sendDocument()` and `server-only/document/send-document.ts` under
`documenso-explain-runtime`. `docs/benchmarks/suite/methodology.md` asserts that this file
is grader input only, that it "is not passed into retrieval", and that its obligation
checklist "is not written into the answering agent's prompt". That isolation is asserted in
prose. No test, lint rule, or CI check enforces it, and nothing fails if a future change
reads the manifest from retrieval or splices its obligations into a prompt. Until an
enforcement check exists, every E3 citation must state that the retrieval/grader boundary
is documented rather than proven. This is a separate linked issue and bears directly on
[#660](https://github.com/mohanagy/madar/issues/660).

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
