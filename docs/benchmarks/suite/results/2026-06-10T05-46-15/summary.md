# Benchmark suite summary

- Generated: 2026-06-10T06:02:53.091Z
- Filters: repo=cal-diy, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cal-diy | completed | legacy: full_win (routing/tool/latency win: tool calls 18 → 2, latency 142588ms → 36174ms; provider input win: baseline 657606 → madar 75812; turns win: baseline 19 → madar 3; fresh_token win: baseline 35300 → madar 15516; cost win: baseline 0.6985805 → madar 0.15337974999999998) | true | — | 657606 (657606-657606, n=1) | 75812 (75812-75812, n=1) | — | 18 (18-18, n=1) | 2 (2-2, n=1) | — | 3 (3-3, n=1) | 0 (0-0, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 142588 (142588-142588, n=1) | 36174 (36174-36174, n=1) | — | 0.70 (0.70-0.70, n=1) | 0.15 (0.15-0.15, n=1) | — | — |
