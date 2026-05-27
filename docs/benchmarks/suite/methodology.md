# Benchmark suite methodology

This suite exists to make Madar's benchmark claims reproducible without collapsing everything into one blended marketing number.

## Repo selection

The fixed repo set is tracked in [`repos.json`](./repos.json).

- Keep the shape mix explicit: small TypeScript, mid-size service, larger TypeScript monorepo, Python service, Go service.
- The suite may use public repos or fixture-style proxies. It must not require the private GoValidate codebase.
- Only rows marked `status: "ready"` are runnable today. Planned rows stay visible in the manifest so the public surface shows the intended spread honestly.

## Task selection

The fixed task set is tracked in [`tasks.json`](./tasks.json).

- Task ids are suite dispatch keys such as `explain-runtime`, `implement`, and `review`.
- A task becomes runnable only when it has `status: "ready"` and a repo-specific prompt in `prompts`.
- Missing prompts are treated as planned cells, not silently skipped evidence.

## Trial protocol

- Default trials per runnable cell: **3**
- Run modes:
  - **cold** — measured directly with no suite-managed priming run
  - **warm** — one priming compare run is executed and discarded before the measured run
- Each measured cell currently records:
  - baseline
  - Madar
  - SPI Madar when the repo entry supports SPI

## What is measured

Primary metric:

- Anthropic-reported input tokens per task from the native-agent compare `result` event

Secondary metrics:

- total tool-call count
- `Read` count
- `Glob` + `Grep` count
- wall-clock duration
- total cost

Per-cell artifacts keep `report.share-safe.json` as the canonical persisted report so summaries can be inspected without leaking private local paths.

## Isolation mode and canonical environment

- Published benchmark cells are expected to run in isolation mode via [`docs/benchmarks/suite/isolation/`](./isolation/).
- `./isolation/run-isolated.sh` sets `CLAUDE_CONFIG_DIR` to the shipped minimal config and exports `MADAR_BENCH_ISOLATION=1`.
- The pinned environment contract lives in [`isolation/environment.json`](./isolation/environment.json). In isolation mode, `madar bench:suite` compares the live environment against that contract before each cell.
- Environment drift marks the cell `status: "env_mismatch"` and excludes it from measured counts. `summary.md` records `Cells skipped for env drift: N`.
- Development runs outside isolation mode remain useful receipts, but their cells are tagged `isolation: false` and should not be cited as published benchmark claims.

## Reporting rules

- Results are written under `docs/benchmarks/suite/results/<timestamp>/`
- `summary.json` is the machine-readable rollup
- `summary.md` is the human-readable rollup
- Each cell reports `status` and `isolation: true|false`
- Keep **repos as rows**
- Report **median + min/max + n**
- Keep **cold** and **warm** separate
- Do **not** add a blended cross-repo rollup row

## What is not controlled

The suite is reproducible, but it is not a lab instrument. The following still vary:

- model version drift
- provider-side routing changes
- rate limits and queueing
- time-of-day cache state
- agent runtime behavior outside the prompt itself

Those caveats are part of the evidence, not a reason to hide variance.
