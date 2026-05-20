# Performance benchmark plan for `generate`, `update`, and `cluster-only`

> **Tracking issue:** [#178](https://github.com/mohanagy/graphify-ts/issues/178)

This benchmark is a **measurement harness**, not a performance gate. Its job is to keep graph-generation regressions visible with a tiny reproducible fixture in CI and a repeatable manual flow for larger local repositories.

## What the benchmark covers

The synthetic harness runs six variants on isolated fixture copies:

1. `generate-legacy` — normal `generate`
2. `generate-spi-cold` — first `generate --spi` run
3. `generate-spi-warm` — second `generate --spi` run on the same workspace to measure the cache-hit path
4. `update-noop` — `generate --update` with no source changes
5. `update-changed` — `generate --update` after mutating one code file
6. `cluster-only` — `generate --cluster-only` after a baseline graph already exists

## Metrics tracked

Every variant records the same structured fields in `<variant>.json` and `summary.json`:

- wall-clock time (`wall_clock_ms`)
- file counts (`total_files`, `code_files`, `non_code_files`)
- extraction counts (`extractable_files`, `extracted_files`)
- incremental counts (`changed_files`, `deleted_files`)
- graph size (`node_count`, `edge_count`, `graph_size_bytes`)
- output size (`output_size_bytes`)
- cache behavior (`cache_hit`, `cache_reason`, `cache_file_count`)

The benchmark reads these from structured `GenerateGraphResult` fields where possible instead of scraping human-readable terminal notes.

## CI-safe synthetic benchmark

Run the checked-in fixture benchmark from the repo root after building:

```bash
npm run build
node docs/benchmarks/performance/run.mjs
```

Artifacts land under `docs/benchmarks/performance/results/<timestamp>/`:

1. one JSON file per variant
2. `summary.json` with the full matrix
3. the copied per-variant workspaces used for the run

This fixture is intentionally small. It is for **schema and cache-behavior coverage**, not for proving absolute throughput on real repositories.

## Manual large-repo benchmark flow

For a local large repository, point the same harness at another workspace:

```bash
npm run build
GRAPHIFY_PERF_FIXTURE=/absolute/path/to/repo \
GRAPHIFY_PERF_RESULTS_DIR=/absolute/path/to/output-dir \
node docs/benchmarks/performance/run.mjs
```

Use the synthetic fixture in CI, and use the local-repo run when you want realistic wall-clock measurements for:

- initial `generate`
- incremental `update` after a narrow change
- `cluster-only` refresh cost
- SPI cold vs warm cache behavior

## Interpreting results

- `extractable_files` is the total corpus eligible for extraction in that workspace state.
- `extracted_files` is the number of files freshly re-extracted for that run. It should drop to `0` for SPI warm-cache hits, update no-op runs, and cluster-only refreshes.
- `cache_reason` is only populated for SPI runs. Typical values are `no-cache`, `fresh-cache`, and `key-mismatch`.
- Compare `graph_size_bytes` and `output_size_bytes` together: the graph file can stay flat while the total output directory still grows.

## Non-goals

- Do not turn this into a strict perf threshold in CI.
- Do not claim broad performance wins from the synthetic fixture alone.
- Do not optimize generation paths without a before/after measurement from this harness or a real local workspace run.
