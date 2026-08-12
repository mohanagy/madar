# Qualification contract

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655)
against Madar commit `06b373a447acfce895412ac10eb4e5228c5df0b7` (`v0.32.1`).

This directory is the independent evaluation contract used to decide whether a roadmap
change is safe to ship. It is deliberately separate from
[`docs/benchmarks/suite/`](../benchmarks/suite/), which is the product benchmark suite and
whose per-repo expectations were authored alongside the product.

## What this contract is for

Grading Madar with expectations that Madar produced tells you nothing. This contract fixes
five things before any change is evaluated:

1. what is being evaluated (`corpus.json`, `tasks.json`);
2. what a correct answer is, authored without looking at Madar output (`truth/`);
3. how it is scored, and by which method per category (`rubrics.json`);
4. when a run does not count at all (`validity-rules.md`, `receipt-schema.json`);
5. what result blocks a merge or forces a rollback (`stop-rule.md`).

## Files

| File | Deliverable |
| --- | --- |
| [`corpus.json`](./corpus.json) | Versioned corpus manifest: targets, revisions, dependency locks, holdout class. |
| [`tasks.json`](./tasks.json) | Versioned task definitions: frozen prompts with hashes, categories, scoring method, truth provenance. |
| [`truth/`](./truth/) | Independent truth and rubric input, one file per task. |
| [`rubrics.json`](./rubrics.json) | Scoring dimensions, per-category scoring methods, blinding rules, aggregation rules. |
| [`receipt-schema.json`](./receipt-schema.json) | Environment and run receipt schema. |
| [`examples/`](./examples/) | Two illustrative receipts: a valid Tier 1 run and an invalid Tier 2 run that stays `not_measured`. |
| [`validity-rules.md`](./validity-rules.md) | Valid/invalid criteria, the `not_measured` rule, retention, and what today's emitter actually produces. |
| [`holdout-policy.md`](./holdout-policy.md) | Hidden holdout handling — and why the sealed slot is currently unsatisfied. |
| [`stop-rule.md`](./stop-rule.md) | Objective stop, rollback, and publication rule. |
| [`evidence-categories.md`](./evidence-categories.md) | Evidence classes E1–E6 and required labelling. |
| [`tier1.json`](./tier1.json) | The small deterministic subset a pull request can run. |
| [`tier2-matrix.json`](./tier2-matrix.json) | The planned repeated-run matrix. |
| [`fixtures/`](./fixtures/) | Tier 1 target workspaces. |
| [`freeze.json`](./freeze.json) | SHA-256 of every file above. A silent change to any of them fails validation. |

## Tiers

**Tier 1** is deterministic, needs no network, no model provider, and no spend. It measures
whether the evidence required to answer each frozen task was present in the context
artifact, and whether readiness was correctly refused on the negative-trust probes. It never
scores answer quality and never runs an agent.

**Tier 2** runs a real agent on both arms with repeated trials and blinded rubric scoring.
It is frozen but not executed; its prerequisites are listed in `tier2-matrix.json`.

## Running it

```bash
npm ci
npm run qualify:validate
```

`qualify:validate` checks, from a clean checkout and without running Madar:

- every declared contract version agrees;
- every task references a real target, and every frozen prompt matches its recorded hash;
- every truth file exists, matches its task, and cites only paths that exist in the target;
- every truth file records who authored it and asserts no Madar-derived source was used;
- all six required task categories are covered;
- every Tier 1 cell and negative-trust probe resolves, and every probe prompt hash matches;
- both example receipts validate against `receipt-schema.json`, and no unmeasured score
  carries a value;
- **no qualification target id, task id, prompt string, or fixture symbol appears anywhere
  in `src/`**;
- every file in this directory matches its frozen digest.

Regenerating the freeze file is deliberate and must be explained in the pull request:

```bash
npm run qualify:validate -- --write
```

Executing the Tier 1 subset against Madar is [#661](https://github.com/mohanagy/madar/issues/661),
not this contract.

## Independence

Both Tier 1 fixtures and all six truth files were authored on 2026-08-12 from blank files.
Madar was never run against them, and no Madar retrieval output, context pack,
`implementationGuidance`, Madar-selected file list, or Madar-generated validation command
was consulted before freezing. Each task records this in `truth_provenance`.

Two consequences follow, and both are stated rather than papered over:

- **Thresholds are pre-registered, not calibrated.** Nobody knows how many Tier 1 cells
  currently pass. The first execution is a measurement; a failure there is a product
  finding, not a reason to edit this contract.
- **The author is not independent of the production-rule author.** Madar has one author, so
  `independent_of_production_rule_author` is `false` on every task, blinded review is
  unavailable, and the sealed holdout slot is unsatisfied. See
  [`holdout-policy.md`](./holdout-policy.md) for the human action that would fix this. Until
  then this corpus measures regression, not generalization, and no superiority or
  generalization claim may rest on it.

## Non-goals

This contract does not run the 480+ public superiority experiment, does not change
production retrieval or context logic, does not tune ranking against any target, and does
not publish any claim.
