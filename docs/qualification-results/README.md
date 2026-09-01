# Tier 1 qualification results

Measured output from executing the frozen Tier 1 subset in
[`docs/qualification/tier1.json`](../qualification/tier1.json) against this checkout.

## Why results live here and not in `docs/qualification/`

`npm run qualify:validate` walks **every file** under `docs/qualification/` and fails any
path that is not recorded in `freeze.json`
(`.github/scripts/validate-qualification-contract.mjs`, the `walk(ROOT)` / `is not covered by
freeze.json` check). Writing results into the contract directory would therefore force a
`freeze.json` regeneration on every run — that is, editing the frozen contract to accommodate
a measurement. Results live in this sibling directory so the frozen contract stays
byte-identical and independently verifiable.

## Running it

```bash
npm run build                       # the evaluator uses the real built CLI
npm run qualify:tier1 -- --out docs/qualification-results/tier1/<run-id>/run-a --run-id run-a
npm run qualify:tier1-controls      # E1-E15 and S1-S4 evaluator falsifiability controls
npm run qualify:tier1-compare -- <run-a-dir> <run-b-dir>
```

`--no-network` refuses to reach the network and requires a warm clone cache that already
contains every pinned commit.

## Exit codes

`qualify:tier1` distinguishes *a product that failed* from *a run that could not be measured*.
Collapsing the two would let a broken harness read as a product regression, or a real failure
hide behind an infrastructure excuse.

| Code | Meaning |
| --- | --- |
| `0` | Every cell was measured and passed. |
| `2` | The run was valid and measured, and **at least one cell failed** the frozen contract. This is a product finding. |
| `1` | The run **could not be measured faithfully**: harness error, frozen-contract inconsistency, or target-preparation/identity failure. Never a statement about product quality. |

`qualify:tier1-compare` exits `0` when two runs are semantically identical and `1` otherwise,
naming the smallest differing field.

`qualify:tier1-controls` exits `0` only when every control fires in **both** directions:

| Control | Proves |
| --- | --- |
| E1 | A missing critical path or symbol fails the cell. |
| E2 | An unsupported claim — a cited path or printed symbol absent from the pinned target — fails. |
| E3 | A false ready on a negative probe fails. |
| E4 | A missing citation fails. |
| E5 | A target-revision mismatch is `invalid`, never `fail`. |
| E6 | A mutated frozen truth file or probe rule is refused. |
| E7 | Removing the observable absence declaration from a truthful result stops the probe passing. |
| E8 | Raising a task cell with missing required evidence to `ready` or `ready_with_caveat` increments false-ready and fails the cell. |
| E9 | A frozen `required_behaviour` this evaluator does not measure yields `invalid`, never `pass`. |
| E10 | An artifact channel the registry does not classify is detected, not silently dropped. |
| E11 | Symbol grounding distinguishes a real identifier from an invented one. |
| E12 | Probe subject terms are a deterministic function of the frozen bytes. |
| S1 | A symbol in a real supported evidence channel enters observed symbols — for every artifact shape. |
| S2 | A symbol present only in frozen truth stays missing. |
| S3 | `Hono.fetch` satisfies `fetch` (the projection `rubrics.json` authorises); `SmartRouter.match` does **not** satisfy `SmartRouter`. |
| S4 | A name appearing only in prose, in the echoed prompt, in a community label, or in retained snippet text does not count. |
| E13 | Naming a probe's subject is not declaring it absent: an affirmative claim that mentions the subject fails, a statement that names it and asserts absence passes, and absence language about a different subject fails. |
| E14 | A `must_not_report_ready_when` clause fires only on evidence its own text names. Unrelated missing evidence leaves it `undetermined`, never violated. |
| E15 | Task cells gate on cited paths, as `rubrics.json` mandates, not on every printed symbol; the negative probes gate on both, as their frozen `required_behaviour` mandates. |

## Result directories

| Directory | Status |
| --- | --- |
| `tier1/2026-09-01-first-baseline/` | Attempt 1 — provisional, superseded. Bytes preserved; see its `CLASSIFICATION.md`. |
| `tier1/2026-09-01-corrected-baseline/` | The measurement of record, produced by the audited evaluator. |

A superseded result is never edited, regenerated, or relabelled as though it came from the
corrected evaluator. It is kept, classified, and pointed at.

## Gate status

Tier 1 is **not** a mandatory protected gate. `tier1.json#/gate/activation` records
`state: pre_baseline`, `active: false`, and the gate activates only once a baseline exists.
This directory holds that first baseline. Activation is a separate maintainer decision.

## How to read a result

- `result.json` — machine-readable per-cell result.
- `report.md` — the concise human report.
- `frozen-input-manifest.json` — every frozen input, its SHA-256, and the resolved id graph.
- `prepared-target-receipt.json` — pinned SHA, patch digest, and cited-blob verification per target.
- `semantic-digest.txt` — digest over the cell population, states, expected/observed sets and
  metrics, excluding declared-volatile fields (timestamps, run ids, durations, paths).
- `logs/` — retained stdout for each `generate` and `pack` invocation, with absolute local
  paths redacted at write time.
- `result.evidence_surface` — the declared channel registry, and whether the run's evidence
  set was closed over every channel the artifacts actually presented.
- `result.run_independence` — per-arm prepared worktree, graph artifact digest, clone-cache
  read status, and a digest of every Pack artifact, so two arms can be shown to have
  executed independently rather than one reading the other's output.

`pass`, `fail` and `invalid` counts are always reported separately. Invalid cells are never
folded into a quality percentage, per
[`validity-rules.md`](../qualification/validity-rules.md).
