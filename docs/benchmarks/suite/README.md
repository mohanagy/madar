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
- [`quality-gates.json`](./quality-gates.json) — deterministic receipt checks only
- [`human-review.json`](./human-review.json) — separate semantic review prompts, notes, and explicit `pending`/`passed`/`failed` status
- [`holdouts/`](./holdouts/) — alternate repos/prompts with no runtime-proof profile
- [`methodology.md`](./methodology.md) — trial protocol, caveats, and reporting rules
- `madar bench:suite` — the CLI entrypoint that expands runnable cells and writes results under `docs/benchmarks/suite/results/<timestamp>/`

Current wiring is still conservative, but it is no longer a single-cell scaffold:

- ready repo shapes: `ts-small`, `nestjs-mid`, `ts-monorepo-large`, `python-service`, `go-service`, `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`
- ready task kinds: `explain-runtime`, `implement`, `review`, and `impact`
- Python and Go now ship as concrete public fixture workspaces under `docs/benchmarks/suite/fixtures/`
- six git-backed public repos are now prompt-wired as ready rows: `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`
- fresh July 15 isolated `explain-runtime` receipts are published for `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`; all ran from the same unpacked `@lubab/madar@0.31.0` tarball and none reached a valid performance comparison
- historical June receipts remain published as real controlled profile-assisted measurements; they demonstrate the observed source-checkout result, but not untuned npm-package behavior
- `documenso`, `novu`, and `twenty` are configured with scoped `graphRoot` values where prior receipts showed broad-root readiness blockers; suite runs generate and compare against those scoped graphs instead of the oversized monorepo roots
- public explain-runtime reruns load deterministic answer-quality gates from [`quality-gates.json`](./quality-gates.json); human semantic review status is tracked independently in [`human-review.json`](./human-review.json), and all July rows remain `pending` without overriding their machine-ineligible outcomes
- isolated Claude reruns for those public explain-runtime rows must allow `mcp__madar__retrieve` (for example with `--allowedTools mcp__madar__retrieve`)
- runner execution now clones or copies each ready row into a temporary benchmark workspace, normalizes repo-local Claude/MCP config there, provisions the Madar Claude install, and verifies that install before prompt spend
- `./isolation/run-isolated.sh` builds `npm pack`, unpacks it outside the checkout, and uses that artifact for both the suite CLI and MCP server; `MADAR_BENCH_CLI_PATH` is an explicit development override and cannot produce a publishable receipt
- the launcher treats `docs/benchmarks/suite/isolation/.claude` as a checked-in template and syncs it into a persistent runtime isolation profile outside the repo; if your normal Claude profile is logged in but that isolated runtime profile is not, it fails fast and prints the exact login command

Current public TypeScript `explain-runtime` receipts (July 15, 2026; packed `0.31.0` artifact; one warm-cache trial per row):

`Legacy` runs the explicit `--legacy` extractor. `SPI` runs strict `--spi` with additional framework-shaped metadata and disk-cache behavior. Normal `madar generate .` now uses capability-aware auto-extraction instead of either benchmark-only mode.

| Repo | Bundle | Legacy outcome | SPI outcome |
| --- | --- | --- | --- |
| `documenso` | [`results/2026-07-15T06-55-50/summary.md`](./results/2026-07-15T06-55-50/summary.md) | `not_measured` — follow-up missed send preparation and answer evidence was incomplete | `not_measured` — same contract failure plus answer-evidence gaps |
| `formbricks` | [`results/2026-07-15T07-08-43/summary.md`](./results/2026-07-15T07-08-43/summary.md) | `not_measured` — two attributable Madar calls occurred, but the trace could not justify the follow-up broad exploration | `not_measured` — one attributable Madar call occurred; the same prompt-contract uncertainty remained, plus baseline answer-gate failures |
| `dub` | [`results/2026-07-15T07-41-50/summary.md`](./results/2026-07-15T07-41-50/summary.md) | `not_measured` — no attributable Madar MCP call | `not_measured` — no attributable Madar MCP call |
| `twenty` | [`results/2026-07-15T08-08-36/summary.md`](./results/2026-07-15T08-08-36/summary.md) | `not_measured` — no attributable Madar MCP call | `not_measured` — no attributable Madar MCP call |
| `cal-diy` | [`results/2026-07-15T08-51-54/summary.md`](./results/2026-07-15T08-51-54/summary.md) | `not_measured` — no attributable Madar MCP call | Not configured |
| `novu` | [`results/2026-07-15T09-27-25/summary.md`](./results/2026-07-15T09-27-25/summary.md) | `not_measured` — no attributable Madar MCP call | Not configured |

All six bundles report `isolation: true`, zero preparation skips, zero environment-drift skips, runtime source `npm_pack`, package version `0.31.0`, and tarball SHA-256 `9c0192e2abf390cf95aeaf89efbcbe6b8b45c19a139760df554e168542e95b4e`. Four rows show that installation verification alone does not guarantee agent adoption: Claude searched for tools and then fell back to broad repository tools without an attributable Madar call. The other two rows invoked Madar but failed strict prompt/answer gates. Resource counters remain in the receipts for diagnosis, but none form a valid performance comparison. These outcomes expose adoption and answer-completeness gaps; they are not six measured product losses.

Controlled historical TypeScript `explain-runtime` receipts (June 10, 2026; source checkout with task-specific runtime-proof profiles):

These six runs are genuine measurements under the recorded setup. Every row invoked Madar and passed the deterministic gates used at the time; the receipts record 3.5x–18.5x fewer tool calls, 2.2x–15.6x less provider-reported input, and 1.65x–7.09x lower latency. The answering prompts included exact proof checklists and the checkout retrieval path could load expected files and functions from `runtime-proof.json`. Because `docs/` was not part of the npm package, normal installed users did not receive that assistance. Treat these receipts as controlled evidence of achievable profile-assisted performance, not as a production-default or universal claim.

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

Measured results remain repo/task-specific receipts. Controlled and production-default experiments stay labeled separately. Public claims point back to dated artifact folders plus [`docs/claims-and-evidence.md`](../../claims-and-evidence.md) until the matrix includes more public languages, more prompts, and more independent receipts.
