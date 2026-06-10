# Benchmark suite summary

- Generated: 2026-06-10T05:46:04.476Z
- Filters: repo=twenty, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| twenty | completed | legacy: full_win (routing/tool/latency win: tool calls 18 → 2, latency 120091ms → 57526ms; provider input win: baseline 555654 → madar 75817; turns win: baseline 19 → madar 3; fresh_token win: baseline 48051 → madar 15506; cost win: baseline 0.6981324999999999 → madar 0.1613315); SPI: full_win (routing/tool/latency win: tool calls 19 → 4, latency 153961ms → 141220ms; provider input win: baseline 725706 → madar 137307; turns win: baseline 20 → madar 5; fresh_token win: baseline 51410 → madar 29156; cost win: baseline 0.8655489999999999 → madar 0.269234) | true | — | 555654 (555654-555654, n=1) | 75817 (75817-75817, n=1) | 137307 (137307-137307, n=1) | 18 (18-18, n=1) | 2 (2-2, n=1) | 4 (4-4, n=1) | 7 (7-7, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 120091 (120091-120091, n=1) | 57526 (57526-57526, n=1) | 141220 (141220-141220, n=1) | 0.70 (0.70-0.70, n=1) | 0.16 (0.16-0.16, n=1) | 0.27 (0.27-0.27, n=1) | — |
