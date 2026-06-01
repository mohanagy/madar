# Claims and evidence

This file is the public map between what Madar says and what the repo can actually prove today.

## Demonstrated today

| Claim | Surface | Evidence |
| --- | --- | --- |
| 4x fewer tool calls on the verified GoValidate backend explain cell. | `README.md`, `CHANGELOG.md` | [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.json`](docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.json) (`tool_call_counts.baseline.total = 28`, `tool_call_counts.madar.total = 7`) |
| 4.75x fewer input tokens, 2.21x fewer uncached input tokens, 2.2x lower latency, and 2.73x lower cost on that same cell. | `README.md`, `CHANGELOG.md` | Same artifact (`reductions.input_tokens = 4.75`, `reductions.uncached_input_tokens = 2.21`, `reductions.duration_ms = 2.2`, `reductions.cost_usd = 2.73`) |
| The verified release cell stayed bounded after the first Madar call. | `README.md`, benchmark notes | Same artifact (`install_verified = true`, `measurement_validity = "valid"`, `madar_trace.madar_mcp_call_count = 1`, `madar_trace.exploration_outcome = "madar_invoked"`, `madar_trace.broad_exploration_tool_call_count = 0`) |
| Madar ships deterministic, share-safe benchmark receipts. | `README.md`, benchmark docs | [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.share-safe.json`](docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.share-safe.json) and other `report.share-safe.json` artifacts under `docs/benchmarks/**` |
| Pack Schema v1 and the MCP response shape are documented surfaces, not ad hoc output. | `README.md`, pack docs | [`docs/mcp-response-shape.md`](docs/mcp-response-shape.md), `tests/unit/pack-quality-fixtures.test.ts`, `tests/unit/pack-quality-helper.test.ts` |

## In progress

| Claim | Current status | Next evidence |
| --- | --- | --- |
| Public benchmark claims should hold up as per-repo receipts instead of a single headline number. | The repo now publishes small-library, service, and monorepo fixture-style rows under [`docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md`](docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md), including initial implement/review workflow-outcome receipts, but that matrix is still proxy-heavy and repo-specific. | Add more measured rows under `docs/benchmarks/suite/results/`, especially public Python/Go targets and more non-fixture prompts, while keeping each row tied to its repo/task cell. |
| Madar can be scored on bounded implementation-task correctness signals. | A deterministic implementation-task receipt now exists under [`docs/benchmarks/2026-05-31-implement-outcome/`](docs/benchmarks/2026-05-31-implement-outcome/README.md). It records files touched, wrong-file edits, validation commands, and reviewer-visible correctness on an isolated fixture harness without turning that one row into a generalized product claim. | Add more implementation rows across distinct repos/tasks, then promote only the metrics that stay stable across cells. |
| Install-guided bounded retrieval should hold across more repos and prompts. | Evidence is mixed today; the FounderCommandCenter contrast note shows a case where the pack acted as extra context instead of a stop condition. | Keep publishing counterexamples and positive receipts side-by-side, starting with [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](docs/benchmarks/2026-05-25-founder-command-center-auth-flow/README.md) and future suite rows. |

## Not yet measured

| Claim | Why it is not public copy today |
| --- | --- |
| Madar improves implementation outcomes across repos or consistently avoids wrong-file edits. | We now have one deterministic implementation-task receipt and initial implement/review workflow-outcome suite rows, but we do not yet have cross-repo implementation-task evidence strong enough for a generalized public win claim. Track broader validation under [#332](https://github.com/mohanagy/madar/issues/332). |
| Lower-confidence packs behave as well as the demonstrated high-confidence release cell. | The `0.27.0` public receipt is one strong, install-verified explain cell; medium/low-confidence prompts still need their own measured rows. |
| A universal turns / latency / exploration win across repos. | Public receipts are repo- and prompt-specific, so they do not justify a single-number cross-repo headline. |
| The agent always stops exploring after one pack. | Madar shapes the first pass, but it does not control the runtime or guarantee tool behavior. |

## How this maps to README.md

- `README.md` should state the demonstrated release cell, the benchmark-suite direction, and the not-yet-measured limits in the same place.
- Any new public claim should link back to a dated artifact or to the reproducible suite surface under [`docs/benchmarks/suite/`](docs/benchmarks/suite/README.md).
- When evidence is mixed, the README should say that directly and point to the counterexample note or issue instead of smoothing it into marketing.

## Related evidence

- [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/`](docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/) — the verified `0.27.0` release cell cited in `README.md` and `CHANGELOG.md`.
- [`docs/benchmarks/2026-05-31-implement-outcome/`](docs/benchmarks/2026-05-31-implement-outcome/README.md) — deterministic implementation-task receipt with isolated workspaces, validation, and reviewer-visible correctness checks.
- [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](docs/benchmarks/2026-05-25-founder-command-center-auth-flow/README.md) — mixed exploration evidence, including the FounderCommandCenter contrast note.
- [`docs/benchmarks/govalidate-suite/`](docs/benchmarks/govalidate-suite/README.md) — public prompt set plus deterministic pack/answer quality gates.
- [`docs/benchmarks/suite/`](docs/benchmarks/suite/README.md) — fixed manifests, methodology, CLI runner, and per-repo spread results.
- [`docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md`](docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md) — the first multi-shape suite bundle, including initial implement/review workflow-outcome rows.
- [`docs/benchmarks/suite/results/2026-05-26T18-31-04/summary.md`](docs/benchmarks/suite/results/2026-05-26T18-31-04/summary.md) — the first measured warm-cache `nestjs-mid` / `explain-runtime` suite row.
