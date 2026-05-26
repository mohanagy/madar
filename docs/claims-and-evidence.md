# Claims and evidence

This file is the public map between what Madar says and what the repo can actually prove today.

## Demonstrated today

| Claim | Surface | Evidence |
| --- | --- | --- |
| Madar builds local, task-aware, verifiable context packs from graph artifacts. | `README.md`, install docs, package metadata | `madar generate`, `madar pack`, Pack Schema v1 surfaces, MCP tool docs |
| `execution_slice` is a static runtime-path hypothesis, not a live trace. | `README.md`, tutorials, proof docs | runtime-routing docs and tests, benchmark artifacts that persist static slice output |
| Madar can publish share-safe compare artifacts. | `README.md`, benchmark docs | `report.share-safe.json` artifacts in `docs/benchmarks/**` |
| Some repo/task pairs show token and cost wins on explain-style work. | `README.md`, benchmark receipts | Dated artifact folders under `docs/benchmarks/` |

## In progress

| Claim | Current status | Next evidence |
| --- | --- | --- |
| Strict install guidance reduces exploration in practice. | Mixed evidence today; the FounderCommandCenter contrast note shows a regression case where the pack was treated as extra context instead of a stop condition. | Track per-repo/task tool-call spread and future measured rows under [`docs/benchmarks/suite/`](docs/benchmarks/suite/README.md). |
| Public benchmark claims should be reproducible across repos. | The repo now ships the fixed manifests, methodology, `madar bench:suite` runner, and the first measured warm-cache `nestjs-mid` / `explain-runtime` row. The broader matrix is still incomplete. | Add more measured rows under `docs/benchmarks/suite/results/` and keep the manifests/methodology current. |

## Not yet measured

| Claim | Why it is not public copy today |
| --- | --- |
| Fewer wrong-file edits | We do not yet have an implementation-task benchmark that measures edit correctness. |
| Universal turns / latency / exploration wins | Public receipts are repo- and prompt-specific; they do not justify a single-number cross-repo headline. |
| Agent always stops exploring after one pack | Madar can shape the first pass, but it does not control the runtime or guarantee tool behavior. |

## How this maps to README.md

- `README.md` should only state what is demonstrated, what is in progress, and what is not yet measured.
- Any new public claim should link back to a dated artifact or to the reproducible suite surface under [`docs/benchmarks/suite/`](docs/benchmarks/suite/README.md).
- When evidence is mixed, the README should say that directly and point to the counterexample note or issue instead of smoothing it into marketing.

## Related evidence

- [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](docs/benchmarks/2026-05-25-founder-command-center-auth-flow/README.md) — mixed exploration evidence, including the FounderCommandCenter contrast note.
- [`docs/benchmarks/govalidate-suite/`](docs/benchmarks/govalidate-suite/README.md) — public prompt set plus deterministic pack/answer quality gates.
- [`docs/benchmarks/suite/`](docs/benchmarks/suite/README.md) — fixed manifests, methodology, CLI runner, and per-repo spread results.
- [`docs/benchmarks/suite/results/2026-05-26T18-31-04/summary.md`](docs/benchmarks/suite/results/2026-05-26T18-31-04/summary.md) — first measured warm-cache `nestjs-mid` / `explain-runtime` suite row.
