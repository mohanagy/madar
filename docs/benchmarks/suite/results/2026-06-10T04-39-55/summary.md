# Benchmark suite summary

- Generated: 2026-06-10T04:48:37.521Z
- Filters: repo=documenso, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| documenso | completed | legacy: full_win (routing/tool/latency win: tool calls 10 → 2, latency 66587ms → 31291ms; provider input win: baseline 229298 → madar 76631; turns win: baseline 11 → madar 3; fresh_token win: baseline 44489 → madar 15956; cost win: baseline 0.46768925 → madar 0.1555605); SPI: not_measured (benchmark readiness is not_ready (missing runtime proof obligations: send preparation; runtime slice confidence is medium)) | true | — | 229298 (229298-229298, n=1) | 76631 (76631-76631, n=1) | 124125 (124125-124125, n=1) | 10 (10-10, n=1) | 2 (2-2, n=1) | 3 (3-3, n=1) | 7 (7-7, n=1) | 0 (0-0, n=1) | 1 (1-1, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 66587 (66587-66587, n=1) | 31291 (31291-31291, n=1) | 41516 (41516-41516, n=1) | 0.47 (0.47-0.47, n=1) | 0.16 (0.16-0.16, n=1) | 0.30 (0.30-0.30, n=1) | — |
