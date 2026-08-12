# Qualification contract

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655)
against Madar commit `06b373a447acfce895412ac10eb4e5228c5df0b7` (`v0.32.1`).

This directory is the independent evaluation contract used to decide whether a roadmap
change is safe to ship. It is deliberately separate from
[`docs/benchmarks/suite/`](../benchmarks/suite/), which is the product benchmark suite.

## Why a separate corpus exists

Two properties are required, and the existing benchmark suite has neither.

**Independence from Madar output.** Grading Madar with expectations Madar produced tells
you nothing. Today's per-task expectations live in
[`docs/benchmarks/suite/runtime-proof.json`](../benchmarks/suite/runtime-proof.json) as
exact expected symbols and paths, authored alongside the product.

**Naturalness.** Every row in
[`docs/benchmarks/suite/repos.json`](../benchmarks/suite/repos.json) that is keyed by
`path` is an in-repo proxy — `examples/sample-workspace`, two `tests/fixtures/pack-quality`
workspaces, and two fixture directories under the suite itself. A corpus of self-authored
proxies cannot detect production behaviour drifting toward benchmark-shaped repositories,
because the proxies were shaped by the same hands as the production rules.

Every target in this corpus is therefore a real, externally authored, permissively licensed
project pinned at an immutable commit. There are no fixture proxies;
`corpus.json#/proxy_targets` is empty and documents the conditions under which an entry
would be permitted.

## Targets

| Target | Repository | Commit | License |
| --- | --- | --- | --- |
| `hono` | [honojs/hono](https://github.com/honojs/hono) | `26de73133b8552f56ba72e025ecd82b08900d796` | MIT |
| `unstorage` | [unjs/unstorage](https://github.com/unjs/unstorage) | `e6be6135832f350ca16f9a77432e1d4f0aa85ed7` | MIT |
| `hono-seeded-compose` | same as `hono`, plus [`patches/hono-compose-reentrancy-guard.patch`](./patches/hono-compose-reentrancy-guard.patch) | `26de7313…` | MIT |
| `hono-seeded-error-disclosure` | same as `hono`, plus [`patches/hono-error-message-disclosure.patch`](./patches/hono-error-message-disclosure.patch) | `26de7313…` | MIT |
| `sealed-holdout-a` | undisclosed | — | **unsatisfied**, see [`holdout-policy.md`](./holdout-policy.md) |

Seeded defects are injected into the real code as patches against the pinned commit, not
recreated inside a synthetic workspace built around the answer.

## Files

| File | Deliverable |
| --- | --- |
| [`corpus.json`](./corpus.json) | Versioned corpus manifest: repositories, commits, licenses, prepare commands, patches, cited blob digests, holdout class. |
| [`tasks.json`](./tasks.json) | Versioned task definitions: frozen prompts with hashes, categories, scoring method, truth provenance. |
| [`truth/`](./truth/) | Independent truth and rubric input, one file per task. |
| [`patches/`](./patches/) | Seeded-defect patches applied to the pinned commit. |
| [`rubrics.json`](./rubrics.json) | Scoring dimensions, per-category scoring methods, blinding rules, aggregation rules. |
| [`receipt-schema.json`](./receipt-schema.json) | Environment and run receipt schema. |
| [`examples/`](./examples/) | Two illustrative receipts: a valid Tier 1 run and an invalid Tier 2 run that stays `not_measured`. |
| [`validity-rules.md`](./validity-rules.md) | Valid/invalid criteria, the `not_measured` rule, retention, and what today's emitter actually produces. |
| [`holdout-policy.md`](./holdout-policy.md) | Hidden holdout handling — and why the sealed slot is currently unsatisfied. |
| [`stop-rule.md`](./stop-rule.md) | Objective stop, rollback, and publication rule. |
| [`evidence-categories.md`](./evidence-categories.md) | Evidence classes E1–E6 and required labelling. |
| [`tier1.json`](./tier1.json) | The small deterministic subset a pull request can run. |
| [`tier2-matrix.json`](./tier2-matrix.json) | The planned repeated-run matrix. |
| [`freeze.json`](./freeze.json) | SHA-256 of every file above. A silent change to any of them fails validation. |

## Tiers

**Tier 1** is deterministic, needs no model provider and no spend. It measures whether the
evidence required to answer each frozen task was present in the context artifact, and
whether readiness was correctly refused on the negative-trust probes. It never scores
answer quality and never runs an agent. It does need network access to clone the pinned
targets; a warm clone cache or a local mirror satisfies that without changing any result,
because the commit and the patch fix the content exactly.

**Tier 2** runs a real agent on both arms with repeated trials and blinded rubric scoring.
It is frozen but not executed; its prerequisites are in `tier2-matrix.json`.

## Running it

```bash
npm ci
npm run qualify:validate
```

`qualify:validate` checks, offline and without running Madar:

- every declared contract version agrees;
- every target pins a 40-character commit SHA and records a license and prepare steps;
- every task references a real target, and every frozen prompt matches its recorded hash;
- every truth file exists, matches its task, and cites only paths recorded in that target's
  `cited_blobs` map;
- every truth file records who authored it and asserts no Madar-derived source was used;
- all six required task categories are covered;
- every seeded target names a patch file that exists and is a well-formed unified diff
  touching only paths recorded for that target;
- every Tier 1 cell and negative-trust probe resolves, and every probe prompt hash matches;
- both example receipts validate against `receipt-schema.json`, and no unmeasured score
  carries a value;
- **no qualification target id, task id, prompt string, or pinned-repository symbol appears
  anywhere in `src/`**;
- every file in this directory matches its frozen digest.

To additionally confirm the pinned commits and blob digests against the real repositories
— this one needs network access:

```bash
npm run qualify:validate -- --verify-corpus
```

Regenerating the freeze file is deliberate and must be explained in the pull request:

```bash
npm run qualify:validate -- --write
```

Executing the Tier 1 subset against Madar is [#661](https://github.com/mohanagy/madar/issues/661),
not this contract.

## Independence

All six truth files were authored on 2026-08-12 by reading the pinned repository sources
directly. Madar was never run against any target, and no Madar retrieval output, context
pack, `implementationGuidance`, Madar-selected file list, or Madar-generated validation
command was consulted before freezing. Each task records this in `truth_provenance`.

Two consequences follow, and both are stated rather than papered over:

- **Thresholds are pre-registered, not calibrated.** Nobody knows how many Tier 1 cells
  currently pass. Pre-registering before calibrating is the correct order: a threshold
  fitted to observed output would describe current behaviour instead of testing it. The
  first execution is a measurement, and a failure there is a product finding, not a reason
  to edit this contract.
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
