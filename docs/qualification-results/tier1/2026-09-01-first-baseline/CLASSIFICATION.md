# Attempt 1 — provisional, superseded by an evaluator-contract audit

**Status:** Phase 1 attempt 1 — provisional pending evaluator-contract audit.
**Bytes:** preserved exactly as produced. Nothing in `run-a/` or `run-b/` has been
edited, regenerated, or relabelled.
**Superseded by:** [`../2026-09-01-corrected-baseline/`](../2026-09-01-corrected-baseline/)

This directory holds the first execution of the frozen Tier 1 subset (issue #661,
PR #733) at Madar revision `72ecb4aa72899c5fa1ba4e2c27795070e74871eb`. It reported
**2 pass / 6 fail / 0 invalid**, semantic digest
`82902a3b6ac0bd7fc28eb849f69def9a52ab2482d3fceb647297f4d78216a959`.

A subsequent audit of the evaluator against the frozen contract found four defects in
the **evaluator**, not in the product. The runs themselves were validly prepared and the
retained artifacts are sound — which is why they remain the input to the corrected
measurement rather than being discarded. What changed is what the evaluator was able to
see and willing to conclude.

None of the corrections touch `src/**`, `docs/qualification/**`, or any frozen truth
file. All three remain byte-identical to the PR base.

## Why these verdicts are superseded

### D1 — the evidence set was not closed over the artifact's own channels

`extractEvidence` read about a dozen fields, chosen against an `impact`-shaped artifact.
Madar emits a different shape per task kind, and the selected-node channel differs with
it:

| Task kind | Where selected nodes live | Read by attempt 1 |
| --- | --- | --- |
| `impact` | `pack.direct_dependents[]`, `pack.affected_files[]` | yes |
| `explain` / `arch` / `plan` | `pack.matched_nodes[]`, `pack.relationships[]`, `pack.slice.*` | **no** |
| `review` | `pack.seed_nodes[]`, `pack.review_bundle.nodes[]` | **no** |

Five of the eight cells — `arch-unstorage-driver-seam`, `plan-unstorage-add-driver`,
`review-hono-error-handling` and both negative probes — were therefore scored against an
evidence set that omitted the channel where their evidence actually was. Sixteen retained
artifacts present **270** distinct string channels; attempt 1 classified none of them
explicitly.

The corrected evaluator declares every channel exactly once in
`scripts/lib/qualify-tier1/channels.mjs`, including the ones deliberately treated as
non-evidence and why, and refuses to measure a cell whose artifact presents a channel the
registry does not classify. Closure is now a checked property of a run.

### D2 — symbol recall was reported as zero for a reason that was partly the evaluator's

All six task cells reported 0 symbol recall. Some of that is real: `SmartRouter`,
`RegExpRouter`, `TrieRouter`, `UnsupportedPathError`, `compose`, `Context`, `getPath`,
`createStorage`, `getMount` and `DriverFactory` do not occur **anywhere** in the raw
artifacts for their cells, in any channel, in either run. That is a product finding and
it is preserved as one.

But it was not zero everywhere for product reasons. Reading the omitted channels changes
three cells:

| Cell | Attempt 1 | Corrected |
| --- | --- | --- |
| `arch-unstorage-driver-seam@unstorage` | paths 0/4 | paths 1/4 |
| `plan-unstorage-add-driver@unstorage` | symbols 0/3 | symbols 1/3 |
| `review-hono-error-handling@…` | symbols 0/3 | symbols 2/3 |

Every one of those cells still fails — `min_critical_fact_recall` is 1.0 — but a count
that was wrong is now right, and "zero recall everywhere" was a stronger claim than the
evidence supported.

Three related corrections came out of the same audit and are recorded because each would
otherwise have produced **a false accusation against the product**:

- `workflow_centers[].label` is polymorphic. For community-shaped entries it carries a
  cluster name such as `Users Index Test` or `Drivers Github — Driver`. Admitting those
  as symbols reported four cells as printing fabricated symbols. They are now excluded by
  the entry's own shape.
- `pack.execution_slice.steps[].source_file` carries a bare basename (`router.ts`). Calling
  that a fabricated path was an artefact of resolving it from the target root, not a
  product defect. Basename references are now recorded separately and never accused.
- Symbol grounding is **reported only** for task cells.
  `rubrics.json#/methods/evidence_obligation_recall` mandates exactly one existence check —
  "Every path cited by the artifact must exist in the pinned target" — and says nothing
  about symbols. Gating a task cell on ungrounded symbols would fail a cell the frozen
  contract passes, which is as much an infidelity as relaxing a threshold. The negative
  probes are different: their frozen `required_behaviour` says "No fabricated path **or
  symbol**", so `evaluateProbe` gates on both.

### D3 — both negative probes passed with a frozen requirement unmeasured

Each frozen probe requires **all** of: no ready state; an explicit declaration that the
requested behaviour was not found; no fabricated path or symbol. Attempt 1 measured the
first and part of the third, recorded that the declaration requirement was "not observable
at this tier", and returned `pass` anyway.

The declaration requirement *is* observable. The artifact has an absence surface —
`evidence.answerability.caveats[]`, `pack.answer_contract.uncertainty_notes[]` and
`missing_phases[]` and `do_not_claim[]`, `evidence.answerability.missing_obligations[]`,
`negative_guidance[]`, `missing_context[]`, `missing_semantic[]` and others. It is read,
and neither probe satisfies the requirement:

- `neg-unstorage-absent-encryption`: 32 declaration strings; not one mentions encryption,
  keys, or a backend write path.
- `neg-hono-absent-matcher-persistence`: 48 declaration strings; not one states that no
  on-disk matcher cache exists. `missing_phases: ["controller", "persistence"]` is a
  statement about the pack's own coverage in a generic runtime-pipeline taxonomy, not a
  finding about Hono's routing.

Both are now **fail**, reason `missing_required_absence_declaration`. A frozen requirement
that is not measured now makes a probe `invalid`; it can never make it `pass`.

### D4 — a task cell reported a ready state on missing evidence with false-ready 0

`impact-hono-drop-router-fallback@hono` reported `ready_with_caveat` with path recall 0/4
and symbol recall 0/4, and a reported false-ready count of **0**. Its frozen truth carries
`must_not_report_ready_when: ["the relationship between the constructor in src/hono.ts and
the three router implementations is missing from the evidence set and is not declared as
unresolved"]`. Attempt 1 classified that clause `undetermined` and left the count at zero.

`ready_with_caveat` is a ready state in the product contract, traced rather than assumed:
`isTerminalContextPackPayload` (`src/infrastructure/compare.ts:1685`) returns true for both
`ready` and `ready_with_caveat`; `readinessRank` (`src/runtime/context-pack-recovery.ts:51`)
ranks it above `verify_targets`; the installed consumer directives say both are terminal
("answer from the pack … make no later MCP, Read, Bash, Glob, or Grep call") and that
neither may be expanded. A consumer that receives it proceeds as answer-ready.

The corrected evaluator does not parse that English, and it does not substitute aggregate
recall for it either — unrelated missing evidence would then read as a violation of a clause
it has nothing to do with. What is decidable without interpretation is whether the clause's
own text **literally names** a required item the artifact failed to surface. The impact
clause names `src/hono.ts`, and `src/hono.ts` is in the missing set; with no declaration
reporting it unresolved and a ready state published, the clause is violated. A clause that
names no missing required item stays `undetermined` — recorded, never assumed clean. The
published channel is `evidence.answerability.state`, mirrored at
`governance.directive.answerability`.

A related correction: a declaration must both name the probe's subject **and** assert that
it is absent. Mentioning the subject is not declaring it missing — the declaration channels
include affirmative prose, and a claim such as "supporting evidence for the route matcher
cache" names the subject while asserting the opposite of what the frozen probe requires.

## What is NOT superseded

- Target preparation. Every cited blob verified (`prepared-target-receipt.json`), both
  patches applied cleanly, every pinned SHA matched.
- The retained `pack` and `generate` logs. They are the raw product output and are the
  input the corrected evaluator re-reads.
- The `#660` inherited-signal observation, which reached no attribution and still does not.
- The finding that the packs for these prompts select largely unrelated material — the
  request-dispatch cell targeting `src/helper/route/index.ts`, the driver-seam cell
  targeting `src/drivers/cloudflare-kv-http.ts`. That is the product result this baseline
  exists to record.

## What the corrected totals are

Attempt 1: **2 pass / 6 fail / 0 invalid**.
Corrected: **0 pass / 8 fail / 0 invalid**.

The two "passes" were the negative probes, and both were passing on an unmeasured
requirement. The corrected total is not a regression; it is the first honestly measured
result. Per `tier1.json#/calibration_status`, a failing cell on first execution is a product
finding for a maintainer to triage, not a reason to edit the frozen contract — and per
`#/gate/forbidden_remedies`, not a reason to relax a threshold or mark a measured failure
`not_measured`.
