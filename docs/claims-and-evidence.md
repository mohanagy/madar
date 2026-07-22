# Claims and evidence

This file is the public map between what Madar says and what the repo can actually prove today.

## Demonstrated today

| Claim | Surface | Evidence |
| --- | --- | --- |
| 4x fewer tool calls on the verified GoValidate backend explain cell. | `CHANGELOG.md`, benchmark notes | [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.json`](./benchmarks/regression/0.27.0-next.4-govalidate-explain/report.json) (`tool_call_counts.baseline.total = 28`, `tool_call_counts.madar.total = 7`) |
| 4.75x fewer input tokens, 2.21x fewer uncached input tokens, 2.2x lower latency, and 2.73x lower cost on that same cell. | `CHANGELOG.md`, benchmark notes | Same artifact (`reductions.input_tokens = 4.75`, `reductions.uncached_input_tokens = 2.21`, `reductions.duration_ms = 2.2`, `reductions.cost_usd = 2.73`) |
| The verified release cell stayed bounded after the first Madar call. | Benchmark notes | Same artifact (`install_verified = true`, `measurement_validity = "valid"`, `madar_trace.madar_mcp_call_count = 1`, `madar_trace.exploration_outcome = "madar_invoked"`, `madar_trace.broad_exploration_tool_call_count = 0`) |
| Six controlled v0.30 source-checkout trials recorded lower tool-call, provider-input, latency, and cost counters when Madar was given task-specific runtime-proof profiles. | `README.md`, benchmark suite | The six June 10 receipts under [`docs/benchmarks/suite/results/`](./benchmarks/suite/README.md) record `full_win` under the gates used at the time, one attributable Madar call per row, tool-call reductions from 3.5x to 18.5x, provider-input reductions from 2.2x to 15.6x, and latency reductions from 1.65x to 7.09x. This is controlled profile-assisted evidence, not untuned npm-package proof. |
| Madar ships deterministic, share-safe benchmark receipts. | `README.md`, benchmark docs | [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/report.share-safe.json`](./benchmarks/regression/0.27.0-next.4-govalidate-explain/report.share-safe.json) and other `report.share-safe.json` artifacts under `docs/benchmarks/**` |
| The public benchmark harness fails closed when Madar attribution or strict answer contracts are missing. | `README.md`, benchmark suite | The six July 15 packed-artifact summaries under [`docs/benchmarks/suite/results/`](./benchmarks/suite/README.md) all report `not_measured`; no resource delta is promoted as a win. |
| Pack Schema v1 and the MCP response shape are documented surfaces, not ad hoc output. | `README.md`, pack docs | [`docs/mcp-response-shape.md`](./mcp-response-shape.md), `tests/unit/pack-quality-fixtures.test.ts`, `tests/unit/pack-quality-helper.test.ts` |

## In progress

