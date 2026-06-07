# 2026-06-07 — Twenty scoped server-modules runtime compare

This folder records a refreshed isolated `native_agent` compare receipt for [`twentyhq/twenty`](https://github.com/twentyhq/twenty), scoped to `packages/twenty-server/src/modules`.

The root `twenty` suite row is still too large for the compare safety guard: the generated root graph exceeded the 10 MB `validateGraphPath()` limit, so the suite could not publish a root-repo `summary.md` row for `twenty`. This scoped receipt keeps the benchmark honest instead of fabricating a root-repo result.

## Scope

- **Repo:** `twentyhq/twenty`
- **Scoped graph root:** `packages/twenty-server/src/modules`
- **Question:** `How does Twenty process a CRM record mutation from API handling through workspace services to persistence?`
- **Runner:** `cat {prompt_file} | claude -p --output-format json --verbose --allowedTools mcp__madar__retrieve`
- **Isolation:** `true`
- **Publication contract:** `report.json` is the checked-in share-safe alias of `report.share-safe.json`

## Result status

This receipt is **supplemental evidence only**.

1. `measurement_validity = "valid"` and `trace_status = "trace_available"`, so the run itself is real.
2. `benchmark_readiness.status = "not_ready"`, so both `claim_assessment` and `benchmark_outcome = "not_measured"`.
3. The raw counters improved, but that is **not** a benchmark win for public copy because the scoped graph still missed downstream persistence and suggested `messaging/out/graph.json` as the next slice.
4. The checked-in `madar-answer.txt` is now a real answer artifact instead of a permission prompt, but it still documents the current graph gap rather than proving a clean end-to-end Twenty mutation trace.

## Raw counters from the refreshed run

| Metric | Baseline | Madar | Raw delta |
| --- | ---: | ---: | ---: |
| Tool calls | 14 | **2** | **7x fewer** |
| Turns | 15 | **3** | **5x fewer** |
| Latency | 105,673 ms | **23,471 ms** | **4.5x faster** |
| Input tokens (Anthropic-reported) | 349,977 | **97,981** | **3.57x less** |
| Cost (USD) | 0.522845 | **0.293223** | **1.78x less** |

## Important interpretation notes

1. This is a **scoped server-modules receipt**, not a full-root suite row for the whole `twenty` monorepo.
2. The refreshed report now checks in real answer artifacts, but the answer remains a counterexample: it explicitly says the current graph slice does not surface the Twenty CRM mutation path.
3. Because `benchmark_outcome = "not_measured"`, treat this folder as a share-safe receipt and debugging aid, not as headline benchmark proof.
4. The right next step for suite parity is either a better scoped graph that covers the persistence path or scoped-root support for very large public monorepos so `twenty` can land as a first-class suite row.

## Files in this directory

- `README.md` — this file
- `report.share-safe.json` — the refreshed share-safe compare receipt
- `report.json` — checked-in alias of `report.share-safe.json`
- `baseline-answer.txt` — checked-in baseline answer artifact
- `madar-answer.txt` — checked-in Madar answer artifact
- `baseline-prompt.txt` — checked-in baseline prompt
- `madar-prompt.txt` — checked-in Madar prompt
