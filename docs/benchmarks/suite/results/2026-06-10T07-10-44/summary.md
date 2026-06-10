# Benchmark suite summary

- Generated: 2026-06-10T07:23:48.485Z
- Filters: repo=formbricks, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| formbricks | completed | legacy: full_win (routing/tool/latency win: tool calls 37 → 2, latency 157645ms → 22559ms; provider input win: baseline 163482 → madar 74395; turns win: baseline 6 → madar 3; fresh_token win: baseline 19471 → madar 14663; cost win: baseline 0.4972762999999999 → madar 0.1349815); SPI: not_measured (benchmark readiness is not_ready (missing runtime proof obligations: persistence; runtime slice confidence is low)) | true | — | 163482 (163482-163482, n=1) | 74395 (74395-74395, n=1) | 120683 (120683-120683, n=1) | 37 (37-37, n=1) | 2 (2-2, n=1) | 3 (3-3, n=1) | 22 (22-22, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 157645 (157645-157645, n=1) | 22559 (22559-22559, n=1) | 44711 (44711-44711, n=1) | 0.50 (0.50-0.50, n=1) | 0.13 (0.13-0.13, n=1) | 0.27 (0.27-0.27, n=1) | — |
