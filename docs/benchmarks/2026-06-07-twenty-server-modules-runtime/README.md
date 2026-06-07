# 2026-06-07 — Twenty scoped server-modules runtime compare

This folder records a real isolated `native_agent` compare receipt for [`twentyhq/twenty`](https://github.com/twentyhq/twenty), scoped to `packages/twenty-server/src/modules`.

The root `twenty` suite row is currently too large for the compare safety guard: the generated root graph exceeded the 10 MB `validateGraphPath()` limit, so the suite could not publish a root-repo `summary.md` row for `twenty` yet. This scoped receipt keeps the benchmark honest instead of fabricating a root-repo result.

## Scope

- **Repo:** `twentyhq/twenty`
- **Scoped graph root:** `packages/twenty-server/src/modules`
- **Question:** `How does Twenty process a CRM record mutation from API handling through workspace services to persistence?`
- **Runner:** `cat {prompt_file} | claude -p --output-format json --verbose`
- **Isolation:** `true`
- **Publication contract:** `report.json` is the checked-in share-safe alias of `report.share-safe.json`

## Headline numbers

| Metric | Baseline | Madar | Outcome |
| --- | ---: | ---: | ---: |
| Tool calls | 68 | **3** | **22.67x fewer** |
| Turns | 7 | **4** | **1.75x fewer** |
| Latency | 361,671 ms | **18,850 ms** | **19.19x faster** |
| Input tokens (Anthropic-reported) | 233,365 | **114,476** | **2.04x less** |
| Cost (USD) | 0.79588485 | **0.2344645** | **3.39x less** |

## Important interpretation notes

1. This is a **scoped server-modules receipt**, not a full-root suite row for the whole `twenty` monorepo.
2. The receipt is still a **valid isolated compare run**: `measurement_validity = "valid"`, `trace_status = "trace_available"`, and `madar_mcp_call_count = 2`.
3. `benchmark_readiness.status` remains `not_ready` because the retrieved slice still missed downstream persistence and suggested an even narrower next graph (`messaging/out/graph.json`). Treat this as bounded workflow evidence, not a generalized product claim for the whole repo.
4. The right next step for suite parity is adding scoped-root support for very large public monorepos so `twenty` can land as a first-class suite row instead of a sibling receipt.

## Files in this directory

- `README.md` — this file
- `report.share-safe.json` — the share-safe compare receipt
- `report.json` — checked-in alias of `report.share-safe.json`
