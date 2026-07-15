# Benchmark suite summary

- Generated: 2026-07-15T07:41:25.132Z
- Runtime artifact: source=npm_pack, package=0.31.0, tarball_sha256=sha256:9c0192e2abf390cf95aeaf89efbcbe6b8b45c19a139760df554e168542e95b4e
- Filters: repo=formbricks, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| formbricks | completed | legacy: not_measured (prompt contract is not_measured (broad exploration occurred after the first Madar call, but the trace does not show whether missing_context justified it)); SPI: not_measured (prompt contract is not_measured (broad exploration occurred after the first Madar call, but the trace does not show whether missing_context justified it); answer quality failed for baseline: missing survey, missing analytics, missing direct evidence citation: request handling, missing direct evidence citation: persistence, forbidden not directly) | true | — | 693087 (693087-693087, n=1) | 863556 (863556-863556, n=1) | 1937449 (1937449-1937449, n=1) | 20 (20-20, n=1) | 19 (19-19, n=1) | 34 (34-34, n=1) | 5 (5-5, n=1) | 5 (5-5, n=1) | 6 (6-6, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 353003 (353003-353003, n=1) | 135292 (135292-135292, n=1) | 250307 (250307-250307, n=1) | 2.56 (2.56-2.56, n=1) | 1.03 (1.03-1.03, n=1) | 1.82 (1.82-1.82, n=1) | — |
