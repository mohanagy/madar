# Benchmark suite methodology

This suite exists to make Madar's benchmark claims reproducible without collapsing everything into one blended marketing number.

## Repo selection

The fixed repo set is tracked in [`repos.json`](./repos.json).

- Keep the shape mix explicit: small TypeScript, mid-size service, larger TypeScript monorepo, Python service, Go service.
- The suite may use public repos or fixture-style proxies. It must not require the private GoValidate codebase.
- The current public git-backed rows are `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu`.
- `status: "ready"` means the repo/task cell is prompt-wired and intended to run once the local install gate passes.
- `status: "planned"` means the row stays visible in the manifest for roadmap clarity but must not be counted as measured evidence yet.
- Actual execution clones or copies each ready repo into a temporary benchmark workspace, normalizes repo-local Claude/MCP config there, provisions the Madar Claude install, and verifies that install before prompt spend. Rows may set `graphRoot` to a safe relative subdirectory when a large monorepo needs a first-class scoped graph; generation, install verification, warmup, and measured compare execution all run from that scoped root. The current public scoped rows are encoded directly in `repos.json` so reruns are reproducible instead of depending on ad hoc manual `cd` commands. Git-backed rows should pin `source.ref` to an immutable commit SHA or release tag, and if repo preparation or the suite-managed install fails, the cell is reported as skipped instead of silently treated as measured evidence.

## Task selection

The fixed task set is tracked in [`tasks.json`](./tasks.json).

- Task ids are suite dispatch keys such as `explain-runtime`, `implement`, and `review`.
- A task becomes runnable only when it has `status: "ready"` and a repo-specific prompt in `prompts`.
- Missing prompts are treated as planned cells, not silently skipped evidence.
- Alternate manifests supplied with `--repos-manifest` and `--tasks-manifest` use the same runner. The checked-in [`holdouts/`](./holdouts/) manifests exercise repos and prompts that have no runtime-proof profile; private holdouts can use files outside the checkout.

## Retrieval and grader boundary

- Production `retrieve` and `context_pack` are prompt- and repository-agnostic. They do not load benchmark manifests, exact prompts, expected paths, or expected symbols.
- [`runtime-proof.json`](./runtime-proof.json) is grader input. It may reject a receipt for missing direct evidence, but it is not passed into retrieval and its obligation checklist is not written into the answering agent's prompt.
- Legitimate task-specific behavior must be generic. Runtime-flow prompts may be classified from task wording and routed to the directed `slice-v1` strategy; the same classifier and strategy apply to unseen repos and paraphrased prompts. Repo names, exact prompt equality, expected filenames, and expected symbols are forbidden retrieval signals.
- `npm run verify:pack-parity` calls the production MCP retrieval surface from both the checkout build and an unpacked npm tarball with the same version, graph, prompt, and options. CI rejects semantic response drift.

## Trial protocol

- Default trials per runnable cell: **3**
- Run modes:
  - **cold** — measured directly with no suite-managed priming run
  - **warm** — one priming compare run is executed and discarded before the measured run
- Each measured cell currently records:
  - baseline
  - Madar
  - the historical SPI-labelled Madar arm, now the compatibility `--spi` selector for strict canonical JS/TS, when the repo entry supports it

When a benchmark run uses an ordered question list, Madar keeps one session across that list so repeated-turn savings can be measured instead of only first-turn cost. Those per-question receipts include `reused_context_tokens`, `effective_query_tokens`, and `session_diagnostics`; single-question cells remain first-turn only.

## What is measured

Primary metric:

- Anthropic-reported input tokens per task from the native-agent compare `result` event

Secondary metrics:

- total tool-call count
- `Read` count
- `Glob` + `Grep` count
- wall-clock duration
- total cost

Workflow outcome metrics, when the compare receipt provides them:

- wrong-file edits — count of edits applied outside the intended target file or package boundary for the cell.
- validation pass/fail — boolean receipt for whether the task-specific validation command or check completed successfully.
- review time — elapsed seconds spent producing the review-style result for that cell.
- rework — count of extra fix/retry loops required before the reported outcome stabilized.
- human intervention — boolean receipt for whether a person had to step in to unblock or correct the run. It is independent of `validation_passed`, `wrong_file_edits`, and `rework_loops`.

Per-cell artifacts keep `report.share-safe.json` as the canonical persisted report so summaries can be inspected without leaking private local paths.
For checked-in fixture bundles under `docs/benchmarks/suite/results/`, `report.json` is a checked-in share-safe alias of `report.share-safe.json`; the private unsanitized local-path report is not published.

## Deterministic validation and human review

- `quality-gates.json` contains reproducible string, caveat, and direct-evidence citation checks. Its `passed` value means only that those machine checks passed.
- `human-review.json` is a separate semantic review queue. Each row has an explicit `pending`, `passed`, or `failed` status and evaluates causal order, coherence, omissions, and whether cited evidence actually supports the answer.
- A deterministic pass never implies human approval. A public answer-quality claim requires both a passing deterministic receipt and a recorded human review; pending review stays pending even when every machine gate passes.

## Isolation mode and canonical environment

- Published benchmark cells are expected to run in isolation mode via [`docs/benchmarks/suite/isolation/`](./isolation/).
- `./isolation/run-isolated.sh` creates an npm tarball, unpacks it under the external runtime profile, uses the packed CLI for both `bench:suite` and MCP, syncs the shipped minimal config, points `CLAUDE_CONFIG_DIR` at that profile, and exports `MADAR_BENCH_ISOLATION=1`.
- Published cells must report `MADAR_BENCH_RUNTIME_SOURCE=npm_pack`. A `MADAR_BENCH_CLI_PATH` override is for development only because it reintroduces checkout behavior.
- That isolation profile is separate from the user's default Claude profile; if the default profile is logged in but the isolated runtime profile is not, the launcher now fails fast and prints the exact `CLAUDE_CONFIG_DIR=... claude auth login` command to run once before a measured rerun.
- The pinned environment contract lives in [`isolation/environment.json`](./isolation/environment.json). In isolation mode, `madar bench:suite` compares the live environment against that contract before each cell.
- Environment drift marks the cell `status: "env_mismatch"` and excludes it from measured counts. `summary.md` records `Cells skipped for env drift: N`.
- Development runs outside isolation mode remain useful receipts, but their cells are tagged `isolation: false` and should not be cited as published benchmark claims.

## Reporting rules

- Results are written under `docs/benchmarks/suite/results/<timestamp>/`
- `summary.json` is the machine-readable rollup
- `summary.md` is the human-readable rollup
- Each cell reports `status` and `isolation: true|false`
- Implement/review cells may also report workflow outcomes beyond token, latency, and tool-call counts when the receipt includes them
- Checked-in fixture bundles may keep `started_at` / `completed_at` fixture anchors for deterministic publication; use each arm's `duration_ms` field for elapsed timing comparisons.
- Checked-in fixture bundles may keep deterministic per-scenario `tool_call_counts`, so identical counts across trials are not by themselves evidence of duplicated live runs.
- Keep **repos as rows**
- Report **median + min/max + n**
- Keep **cold** and **warm** separate
- Do **not** add a blended cross-repo rollup row

## What is not controlled

The suite is reproducible, but it is not a lab instrument. The following still vary:

- model version drift
- provider-side routing changes
- rate limits and queueing
- time-of-day cache state
- agent runtime behavior outside the prompt itself

Those caveats are part of the evidence, not a reason to hide variance.
