# Benchmark suite summary

- Generated: 2026-06-10T08:24:39.535Z
- Filters: repo=cal-diy, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cal-diy | completed | legacy: full_win (routing/tool/latency win: tool calls 37 → 3, latency 252042ms → 38718ms; provider input win: baseline 1588241 → madar 101820; turns win: baseline 38 → madar 4; fresh_token win: baseline 61669 → madar 21688; cost win: baseline 1.4263435 → madar 0.194639) | true | — | 1588241 (1588241-1588241, n=1) | 101820 (101820-101820, n=1) | — | 37 (37-37, n=1) | 3 (3-3, n=1) | — | 12 (12-12, n=1) | 0 (0-0, n=1) | — | 1 (1-1, n=1) | 0 (0-0, n=1) | — | 252042 (252042-252042, n=1) | 38718 (38718-38718, n=1) | — | 1.43 (1.43-1.43, n=1) | 0.19 (0.19-0.19, n=1) | — | — |
