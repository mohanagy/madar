# Benchmark suite summary

- Generated: 2026-06-07T13:47:59.743Z
- Filters: repo=documenso, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| documenso | completed | legacy: not_measured (benchmark readiness is not_ready (runtime slice confidence is low; no SPI evidence found in the current pack; retry with packages/out/graph.json or another SPI-scoped graph; root graph is broad for this question; retrieved evidence is concentrated under packages/)) | true | — | 459239 (459239-459239, n=1) | 109648 (109648-109648, n=1) | — | 13 (13-13, n=1) | 3 (3-3, n=1) | — | 6 (6-6, n=1) | 0 (0-0, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 98034 (98034-98034, n=1) | 39751 (39751-39751, n=1) | — | 0.56 (0.56-0.56, n=1) | 0.25 (0.25-0.25, n=1) | — | — |
