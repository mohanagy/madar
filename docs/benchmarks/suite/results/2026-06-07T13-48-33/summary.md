# Benchmark suite summary

- Generated: 2026-06-07T13:54:29.640Z
- Filters: repo=formbricks, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| formbricks | completed | legacy: full_win (routing/tool/latency win: tool calls 15 → 3, latency 96144ms → 46137ms; provider input win: baseline 387542 → madar 115174; turns win: baseline 16 → madar 4; fresh_token win: baseline 32241 → madar 26005; cost win: baseline 0.5077094999999999 → madar 0.25829325000000003) | true | — | 387542 (387542-387542, n=1) | 115174 (115174-115174, n=1) | — | 15 (15-15, n=1) | 3 (3-3, n=1) | — | 5 (5-5, n=1) | 1 (1-1, n=1) | — | 0 (0-0, n=1) | 0 (0-0, n=1) | — | 96144 (96144-96144, n=1) | 46137 (46137-46137, n=1) | — | 0.51 (0.51-0.51, n=1) | 0.26 (0.26-0.26, n=1) | — | — |
