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
npm run qualify:tier1-controls      # E1-E6 evaluator falsifiability controls
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

`qualify:tier1-controls` exits `0` only when every E1-E6 control fires in **both** directions.

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

`pass`, `fail` and `invalid` counts are always reported separately. Invalid cells are never
folded into a quality percentage, per
[`validity-rules.md`](../qualification/validity-rules.md).
