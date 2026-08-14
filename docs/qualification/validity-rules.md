# Run validity and invalidation rules

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655).

A qualification run is either **valid**, **degraded**, or **invalid**. Only a valid run
carries a result. An invalid run is not a loss and not a win — it is a run that did not
happen in a measurable way.

## Invalidation conditions

Any one of these sets `validity.status` to `invalid` and adds the matching reason code
to `validity.invalidation_reasons`:

| Reason code | Condition |
| --- | --- |
| `missing_attributable_madar_call` | The task contract sets `requires_attributable_madar_call` and the transcript shows no attributable Madar call in the Madar arm. |
| `prompt_contract_failure` | The prompt actually delivered to the agent does not hash-match the frozen prompt, or the two arms received different prompts. |
| `answer_contract_failure` | The arm produced no answer, a permission request instead of an answer, or a truncated answer. |
| `target_revision_mismatch` | The checked-out target commit differs from `corpus.json`, or a cited blob digest in the prepared tree does not match the recorded `cited_blobs` entry. |
| `patch_application_failure` | A seeded-defect target's patch did not apply cleanly to the pinned commit, or applied with fuzz. |
| `package_revision_mismatch` | The Madar commit, package version, or tarball digest differs from the pinned identity. |
| `dependency_lock_mismatch` | The dependency lock digest differs from the pinned identity, or the install used `npm install` rather than `npm ci`. |
| `isolation_failure` | `environment.isolation` is false, or the run used a `MADAR_BENCH_CLI_PATH`-style development override. |
| `incomplete_transcript` | The transcript is missing, truncated, or cannot attribute tool calls. |
| `incomplete_receipt` | Any required field in [`receipt-schema.json`](./receipt-schema.json) is absent. |
| `judge_failure` | A deterministic grader errored, or a blinded reviewer could not score the answer. |
| `environment_mismatch` | `environment.drift.detected` is true and the drift was not resolved before the cell ran. |
| `quality_gate_failure` | A gate failed in a way that prevents comparison at all — not a gate the arm simply lost. |
| `truth_unavailable` | The target/task pair has no independent truth — for example a target added to the manifest before its truth file exists, or the unsatisfied sealed-holdout slot. |
| `blinding_unavailable` | A Tier 2 quality dimension was scored without an independent blinded reviewer. |

`degraded` is reserved for runs that are attributable and complete but weaker than the
contract intends — for example a Madar arm whose first attributable call came only after
broad exploration (`adoption.status: "late"`). A degraded run may be inspected and
discussed; it may not be aggregated.

## The `not_measured` rule

1. `validity.aggregatable` **must** be `false` whenever `validity.status` is not `valid`.
   The receipt schema enforces this.
2. Every unmeasured score carries `measured: false`, `value: null`, and a
   `not_measured_reason`. A score of `0` and a score of `not_measured` are different
   things and must never be interchanged.
3. `not_measured` describes a run that could not be measured. A run that **was** measured
   and failed is a failure. Relabelling a failure as `not_measured` is a contract
   violation, not a reporting choice.
4. Invalid rows stay visible. Every published table prints `n_invalid` beside `n_valid`.
   A table that shows only valid rows is not a permitted summary of this corpus.
5. Cost, token, and latency figures from an invalid run may be retained for diagnosis and
   must never be cited as a cost or efficiency result.

## Gate ordering

Correctness and critical-fact completeness are evaluated before any token, latency, or
cost column is populated. A cost improvement on a cell that failed a quality gate is not
reported as an improvement in any form.

## Cost separation

`costs.indexing`, `costs.context_build`, and `costs.agent` are three separate accounts.
They are never summed into a single number, and an unmeasured account is
`measured: false`, never `0`.

## Retention

For every run, whether valid or not, the tier-specific artifacts below are retained
alongside the receipt for at least **24 months**. The execution artifact is
the raw agent transcript (Tier 2) or the context artifact (Tier 1).

- Tier 1 retains the context artifact, exact prompt text, environment receipt, and truth
  file because deterministic evaluation must be reproducible without running an agent. It
  does not require an agent answer, a raw transcript, or an attributable Madar call.
- Tier 2 retains everything Tier 1 retains, plus the raw agent transcript and the answer
  text of both arms, because the agent run and its comparison must be auditable. Where the
  task requires an attributable Madar call, the transcript must establish it.

Each retained artifact is recorded in `retention` with its path and SHA-256. A run whose
artifacts were not retained is `incomplete_receipt`.

## What today's emitter actually produces

This schema is a contract, not a description of `v0.32.1` behaviour. Mapping against
`NativeAgentCompareReport` in `src/infrastructure/compare.ts` at the pinned commit:

| Schema area | Status at `06b373a4` |
| --- | --- |
| `validity.status` | Partially present as `measurement_validity` (`valid` / `degraded` / `invalid`). |
| `validity.invalidation_reasons` | **Not emitted.** Reasons exist only as prose in `benchmark_outcome.evidence`. |
| `validity.aggregatable` | **Not emitted.** |
| `adoption.*` | Partially present as `madar_mcp_call_count` and `trace_status`; there is no `adopted`/`late`/`absent` classification field and no post-first-call broad-exploration counter. |
| `costs.agent` | Present, spread across `reductions`, `prompt_token_source`, and `provider_proof`. |
| `costs.indexing`, `costs.context_build` | **Not emitted.** There is no separate indexing or context-build cost account anywhere in the report. |
| `scores.*` | **Not emitted** in this shape. `answer_quality` carries term-presence checks and a human-review status only. |
| `identity.*` | Partially present via `environment`, `exec_command`, and the isolation launcher; there is no single identity block and no dependency-lock digest. |
| `retention.*` | Paths are emitted in `paths`; digests and a retention policy are **not**. |

Closing that gap is emitter work and is deliberately out of scope for #655, which must not
modify production or reporting logic. It is a separate linked issue.