| Claim | Current status | Next evidence |
| --- | --- | --- |
| Public benchmark claims should hold up as per-repo receipts instead of a single headline number. | The June 10 TypeScript receipts remain valid as controlled profile-assisted measurements, but their setup included exact proof obligations and checkout-only retrieval profiles unavailable to npm users. All six affected rows were rerun on July 15 from the same unpacked `@lubab/madar@0.31.0` tarball with untuned production retrieval and strict gates; none reached a valid performance comparison. `documenso` and `formbricks` failed prompt/answer gates, while `dub`, `twenty`, `cal-diy`, and `novu` recorded no attributable Madar MCP call. These are different experiments: the July results neither confirm nor refute the earlier controlled efficiency measurements. Human review remains separately `pending` and cannot override machine ineligibility. | Improve verified-tool discoverability and agent adoption, tighten the prompt/answer path, then rerun repeated trials. Publish a production-default performance claim only for rows that invoke Madar, pass deterministic gates, and receive separate human review. |
| Madar can be scored on bounded implementation-task correctness signals. | A deterministic implementation-task receipt now exists under [`docs/benchmarks/2026-05-31-implement-outcome/`](./benchmarks/2026-05-31-implement-outcome/README.md). It records files touched, wrong-file edits, validation commands, and reviewer-visible correctness on an isolated fixture harness without turning that one row into a generalized product claim. | Add more implementation rows across distinct repos/tasks, then promote only the metrics that stay stable across cells. |
| Install-guided bounded retrieval should hold across more repos and prompts. | Evidence is mixed today; the FounderCommandCenter contrast note shows a case where the pack acted as extra context instead of a stop condition. | Keep publishing counterexamples and positive receipts side-by-side, starting with [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](./benchmarks/2026-05-25-founder-command-center-auth-flow/README.md) and future suite rows. |
| Madar can act as a context/evidence layer for review and security tools. | The README and proof-workflow docs now map `pr_impact`, `review-compare`, `madar handoff`, and `report.share-safe.json` onto review/security workflows with CodeRabbit, Qodo, and Codex Security. That is workflow guidance, not a measured superiority claim. | Publish dated review/security evaluation receipts that compare overlap, misses, and human follow-up on the same diff while keeping the artifacts share-safe. |
| Madar can publish customer-style workflow proof as bounded drafts before more live partner receipts exist. | The repo now has **design-partner workflow** drafts under [`docs/benchmarks/2026-06-01-design-partner-workflow-loops/`](./benchmarks/2026-06-01-design-partner-workflow-loops/README.md). They are **anonymized** **workflow-loop notes** and **synthetic reproductions**, not yet five live design partners. | Replace the draft bundle with more repeated partner-approved receipts or stronger synthetic reproductions that preserve the same share-safe boundary. |
| Madar can make federation a flagship multi-repo enterprise workflow in public docs without overclaiming benchmark breadth. | The repo now has a **synthetic federation receipt** under [`docs/benchmarks/2026-06-01-federation-flagship/`](./benchmarks/2026-06-01-federation-flagship/README.md), backed by checked-in `frontend` / `backend` / `shared` graph fixtures under `tests/fixtures/federation-flagship/`. The current cross-repo proof comes from **shared labels**, so it is useful workflow evidence, not a broad cross-repo benchmark headline. | Replace the synthetic receipt with dated real-repo federation receipts or a broader measured benchmark before promoting stronger enterprise claims. |

## Not yet measured

