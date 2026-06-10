# Benchmark suite summary

- Generated: 2026-06-10T07:38:58.182Z
- Filters: repo=dub, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dub | completed | legacy: full_win (routing/tool/latency win: tool calls 9 → 2, latency 69364ms → 30246ms; provider input win: baseline 233038 → madar 76538; turns win: baseline 10 → madar 3; fresh_token win: baseline 33088 → madar 15847; cost win: baseline 0.392839 → madar 0.15703375); SPI: partial_win (routing/tool/latency loss: tool calls 6 → 2, latency 66711ms → 79814ms; provider input win: baseline 223715 → madar 75033; turns win: baseline 7 → madar 3; fresh_token win: baseline 29692 → madar 15171; cost win: baseline 0.3587505 → madar 0.14159425) | true | — | 233038 (233038-233038, n=1) | 76538 (76538-76538, n=1) | 75033 (75033-75033, n=1) | 9 (9-9, n=1) | 2 (2-2, n=1) | 2 (2-2, n=1) | 6 (6-6, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 69364 (69364-69364, n=1) | 30246 (30246-30246, n=1) | 79814 (79814-79814, n=1) | 0.39 (0.39-0.39, n=1) | 0.16 (0.16-0.16, n=1) | 0.14 (0.14-0.14, n=1) | — |
