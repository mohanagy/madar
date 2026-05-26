# Benchmark suite scaffold

This directory is the public landing zone for the reproducible benchmark suite tracked in [#332](https://github.com/mohanagy/madar/issues/332).

## What this suite is for

- fixed repos
- fixed task kinds
- cold-cache and warm-cache runs kept separate
- repeated trials per cell
- **per-repo spread**, not a blended marketing number

## Claim policy

- do not publish a single-number cross-repo headline
- do not upgrade a public claim from README.md until the relevant suite cell exists
- keep dated one-off receipts under `docs/benchmarks/` as receipts, not as universal proof

## Current status

The runner-backed suite now ships in this directory:

- [`repos.json`](./repos.json) — fixed repo ids and current readiness
- [`tasks.json`](./tasks.json) — fixed task ids and current prompt wiring
- [`methodology.md`](./methodology.md) — trial protocol, caveats, and reporting rules
- `madar bench:suite` — the CLI entrypoint that expands runnable cells and writes results under `docs/benchmarks/suite/results/<timestamp>/`

Current wiring is intentionally conservative:

- `nestjs-mid` is the first runnable fixture-style mid-size service proxy
- `explain-runtime` is the first runnable task kind
- the rest of the fixed matrix is present in the manifests as planned rows so the public surface shows the intended spread without pretending those cells are already measured

First measured row:

- [`results/2026-05-26T18-31-04/summary.md`](./results/2026-05-26T18-31-04/summary.md) — warm-cache `nestjs-mid` / `explain-runtime`, 3 trials, baseline vs Madar vs SPI Madar

Run a dry-run first:

```bash
madar bench:suite --dry-run
```

Run the first wired cell:

```bash
madar bench:suite \
  --repo nestjs-mid \
  --task explain-runtime \
  --mode warm \
  --trials 3 \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes
```

Measured results remain repo/task specific receipts. Public claims stay conservative and point back to dated artifact folders plus [`docs/claims-and-evidence.md`](../../claims-and-evidence.md) until the broader matrix is populated.
