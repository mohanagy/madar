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

Current wiring is still conservative, but it is no longer a single-cell scaffold:

- ready repo shapes: `ts-small`, `nestjs-mid`, `ts-monorepo-large`, `python-service`, `go-service`, `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`
- ready task kinds: `explain-runtime`, `implement`, `review`, and `impact`
- Python and Go now ship as concrete public fixture workspaces under `docs/benchmarks/suite/fixtures/`
- six git-backed public repos are now prompt-wired as ready rows: `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`
- isolated public `explain-runtime` receipts are now published for `documenso`, `formbricks`, `dub`, `cal-diy`, and `novu`
- `twenty` currently ships as a scoped `packages/twenty-server/src/modules` compare receipt because the root suite graph breaches the current compare size guard
- runner execution now clones or copies each ready row into a temporary benchmark workspace, normalizes repo-local Claude/MCP config there, provisions the Madar Claude install, and verifies that install before prompt spend

Latest published public-repo receipts:

- [`results/2026-06-07T12-03-13/summary.md`](./results/2026-06-07T12-03-13/summary.md) — isolated warm-cache `explain-runtime` suite receipt for `documenso`
- [`results/2026-06-07T12-07-40/summary.md`](./results/2026-06-07T12-07-40/summary.md) — isolated warm-cache `explain-runtime` suite receipt for `formbricks`
- [`results/2026-06-07T12-12-25/summary.md`](./results/2026-06-07T12-12-25/summary.md) — isolated warm-cache `explain-runtime` suite receipt for `dub`
- [`results/2026-06-07T12-30-26/summary.md`](./results/2026-06-07T12-30-26/summary.md) — isolated warm-cache `explain-runtime` suite receipt for `cal-diy`
- [`results/2026-06-07T12-45-30/summary.md`](./results/2026-06-07T12-45-30/summary.md) — isolated warm-cache `explain-runtime` suite receipt for `novu`
- [`../2026-06-07-twenty-server-modules-runtime/README.md`](../2026-06-07-twenty-server-modules-runtime/README.md) — isolated scoped compare receipt for `twenty`, published against `packages/twenty-server/src/modules` because the root suite graph is too large for the current compare guard

Historical fixture bundle:

- [`results/2026-05-31T12-00-00/summary.md`](./results/2026-05-31T12-00-00/summary.md) — small-library, service, and monorepo fixture-style rows across explain, implement, review, and impact tasks, with workflow-outcome summaries on the implement/review cells
- [`results/2026-05-26T18-31-04/summary.md`](./results/2026-05-26T18-31-04/summary.md) — the first warm-cache `nestjs-mid` / `explain-runtime` receipt kept for historical continuity

Run a dry-run first:

```bash
madar bench:suite --dry-run
```

Run one wired cell:

```bash
madar bench:suite \
  --repo nestjs-mid \
  --task explain-runtime \
  --mode warm \
  --trials 3 \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes
```

Measured results remain repo/task-specific receipts. Public claims stay conservative and point back to dated artifact folders plus [`docs/claims-and-evidence.md`](../../claims-and-evidence.md) until the matrix includes more public languages, more prompts, and more independent receipts.
