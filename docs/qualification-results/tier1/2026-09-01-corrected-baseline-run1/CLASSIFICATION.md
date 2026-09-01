# Provisional corrected attempt, first run — superseded

**Status:** `provisional_untrusted_prose_adjudication`
**Result:** 0 pass / 8 fail / 0 invalid, semantic digest
`b11d4c3ecbdc0f4f289099720ac3366f57a14bd7fa0e9e76cc0640a3bdbd2e43`.
**Recovered from:** commit `d53bbd1a6301ba9481f71af54b2856cf978ab91a`.

## Why this directory exists

These bytes were originally written to
[`../2026-09-01-corrected-baseline/`](../2026-09-01-corrected-baseline/). When a review
found further defects in the prose evaluator, that directory was **re-run in place**, which
overwrote them. Its `CLASSIFICATION.md` nevertheless claimed the bytes were "preserved
exactly as produced". That claim was false, and a later independent review caught it by
diffing the directory against `d53bbd1a`.

The bytes were still recoverable from git and are restored here unmodified, so no
measurement in this phase is lost. The sibling directory now holds only the second
provisional run (`0c45822d…`) and says so.

The mistake was overwriting a result directory instead of writing a new sibling. The rule
that was breached — a superseded result is never regenerated in place — is the same rule
this file exists to honour.

## What it measured

The first evaluator correction: the evidence surface closed over all 270 artifact channels,
per-task-kind selected-node channels, and `ready_with_caveat` resolved through the product
readiness contract. It still decided the frozen English requirements by matching negation
words and subject mentions, which is why it is untrusted — see
[`../2026-09-01-corrected-baseline/CLASSIFICATION.md`](../2026-09-01-corrected-baseline/CLASSIFICATION.md).

Not comparable to any other attempt: different adjudication procedure, and the semantic
digest now covers the adjudication contract identity.
