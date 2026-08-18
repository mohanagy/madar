# Real-workspace measurement (maintained)

Measures generation and retrieval against the **canonical v2 graph artifact**,
`out/graph.madar`. Use this for any new measurement.

```bash
# controlled fixture (default)
bash docs/benchmarks/tools/real-workspace/run.sh

# a real workspace
MADAR_BENCH_FIXTURE=/absolute/path/to/repo \
  bash docs/benchmarks/tools/real-workspace/run.sh
```

## Why this exists separately from the dated directories

`docs/benchmarks/<date>-*/` are frozen records: each one is the evidence for a
measurement taken at a point in time, and its numbers belong to the artifact
contract in force then. `docs/benchmarks/2026-05-11-spi-vs-legacy/` measured a v1
JSON graph at `out/graph.json` with `wc -c`.

After the artifact cutover that path holds the tombstone, so the archived runner
would not have failed — it would have recorded the marker's size as the graph
size, roughly three orders of magnitude below the real artifact. Splitting the
maintained tool out keeps the archive readable as history and keeps current
measurement honest.

`MADAR_BENCH_MODE` makes the boundary explicit:

| Value | Accepted by | Meaning |
| --- | --- | --- |
| `current` (default) | this runner | measures `out/graph.madar` under the current contract |
| `historical` | archived runners only | reruns a v1-era procedure, and only against a binary that still produces v1 |

The archived runners refuse to start without `MADAR_BENCH_MODE=historical`, and
refuse to continue if the binary under test publishes a v2 artifact.

## What is measured

`metrics.json`, `schema_version: 2`:

| Field | Meaning |
| --- | --- |
| `artifact.bytes` | size of `out/graph.madar`, header included |
| `artifact.header` | asserted to be `MADAR_GRAPH_ARTIFACT/2` |
| `artifact.legacy_path` | `tombstone`, verified byte-for-byte against the exact marker |
| `build_time_ms` | `generate --no-html` wall clock |
| `node_count` | nodes in the artifact payload |
| `fact_count` | facts in the artifact payload |
| `prompts[].serialized_token_count` | tokens in the serialized context for that prompt |
| `prompts[].matched_node_count` | nodes the pack matched |

Two field names differ from the v1-era schema on purpose:

- **`artifact.bytes`, not `graph_size_bytes`.** The old name meant the v1 JSON
  file. A v2 artifact is a different format, so putting its size under the old
  name would invite a comparison that is not valid.
- **`serialized_token_count`, not `pack_token_count`.** `pack.token_count` is
  absent from the pack response on one retrieval path, and the archived runner
  read it with `?? 0` — so a prompt that packed a full context could be recorded
  as zero tokens. `serialized_budget.token_count` is present on every path.
  `pack-metrics.mjs` treats a missing field as an error rather than a zero.

## Validity checks

The run aborts rather than emitting a partial metrics file when:

- `out/graph.madar` is missing or empty after generation
- `out/graph.json` is not the exact tombstone (the workspace never cut over)
- the artifact does not carry the v2 header, or is a moved marker
- `pack` fails, or returns a response the metrics cannot be read from

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MADAR_BENCH_MODE` | `current` | must be `current` here |
| `MADAR_BENCH_FIXTURE` | `./fixture` | workspace to measure |
| `MADAR_BENCH_PROMPTS` | `./prompts.json` | prompt set |
| `MADAR_BENCH_RESULTS_DIR` | `./results/<timestamp>` | output bundle |
| `MADAR_BENCH_CLI` | `dist/src/cli/bin.js` | CLI under test |
| `MADAR_BENCH_TIMESTAMP` | current UTC time | fixes the bundle name |
