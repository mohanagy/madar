# Benchmark suite summary

- Generated: 2026-06-10T07:10:31.479Z
- Filters: repo=documenso, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| documenso | completed | legacy: full_win (routing/tool/latency win: tool calls 7 → 2, latency 58244ms → 35277ms; provider input win: baseline 174504 → madar 76721; turns win: baseline 8 → madar 3; fresh_token win: baseline 31754 → madar 16001; cost win: baseline 0.34977474999999997 → madar 0.16343675); SPI: not_measured (benchmark readiness is not_ready (missing runtime proof obligations: send preparation; runtime slice confidence is medium)) | true | — | 174504 (174504-174504, n=1) | 76721 (76721-76721, n=1) | 125389 (125389-125389, n=1) | 7 (7-7, n=1) | 2 (2-2, n=1) | 3 (3-3, n=1) | 4 (4-4, n=1) | 0 (0-0, n=1) | 1 (1-1, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 58244 (58244-58244, n=1) | 35277 (35277-35277, n=1) | 63359 (63359-63359, n=1) | 0.35 (0.35-0.35, n=1) | 0.16 (0.16-0.16, n=1) | 0.31 (0.31-0.31, n=1) | — |
