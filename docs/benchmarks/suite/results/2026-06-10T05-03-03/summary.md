# Benchmark suite summary

- Generated: 2026-06-10T05:18:01.212Z
- Filters: repo=dub, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dub | completed | legacy: full_win (routing/tool/latency win: tool calls 10 → 2, latency 68252ms → 27765ms; provider input win: baseline 234403 → madar 75012; turns win: baseline 11 → madar 3; fresh_token win: baseline 32429 → madar 15123; cost win: baseline 0.40174475 → madar 0.14164025); SPI: partial_win (routing/tool/latency loss: tool calls 7 → 3, latency 68726ms → 87088ms; provider input win: baseline 265060 → madar 101799; turns win: baseline 8 → madar 4; fresh_token win: baseline 30313 → madar 21707; cost win: baseline 0.3955475 → madar 0.19614675) | true | — | 234403 (234403-234403, n=1) | 75012 (75012-75012, n=1) | 101799 (101799-101799, n=1) | 10 (10-10, n=1) | 2 (2-2, n=1) | 3 (3-3, n=1) | 6 (6-6, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 68252 (68252-68252, n=1) | 27765 (27765-27765, n=1) | 87088 (87088-87088, n=1) | 0.40 (0.40-0.40, n=1) | 0.14 (0.14-0.14, n=1) | 0.20 (0.20-0.20, n=1) | — |
