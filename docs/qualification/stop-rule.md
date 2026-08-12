# Stop, rollback, and publication rule

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655).

This rule exists to be objective enough to block a pull request or a release without a
judgement call. Each condition is written so that a reviewer can answer yes or no from the
receipts alone.

## S1 — Stop conditions (a change must not ship)

A roadmap change **must not merge**, and must be rolled back or disabled if already
merged, when any of the following holds against the frozen corpus.

| Id | Condition | Objective test |
| --- | --- | --- |
| S1.1 | Critical-fact completeness regresses beyond the pre-registered margin | For any task, the post-change critical-fact completeness is lower than the pre-change value by more than the non-inferiority margin **0.05**, on `n_valid >= 5` paired trials in the same cell. |
| S1.2 | Unsupported claims increase materially | For any task, the post-change mean unsupported-claim count exceeds the pre-change mean by **more than 0.5 claims per answer**, or any single answer introduces an unsupported claim listed in that task's `unsupported_claim_traps` that the pre-change arm did not make. |
| S1.3 | False-ready behaviour appears | Any negative-trust probe in [`tier1.json`](./tier1.json) reports a ready state, or any evidence set contains a path or symbol that does not exist in the pinned target. This is a **single-occurrence** trip: one instance blocks. |
| S1.4 | Host adoption falls below the phase target | Across the Tier 2 sweep, fewer than the phase target of Madar-arm runs have `adoption.status` of `adopted`. Phase 0 target: **not set** — adoption is measured and reported, and a *decrease* of more than 10 percentage points against the previous recorded sweep blocks. |
| S1.5 | Graph or artifact integrity fails | Any graph-integrity invariant from #656–#659 fails, or an artifact fails its round-trip or old-reader-rejection check. Single-occurrence trip. |
| S1.6 | Results depend on qualification-repository literals | Any qualification fixture path, symbol, prompt string, repository id, or a near-equivalent special case appears in production retrieval, ranking, context, or claim logic. Single-occurrence trip; checked deterministically by `npm run qualify:validate`. |
| S1.7 | Output differences remain unexplained | A retrieval, pack, graph, or artifact output differs from the pre-change baseline and the pull request does not explain the difference. Updating a snapshot is not an explanation. |
| S1.8 | Cost improves only by reducing outcome quality | A token, latency, or cost improvement is reported for a cell whose correctness or critical-fact completeness is not non-inferior under S1.1. |

## S2 — Rollback

When a stop condition is discovered after merge:

1. Disable the change at the narrowest available seam — feature flag, default flip, or
   revert of the specific commit — the same day it is confirmed.
2. Do not fix forward on the protected branch while a stop condition is tripped.
3. File the finding as a linked issue with the receipt paths that prove it.
4. Re-run the affected Tier 1 subset after the rollback and attach the receipt showing the
   condition cleared.
5. If the change already shipped to npm, the release notes are amended and the affected
   claim is withdrawn before anything else ships.

## S3 — Publication

A claim derived from this corpus may be published only when **all** of the following hold.
Any single failure means the claim is not published in any weakened form either.

1. Every cell backing the claim has `validity.status: "valid"` and `aggregatable: true`.
2. `n_invalid` is published beside `n_valid` for every row.
3. Correctness and critical-fact completeness passed **before** any cost or latency figure
   is shown.
4. Tier 2 scores were produced by a blinded reviewer who did not author the change.
5. The sealed holdout is satisfied, or the report makes no generalization claim and carries
   the line `sealed holdout unsatisfied; results measure regression only`.
6. The claim is narrower than or equal to the evidence: per-target and per-task, never a
   blended headline.
7. The evidence class is labelled per [`evidence-categories.md`](./evidence-categories.md).

## S4 — What may never be used to clear a stop condition

- Editing a truth file, a rubric threshold, or a prompt after seeing a result.
- Adding a qualification path, symbol, prompt, or repository name to production logic.
- Re-running a failing cell until it passes and reporting the passing run.
- Marking a measured failure as `not_measured`.
- Substituting a different task, target, or prompt for the one that failed.
- Narrowing the corpus so the failing cell is no longer in it.

Changing the frozen contract is possible, but only by bumping `contract_version`, stating
what changed and why in the pull request, and re-baselining every affected cell. A contract
change never retroactively clears a recorded stop condition.
