# Benchmark suite summary

- Generated: 2026-07-15T07:08:04.606Z
- Runtime artifact: source=npm_pack, package=0.31.0, tarball_sha256=sha256:9c0192e2abf390cf95aeaf89efbcbe6b8b45c19a139760df554e168542e95b4e
- Filters: repo=documenso, task=explain-runtime, mode=warm, trials=1
- cells_skipped_for_install: 0 (preparation failures)
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| documenso | completed | legacy: not_measured (prompt contract is violated (focused follow-up did not target missing runtime obligation: send preparation); answer quality failed for baseline: missing direct evidence citation: recipient creation; answer quality failed for madar: missing direct evidence citation: send preparation, missing direct evidence citation: signing state, missing direct evidence citation: notification delivery); SPI: not_measured (prompt contract is violated (focused follow-up did not target missing runtime obligation: send preparation); answer quality failed for baseline: missing direct evidence citation: recipient creation, missing direct evidence citation: notification delivery; answer quality failed for madar: missing direct evidence citation: send preparation, missing direct evidence citation: recipient creation, missing direct evidence citation: signing state, missing direct evidence citation: notification delivery) | true | — | 348895 (348895-348895, n=1) | 194638 (194638-194638, n=1) | 120717 (120717-120717, n=1) | 11 (11-11, n=1) | 5 (5-5, n=1) | 4 (4-4, n=1) | 7 (7-7, n=1) | 1 (1-1, n=1) | 2 (2-2, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 0 (0-0, n=1) | 87129 (87129-87129, n=1) | 59033 (59033-59033, n=1) | 40264 (40264-40264, n=1) | 0.63 (0.63-0.63, n=1) | 0.40 (0.40-0.40, n=1) | 0.30 (0.30-0.30, n=1) | — |
