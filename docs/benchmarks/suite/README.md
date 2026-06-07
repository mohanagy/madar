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
- the latest published bundle still measures the three TypeScript fixture-style rows; the Python and Go fixtures plus the git-backed public repos are runnable but not yet published as dated receipts
- runner execution now clones or copies each ready row into a temporary benchmark workspace, normalizes repo-local Claude/MCP config there, provisions the Madar Claude install, and verifies that install before prompt spend

Latest published bundle:

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
