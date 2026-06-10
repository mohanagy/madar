# Benchmark suite summary

- Generated: 2026-06-10T05:02:49.558Z
- Filters: repo=formbricks, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| formbricks | completed | legacy: full_win (routing/tool/latency win: tool calls 41 → 2, latency 184178ms → 22169ms; provider input win: baseline 253607 → madar 74755; turns win: baseline 11 → madar 3; fresh_token win: baseline 27859 → madar 14887; cost win: baseline 0.6117960499999999 → madar 0.1364245); SPI: not_measured (prompt contract is violated (focused follow-up did not target missing runtime obligation: persistence); benchmark readiness is not_ready (missing runtime proof obligations: persistence; runtime slice confidence is low)) | true | — | 253607 (253607-253607, n=1) | 74755 (74755-74755, n=1) | 116577 (116577-116577, n=1) | 41 (41-41, n=1) | 2 (2-2, n=1) | 3 (3-3, n=1) | 18 (18-18, n=1) | 0 (0-0, n=1) | 1 (1-1, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 184178 (184178-184178, n=1) | 22169 (22169-22169, n=1) | 48625 (48625-48625, n=1) | 0.61 (0.61-0.61, n=1) | 0.14 (0.14-0.14, n=1) | 0.25 (0.25-0.25, n=1) | — |
