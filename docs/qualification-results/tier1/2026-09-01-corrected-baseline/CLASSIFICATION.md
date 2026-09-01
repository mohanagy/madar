# Provisional corrected attempt — superseded

**Status:** `provisional_untrusted_prose_adjudication`
**Result:** 0 pass / 8 fail / 0 invalid, semantic digest
`0c45822d53a8dd9e94fc1e5d75b1d631d32ec3bda3f86d05b60d897ce1ee6051`.

**Bytes — read this before citing them.** This directory holds the **second** run of the
provisional corrected evaluator. An earlier run (`b11d4c3e…`) was written here first and
was then **overwritten in place** when the evaluator was corrected again, rather than being
written to a new sibling directory. An earlier version of this file claimed the bytes were
"preserved exactly as produced"; that was wrong, and an independent review caught it by
diffing this directory against commit `d53bbd1a`.

The overwritten bytes were recoverable from git and are restored, unmodified, at
[`../2026-09-01-corrected-baseline-run1/`](../2026-09-01-corrected-baseline-run1/). No
measurement was lost, but the preservation claim was false while it stood.
**Superseded by:** [`../2026-09-01-adjudicated-baseline/`](../2026-09-01-adjudicated-baseline/)

## What this attempt fixed, and kept

It corrected four real evaluator defects in [attempt 1](../2026-09-01-first-baseline/CLASSIFICATION.md):
the evidence surface was not closed over the artifact's own channels, symbol recall was
partly an evaluator artefact, both negative probes passed on an unmeasured requirement, and a
task cell reported `ready_with_caveat` on 0/4 evidence with a false-ready count of zero.

Those corrections are **not** what makes this attempt untrusted. They are retained in the
adjudicated evaluator: the 270-channel registry with its closure guard, per-task-kind
selected-node channels, symbol extraction across every approved channel, `ready_with_caveat`
resolved through the product readiness contract rather than its name, and independent arms.

## Why it is superseded

It decided the frozen prose requirements by **reading sentences**. Two independent review
rounds showed that is not decidable in either direction:

- `assertsAbsence` matched a negation marker anywhere in a string, so
  *"There is no doubt that an on-disk matcher cache exists"* satisfied the frozen requirement
  to declare that no such cache exists — while asserting the opposite.
- `declaredUnresolved` matched any mention of a missing item, and the declaration channels
  included affirmative `claims[].text`, so *"supporting evidence for src/hono.ts"* suppressed
  a false-ready condition — while asserting the file was present.

Both heuristics have been removed, not disabled. Absence and unresolved state are now decided
only by typed artifact channels whose schema carries a status field and a subject field,
declared per clause in [`docs/qualification/tier1-adjudication.json`](../../../qualification/tier1-adjudication.json)
and bound to each frozen sentence by the SHA-256 of its exact bytes.

## Comparability

This attempt's totals happen to match the adjudicated baseline's — 0 pass / 8 fail — but the
two are **not comparable** and neither confirms the other. They were produced by different
adjudication procedures. The semantic digest now covers the adjudication contract identity
precisely so that a result from a prose evaluator can never compare equal to an adjudicated
one.