| Claim | Why it is not public copy today |
| --- | --- |
| Madar improves implementation outcomes across repos or consistently avoids wrong-file edits. | We now have one deterministic implementation-task receipt and initial implement/review workflow-outcome suite rows, but we do not yet have cross-repo implementation-task evidence strong enough for a generalized public win claim. Track broader validation under [#332](https://github.com/mohanagy/madar/issues/332). |
| Madar improves CodeRabbit, Qodo, Codex Security, or other review and security tools by default. | There is no comparative review/security evaluation yet that is broad enough to support a public superiority claim. Current docs describe workflow fit and share-safe evidence surfaces, but no comparative review/security evaluation has been published. |
| Madar already has five live design partners proving repeated workflow wins. | The repo now has anonymized design-partner drafts and synthetic reproductions, but **not yet five live design partners** or a public multi-partner workflow outcome set. |
| Lower-confidence packs behave as well as the demonstrated high-confidence release cell. | The `0.27.0` public receipt is one strong, install-verified explain cell; medium/low-confidence prompts still need their own measured rows. |
| A universal turns / latency / exploration win across repos. | Public receipts are repo- and prompt-specific, so they do not justify a single-number cross-repo headline. |
| The agent always stops exploring after one pack. | Madar shapes the first pass, but it does not control the runtime or guarantee tool behavior. |

## Competitive positioning

This is a capability/scope summary, not a benchmark claim or quality verdict.

| Tool | Best first use | Where it stops |
| --- | --- | --- |
| **Madar** | Task-scoped local repo evidence for explain, review, and impact work on large TypeScript/Node repos | Not a hosted knowledge base or broad cross-language parity tool today |
| **Repomix** | Exporting or sharing a broad repo snapshot/prompt bundle | Not a task-aware local retrieval layer, PR-impact surface, or agent install flow |
| **Context7** | Pulling external library/framework docs into prompts | Not a local codebase analysis, PR-impact, or graph-backed repository context tool |

Use this as a scope summary, not a benchmark claim. If a future README or sales surface makes a stronger comparative claim, it must link to dated evidence first.

## How this maps to README.md

- `README.md` should lead with first-use value, then distinguish controlled profile-assisted evidence from production-default package validation without presenting either experiment as a universal verdict.
- `README.md` should name the near-term primary ICP directly: teams using AI coding agents on medium-to-large TypeScript/Node repos where broad exploration creates cost, latency, privacy, or wrong-file-edit risk.
- `README.md` should frame Madar as deterministic local context compilation that complements agents and IDE indexing, not another generic codebase index.
- `README.md` should call out what is not the primary ICP today instead of implying Madar is already equally ready for every coding-agent workflow or repo shape.
- The team and enterprise offer should stay service-scoped: benchmark setup, proof report support, and a procurement/security note inside the same local-first trust boundary.
- Team and enterprise offer docs should say Madar is **not a hosted control plane** and avoid implying managed cloud hosting or source-code custody.
- Hosted dashboard positioning should stay deferred until **explicit customer demand** exceeds the current local proof path built from the canonical `graph.json`, `GRAPH_REPORT.md`, and `report.share-safe.json`.
- Any future hosted-dashboard note must keep the **no cloud indexing assumption** explicit and describe a share-safe-artifacts-only boundary rather than implying raw-source upload.
- Distribution channels should stay framed around shipped local installs first: Claude, Cursor, Copilot, Gemini, Codex, Aider, and OpenCode are current surfaces; the official MCP Registry manifest and release-gated OIDC workflow are prepared to publish the next eligible entry and point it to the same local-first flow, while broader **MCP directories** and registry/listing expansion are later only when **proof/onboarding readiness** is stronger.
- Any distribution-channel note should keep the **local trust boundary** explicit, distinguish current installers from future listing work, and avoid marketplace-scale adoption claims before stronger conversion proof exists.
- Do not imply a hosted relay, plugin-store rollout, or source custody requirement when describing future channel work.
- Current public language copy must state that Madar indexes JavaScript and TypeScript only. Other languages are unsupported coverage, not a lower-confidence extractor tier.
- Any future language expansion requires a new accepted product/architecture decision, repeated user demand, and benchmark or fixture evidence before implementation or public claims.
- Any design-partner workflow evidence should stay **anonymized**, use **workflow-loop notes** or **synthetic reproductions** when needed, and avoid implying five live partner wins before those receipts exist.
- Any federation claim should keep the **synthetic federation receipt** boundary explicit, say when the current proof depends on **shared labels**, and avoid turning that into a broad cross-repo benchmark headline.
- Any new public claim should link back to a dated artifact or to the reproducible suite surface under [`docs/benchmarks/suite/`](./benchmarks/suite/README.md).
- When evidence is mixed, the README should say that directly and point to the counterexample note or issue instead of smoothing it into marketing.

## Related evidence

- [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/`](./benchmarks/regression/0.27.0-next.4-govalidate-explain/) — the verified `0.27.0` release cell cited in `README.md` and `CHANGELOG.md`.
- [`docs/benchmarks/2026-05-31-implement-outcome/`](./benchmarks/2026-05-31-implement-outcome/README.md) — deterministic implementation-task receipt with isolated workspaces, validation, and reviewer-visible correctness checks.
- [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](./benchmarks/2026-05-25-founder-command-center-auth-flow/README.md) — mixed exploration evidence, including the FounderCommandCenter contrast note.
- [`docs/benchmarks/2026-06-01-design-partner-workflow-loops/`](./benchmarks/2026-06-01-design-partner-workflow-loops/README.md) — anonymized workflow-loop notes and synthetic reproductions for explain/review/impact proof drafts.
- [`docs/benchmarks/2026-06-01-federation-flagship/`](./benchmarks/2026-06-01-federation-flagship/README.md) — synthetic federation receipt for the smallest reproducible frontend/backend/shared enterprise workflow.
- [`docs/benchmarks/govalidate-suite/`](./benchmarks/govalidate-suite/README.md) — public prompt set plus deterministic pack/answer quality gates.
- [`docs/benchmarks/suite/`](./benchmarks/suite/README.md) — fixed manifests, methodology, CLI runner, and per-repo spread results.
- [`docs/benchmarks/suite/results/2026-07-15T06-55-50/summary.md`](./benchmarks/suite/results/2026-07-15T06-55-50/summary.md) — current packed-artifact `documenso` receipt; legacy and SPI are `not_measured` after prompt/answer-gate failures.
- [`docs/benchmarks/suite/results/2026-07-15T07-08-43/summary.md`](./benchmarks/suite/results/2026-07-15T07-08-43/summary.md) — current packed-artifact `formbricks` receipt; legacy and SPI are `not_measured` after prompt-contract uncertainty, with additional SPI answer-gate failures.
- [`docs/benchmarks/suite/results/2026-07-15T07-41-50/summary.md`](./benchmarks/suite/results/2026-07-15T07-41-50/summary.md) — current packed-artifact `dub` receipt; legacy and SPI are `not_measured` because no attributable Madar MCP call was recorded.
- [`docs/benchmarks/suite/results/2026-07-15T08-08-36/summary.md`](./benchmarks/suite/results/2026-07-15T08-08-36/summary.md) — current packed-artifact `twenty` receipt; legacy and SPI are `not_measured` because no attributable Madar MCP call was recorded.
- [`docs/benchmarks/suite/results/2026-07-15T08-51-54/summary.md`](./benchmarks/suite/results/2026-07-15T08-51-54/summary.md) — current packed-artifact `cal-diy` receipt; legacy is `not_measured` because no attributable Madar MCP call was recorded.
- [`docs/benchmarks/suite/results/2026-07-15T09-27-25/summary.md`](./benchmarks/suite/results/2026-07-15T09-27-25/summary.md) — current packed-artifact `novu` receipt; legacy is `not_measured` because no attributable Madar MCP call was recorded.
- [`docs/benchmarks/suite/results/2026-06-10T07-01-18/summary.md`](./benchmarks/suite/results/2026-06-10T07-01-18/summary.md) — controlled profile-assisted `documenso` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-06-10T07-10-44/summary.md`](./benchmarks/suite/results/2026-06-10T07-10-44/summary.md) — controlled profile-assisted `formbricks` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-06-10T07-24-01/summary.md`](./benchmarks/suite/results/2026-06-10T07-24-01/summary.md) — controlled profile-assisted `dub` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-06-10T07-39-11/summary.md`](./benchmarks/suite/results/2026-06-10T07-39-11/summary.md) — controlled profile-assisted `twenty` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-06-10T08-08-44/summary.md`](./benchmarks/suite/results/2026-06-10T08-08-44/summary.md) — controlled profile-assisted `cal-diy` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-06-10T08-24-49/summary.md`](./benchmarks/suite/results/2026-06-10T08-24-49/summary.md) — controlled profile-assisted `novu` receipt; a real source-checkout measurement, not untuned npm-package proof.
- [`docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md`](./benchmarks/suite/results/2026-05-31T12-00-00/summary.md) — the first multi-shape suite bundle, including initial implement/review workflow-outcome rows.
- [`docs/benchmarks/suite/results/2026-05-26T18-31-04/summary.md`](./benchmarks/suite/results/2026-05-26T18-31-04/summary.md) — the first measured warm-cache `nestjs-mid` / `explain-runtime` suite row.
