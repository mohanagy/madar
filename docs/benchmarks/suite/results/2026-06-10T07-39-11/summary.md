# Benchmark suite summary

- Generated: 2026-06-10T08:08:31.545Z
- Filters: repo=twenty, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| twenty | completed | legacy: full_win (routing/tool/latency win: tool calls 21 → 3, latency 128535ms → 58704ms; provider input win: baseline 694972 → madar 103125; turns win: baseline 22 → madar 4; fresh_token win: baseline 48000 → madar 22355; cost win: baseline 0.7999594999999997 → madar 0.2068585); SPI: partial_win (routing/tool/latency loss: tool calls 18 → 3, latency 108643ms → 142883ms; provider input win: baseline 592076 → madar 111021; turns win: baseline 19 → madar 4; fresh_token win: baseline 44209 → madar 29866; cost win: baseline 0.6878869999999999 → madar 0.27005599999999996) | true | — | 694972 (694972-694972, n=1) | 103125 (103125-103125, n=1) | 111021 (111021-111021, n=1) | 21 (21-21, n=1) | 3 (3-3, n=1) | 3 (3-3, n=1) | 7 (7-7, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 128535 (128535-128535, n=1) | 58704 (58704-58704, n=1) | 142883 (142883-142883, n=1) | 0.80 (0.80-0.80, n=1) | 0.21 (0.21-0.21, n=1) | 0.27 (0.27-0.27, n=1) | — |
