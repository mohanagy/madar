# Performance benchmark plan for `generate`, `update`, and `cluster-only`

> **Tracking issue:** [#178](https://github.com/mohanagy/madar/issues/178)

This benchmark is a **measurement harness**, not a performance gate. Its job is to keep graph-generation regressions visible with a tiny reproducible fixture in CI and a repeatable manual flow for larger local repositories.

## What the benchmark covers

The synthetic harness runs four variants on isolated fixture copies:

1. `generate` — generation through the canonical TypeScript/JavaScript index
2. `update-noop` — a full canonical `generate --update` with no source changes
3. `update-changed` — a full canonical `generate --update` after mutating one code file
4. `cluster-only` — `generate --cluster-only` after a baseline graph already exists

`--update` is intentionally measured as a full rebuild in this phase. The benchmark does not claim per-file incremental extraction or cache-hit behavior.

## Metrics tracked

Every variant records the same structured fields in `<variant>.json` and `summary.json`:

- wall-clock time (`wall_clock_ms`)
- supported and unsupported indexing counts from the canonical completeness receipt
- graph size (`node_count`, `edge_count`, `graph_size_bytes`)
- output size (`output_size_bytes`)

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

This fixture is intentionally small. It is for **schema and path coverage**, not for proving absolute throughput on real repositories.

## Manual large-repo benchmark flow

For a local large repository, point the same harness at another workspace:

```bash
npm run build
MADAR_PERF_FIXTURE=/absolute/path/to/repo \
MADAR_PERF_RESULTS_DIR=/absolute/path/to/output-dir \
node docs/benchmarks/performance/run.mjs
```

Use the synthetic fixture in CI, and use the local-repo run when you want realistic wall-clock measurements for:

- initial `generate`
- full canonical `update` after a narrow change
- `cluster-only` refresh cost
- canonical full-build cost

## Interpreting results

- Supported counts cover `.ts`, `.tsx`, `.js`, and `.jsx`. Recognized files outside that scope remain unsupported and contribute no graph facts.
- `update-noop` still rebuilds the canonical graph. Only `cluster-only` skips source indexing.
- Compare `graph_size_bytes` and `output_size_bytes` together: the graph file can stay flat while the total output directory still grows.

## Non-goals

- Do not turn this into a strict perf threshold in CI.
- Do not claim broad performance wins from the synthetic fixture alone.
- Do not optimize generation paths without a before/after measurement from this harness or a real local workspace run.
