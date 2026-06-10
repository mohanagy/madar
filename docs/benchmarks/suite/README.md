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
- isolated public `explain-runtime` legacy receipts are now published for `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`
- `documenso`, `novu`, and `twenty` are configured with scoped `graphRoot` values where prior receipts showed broad-root readiness blockers; suite runs generate and compare against those scoped graphs instead of the oversized monorepo roots
- public explain-runtime reruns now load deterministic answer-quality gates from [`quality-gates.json`](./quality-gates.json); permission-blocked answers are not benchmark wins, and neither are inference-heavy answers
- isolated Claude reruns for those public explain-runtime rows must allow `mcp__madar__retrieve` (for example with `--allowedTools mcp__madar__retrieve`)
- runner execution now clones or copies each ready row into a temporary benchmark workspace, normalizes repo-local Claude/MCP config there, provisions the Madar Claude install, and verifies that install before prompt spend
- `./isolation/run-isolated.sh` now treats `docs/benchmarks/suite/isolation/.claude` as a checked-in template and syncs it into a persistent runtime isolation profile outside the repo; if your normal Claude profile is logged in but that isolated runtime profile is not, the launcher fails fast and prints the exact `CLAUDE_CONFIG_DIR=... claude auth login` command to run once before rerunning the benchmark

Latest published public TypeScript `explain-runtime` legacy receipts (repo/task-specific; where a bundle also includes an SPI arm, treat that SPI arm separately):

| Repo | Bundle | Legacy receipt |
| --- | --- | --- |
| `documenso` | [`results/2026-06-10T07-01-18/summary.md`](./results/2026-06-10T07-01-18/summary.md) | [`report.share-safe.json`](./results/2026-06-10T07-01-18/raw/documenso/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |
| `formbricks` | [`results/2026-06-10T07-10-44/summary.md`](./results/2026-06-10T07-10-44/summary.md) | [`report.share-safe.json`](./results/2026-06-10T07-10-44/raw/formbricks/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |
| `dub` | [`results/2026-06-10T07-24-01/summary.md`](./results/2026-06-10T07-24-01/summary.md) | [`report.share-safe.json`](./results/2026-06-10T07-24-01/raw/dub/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |
| `twenty` | [`results/2026-06-10T07-39-11/summary.md`](./results/2026-06-10T07-39-11/summary.md) | [`report.share-safe.json`](./results/2026-06-10T07-39-11/raw/twenty/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |
| `cal-diy` | [`results/2026-06-10T08-08-44/summary.md`](./results/2026-06-10T08-08-44/summary.md) | [`report.share-safe.json`](./results/2026-06-10T08-08-44/raw/cal-diy/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |
| `novu` | [`results/2026-06-10T08-24-49/summary.md`](./results/2026-06-10T08-24-49/summary.md) | [`report.share-safe.json`](./results/2026-06-10T08-24-49/raw/novu/explain-runtime/warm-cache/legacy/trial-001/report.share-safe.json) — `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_contract.runtime_proof.missing_obligations = []` |

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

For isolated public `explain-runtime` reruns, keep the retrieve permission explicit so the benchmark does not turn a permissions prompt into a fake win:

```bash
./docs/benchmarks/suite/isolation/run-isolated.sh \
  --repo formbricks \
  --task explain-runtime \
  --mode warm \
  --trials 1 \
  --exec 'cat {prompt_file} | claude -p --output-format json --verbose --allowedTools mcp__madar__retrieve' \
  --yes
```

Measured results remain repo/task-specific receipts. Public claims stay conservative and point back to dated artifact folders plus [`docs/claims-and-evidence.md`](../../claims-and-evidence.md) until the matrix includes more public languages, more prompts, and more independent receipts.
