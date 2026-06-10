# Benchmark suite summary

- Generated: 2026-06-10T06:13:02.035Z
- Filters: repo=novu, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| novu | completed | legacy: full_win (routing/tool/latency win: tool calls 11 → 3, latency 103788ms → 32470ms; provider input win: baseline 430221 → madar 102456; turns win: baseline 12 → madar 4; fresh_token win: baseline 34648 → madar 21970; cost win: baseline 0.558867 → madar 0.20143375) | true | — | 430221 (430221-430221, n=1) | 102456 (102456-102456, n=1) | — | 11 (11-11, n=1) | 3 (3-3, n=1) | — | 3 (3-3, n=1) | 0 (0-0, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 103788 (103788-103788, n=1) | 32470 (32470-32470, n=1) | — | 0.56 (0.56-0.56, n=1) | 0.20 (0.20-0.20, n=1) | — | — |
