# Benchmark suite summary

- Generated: 2026-06-07T14:24:25.232Z
- Filters: repo=novu, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| novu | completed | legacy: not_measured (benchmark readiness is not_ready (runtime slice confidence is low; no SPI evidence found in the current pack; retry with apps/out/graph.json or another SPI-scoped graph; root graph is broad for this question; retrieved evidence is concentrated under apps/)) | true | — | 1558889 (1558889-1558889, n=1) | 151959 (151959-151959, n=1) | — | 30 (30-30, n=1) | 4 (4-4, n=1) | — | 12 (12-12, n=1) | 1 (1-1, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 242303 (242303-242303, n=1) | 54882 (54882-54882, n=1) | — | 1.42 (1.42-1.42, n=1) | 0.33 (0.33-0.33, n=1) | — | — |
