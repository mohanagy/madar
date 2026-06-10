# Benchmark suite summary

- Generated: 2026-06-10T08:37:24.906Z
- Filters: repo=novu, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| novu | completed | legacy: full_win (routing/tool/latency win: tool calls 23 → 2, latency 220340ms → 31075ms; provider input win: baseline 1055389 → madar 75772; turns win: baseline 24 → madar 3; fresh_token win: baseline 63542 → madar 15491; cost win: baseline 1.1315955 → madar 0.16203) | true | — | 1055389 (1055389-1055389, n=1) | 75772 (75772-75772, n=1) | — | 23 (23-23, n=1) | 2 (2-2, n=1) | — | 4 (4-4, n=1) | 0 (0-0, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 220340 (220340-220340, n=1) | 31075 (31075-31075, n=1) | — | 1.13 (1.13-1.13, n=1) | 0.16 (0.16-0.16, n=1) | — | — |
