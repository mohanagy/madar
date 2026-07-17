# Changelog

All notable changes to the TypeScript package will be documented in this file.

## [Unreleased]

### Changed

- **Cross-layer questions recover by query obligation instead of repeating the loudest vocabulary**: retrieval splits multi-stage flow questions into bounded obligations, reserves structurally connected anchors across distinct communities, and reports initial/final obligation coverage plus promoted communities in the retrieval plan. Explain packs can now treat a diverse cross-file set of direct workflow owners as supporting evidence instead of replacing stronger obligation anchors with weaker related candidates merely to satisfy a ranking label. Execution-owner questions such as “what runs the monthly close?” now receive behavior-slice retrieval, and exact file ownership remains available even when clustering separates a file node from its symbols. Addresses #565.

### Fixed

- **A valid unchanged graph becomes usable without rebuilding at every MCP startup**: automatic refresh validates generation policy, graph freshness, indexing outcomes, the authoritative source snapshot, deletions, additions, ignored discovery paths, and control-file changes before reusing a graph. A graph-backed request waits through a bounded transient reconciliation window and completes as the same request once ready, while MCP initialization, discovery, and ping remain responsive. Changed, missing, incomplete, or policy-mismatched graphs still rebuild or fail closed. Addresses #564.

## [0.31.3] - 2026-07-17

### Fixed

- **Automatic refresh no longer becomes permanently unavailable after refresh-lease contention**: leases whose recorded owner is definitely dead are reclaimed immediately, while a live owner is awaited with bounded, abortable backoff instead of turning a 30-second contention window into a terminal watcher failure. Shutdown requested during contended startup is honored promptly. Closes #561.
- **Agents can distinguish temporary graph reconciliation from graph repair**: graph-backed MCP calls now return structured `madar_graph_not_ready` error data with `retryable`, `retry_after_ms`, and `suggested_action`. `starting`, `pending`, and `reconciling` ask the agent to retry the same Madar request; failed, incomplete, or policy-mismatched graphs remain fail-closed and ask for repair.

### Notes

- Restart or reconnect the agent's MCP session after upgrading so it launches the `0.31.3` runtime. No installer-profile migration or manual graph generation is required when the graph is only reconciling.

## [0.31.2] - 2026-07-16

### Fixed

- **Codex no longer times out while Madar performs the initial automatic refresh**: the MCP transport becomes responsive immediately while graph reconciliation runs in a background worker, and graph-backed calls remain fail-closed until the watcher reports a ready graph. Worker startup and reconciliation failures remain visible through watcher state, stderr, and MCP freshness errors. Closes #559.
- **Managed Codex profiles now allow large workspaces enough time to start**: new and updated `.codex/config.toml` entries set `startup_timeout_sec = 180` without overwriting unrelated user configuration.

### Notes

- After upgrading, rerun `madar codex install` in each Codex workspace to migrate the managed MCP block to the extended startup timeout.

## [0.31.1] - 2026-07-15

### Changed

- **The README now starts with a first-use path instead of internal product detail**: new users get a 60-second trial, a concrete password-reset example, agent setup commands, a plain-language explanation of what changes for the agent, and clear fit and limitation guidance before deeper architecture or benchmark material.
- **Public benchmark evidence now keeps unlike experiments separate**: the genuine June source-checkout measurements remain documented as controlled profile-assisted evidence, while the July packed-artifact reruns are correctly reported as zero valid performance comparisons rather than six product losses. The README links to the complete dated receipts instead of reproducing an internal benchmark report on the landing page.

### Notes

- This is a documentation-only patch. Runtime behavior is unchanged from `0.31.0`.

## [0.31.0] - 2026-07-15

### Added

- **Context packs now separate evidence quality from answer readiness**: responses expose independent evidence-strength, retrieval-coverage, and answerability signals; incomplete explain packs keep their original evidence through up to two bounded cumulative recovery passes; and agents receive exact verification targets instead of treating a medium compatibility score as a reason to restart broad search. Closes #552.
- **Conceptual questions get a deterministic repository-local fallback**: lexical misses can run one bounded, graph-grounded recovery pass without requiring embeddings, while unrelated prompts remain empty instead of drifting to high-degree hubs. Self-hosted regression fixtures cover expected-file recall, selected-file precision, answerability, token budgets, latency, and negative controls. Closes #555.
- **Retrieval and extraction expose explicit typed stages**: seed generation, expansion, ranking, packing, evidence planning, recovery, discovery, capability selection, per-language extraction, framework augmentation, merge, relationship resolution, and diagnostics projection now have stable internal boundaries with source-safe stage diagnostics. Closes #556.

### Changed

- **Generated code graphs are directed by default**: generate, update, watch, try, and automatic refresh preserve source-to-target edges; legacy undirected graphs rebuild safely; generic context queries still inspect both sides of incident relationships; and impact, call-chain, and directional slicing reject visualization-only undirected artifacts instead of returning misleading results. Closes #548.
- **Strict agent installs match the MCP tools they actually expose**: generated guidance uses `context_pack` and `context_expand`, follows the new answerability states, and no longer instructs agents to call unavailable tools. Closes #550.
- **Auto-refresh is policy-preserving and fail-closed**: adaptive full reconciliations replace silent scan caps, filesystem events invalidate graph-backed answers immediately, generation settings are fingerprinted and reused, policy drift forces a full rebuild, media sidecar content changes are detected even when file mtimes do not advance, and watcher/reconciliation health is visible through status and doctor output. Closes #553.
- **Indexing completeness is explicit and auditable**: generation records every indexed, warned, policy-skipped, unsupported, and failed source file in a local manifest, emits a path-free share-safe companion, and supports strict thresholds for incomplete coverage. Closes #554.

### Fixed

- **Sensitive-path discovery no longer excludes ordinary security source code**: source files such as token, password-reset, credential-provider, and secret-manager implementations remain indexable, while private keys, environment files, credential stores, and non-source secret material stay excluded with structured reason codes. Closes #549.
- **Production retrieval no longer consumes benchmark answers**: expected files, symbols, and runtime-proof obligations remain in the evaluation harness and cannot influence the shipped retrieval path. Six July 15 public rows were rerun from an unpacked `@lubab/madar@0.31.0` tarball and published as dated receipts; every row is `not_measured` because strict prompt/answer gates failed or no attributable Madar MCP call occurred, so this release makes no replacement public performance-win claim. Closes #551.

## [0.30.0] - 2026-07-14

### Added

- **Installed MCP integrations now keep their graph current automatically**: newly generated Claude Code, Codex, Cursor, Copilot, Gemini, Aider, and OpenCode configurations launch `madar serve --stdio --auto-refresh`. The server reconciles the active workspace at startup, watches it while the agent session is active, and publishes refreshed graph artifacts atomically after source or relevant configuration changes. Re-run your agent's `madar <agent> install` command after upgrading to update an existing managed MCP entry. Closes #545.
- **Linked Git worktrees now receive isolated Madar artifacts**: default graphs, caches, reports, compare output, and time-travel artifacts live outside a linked checkout in its repository's shared Git data directory, with a distinct artifact directory for each worktree. This prevents branches from sharing or overwriting graph state while keeping generated artifacts out of the checkout. Closes #546.

### Notes

- **An MCP server is scoped to the worktree it started in**: start or reconnect the agent/MCP server from the intended worktree. A running server cannot follow an agent that later changes directory or creates and moves into another worktree.

## [0.29.0] - 2026-07-12

### Added

- **Git-aware generation is available with `--respect-gitignore`**: `madar generate`, `madar generate --watch`, and `madar watch` can restrict discovery to tracked files plus non-ignored untracked files. The behavior covers legacy, SPI, incremental, and watch rebuilds while preserving normal discovery outside Git repositories. Closes #535.
- **Codex CLI now gets a complete project-local integration**: `madar codex install` writes the Madar-owned AGENTS.md profile, a task-applicable `UserPromptSubmit` hook in `.codex/hooks.json`, its generated `.codex/madar-user-prompt-submit.cjs` script, and a marker-owned `[mcp_servers.madar]` block in `.codex/config.toml`. The hook supplies model-visible guidance only for local code tasks; it remains guidance rather than enforcement.
- **Codex install safety and verification are explicit**: install and uninstall preserve unrelated hooks, TOML, and AGENTS content; `madar doctor` / `madar status` now validate the on-disk Codex hook, script, and MCP entry while documenting that live Codex trust and activation must be confirmed through Codex itself.

### Changed

- **Codex documentation and CLI handoff are aligned with the live integration**: quickstarts, compatibility docs, built-in skill guidance, release smoke checks, and the post-generate next-command list now point to the Codex hook/MCP setup and its trusted-repository activation steps.

## [0.28.1] - 2026-06-10

### Fixed

- **A retrieve call with `semantic`/`rerank` no longer kills the MCP server when the optional `@huggingface/transformers` package is missing**: the rejection previously escaped the stdio serve loop unhandled, terminating the process mid-call so agents saw an infinite spinner instead of an error. Retrieve failures now return an MCP `isError` tool result the agent can read and react to, and the serve loop is hardened so no handler rejection can tear down the server.
- **A project-local `npm install @huggingface/transformers` now actually enables semantic/rerank**: npx-launched and globally installed servers resolve the optional package from the project root (derived from the graph path) in addition to madar's own installation, and the install hint in the error message now points at instructions that work for those installs.
- **Failed semantic model loads no longer poison the pipeline cache**: a rejected load is evicted, so installing the package and retrying succeeds without restarting the server.

### Added

- **Semantic/rerank capability gating in the retrieve tool schema**: `tools/list` omits the `semantic`, `semantic_model`, `rerank`, and `rerank_model` fields when the optional package is not resolvable, so agents never request a capability the machine lacks.
- **`madar doctor` now reports semantic/rerank availability** with the exact enable command, without affecting overall health status.
- **Semantic model loads are bounded by a timeout** (`MADAR_MODEL_LOAD_TIMEOUT_MS`, default 120s) so a stalled first-use model download cannot block the serial stdio request loop indefinitely.

## [0.28.0] - 2026-06-10

### Added

- **Proof-backed public TypeScript benchmark receipts are now part of the stable release**: the public `documenso`, `formbricks`, `dub`, `twenty`, `cal-diy`, and `novu` `explain-runtime` legacy rows now have checked-in share-safe receipts with `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, passing Madar answer-quality gates, and empty runtime-proof missing obligations.
- **Strict runtime-proof benchmarking is now first-class**: benchmark rows can require explicit entrypoint, handoff, and terminal-effect obligations, and reports now expose runtime-proof evidence so a row cannot be claimed as a win when required flow evidence is missing.

### Changed

- **README and claim surfaces now lead with the 0.28.0 proof boundary**: public copy now shows the six-row TypeScript `explain-runtime` legacy benchmark table while keeping the claim scoped to single-trial, repo/task-specific receipts and keeping SPI arms separate.
- **Runtime retrieval is more completeness-driven**: slice selection, targeted recovery, source evidence, scoped benchmark roots, and framework/runtime handoff handling were tightened so Madar can surface direct evidence before the agent answers.

### Fixed

- **Benchmark receipts no longer hide missing proof behind soft wins**: strict rows now fail closed when required runtime obligations are absent, direct-evidence answer checks are enforced, nested trace tool inputs are summarized more reliably, and mixed workspace-relative evidence path issues are removed from the saved reports.
- **Public benchmark reproducibility is stronger**: the suite honors explicit benchmark CLI overrides, keeps scoped-root fixtures platform-aware, avoids dropping source-visible runtime files behind broad ignore rules, and records share-safe reports for each public legacy row.

## [0.27.9] - 2026-06-04

### Added

- **The next-track adoption bundle is now the stable `0.27.9` release**: Madar now ships the public benchmark suite and language fixtures, the one-command `madar try` proof flow, opt-in funnel telemetry, verified agent quickstarts, the design-partner loop, and the proof-first launch/distribution checklist that landed across `0.27.9-next.0` and `0.27.9-next.1`.

### Changed

- **Freshness, MCP routing, and native-agent reporting are tighter on the stable line**: the git-backed freshness model now covers `madar pack`, `madar prompt`, `madar handoff`, `madar doctor`, and `madar status`; native-agent compare keeps separate baseline/Madar prompt artifacts with stricter task-bounded guidance and clearer attribution; generated Claude and Cursor MCP configs now launch the installed `madar` CLI directly; and `madar install <platform>` now works alongside `--platform`.

### Fixed

- **Windows agent workflows are now release-ready**: Claude installs now use a generated local `.claude/madar-user-prompt-submit.cjs` script instead of an oversized inline hook, Windows native-agent `--exec` commands now honor the expected `cmd.exe` contract, timed-out native-agent arms preserve settled partial artifacts, and compare trace classification no longer mistakes deferred `ToolSearch` Madar selection for broad exploration.

## [0.27.9-next.7] - 2026-06-04

### Fixed

- **Generated Claude and Cursor MCP configs now launch Madar directly**: repo-local installs now write the bare `madar` command with `serve --stdio <graph path>` instead of version-pinned `npx` / `npx.cmd` launchers, so Windows installs no longer depend on the `.cmd` shim and the generated MCP config matches the installed CLI contract.

## [0.27.9-next.6] - 2026-06-04

### Fixed

- **Windows native-agent `--exec` commands now run under the expected shell contract**: compare, benchmark, and review native-agent runners now use `cmd.exe` on Windows with cmd-compatible quoting and workspace wrapping, so cmd-style exec templates such as `type {prompt_file} | claude -p --output-format stream-json --verbose` no longer hang the Madar arm behind a PowerShell mismatch.

## [0.27.9-next.5] - 2026-06-04

### Fixed

- **Native-agent compare prompts are stricter and timeout artifacts keep partial evidence**: task-scoped compare prompts now forbid broad graph-navigation detours, limit raw follow-up exploration to one focused read/search with concise caveats when confidence stays low, and timed-out native-agent arms now preserve any settled stdout/stderr in the saved answer/report artifacts instead of discarding that partial evidence.

## [0.27.9-next.4] - 2026-06-03

### Fixed

- **Native-agent compare now keeps baseline and Madar prompt artifacts separate**: compare runs now write dedicated baseline and Madar prompt files, record both paths in `report.json`, and preserve the legacy `prompt_file` field as the Madar prompt so existing consumers stay compatible while prompt inspection becomes clearer and debuggable.

## [0.27.9-next.3] - 2026-06-03

### Fixed

- **Windows Claude prompt hooks now run from a generated local script instead of an oversized inline shell command**: `claudeInstall` now writes `.claude/madar-user-prompt-submit.cjs` and points `UserPromptSubmit` at `node .claude/madar-user-prompt-submit.cjs`, eliminating the shell-length truncation that still broke `0.27.9-next.2` with `unexpected EOF while looking for matching '"'`.

## [0.27.9-next.2] - 2026-06-03

### Fixed

- **Windows cmd.exe command-line length limit is now respected**: the generated `UserPromptSubmit` hook has been aggressively minified to fit within Windows cmd.exe's 8,191 character limit, resolving the `unexpected eof while looking for matching` shell parse failure on Windows systems.

## [0.27.9-next.1] - 2026-06-03

### Fixed

- **Windows Claude submit hooks are now shell-safe**: the generated `UserPromptSubmit` hook and related payload builders now pass base64 data through argv instead of embedding it in shell-quoted inline JavaScript, avoiding the Windows `unexpected eof while looking for matching` failure.

## [0.27.9-next.0] - 2026-06-03

### Added

- **Adoption proof surfaces now cover the full next-track rollout bundle**: Madar now ships a public multi-repo benchmark suite and language fixtures, the one-command `madar try` first-run flow, verified agent-specific quickstarts and smoke-tested install docs, a design-partner feedback loop with reproducible receipts, and the proof-first launch/distribution checklist. Closes #469, #470, #472, #473, and #474.

### Changed

- **Public adoption messaging and instrumentation are now aligned across the next track**: the README/npm discovery path now reflects the Madar positioning and legacy-name cleanup, prerelease docs stay on `blob/next`, and the opt-in telemetry funnel records coarse install/generate/pack/prompt/doctor/status/compare adoption stages without collecting source text or paths. Closes #467, #468, and #471.

### Fixed

- **Graph freshness and stale-context guarantees are now scoped and git-backed**: `madar pack`, `madar prompt`, `madar handoff`, `madar doctor`, and `madar status` now report whole-repo vs selected-context freshness using the graph build revision plus current git diff as the source of truth on git workspaces, with privacy-safe governance receipts and tighter stale-context behavior for follow-up flows. Closes #477 and #479.

## [0.27.8] - 2026-06-02

### Added

- **README reference content now has dedicated docs**: long-form Pack Schema v1, adaptive context-pack, execution-slice, MCP tool, installer, strict-profile, MCP Registry, command-reference, and discovery-rule details now live under `docs/concepts/context-packs.md` and `docs/reference/cli-and-mcp.md` so the package README can stay focused on onboarding.

### Changed

- **The README is now a shorter npm-facing landing page**: the public README now leads with the product promise, quickstart, agent choices, core surfaces, evidence boundaries, and documentation index, while keeping claim and release links npm-safe.

## [0.27.7] - 2026-06-02

### Added

- **Federation is now documented as a flagship multi-repo workflow proof**: Madar now ships a reproducible three-repo federation fixture plus a checked-in synthetic federation receipt and supporting docs so the enterprise/multi-repo workflow claim has a concrete local artifact without overstating the current implementation. Closes #429.

### Changed

- **The roadmap docs are more decision-ready**: the main release now includes design-partner workflow loop drafts, plugin distribution-channel research, and the current language-expansion decision so the stable line reflects the product direction already merged on `main`. Closes #425, #431, and #432.

### Fixed

- **Implement compare validation is now safer and more transparent**: `compare --task implement` now discloses repo-local validation commands in the native-agent warning flow, supports a configurable `--validation-timeout`, aborts hung validation command process groups reliably, and safely handles targeted test paths with spaces, shell metacharacters, or repo-root flag-like names.
- **Release README links now stay on the correct published branch**: stable README changelog and release-sensitive docs links now target `blob/main`, prerelease links still target `blob/next`, and release hygiene catches branch drift for both channels.

## [0.27.7-next.1] - 2026-06-01

### Fixed

- **Implement compare validation is now safer and more transparent**: `compare --task implement` now discloses repo-local validation commands in the native-agent warning flow, supports a configurable `--validation-timeout`, aborts hung validation command process groups reliably, and safely handles targeted test paths with spaces, shell metacharacters, or repo-root flag-like names.
- **Prerelease README links now stay on the published branch**: next-only docs links now target `blob/next`, and release hygiene rejects prerelease README links that drift back to `blob/main`.

## [0.27.7-next.0] - 2026-06-01

### Added

- **Federation is now documented as a flagship multi-repo workflow proof**: Madar now ships a reproducible three-repo federation fixture plus a checked-in synthetic federation receipt and supporting docs so the enterprise/multi-repo workflow claim has a concrete local artifact without overstating the current implementation. Closes #429.

### Changed

- **The next-track roadmap docs are more decision-ready**: the `next` line now includes design-partner workflow loop drafts, plugin distribution-channel research, and the current language-expansion decision so the upcoming beta reflects the product direction already merged on `next`. Closes #425, #431, and #432.

## [0.27.6] - 2026-05-29

### Changed

- **The legacy `madar add <url>` surface is removed from the public CLI**: Madar now stays explicitly local-codebase-only at the command surface, while `save-result` remains available for exporting query results and older ingest-produced artifacts still preserve their legacy `builtin:ingest:*` provenance when they are read back.

## [0.27.5] - 2026-05-29

### Fixed

- **Answer-ready explain packs now keep promoted runtime-path workflow centers**: explain pack assembly preserves nodes that are simultaneously part of the runtime primary path and promoted into `workflow_centers`, so scope-matched runs no longer emit `slice_path_nodes_not_promoted` for evidence already kept in the pack. Closes #399.
- **Explain serialization now enforces the declared budget**: answer-ready `madar pack`, MCP `context_pack`, and stdio explain responses now trim lower-value evidence until the serialized payload fits the requested budget, set `serialized_budget.enforced: true` when trimming occurs, and reject malformed stored follow-up handles instead of expanding them silently. Closes #400.

## [0.27.4] - 2026-05-29

### Fixed

- **`runNativeAgentArmWithTimeout` no longer races ahead of a settling arm**: after aborting a timed-out arm the runner is given a 200 ms grace window to fully settle before the `timed_out` outcome is recorded, preventing a partially-completed result from being misclassified. Truly stuck arms that never respond to abort still resolve via the grace timeout.
- **`assessNativeAgentPromptContract` returns `not_measured` for post-pack broad exploration**: broad exploration after a pack call can be justified by missing context or coverage gaps that the trace model does not capture, so marking it as `violated` caused false failures. The honest status is `not_measured`.
- **`suggestBenchmarkGraphScope` handles absolute `source_file` paths**: source files from fixtures using absolute paths (e.g. `/tmp/.../backend/src/auth-route.ts`) now have their project root inferred and stripped before scope extraction, so the reported scope is `backend` instead of the first path segment.
- **`candidateScopes` in MCP response evidence handles absolute and Windows paths**: scope detection now finds the segment immediately before a generic directory marker (`src`, `test`, `tests`, `lib`, etc.) rather than splitting on the first `/`, fixing incorrect scope attribution for long absolute paths and Windows-style paths.

## [0.27.3] - 2026-05-28

### Added

- **Explain packs now default to compact answer-ready output**: `madar pack`, MCP `context_pack`, and compare prompt packs can return bounded answer-ready JSON by default while preserving full diagnostics behind verbose mode. Closes #376.
- **Runtime-generation fixtures cover the full report path**: pack-quality regression coverage now includes the runtime-generation explain/report flow so spine selection is tested against the real orchestrator, storage, and quality-gate handoff. Closes #377.

### Changed

- **Installed-agent guidance is stricter about Madar-first exploration**: generated Claude/Codex/Copilot/Cursor/Gemini instructions now tell agents to inspect `evidence.pack_confidence`, `recommended_first_read`, and `evidence.agent_directive`, and to try one focused Madar follow-up before broad raw search. Closes #378.
- **Native-agent benchmark outcomes now gate full wins on regressions**: compare reports include `benchmark_outcome` checks for routing/tool/latency, total tokens, fresh-token usage, provider cost, and turns, so faster routing with worse cost or fresh-token behavior is marked as a partial win instead of a full win. Closes #379.

## [0.27.2] - 2026-05-28

### Changed

- **Native-agent compare now explains missing verbose traces explicitly**: `report.json` records whether Claude verbose trace data was available, and the CLI/docs clarify that `--verbose` is required for MCP-call attribution while provider usage can still come from `--output-format json`. Closes #368.
- **Native-agent traces distinguish pre-Madar broad exploration**: verbose compare reports now classify `ToolSearch`/`Glob`/`Grep`/`Bash` before the first Madar MCP call as `madar_invoked_after_broad_exploration`, preserving valid attribution while surfacing the routing drift. Closes #369.
- **Native-agent benchmark summaries separate routing wins from token proof**: valid attributed runs now carry `claim_assessment` so fewer tools/faster latency can be reported separately from provider-token reduction, and fresh-token regressions keep token-reduction claims marked `not_proven`. Closes #370.

## [0.27.1] - 2026-05-28

### Fixed

- **Native-agent compare no longer reports favorable reductions for degraded no-trace runs**: `report.json.reductions` and suite-summary win lines now stay suppressed unless the run is attributable to a valid Madar invocation. Closes #361.
- **`madar summary` runtime paths stay closer to real workflow spines**: runtime-path scoring now admits worker-style starts with runtime predecessors, recognizes metadata-less worker/job file hints, and keeps helper-style endpoint pairs from outranking backend workflow boundaries. Closes #362.
- **Native-agent compare no longer stalls silently on hung arms**: `compare --baseline-mode native_agent` now supports per-arm timeouts, stderr heartbeats, and `run-state.json` progress receipts, and it writes partial reports instead of hanging forever when the baseline or Madar arm gets stuck. Closes #363.

## [0.27.0] - 2026-05-27

### Added

- **Agent-directive evidence blocks on Madar MCP responses**: relevant `mcp__madar__*` responses now carry a deterministic top-level `evidence` block with `pack_confidence`, `coverage`, `missing_phases`, `covered_workflow_owners`, and `agent_directive`, and the install rules use that directive to gate broader exploration. Closes #339 via #348.
- **Decision-table install templates**: `madar claude install` and the other agent installers now write concrete tool-routing guidance for prompt types like explain-runtime, impact, relevant-files, and repo-overview work instead of generic "use Madar tools" copy. Closes #337.
- **Snippets in `mcp__madar__retrieve` responses**: `retrieve` now carries inline `nodes[].snippet` content plus a `snippet_budget` so callers can answer from the first response instead of immediately following up with raw file reads. Closes #338.
- **Install presence gates and stable install sentinels**: `madar compare` and `madar bench:suite` now refuse to produce a "valid" Madar benchmark when no install is detected unless `--allow-no-install` is passed, and managed installs write a stable `name: "madar"` / `source: "madar"` sentinel so that detection works across hook encodings. Closes #341 and #349.
- **Environment capture and isolation scaffolding for benchmarks**: benchmark artifacts now record active MCP servers, plugin/skill counts, CLAUDE.md hashes, and active hooks, and the suite ships checked-in isolation assets for reproducible cells. Closes #342 in part.

### Changed

- **Pack assembly post-processing is restored alongside the evidence envelope**: `confidence_score`, `recommended_first_read`, `workflow_centers`, `coverage`, `missing_context`, `negative_guidance`, and related pack fields are again populated at both the response root and inside `.pack` for strong-path runs. Closes #350.
- **Compare verbose-mode reporting is more honest about token behavior**: `report.json.reductions` now keeps uncached/cache-creation deltas, `token_regression` flags fresh-token regressions even when total input drops, and tool-call counts come from the verbose JSON stream instead of a lossy approximation. Closes #316 and #329.
- **`madar summary` now marks empty capability buckets explicitly**: empty `source_domains` and `runtime_paths` report `not_detected` plus a reason instead of silently appearing as empty objects. Closes #317.
- **Public release copy is anchored to a verified benchmark cell**: `README.md`, `CHANGELOG.md`, and `docs/claims-and-evidence.md` now point at the checked-in `0.27.0-next.4` GoValidate release cell instead of generalized benchmark copy.

### Fixed

- **`execution_slice` / `phase_coverage` overclaim on weak evidence**: low-confidence runtime slices no longer pretend they saw every phase in a multi-stage flow, and the surfaced status now reflects the actual trace depth. Closes #315.

## [0.27.0-next.4] - 2026-05-27

### Changed

- **Managed installs are now detected by structure instead of a brittle hook-string grep**: `madar compare` and `madar bench:suite` now recognize the real Claude managed hook shape even when the hook command is base64-wrapped or otherwise obfuscated, so valid installed runs are no longer mislabeled as missing installs.
- **Installed hook identity is now stable across agent surfaces**: Claude, Gemini, and Codex installs now write explicit Madar hook identity markers, compare keeps matcher families distinct when validating installs, and uninstall/detection logic now shares the same managed-hook recognizer instead of drifting by platform.

## [0.27.0-next.3] - 2026-05-27

### Changed

- **Explain-mode MCP flows now stay tighter and more agent-readable**: explain prompts route to `context_pack`, `retrieve` now ships bounded snippets, and the relevant Madar MCP responses surface a top-level `evidence` block with `pack_confidence`, `coverage`, and `agent_directive` so installed guidance can gate exploration on the response itself.
- **Compare and native-agent traces now explain install behavior more clearly**: compare output distinguishes reduced exploration from added-context-only runs, records `agent_directive_seen` values from Madar tool results, and install-gate regressions make it easier to spot when Madar was available but unused or over-expanded.
- **Benchmark-suite isolation receipts are more reproducible**: the suite now checks in its isolation environment metadata and runner assets more explicitly, keeping benchmark proofs and the documented environment closer together across platforms.

## [0.27.0-next.2] - 2026-05-27

### Changed

- **Public claim surfaces now map directly to evidence**: README/package/docs language now separates demonstrated behavior from in-progress and not-yet-measured claims, benchmark docs point at the per-repo suite scaffold instead of a single cross-repo headline, and `docs/claims-and-evidence.md` records what each public claim is allowed to say.
- **The benchmark suite is now runnable and seeded with a real measured row**: `madar bench:suite` expands fixed repo/task manifests, stages compare-backed trials safely, writes summaries and share-safe raw artifacts under `docs/benchmarks/suite/results/`, and ships the first 3-trial warm `nestjs-mid` / `explain-runtime` receipt.
- **Installed guidance stays stricter about bounded exploration**: strict install profiles now explicitly avoid broad raw-file exploration after a strong pack, compare/native-agent traces explain when Madar reduced exploration versus only adding context, and `out/GRAPH_REPORT.md` stays fallback-only when the pack or graph tools are unavailable, stale, or insufficient.

## [0.27.0-next.1] - 2026-05-26

### Changed

- **Context packs stay more trustworthy when evidence is weak**: directive adapters now switch to more cautious wording when confidence or semantic coverage is weak, implementation packs prefer workflow centers in `recommended_first_read`, and runtime-generation explain fallbacks demote helper-style nodes when no execution spine is available.
- **Installed-agent flows expand less often and compare output explains why**: strict agent install guidance now answers after one strong pack unless diagnostics or missing-context signals justify expansion, and compare/native-agent traces now distinguish between reduced exploration and added-context-only runs.
- **Runtime and reporting surfaces are more honest and stable**: runtime-generation `phase_coverage` no longer overstates unseen phases, graph summaries avoid empty outputs on valid graphs, compare output reports token regressions in the right direction, and sensitive-path detection is less prone to false positives.

## [0.27.0-next.0] - 2026-05-25

### Added

- **Pack Schema v1 and agent-ready brief adapters**: `madar pack` now emits a stable Pack Schema v1 envelope for implementation tasks, adds agent-specific `markdown`, `claude`, and `copilot` brief renderers alongside JSON/plain-text output, and preserves workflow centers, first-read guidance, likely edit/test files, public contracts, risk boundaries, validation commands, negative guidance, confidence, and why-explanation from one source of truth.
- **Real pack-quality fixture coverage for workflow-owner promotion**: the pack-quality regression suite now includes fixture-backed acceptance coverage for indirect lexical seeds so workflow-owner promotion remains stable when graph expansion should beat helper-style direct matches.

### Changed

- **Implementation packs are sharper, more explainable, and more testable**: implementation-mode packs now add scored workflow centers, likely edit files, likely test files, explicit Pack Schema v1 sections, budget-aware compression, helper-target preservation when the prompt explicitly names the helper, and the search → expand → promote → attach → refine → render retrieval pipeline metadata.
- **Pack output quality is more stable across adapters and releases**: legacy `text` output stays backward-compatible, the new adapter renderers avoid malformed `: undefined` bullets, and real fixture regressions now lock down the pack surfaces that changed across the recent implementation-pack work.

- **Semantic retrieval is now an explicit opt-in install**: `@huggingface/transformers` no longer ships in the default dependency set for `@lubab/madar`; install it separately to enable `--semantic` / `--rerank`, and madar now surfaces an explicit install hint when that optional package is missing.

## [0.26.1] - 2026-05-24

### Added

- **Implementation-mode context-pack guidance**: `context_pack` prompts and completions now advertise implement mode consistently and include compact implementation guidance when the task is to build or modify behavior.
- **Task applicability gating for non-code prompts**: install-time guidance now classifies prompts that do not need local repository source-code context so Claude/Codex-facing instructions can skip Madar by default and explain the skip in debug mode.

### Changed

- **Consumer installs no longer run a postinstall hook**: the published package removes the automatic `postinstall` reminder and keeps the platform reinstall hint in normal CLI help text instead of install-time execution.
- **Release dependency posture is cleaner and better documented**: the production lockfile now fixes the transitive `protobufjs` audit finding, and the shipped Socket review documents the remaining semantic-stack supply-chain tradeoffs plus the follow-up tracked in #290.

## [0.26.0] - 2026-05-24

### Added

- **Runtime-generation answer contracts and routing explanations**: retrieval and compiled packs now carry a structured answer contract for runtime-generation prompts, and `madar pack --why` / `madar compare --why` can expose deterministic routing metadata from retrieval-gate signals, anchors, exclusions, and diagnostics.
- **Broader conservative Python semantics**: Python extraction now handles FastAPI router composition, router-level/decorator/`Annotated[..., Depends(...)]` dependency linking, cycle-safe `include_router()` traversal, triple-quoted route/prefix strings, and a first-pass Django URL-conf route-to-view mapping pass.

### Changed

- **Runtime-generation routing is sharper and more transparent**: broad report-generation prompts now keep downstream generation-core evidence, UI/display and build-time prompts are less likely to false-positive into backend runtime slices, and routing validation artifacts document the current mixed-but-improving runtime-routing behavior conservatively.
- **`execution_slice` output is more trustworthy for runtime questions**: runtime packs now include deterministic confidence levels plus confidence reasons, richer prompt-scoped phase coverage for auth/validation/report-generation flows, and clearer static-model guidance so users do not mistake graph-derived hypotheses for live traces.
- **Public roadmap/docs now reflect the current post-0.25 line**: contributor-facing roadmap guidance, capability docs, and README notes now align with the current runtime-routing and Python support surface instead of the older narrower wording.

## [0.25.1] - 2026-05-23

### Changed

- **Natural runtime-generation explain prompts now auto-route to behavior slices**: prompts like `How idea report is being generated` no longer need special "trace the backend runtime pipeline" wording to reach level-3 runtime retrieval.
- **`pack --task explain` now defaults to `slice-v1` for runtime-generation questions**: users no longer need to know the experimental retrieval flag to get `execution_slice` output for these backend runtime prompts.
- **`compare` stays aligned with `pack` for runtime-generation prompts**: compare-mode madar prompt packs now use the same runtime-generation routing defaults as the main CLI path, so proof artifacts match the user-facing behavior.

## [0.25.0] - 2026-05-23

### Added

- **First-pass Go semantic indexing**: extraction now resolves conservative Go call flow across local-package imports, receiver methods, and statically resolvable cross-package calls, and it recognizes common `net/http`, Gin, and Chi route entrypoints so Go repos produce far more truthful runtime retrieval paths.

### Changed

- **`execution_slice` runtime answers are much more explicit**: backend runtime packs now add separated `primary_path`, `side_effects`, `terminal_boundaries`, `omitted_branches`, and `phase_coverage` output, so runtime answers no longer flatten every step and branch into one ambiguous list.
- **Execution-phase expectations are prompt-scoped**: queue/worker/persistence questions no longer invent missing controller or service phases just because the prompt mentions requests, and observed phases now emit in canonical runtime order (`controller` → `service` → `queue` → `worker` → `persistence`).

## [0.24.1] - 2026-05-23

### Changed

- **Copilot MCP startup is faster when the local CLI is available**: `madar copilot install` now writes `.vscode/mcp.json` to launch the installed `madar` CLI directly through Node instead of routing through `npx`, which reduces MCP startup overhead while keeping the existing `npx` fallback for environments without a local CLI path.
- **Copilot install paths are more stable across working directories**: relative `packageRoot` inputs are now resolved before the MCP launcher config is generated, so the written Copilot CLI path stays absolute and does not depend on the caller's current working directory.

## [0.24.0] - 2026-05-22

### Added

- **First-pass `routing-controllers` framework support**: SPI extraction now recognizes `typestack/routing-controllers` controllers, route methods, controller-route relationships, and bootstrap registration so framework-heavy TypeScript services produce more truthful retrieval paths and graph summaries.

### Changed

- **Madar public package/repo surfaces are aligned for launch**: the package metadata, repository links, npm URLs, install templates, benchmark docs, examples, and generated wiki footer now consistently point to the `madar` package and the `mohanagy/madar` repository.
- **Release-facing tooling is more precise**: benchmark harnesses now resolve `out/graph.json` correctly after changing directories, update notices print the full `madar <platform> install` commands, and doctor/install hook detection uses the actual Madar hook payload shape instead of broad substring matching.

## [0.23.1] - 2026-05-21

### Docs

- **0.23.0 release docs are easier to discover**: the README now surfaces `madar summary`, the core MCP `graph_summary` tool, `execution_slice`, share-safe compare artifacts, and `compare --baseline-mode pack_only` in the main product story instead of leaving them mostly to the changelog and proof docs.
- **SPI guidance is explicit**: the public docs now explain that `--spi` is still opt-in, when framework-heavy TypeScript/JavaScript repos should use it, and why it helps with storage-oriented prompts, Next.js App Router boundaries, and cached reruns.
- **The getting-started walkthrough matches current behavior**: the sample flow now includes a bounded `summary` step, an optional `generate --spi` branch, pack-only compare usage, and notes that queue-backed runtime questions may surface `execution_slice` plus `report.share-safe.json`.
- **Capability docs translate semantics into user value**: the language matrix now explains how Python FastAPI semantics, queue-worker `enqueues_job` edges, SPI `storage_operation` hints, and Next.js `runtime_boundary` metadata improve real retrieval answers.

## [0.23.0] - 2026-05-21

### Added

- **Compact graph summary surface**: adds a bounded deterministic `madar summary [graph.json]` CLI command plus a default-core MCP `graph_summary` tool that return the same shared JSON overview of graph counts, source domains, top modules, entrypoints, frameworks, and high-signal runtime paths. This is intended as a first-turn repo overview before deeper `retrieve` / `context_pack` calls, and the README/core-profile byte-budget docs now reflect the new 7-tool default core surface.
- **Execution-slice context packs**: runtime-generation backend packs now expose a separate `execution_slice` section with ordered runtime steps and partial-path signaling while preserving the raw `slice` metadata for compatibility.
- **Pack-only compare mode**: `madar compare --baseline-mode pack_only` now compares one bounded raw-context baseline prompt against one compiled madar pack, persists the compact pack audit fields in `report.json`, and keeps `native_agent` as the provider-reported runtime benchmark path.
- **Share-safe proof reports**: `compare`, `review-compare`, and runner-backed `benchmark --exec ...` executions now emit a companion `report.share-safe.json` with stable path placeholders while keeping the full local `report.json`.
- **Generate performance benchmark harness**: adds a small synthetic benchmark flow for `generate`, `update`, `cluster-only`, and SPI cold/warm cache runs, with structured metrics for wall-clock time, file/extraction counts, graph size, output bytes, and cache-hit reasons plus new docs for manual large-repo measurements.
- **Deterministic answer-quality rubric skeleton**: shared GoValidate benchmark gates now include answer-term checks plus manual-review concept notes, and `verify-answer-quality.js` can validate saved benchmark answer artifacts without calling an LLM.
- **Public GoValidate benchmark suite**: adds `docs/benchmarks/govalidate-suite/questions.json` with stable prompt ids and descriptions for ten realistic product questions, preserves optional `id`/`description` metadata in shared benchmark question files, and documents the suite as a conservative public prompt set that stays separate from the dated single-prompt benchmark artifact.
- **Python semantic indexing first pass**: Python extraction now resolves imported top-level function calls across files, guards against dangling nested-function call edges, and adds first-pass FastAPI router/route/endpoint/dependency semantics for decorator-based handlers.

### Changed

- **Queue-backed runtime paths keep their worker handoff**: runtime-generation retrieval now models NestJS/BullMQ-style enqueue-to-worker boundaries with `enqueues_job` semantic edges in both SPI and legacy extraction paths. This first pass is intentionally conservative: it applies when job names are literal and the queue receiver is statically recognizable, including WorkerHost-style BullMQ processors with a queue-scoped `process()` handler. When it matches, compact runtime-generation explain-pack relationships preserve the semantic queue-to-worker handoff instead of depending on direct call chains alone or pretending the producer directly calls the worker.
- **Native-agent compare suite summary**: multi-question `compare --baseline-mode native_agent` runs now roll up comparable-question wins/losses for input tokens, turns, and latency, report mean/median input-token reduction, surface comparable-question counts when some runs are excluded from the aggregate, and highlight the best win and worst regression prompt in the terminal summary.
- **Native-agent cache-aware compare accounting**: `compare --baseline-mode native_agent` now persists derived total/uncached/cached Anthropic input-token fields alongside the raw provider `usage` block, and the terminal summary breaks out uncached/cache creation/cache read lines when cache activity is present.
- **Compact compare trace summaries**: compare summaries now add a single `Madar trace:` line when `report.json` includes `madar_trace`, and the benchmark docs clarify that the persisted field stores only compact, share-safe metadata (counts, tool names, per-turn summaries).
- **Adaptive context-pack render modes**: compiled and retrieved packs now choose one of six deterministic first-pass renderings (`signature`, `behavior_sketch`, `call_chain`, `contract_view`, `implementation_excerpt`, `dependency_record`) after node selection, so task kind can change emitted shape without changing retrieval selection. Lower-token review/impact renderings trade away some raw implementation detail, while explain-mode packs keep full snippets when they are already available.
- **First-pass storage semantics for SPI retrieval**: `--spi` now tags Prisma model operations as read/write endpoints, classifies repository CRUD methods as persistence readers/writers, projects `storage_operation` metadata into extraction nodes, and lets retrieval prefer likely persistence endpoints for storage-oriented prompts. Coverage is intentionally static first-pass only; it does not infer full ORM dataflow.
- **SPI Next.js App Router boundaries are more informative**: `--spi` now keeps app-router convention roles while projecting static `runtime_boundary` metadata for visible client/server entrypoints, tags exported client components from `'use client'` app-directory modules, and recognizes clearly exported server actions from file-level or inline `'use server'` directives. This is still a conservative static pass, not full React/Next runtime modeling.

## [0.22.9] - 2026-05-16

### Added

- **Small sample TypeScript workspace**: adds `examples/sample-workspace/` plus a short tutorial and checked-in prompt examples so new users can run `generate` and `pack` against a compact TypeScript demo without needing a private repo or the larger benchmark demo corpus.
- **Agent orchestration guide**: adds `docs/integrations/agent-orchestration.md` with conservative multi-agent workflows for Claude Code, Codex, Copilot, Cursor, and Gemini, including when to use installed rules, MCP, `pack`, and `prompt`, plus guidance for avoiding repeated context expansion.
- **Codex CLI integration profile**: `madar codex install` now writes Codex-specific context-pack-first AGENTS.md guidance, registers a Codex hook reminder, documents uninstall behavior, and includes generated-text/config tests without requiring Codex during automated runs.
- **Aider and OpenCode profile verification**: `madar aider install` and `madar opencode install` now document their real generated artifacts, ship stronger context-pack-first profile text, and add regression coverage for install behavior without requiring either external agent in CI.
- **Interactive CLI update notices**: interactive `madar` runs now check npm for newer releases using a cached user-level registry lookup, print a short upgrade hint when a newer version exists, and stay silent for `--help`, `--version`, `--json`, CI, and explicitly disabled runs (`MADAR_DISABLE_UPDATE_NOTIFIER=1`).
- **Contributor issue templates**: contributor docs now link the public roadmap and GitHub issue forms cover docs, benchmark, and research/design requests with explicit private-data and reproducibility expectations.
- **Release checklist page**: adds `docs/release.md` with a repeatable maintainer checklist covering version bumps, changelog updates, verification commands, package dry-runs, CLI smoke checks, and post-release verification.
- **Public roadmap page**: adds `docs/roadmap.md` with contributor-facing P0/P1/P2 tracks, issue links, label explanations, and a README pointer back to the main roadmap tracker.
- **End-to-end getting started tutorial**: adds `docs/tutorials/getting-started.md` with a local-first sample-workspace walkthrough covering install, graph generation, `pack`, `prompt`, and a safe `compare` smoke check without requiring paid model usage.
- **Doctor and status health checks**: added `madar doctor` and `madar status` commands to report installed version, graph freshness, local agent wiring (Claude/Cursor/Gemini/Copilot), MCP config validity, and actionable next commands when setup is missing or stale.

### Changed

- **MCP context-pack duplicate suppression**: identical `context_pack` explain calls within one MCP stdio session now reuse the prior payload when graph version and relevant options match, expose cache hit/miss metadata, and automatically miss again after `graph.json` changes.
- **Strict MCP install profile**: `claude`, `cursor`, `copilot`, and `gemini` installs now accept `--profile strict`, keep the lean core MCP tool surface, and rewrite generated guidance toward one `context_pack` first with diagnostics-driven expansion instead of broad exploration.

## [0.22.8] - 2026-05-13

### Added

- **CLI version flags for reproducible runs**: `madar --version` and `madar -v` now print the installed package version and exit cleanly without requiring graph generation.

### Docs

- **Conservative GoValidate report-generation benchmark note**: adds a dated benchmark artifact for one real `compare --baseline-mode native_agent` run on the prompt `"Explain how idea report is getting generated"`, including the exact Anthropic-reported token/turn/latency numbers used, the compact `pack` quality gate values, and explicit safe vs unsafe interpretations.
- **Benchmark caveats are explicit**: the new benchmark note calls out that the result is one prompt/project, that native-agent runs are stochastic and tool-usage-sensitive, and that the measurement does not prove universal token reduction.

## [0.22.7] - 2026-05-12

### Changed

- **Native-agent compare summaries keep the right direction**: human-readable `madar compare --baseline-mode native_agent` output now says `x more` / `x slower` when Madar uses more turns, latency, or input tokens than baseline, instead of incorrectly rendering `0.33x fewer` / `0.33x faster`.

## [0.22.6] - 2026-05-12

### Changed

- **Broad runtime-generation packs stay compact**: slice-v1 now follows the strongest backend runtime anchor forward through runtime `calls` while preserving bounded controller/provider context and suppressing sibling route families, shared-hub fan-out, and script/migration noise for broad report-generation prompts.
- **Cross-platform runtime path scoring is consistent**: retrieval tokenization and source-path matching now normalize Windows-style paths so the same backend runtime anchors win across Linux, macOS, and Windows runs.
- **Graph seed prompts no longer bypass script penalties**: bare `seed` phrasing no longer grants script/migration permission, so graph seed and seed-node questions still penalize migration/script candidates unless the prompt explicitly asks for seeding or scripts.
- **Runtime over-expansion diagnostics and regressions are stronger**: context-pack diagnostics now flag overfilled runtime-generation packs, and the realistic NestJS SPI fixture covers noisy sibling controllers, shared auth/LLM hubs, queue registration, migration scripts, and input-validation review fixes.

## [0.22.5] - 2026-05-12

### Changed

- **Broad report-generation prompts now route to backend runtime paths**: retrieval-gate signals distinguish runtime generation from frontend display rendering, slice-v1 demotes frontend source-path-only anchors for backend-generation prompts, and realistic SPI regressions cover `ReportFooter` frontend noise without breaking report UI/display prompts.

## [0.22.4] - 2026-05-12

### Changed

- **Slice-v1 now keeps runtime-path compaction aligned with the selected slice**: exact method pipeline prompts promote direct runtime path nodes from the slice/full retrieve result into compact `pack.matched_nodes` instead of collapsing back to a 5-node framework summary.
- **Shared-hub fan-in is suppressed for exact pipeline slices**: bidirectional `calls` graphs no longer pull unrelated callers of shared helpers/queue hubs back into `selected_paths`, and explicit `Class.method` anchors now prefer a single strongest method anchor instead of seeding sibling method anchors.
- **Diagnostics now flag omitted slice path evidence**: `slice_path_nodes_not_promoted` warns when direct runtime path nodes found by slice-v1 are missing from the final context pack.

## [0.22.3] - 2026-05-12

### Changed

- **Real NestJS provider-call edges now survive SPI graph generation**: `buildSpi` now resolves GoValidate-shaped `this.service.method()` calls from constructor-injected providers even when the workspace uses NodeNext-style extensionless deep relative imports, so projected `nest_route` nodes keep outgoing `calls` links to provider methods instead of collapsing to same-class helpers only.
- **Realistic NestJS SPI regression coverage**: adds a GoValidate-shaped fixture with deep extensionless imports, decorators, `@Inject()` parameter properties, nested module paths, and graph/projection/retrieval assertions so future releases catch missing provider-call links before shipping.

## [0.22.2] - 2026-05-12

### Changed

- **Fixture-backed NestJS runtime-path coverage**: adds a real SPI workspace fixture that locks in DI-aware route-method call chains from controller -> service -> worker -> repository retrieval, while keeping tests/benchmarks/fixtures available as wrong-domain noise for exclusion-aware prompts.
- **Route-isolation diagnostics**: context-pack diagnostics now warn when a pipeline-shaped slice anchors a route method but never leaves controller-local helper calls (`isolated_route_method`, `missing_provider_call_edges`), which helps distinguish stale/under-linked graphs from healthy runtime-path packs.

## [0.22.1] - 2026-05-12

### Changed

- **Default graph discovery is stricter on duplicate/generated paths**: legacy detect and `--spi` now share hard ignores for nested worktrees, VCS metadata, `out`, dependency stores, and common build/cache outputs, while keeping tests, benchmarks, fixtures, and mocks indexable unless the user excludes them.
- **Retrieval exclusions are intent-aware and token-aware**: prompts like "exclude tests" or "do not include benchmarks" no longer classify as `test` intent, and the parsed excluded domains/terms now suppress matching retrieval candidates without false-positive substring hits on production identifiers such as `ContestService`.
- **Slice-v1 anchors and traversal are more truthful for production prompts**: literal file-path mentions are distinguished from lexical source-path overlap, explicit `Class.method` prompts anchor the method instead of the class, and pipeline-shaped NestJS prompts now walk backward/forward through controller, service, orchestrator, and persistence paths without exploding into sibling controller methods.
- **Context-pack diagnostics catch semantically wrong packs**: diagnostics now flag excluded-domain selections, polluted source paths, controller-only pipeline packs, missing method anchors/runtime pipeline evidence, and test-dominated production packs.

## [0.22.0] - 2026-05-11

### Added

- **Opt-in task-conditioned slicing v1**: retrieval can now run with `retrievalStrategy: 'slice-v1'` to anchor on explicit symbols/paths, take bounded explain/debug/impact/review-oriented slices, suppress barrel-like nodes, and emit `slice` metadata (`mode`, `anchors`, `directions`, `selected_paths`) alongside the selected pack.
- **Real-workspace benchmark flow**: `docs/benchmarks/2026-05-11-spi-vs-legacy/` now ships `run-real-workspace.sh`, `summarize-real-workspaces.mjs`, `prompts.real-workspace.example.json`, and `REAL_WORKSPACE_REPORT_TEMPLATE.md` so backend-only and monorepo workspaces can be benchmarked locally without committing private paths or artifacts.

### Changed

- **Sketch semantics are richer but still deterministic**: `resolution: 'sketch'` now surfaces `reads env`, config reads, and compact side-effect hints such as `external_http`, `llm_call`, and `db_write` when graph evidence exists, while preserving dependency-record output for lighter nodes.
- **Slice-v1 is exposed safely in CLI/MCP**: CLI `pack`, MCP `retrieve`, and MCP `context_pack` now accept `retrieval_strategy: 'default' | 'slice-v1'`, validate unsupported values clearly, and keep compact output unchanged unless the caller opts in.
- **Benchmark analysis is broader and more honest**: the SPI probe now records resolution comparisons (`detail` / `signature` / `sketch`), slice-v1 runs, retrieval-gate metadata, top files, and a value-per-token calibration summary instead of implying a token win.
- **Release hardening for slice-v1 and benchmarks**: async semantic/rerank retrieval now preserves slice boundaries and slice metadata, sketch side-effect hints only derive from executable `calls` edges, benchmark helpers fail clearly on malformed JSON and missing local workspace inputs, and review tasks reject unsupported `retrieval_strategy` values instead of silently ignoring them.

## [0.21.0] - 2026-05-11

### Changed

- **Context-pack value scoring and diagnostics**: `selection_strategy: 'value-per-token'` now scores optional candidates with deterministic evidence-aware signals instead of candidate order, and compiled packs can carry `selection_diagnostics` with per-candidate score, density, reasons, and penalties.
- **Operational retrieval levels**: `retrieval_level` now constrains expansion in runtime retrieval instead of acting as metadata only. Level 0 can short-circuit broad retrieval, level 1 stays seed-local, levels 2–4 progressively add direct dependencies, behavior-slice signals, and broader impact/caller context.
- **Deterministic compressed representations**: `applyContextPackResolution()` now supports `resolution: 'sketch'`, emitting graph-derived `behavior_sketch` / `dependency_record` representations with `representation_type` and `representation_reason`, falling back to `signature` when graph links are unavailable.
- **Context-pack MCP surface**: `context_pack` now accepts `resolution: 'signature' | 'sketch'` in addition to the existing modes, and `verbose: true` can include extended `selection_diagnostics` without bloating the default compact response.

### Docs

- **SPI benchmark harness/report**: `docs/benchmarks/2026-05-11-spi-vs-legacy/` now emits `spi-cold.analysis.json` with selection-strategy comparisons and retrieval-level 1–4 sweeps. The latest bundled fixture run still shows substrate-correct SPI answers plus operational retrieval-level expansion, but no measured `value-per-token` token win over evidence-order on that fixture.

## [0.20.0] - 2026-05-11

> Consolidated release covering both the v0.19-spi-payoff and v0.20-context-compiler milestones. v0.19 was never tagged in isolation — its work (#129, #130, #133) is shipped together with v0.20's items (#131, #132, #134) here.

### Added — v0.19 payoff (SPI substrate becomes measurable)

- **Hono / Fastify / tRPC / Prisma retrieval boost (#129)**: new framework-shaped questions ("show me hono routes", "what tRPC mutations exist", "find the Prisma client") now route to the structurally-correct substrate nodes via `framework_role` boost. Previously only Express / NestJS / Next.js / React Router / Redux had boost rules.
- **SPI vs legacy benchmark harness (#130, closed by PR #136)**: `docs/benchmarks/2026-05-11-spi-vs-legacy/` ships a reproducible runner + fixture covering Express / Hono / tRPC / Prisma. First measured numbers on the fixture: **−26% pack tokens with `--spi`**, **−32% graph.json size**, **+40% slower cold build**, **cache-hit rebuilds 27% faster than legacy**. Critically, the legacy pipeline mis-routes substrate-shaped questions (Prisma query → Express middleware nodes; tRPC mutation query → Express routers) which `--spi` corrects.
- **Metadata-aware framework boost (#133, closed by PR #137)**: extends the boost rules to use `route_path` / `http_method` / `mount_path` / `slice_name` / `procedure_name` / `router_name` substrings — not just the role string. Express was tagging `route_path` but not `http_method` previously; now both flow. Differentiates POST `/users` vs GET `/users`, `authSlice` vs `counterSlice`, `cancelOrder` vs `getUser` procedures. Plus: word-boundary check on http_method (no longer matches "budget"), metadata-only seeding (nodes with no label overlap can still be seeded by metadata), no double-counting of framework_boost in async retrieval.

### Added — v0.20 context compiler

- **Value-per-token selection_strategy (#131)**: new optional input on `compileContextPack`: `selection_strategy: 'evidence-order' | 'value-per-token'`. When `value-per-token`, required-evidence-class candidates are placed first (must-include), then remaining optional candidates compete by density (`score / token_cost`) via `selectByValuePerToken`. Default unchanged.
- **`signature` resolution level (#132)**: `applyContextPackResolution` now accepts a fourth mode alongside `detail` / `summary` / `mixed`. Signature mode keeps the first 1–2 lines of each snippet (function signature) and drops the body — middle ground when the agent needs param types and return shape but not implementation.
- **SPI default-readiness decision framework (#134)**: new doc `docs/decisions/2026-05-11-spi-default-readiness.md` codifies the graduation criteria for flipping `--spi` to the default pipeline, plus the post-flip fallback path. Decision framework, not code — the next code change (the actual flip) must meet this checklist.

### Notes

- v0.20 deliberately defers **#135 task-conditioned slicing v1** — it's a multi-PR substrate (anchor detection, slice walker, task-mode traversal) that doesn't fit a one-shot bundle.
- The `--spi` flag remains opt-in. The default-readiness doc (#134) defines the path to flipping it.

## [0.18.0] - 2026-05-11

### Added

- **`madar generate . --spi`** opt-in flag wires the v0.14–v0.17 SPI substrate into the CLI for the first time. When set, `generateGraph` uses `buildSpiCached` + `projectSpiToExtraction` instead of the legacy `extract()` pipeline. Default behavior is unchanged — pass `--spi` to enable. User-visible wins:
  - `framework_role` + `framework_metadata` from all 9 framework substrates (NestJS, Express, Next.js, React Router, Redux Toolkit, Hono, Fastify, tRPC, Prisma) flow into the projected `ExtractionData`.
  - Repeat builds on an unchanged workspace hit the on-disk SPI cache (`out/.spi-cache/`, see #77) — near-zero rebuild time.
  - Build notes include `"SPI cache hit (N files, key XXXXXXXX)"` or `"SPI build via projector (reason=...)"` so users can see which path ran.

### Notes

- v0.18 is the **CLI-integration** release: the substrate work from v0.14–v0.17 is now actually reachable from `madar generate` without writing library code.
- The default pipeline stays on legacy `extract()` for safety — the SPI parity tests pin shape parity but not strict byte-equivalence. A future release can flip the default once `--spi` has been validated against real workspaces.

## [0.17.0] - 2026-05-11

### Added

- **Hono framework substrate (#83)**: detects `new Hono()` apps, http-method route registrations (`app.get` / `.post` / etc.) with `route_path` + `http_method` metadata, and `app.use([path], middleware)` registrations with optional `mount_path`. New SpiFrameworkRole values: `hono_app`, `hono_route`, `hono_middleware`.
- **Fastify framework substrate (#83)**: detects `Fastify()` / `fastify()` factory calls (default and named imports) → `fastify_app`, `app.<method>(path, [opts,] handler)` → `fastify_route` with `route_path` + `http_method`, and `app.register(plugin, { prefix })` → `fastify_plugin` with optional `mount_path`.
- **tRPC framework substrate (#83)**: detects `<builder>.router({...})` calls → `trpc_router`, and **synthesizes** procedure SpiSymbol entries (`<routerName>.<procedureName>`) for object-literal properties whose value chains end in `.query` / `.mutation` / `.subscription`, with `procedure_name` + `router_name` on framework_metadata. Synthesis mirrors the Express inline-handler pattern from slice 1c-ii.e since tRPC procedures don't have top-level SpiSymbols by default.
- **Prisma framework substrate (#83)**: detects `new PrismaClient()` bindings → `prisma_client`. Schema.prisma parsing and model-access tagging (`prisma.user.findMany`) intentionally deferred — they're substantial slice trains in their own right.

### Notes

- v0.17.0 is the **framework-breadth** release: four new TypeScript framework detectors slot cleanly into the existing SPI substrate, bringing total framework coverage to nine (NestJS, Express, Next.js, React Router, Redux Toolkit, Hono, Fastify, tRPC, Prisma).
- #84 (deeper Python / Go semantic passes) deferred — each language needs its own runtime substrate beyond tree-sitter AST, multi-PR effort. Tree-sitter coverage for Python / Go / Ruby / Java / Rust remains shipped as today.

## [0.16.0] - 2026-05-11

### Added

- **Incremental SPI cache (#77)**: new `buildSpiCached(opts)` wraps `buildSpi` with disk-backed all-or-nothing caching. Cache key = sha256 of workspace root + extractor_version + madar_version + tsconfig content + per-file `(path, mtime, size, sha256)`. Repeat builds on an unchanged workspace skip the full ts.Program pass and return the cached SemanticProgramIndex. Public API: `buildSpiCached`, `clearSpiCache`, `BuildSpiCachedOptions`, `BuildSpiCachedResult`, `SpiCacheStats`, `SpiCacheIndex`. Cache lives in `<root>/out/.spi-cache/` and is format-versioned for clean invalidation on future schema changes.
- **Multi-resolution context (#76)**: new `applyContextPackResolution(nodes, options)` helper adapts a node list to `detail` (no-op), `summary` (drop snippet bodies, keep label/source_file/line_number/match_score), or `mixed` (top-N by match_score get detail, rest summary). New stdio `context_pack` parameter `resolution: 'detail' | 'summary' | 'mixed'` (default `detail`). Response includes `resolution_map` (per-node summary/detail decisions) and `bytes_saved_by_resolution`. Currently supported on the explain branch only; review/impact return a clear `jsonrpcInvalidParams` error when `resolution` is requested with an unsupported task.
- **Weighted PR-impact coverage scoring (#79)**: new `PrImpactResult` fields:
  - `coverage_score_weighted` — bridge/god labels count 3x, regular high-impact 1x. Penalises uncoverage of high-centrality hotspots more aggressively than the unweighted score.
  - `uncovered_hotspot_severities[]` — per-label `'critical'` (bridge/god) / `'high'` (regular high-impact) tier so reviewers can prioritise gaps.
  - `critical_labels[]` — bridge+god subset of high-impact labels (consumer-readable).
  - Compact result recomputes weighted score + severities against the post-compaction review bundle, same correctness contract as the unweighted `coverage_score`.
- **Cache-aware prompt layout (#80)**: new `stable_prefix_hash` field on every `BuiltContextPrompt` (sha256-16 of `stable_prefix`). Byte-stable across re-runs when the underlying graph/anchor is unchanged; invariant under dynamic-suffix changes. Consumers can compare the hash across calls to verify Anthropic's automatic prompt cache will reuse the prefix.

### Notes

- v0.16.0 is the **runtime-efficiency** release: the SPI cache eliminates the repeat-build penalty, multi-resolution gives callers token-budget control, weighted coverage gives reviewers prioritisation, and the prompt-cache hash gives consumers a measurable cache-reuse signal.
- v0.17-language-expansion is next: Prisma / tRPC / Hono / Fastify substrates (#83), deeper Python / Go semantic passes (#84).

## [0.15.0] - 2026-05-11

### Added

- **Context-pack quality diagnostics (#78)**: new `computeContextPackDiagnostics(pack)` scorer emits a deterministic `quality_score` (0–1), severity-ordered warnings, and the raw signals used to compute them. Nine weighted rules detect bad runs: missing required evidence (error), missing required semantic categories, zero claims, undersized retrieval, budget underutilization, missing snippets, low average match_score (now firing on the worst case `avg=0`), orphan nodes (entities with no relationships), and absent architectural signals. Wired into the stdio `context_pack` response (explain branch) so callers see quality flags inline.
- **Delta-only context packs via stdio (#81)**: new `delta_session_id` parameter on `context_pack` makes subsequent calls in the same session ship only nodes the agent hasn't seen yet, plus `referenced_ids[]` for dropped nodes and a `bytes_saved` estimate. New MCP tool `context_pack_session_reset` clears a delta session. Backed by a per-MCP-process LRU `Map<sessionId, Set<nodeId>>` (256 sessions, same bound as prompt sessions).
- **Value-per-token budget selector (#74)**: new pure helper `selectByValuePerToken(candidates, options)` ranks candidates by `score / token_cost` density (greedy bounded-knapsack approximation) and returns the prefix that fits within budget. Deterministic tie-breaking (score desc → cost asc → id asc). Returns per-candidate ranking with rank/density/included flags for diagnostics. Available as a building block for future selection refinements in `retrieve.ts`.

### Notes

- v0.15.0 is the **quality-signals** release: every context_pack response now carries machine-readable feedback on its own structural quality, and per-session dedup makes multi-turn agents cheaper.
- The three v0.15 items deferred to v0.16: PR-impact coverage calibration (#79, needs real PRs), cache-aware prompt-layout measurement (#80, sort_key bands already shipped), and multi-resolution context representations (#76, new representation layer).

## [0.14.0] - 2026-05-11

### Added

- **Semantic Program Index (SPI) v1 substrate (#72)**: complete versioned, typed, deterministic internal representation of TypeScript/Node workspaces — files, symbols (functions/classes/interfaces/types/enums/methods/constants/variables/namespaces), and edges (declares, imports, exports, calls, extends, implements, param_type, return_type, covered_by). Built once via `ts.Program` + the TypeScript type checker, with workspace fingerprinting and deterministic serialization.
- **Framework-aware semantic substrates**: five framework detectors layered over SPI:
  - **NestJS** — modules, controllers, providers, guards/pipes/interceptors, route methods, constructor + `@Inject('TOKEN')` injects edges, dynamic module diagnostics.
  - **Express** — apps, routers, named/inline route handlers with `route_path` + `http_method` metadata, middleware, **cross-file mount-prefix resolution** via the type checker (alias-following + same-file router lookup), router-root trailing-slash normalization.
  - **Next.js** — file-convention tagging for `app/*/page.tsx`, `app/*/route.ts`, `app/*/layout.tsx` (+ loading/error/template), `pages/*`, `pages/api/*`, root `middleware.ts`; `route_path` derived from file path with dynamic segments (`[id]` → `:id`), catch-alls (`[...slug]` → `*`), optional catch-alls (`[[...slug]]` → `*?`), route groups (`(auth)` stripped), parallel routes (`@modal` stripped), and intercepting-route prefixes (`(.)/(..)/( ...)` stripped); HTTP-method exports get `http_method` metadata.
  - **React Router** — `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` / `createStaticRouter` detection, in-config loader/action tagging with `route_path`, nested children path composition, index/pathless layout handling, hoisted same-file route-config arrays (`const routes = [...]; createBrowserRouter(routes)`).
  - **Redux Toolkit** — `createSlice` (slice_name, reducer_keys, action_creators), `configureStore` (reducer_keys), `createAsyncThunk` (type_prefix), `createApi` / RTK Query (endpoint_names from both concise and block arrow-function bodies), `createSelector` / `createDraftSafeSelector` role tagging.
- **SPI → ExtractionData projector**: `projectSpiToExtraction(spi, { root })` bridges the SPI substrate to the existing `buildFromJson → cluster → analyze → graph.json` pipeline. Propagates `framework_role` + `framework_metadata` onto every projected `ExtractionNode` so downstream consumers (retrieval, context packs, MCP) can filter by framework without re-parsing.
- **SPI diff overlay**: `computeSpiDiffOverlay` projects PR-impact deltas through the SPI substrate (slice 3a of #72).

### Changed

- **Express route_path normalization**: `joinRoutePath` collapses the router-root `'/'` case (`app.use('/api/users', router)` + `router.get('/', ...)` → `/api/users`), matching the legacy extractor's emission. Non-root Express semantics preserved unchanged (`/api` + `/api` → `/api/api`).
- **Mount-prefix resolution**: workspace-level finalizer (`finalizeExpressMountPrefixes`) runs after per-file detection so cross-file router mounts resolve regardless of file order.

### Notes

- The SPI substrate is **additive** — the existing `extract()` pipeline remains untouched. Consumers can adopt incrementally via `buildSpi` / `projectSpiToExtraction`.
- Full byte-equivalence with the legacy `extract()` on `examples/demo-repo/out/graph.json` is **not** asserted in this release; the parity tests pin shape parity and the documented taxonomy divergence (legacy emits separate synthesized route nodes, SPI tags handlers directly). Strict byte-equivalence is deferred to a follow-up release.

## [0.13.3] - 2026-05-10

### Changed

- **Marketing positioning**: rewrote the README to lead with AI coding-agent value ("stop making AI agents re-read your repo") and added explicit Why madar, What it does, Core concept, Works with your AI tools, Limitations, and Roadmap sections. All measured numbers and CLI commands are unchanged.
- **Package discoverability**: refreshed `package.json` description and expanded keywords (`ai`, `ai-agents`, `claude-code`, `codex`, `copilot`, `cursor`, `code-intelligence`, `pr-review`, `static-analysis`) so the package surfaces for AI-agent users on npm search.

## [0.13.2] - 2026-05-08

### Fixed

- **Native-agent compare fallback**: preserve exit-0 plain-text `compare --baseline-mode native_agent` runs as answer-only artifacts instead of misclassifying them as failures when Anthropic JSON usage blocks are unavailable.
- **Release metadata alignment**: realigned the package version and changelog with the post-merge release tag workflow so GitHub release validation passes on the next tagged cut.

## [0.13.1] - 2026-05-08

### Note

- **Superseded release tag**: `v0.13.1` was published before `package.json` and `CHANGELOG.md` were advanced from `0.13.0`, so the release workflow rejected it. Use `v0.13.2` for the corrected post-merge release.

## [0.13.0] - 2026-05-08

### Added

- **Task-context planner release**: added task-intent classification, task-specific evidence recipes, semantic coverage reporting, stable expandable handles, and planner-backed `task_intent` / `plan` metadata across compact context-pack surfaces.
- **Executable MCP expansion**: added the full-profile `context_expand` MCP tool so agents can reopen omitted context slices from a prior `context_pack` response inside the same MCP session.

### Changed

- **Context-pack/runtime alignment**: aligned CLI `pack` and MCP `context_pack` around planner-aware metadata, normalized budget handling, and consistent impact-target selection.
- **Docs and examples**: refreshed the README, proof workflows, and MCP examples so the 25-tool full surface, `context_expand`, semantic coverage, and provider/runtime proof disclosures match the shipped runtime.

### Fixed

- **Provider-proof honesty**: corrected compare and benchmark proof reporting so zero-cache provider usage is no longer described as provider-reported cache-read evidence.
- **Impact and expansion metadata**: preserved `target_file_type` in compact impact payloads, trimmed impact target labels before follow-up lookup, hardened fallback line-range handling, and reject malformed stored `context_expand` handles instead of failing with generic runtime errors.
- **Workspace hygiene**: added `.test-artifacts/` to `.gitignore` so local test artifacts stay out of release branches and PRs.

## [0.12.0] - 2026-05-08

### Added

- **Context-pack compiler surface**: added shared context-pack contracts plus the new `madar pack` CLI command for compact explain, review, and impact packs with claims, coverage, expandable refs, and missing-context reporting.
- **Context-session prompt compilation**: added shared context-session state/delta contracts plus the new `madar prompt` CLI command for provider-ready prompts, session payloads, and cache-aware follow-up reuse accounting.
- **MCP context-plane tools**: added `context_pack`, `context_prompt`, and `context_session_reset` to the full MCP tool profile so agents can request compact context packs, provider-ready prompts, and session resets over stdio.

### Changed

- **Context-plane product surface**: refreshed the README, MCP examples, benchmark docs, and package metadata around the shipped “context plane” / “context compiler” positioning.
- **Cache-aware compare and review flows**: unified `compare`, `review-compare`, and benchmark reporting around effective token metrics, coverage metadata, and session-aware prompt packaging.

### Fixed

- **Clean-install compatibility on this environment**: restored the Vite 6.x floor so fresh installs continue to work on the current Node 22.9 setup used during release verification.
- **Prompt/session release hardening**: fixed provider token-count consistency, removed misleading hardcoded prompt task metadata, bounded stored context-prompt sessions, and reject duplicate context session refs.

## [0.11.0] - 2026-05-05

### Added

- **OpenCode MCP installer support**: `madar opencode install` now wires madar into [OpenCode](https://opencode.ai), extending the agent-installer matrix beyond Claude Code, Cursor, Copilot, Gemini CLI, and Aider. Thanks to [@jamemackson](https://github.com/jamemackson) for contributing this feature in [#54](https://github.com/mohanagy/madar/pull/54) — the first community-contributed agent integration in madar.
- **Auto-updating contributors list in README**: a new GitHub Actions workflow (`.github/workflows/contributors.yml`) regenerates the contributors table on every push to `main`, so new contributors are credited automatically without manual README maintenance.

## [0.10.12] - 2026-05-03

### Fixed

- **Benchmark chart readability**: the hosted benchmark comparison bars now use dedicated saturated fill tokens instead of the faint legend-chip tint, so the measured width differences read clearly at a glance.
- **Terminal command visibility**: benchmark `<pre><code>` blocks now strip the inline-code chip styling, preventing pale overlays from obscuring commands inside the dark terminal reproducer panels.

## [0.10.11] - 2026-05-02

### Fixed

- **Hosted retrieval benchmark warning color**: replaced the undefined `--amber-400` token in the 2026-04-30 benchmark page with the defined `--c-lemon` warning color so the published trade-off label renders consistently.
- **Contributing guide clarity**: removed the circular repository-settings sentence from `CONTRIBUTING.md` so the public contribution guide stays concrete and user-facing.

## [0.10.10] - 2026-05-02

### Changed

- **Hosted benchmark pages redesign**: replaced the auto-generated benchmark UI under `docs/benchmarks/` with a Stripe-inspired design system — Inter (with `ss01` + `tnum` features) on white surfaces, deep-navy headings (`#061b31`) with a `#533afd` purple accent, multi-layer blue-tinted shadows, and a 4–8px border-radius scale. Hero, headline-metric, supporting-metric grid, comparison bars, setup list, terminal reproducer block, evidence file list, and disclosure callout were all rebuilt; bar widths remain mathematically tied to the underlying data.

### Fixed

- **Landing page "Why these are reproducible" section**: the four-item explainer was using `<ol><li><dt>/<dd></li></ol>`, which collided with the `.setup-list` 2-column CSS grid and squeezed the right column to one word per line. Switched to a flat `<dl>` so dt/dd pairs map cleanly into the grid.
- **Public docs surface cleanup**: removed internal planning, review, maintainer, marketplace-prep, and research material from `docs/` so the public docs tree now only exposes user-facing guides and proof artifacts.

## [0.10.9] - 2026-05-02

### Added

- **Public proof and distribution assets**: added the benchmark hub and hosted benchmark pages under `docs/benchmarks/`, committed a real GoValidate Platform PR-review benchmark artifact, and added repo-side marketplace listing assets for Smithery and awesome-mcp submissions.

### Fixed

- **Benchmark artifact privacy**: `review-compare` now sanitizes path-derived identifier fields before persisting prompt artifacts, preventing workstation or username fragments from leaking into committed PR-review benchmark evidence.
- **Pages workflow hardening**: pinned the GitHub Pages workflow actions to immutable SHAs and cleaned up the benchmark page monospace font stack.

## [0.10.8] - 2026-05-02

### Changed

- **README benchmark framing**: removed the top-level benchmark cost row and softened the surrounding copy so the published package page leads with speed, fewer turns, and local/privacy value instead of a cold-start model-cost caveat.

## [0.10.6] - 2026-05-02

### Changed

- **README refresh for the published package**: repositioned the npm/GitHub landing copy around the measured production benchmark, a faster quickstart, clearer local-first/privacy guarantees, and explicit trade-off disclosure for cold-start versus multi-question sessions.

## [0.10.5] - 2026-05-01

### Changed

- **Large-graph HTML export clarity**: overview exports now generate dedicated bridge neighborhood pages, and community pages label local-only connectivity as `Local degree` instead of reusing the ambiguous global `Degree` wording.

### Fixed

- **Bridge navigation mismatch**: workspace bridge cards no longer jump into a node's home community page where the cross-community context disappears; they now open a focused bridge neighborhood view that preserves the bridge node's immediate surrounding context.
- **Community scope ambiguity**: interactive and summary community pages now explain that they only show in-community nodes, while bridge-aware nodes surface `Global degree` and `Connected communities` metadata when that broader context exists.

## [0.10.4] - 2026-05-01

### Added

- **`review-compare` real-repo benchmark command**: added a CLI flow that compares verbose versus compact `pr_impact` prompts for the current git diff, saves prompt/report artifacts under `out/review-compare/`, and can optionally execute both prompts through a user-supplied runner template.

### Changed

- **Compact review payload usefulness**: `pr_impact` compact output now carries typed `review_context` with supporting paths, likely test paths, and structural hotspots so the smaller review packet still points reviewers at the most relevant follow-up context.
- **Compact review payload size on real repos**: compact `pr_impact` now trims oversized outer arrays (`changed_files`, `changed_ranges`, `seed_nodes`, `affected_communities`, `high_impact_nodes`) instead of only shrinking the inner review bundle, which cuts real review payload size dramatically on large live diffs.

### Fixed

- **Real-workspace PR diff detection**: `pr_impact` now discovers and reads diffs from nested git repositories under the graph root, so review mode works on multi-project workspaces instead of assuming the graph root itself is a git repo.
- **Review benchmark output-dir validation**: `review-compare` now accepts nested output directories whose parents do not exist yet and correctly validates absolute external output paths against the target graph's own `out/` directory.
- **CLI/runtime validation parity**: the `review-compare` parser no longer rejects valid absolute output directories before runtime can validate them against the selected graph workspace.

## [0.10.3] - 2026-05-01

### Added

- **Diff-first PR review selection**: `pr_impact` now parses unified git diff hunks into `changed_ranges`, narrows to line-aware `seed_nodes`, falls back safely to file-level seeds when symbol line metadata is missing, and returns ranked review risks with severity/reason summaries.

### Changed

- **Compact-by-default PR review MCP output**: the MCP `pr_impact` tool now accepts `budget`, `verbose`, and `compact` flags, returns a compact default payload for review workflows, and preserves the full legacy-style result behind `verbose: true` or `compact: false`.
- **Review bundle compaction and regression benchmarking**: compact PR review bundles now preserve seed-first context while trimming supporting snippets and re-filtering relationships/community context, with focused regression tests pinning materially smaller review payloads on a mixed review fixture.

### Fixed

- **PR diff/runtime edge cases**: normalized reversed source ranges, hardened macOS realpath matching between git diff paths and graph node files, and covered pure-deletion hunks so review selection stays stable across real repositories.

## [0.10.2] - 2026-05-01

### Changed

- **Question-type MCP routing in installed guidance**: the generated Claude, Gemini, Cursor, and hook instructions now route agents to the matching graph tool for the task (`retrieve`, `relevant_files`, `feature_map`, `risk_map`, `implementation_checklist`, `impact`) instead of over-centralizing `retrieve` for every codebase question.

### Fixed

- **Install-guidance regression coverage**: release tests now assert that the generated Claude and Gemini instructions include the full routed tool set, including `impact`.
- **Vitest suite stability on shared machines**: capped `maxWorkers` at `4` in `vitest.config.ts` and locked that contract with a regression test so full-suite runs stop timing out from worker oversubscription.

## [0.10.1] - 2026-05-01

### Added

- **`MADAR_TOOL_PROFILE` env var**: defaults to `core` (6 tools — `retrieve`, `impact`, `call_chain`, `community_overview`, `pr_impact`, `graph_stats`); set to `full` to opt into the legacy 21-tool surface. The Claude / Cursor / VS Code Copilot install templates now write `env: { MADAR_TOOL_PROFILE: "core" }` into the generated `.mcp.json`. Reduces `cache_creation_input_tokens` per session by roughly 16–22K on a Claude Code session start, flipping a +13% cold-start cost regression to cost parity at typical session lengths.
- **`compare --baseline-mode native_agent`**: new comparison mode that runs the user's `--exec` command twice — once with `out/`, `.mcp.json`, `CLAUDE.md`, and `.claude/` snapshot-renamed out of the working directory (baseline), once with them restored (madar) — and reports the Anthropic-billed `usage` blocks from `claude --output-format json` verbatim. Atomic rename / try-finally restore guarantees no project state is left behind even if the runner crashes.
- **Public benchmark artifact**: committed `docs/benchmarks/2026-04-30-govalidate/` with both raw `claude --output-format json` outputs (with the answer body redacted) and a `verify.sh` reproducer. The README, `examples/why-madar.md`, and the install hook payload all cite numbers that `verify.sh` reproduces from the committed evidence.

### Changed

- **Honest benchmark numbers**: replaced the previously-published `384×` retrieve-compression headline (and the `397×` / `897×` variants used in internal-only baseline modes) in the README, in `examples/why-madar.md`, and in the `claude install` PreToolUse hook payload with measured numbers from the 2026-04-30 native_agent comparison: **3× fewer turns**, **~2.8× faster**, **2.6× fewer total input tokens**. Documentation now also discloses the cold-start cost premium (~+13% on a single-question session, amortizing on multi-question sessions).
- **Compare summary framing**: when `--baseline-mode` is `full` or `bounded`, the human-readable summary now appends an explicit "synthetic prompt-token estimate (cl100k_base)" disclosure line so a reader cannot mistake the synthetic ratio for an Anthropic-billed measurement. Use `--baseline-mode native_agent` for Anthropic-reported numbers.

### Fixed

- **Cold-start cost regression on Claude Code session start**: shipping the lean `core` MCP tool profile by default cuts the `cache_creation_input_tokens` overhead by ~16–22K tokens per fresh session. On the 2026-04-30 govalidate measurement this is the difference between madar costing ~13% more than the no-madar baseline and madar amortizing below baseline at multi-question session lengths.

## [0.10.0] - 2026-04-30

### Added

- **Local semantic retrieval**: added opt-in embedding-backed retrieval with `semantic` / `semantic_model` support on the MCP `retrieve` tool and runtime, keeping the default path unchanged while enabling local conceptual matching for harder queries
- **Local cross-encoder reranking**: added opt-in reranking with `rerank` / `rerank_model` support so semantic candidate pools can be rescored locally before prompt assembly

### Improved

- **AST-bounded snippet quality**: TypeScript extraction now persists bounded symbol snippets and line ranges into graph artifacts, and `retrieve` prefers stored snippets before falling back to file-window reads
- **Retrieval ranking and payload efficiency**: completed the remaining roadmap work for shared token accounting, graph-signal caching, snippet file caching, default-path relationship collection, BM25-style lexical scoring, reciprocal-rank fusion, and pruned graph artifact edge payloads
- **Eval visibility**: benchmark quality reports now include grounded match rate and query-bucket summaries so retrieval improvements are tracked beyond label-only recall and MRR
- **Compare low-budget prompt assembly**: compare retrieval now trims prompt context after retrieval with compare-specific ranking so low-budget prompts keep the highest-signal explainer nodes instead of leaf-only snippets

### Fixed

- **Vitest toolchain compatibility**: pinned `vite` to the compatible 6.x line so the test/runtime toolchain avoids the Vite 8 / rolldown native-binding failure on the current Node environment
- **Semantic dependency security**: replaced the deprecated `@xenova/transformers` package with the maintained `@huggingface/transformers` successor so the local semantic retrieval path no longer ships the vulnerable `protobufjs` dependency chain by default
- **Demo benchmark ranking stability**: non file-oriented retrieve queries now keep semantic symbols ahead of same-file path artifacts, restoring the eval benchmark's MRR regression floor without reducing recall

## [0.9.2] - 2026-04-30

### Added

- **Developer workflow MCP tools**: added `relevant_files`, `feature_map`, `risk_map`, and `implementation_checklist` so agents can move from file triage to edit planning without leaving the graph surface

### Improved

- **Eval hardening**: `eval` now reports snippet coverage alongside recall and MRR, and CI enforces the stronger regression gate on the demo graph path
- **Compact MCP defaults**: `retrieve` and `impact` now default to compact payloads, with `verbose: true` preserving the legacy fuller response shape during the transition
- **Payload hygiene**: retrieval and impact responses now emit project-root-relative paths when possible and omit empty `node_kind` noise from raw and compact payloads
- **Framework support clarity**: updated README, proof docs, and the language capability matrix to document the framework-aware JS/TS surface and `framework_role` behavior explicitly

## [0.9.1] - 2026-04-30

### Added

- **Framework-aware JS/TS expansion**: added deep semantic extraction and retrieval/impact ranking support for NestJS and Next.js, extending the existing Express, Redux Toolkit, and React Router coverage to all five planned mainstream JS/TS frameworks

### Improved

- **Framework benchmark guardrails**: benchmark-quality tests now lock representative Express, Redux Toolkit, React Router, NestJS, and Next.js questions to top-hit accuracy plus measured returned-label and token ceilings on a mixed framework graph
- **Framework support docs**: updated the README, capability matrix, and product-positioning example to describe the five-framework coverage honestly, including the boundary between mainstream conventions and dynamic fallback behavior

## [0.9.0] - 2026-04-30

### Added

- **Framework-aware JS/TS extraction**: added deep semantic extraction for Express, Redux Toolkit, and React Router so the graph now emits higher-signal route, middleware, handler, slice, selector, store, loader, action, and route-component relationships

### Improved

- **Compact MCP retrieval and impact**: `retrieve` and `impact` now support an explicit `compact: true` mode for smaller framework-aware payloads while the default MCP response shape stays backward-compatible
- **JS/TS support docs**: updated the README, capability matrix, and product-positioning docs to describe the new framework-aware extraction depth and compact MCP mode

## [0.8.9] - 2026-04-28

### Improved

- **Runner-backed proof docs**: updated README, proof-workflow docs, demo docs, and quick-benchmark examples so `benchmark`/`eval` show the required `--exec` + `--yes` flow and no longer describe those commands as offline-only

## [0.8.8] - 2026-04-28

### Improved

- **Retrieval quality**: improved retrieval ranking with relation-aware expansion so connected evidence surfaces more effectively, and strengthened recall/MRR eval guardrails to prevent misleading benchmark results
- **Gemini compare docs**: documented the stdin-safe Gemini JSON runner (`cat {prompt_file} | gemini -p "" --output-format json`) and clarified that `compare` uses reported Gemini/Claude usage when structured JSON includes it, falling back to labeled local estimates otherwise

## [0.8.7] - 2026-04-27

### Changed

- **Project license**: switched the package, repository license file, README license badge/text, and contribution terms from AGPL to MIT
- **License metadata guardrail**: package metadata tests now enforce that the manifest, README, and contributing guide stay aligned on the MIT license

## [0.8.6] - 2026-04-27

### Fixed

- **Dependency security and release hygiene**: upgraded `vitest` to `4.1.5` and `@types/node` to `25.6.0` from merged Dependabot updates
- **Coupled test-tooling updates**: Dependabot now groups `vitest` and `@vitest/coverage-v8` together, and package metadata tests enforce both the group rule and version alignment to prevent another release-time dependency skew

## [0.8.5] - 2026-04-27

### Fixed

- **Release install compatibility**: aligned `@vitest/coverage-v8` with the repo's Vitest version and added a regression test so `npm ci` succeeds on the Node 20 / npm 10 CI and release runners

## [0.8.4] - 2026-04-27

### Added

- **Graph time travel CLI**: added `madar time-travel <from> <to>` to compare two git refs through local on-demand graph snapshots with `summary`, `risk`, `drift`, and `timeline` views; the default terminal output is the `summary` view
- **Graph time travel MCP tool**: added `time_travel_compare` so MCP clients can run the same ref-to-ref comparison with `from_ref`, `to_ref`, optional `view`, `refresh`, and `limit` parameters

### Improved

- **Time travel snapshot docs**: documented that time-travel snapshots are built on demand, stored under `out/time-travel/snapshots/`, reused from cache when compatible, and rebuilt only when `--refresh` is requested

## [0.8.3] - 2026-04-26

### Added

- **Public capability matrix**: added `docs/language-capability-matrix.md` to document which languages and file types use AST-backed, tree-sitter, heuristic, document, or metadata-only extraction paths
- **Proof workflow docs**: added `docs/proof-workflows.md` to separate reproducible local proof (`benchmark`/`eval`), same-model A/B proof (`compare`), and federated multi-repo proof

### Improved

- **Impact evidence**: `impact` now follows directed dependents and reports `top_paths_per_community` so blast-radius results include path evidence instead of just aggregate counts
- **Retrieve output quality**: `retrieve` now tags matched nodes with a `relevance_band` and avoids over-expanding community-only matches, which keeps graph-guided context tighter
- **Claude install pinning**: generated `.mcp.json` entries now pin `@mohammednagy/madar` to the installed package version so project MCP setups do not silently float
- **Release and proof docs**: README and `examples/why-madar.md` now explain the public capability matrix, reproducible proof ladder, federated proof workflow, and pinned project-local MCP setup

### Fixed

- **License metadata drift**: README and contributing docs now consistently describe the package as GNU AGPL v3.0-only
- **Extractor and stdio maintainability**: refactored the major extractor and stdio hotspots into smaller modules without changing the command surface, making the release safer to maintain

## [0.8.2] - 2026-04-25

### Improved

- **Compare evidence reports**: prompt-token counts now use a local `cl100k_base` tokenizer estimate, persist explicit estimated-token fields, and classify prompt-size failures as `context_overflow` instead of generic failures

## [0.8.1] - 2026-04-25

### Fixed

- **Compare exec templates**: `madar compare` now rejects shell command substitution around `{prompt_file}` so full-repo prompts do not get expanded into argv and fail with OS argument-length limits
- **Compare docs and examples**: README and `examples/why-madar.md` now use stdin-safe runner patterns like `cat {prompt_file} | claude -p` and explicitly warn against command-substitution forms

## [0.8.0] - 2026-04-25

### Added

- **`madar compare` command**: runs a real baseline-vs-madar A/B prompt comparison through a user-supplied terminal LLM command and saves prompt/answer proof bundles under `out/compare/`
- **Compare proof artifacts**: each run now saves prompt files, answer files, and a structured `report.json` with prompt-token counts, statuses, timings, and output paths

### Improved

- **Compare runner safety**: added confirmation before paid prompt runs, clean `--yes` support for non-interactive usage, safer shell execution, and redacted failure reporting in persisted compare artifacts
- **Compare docs**: README and `examples/why-madar.md` now explain when to use `benchmark`, `eval`, and `compare`, including runner placeholders and saved proof outputs

## [0.7.3] - 2026-04-24

### Improved

- **Retrieve quality — community-label scoring**: nodes in communities whose label matches query tokens get a mild boost, bridging conceptual queries ("pipeline") to implementation nodes in that community
- **Retrieve deduplication**: removed redundant community/label computation calls for faster retrieval

### Fixed

- **Gold-standard questions aligned**: eval questions now use terms that match actual node labels, restoring 95% recall with measurable 28.8x compression

## [0.7.0] - 2026-04-24

### Added

- **`madar eval` command**: measures retrieval quality with recall, MRR, and compression ratio against a gold-standard question set
- **Progress output during generate**: step-by-step feedback (detect → extract → build → cluster → analyze → export) so users know the tool isn't hanging
- **Next-steps guidance after generate**: prints platform install commands (`claude install`, `cursor install`, etc.) after graph generation completes
- **Pre-install validation**: warns if `out/graph.json` doesn't exist when running `claude install`, `cursor install`, `gemini install`, or `copilot install`

### Improved

- **Retrieve quality — multi-hop expansion**: expanded from 1-hop to 2-hop neighbor traversal with distance-decaying scores (hop1: 0.5x, hop2: 0.25x), improving recall from 90% to 95% on the built-in benchmark
- **Retrieve quality — structural signal boosting**: bridge nodes get +0.3 score boost, god nodes get -0.2 penalty, same-community nodes get +0.1 boost
- **Retrieve quality — TF-IDF token weighting**: rare query tokens now score higher than common ones, with a 0.1 floor to prevent exact matches from being erased

### Fixed

- **pr_impact missed uncommitted changes**: `gitDiffFiles` now checks unstaged and staged changes against HEAD in addition to branch-to-branch diffs
- **pr_impact skipped all nodes**: the file-node filter used `node_kind !== ''` which excluded every node since `node_kind` is undefined in extracted graphs; replaced with a filename-pattern heuristic

## [0.6.4] - 2026-04-24

### Fixed

- **Retrieve-first enforcement**: AI agents were bypassing the `retrieve` MCP tool by dispatching Explore subagents or using Bash/find instead — strengthen CLAUDE.md, AGENTS.md, GEMINI.md, and Cursor rules with blocking "MUST call retrieve FIRST" language
- **Hook matcher too narrow**: widened from `Glob|Grep` to `Glob|Grep|Bash|Agent|Read` so the PreToolUse hook fires on all codebase exploration tools
- **Cross-platform hooks**: replaced POSIX `[ -f ... ]` with `node -e` + base64 payloads — hooks now work on macOS, Linux, and Windows (PowerShell/CMD)
- **Hook idempotency**: fixed hook detection to match on `out` marker instead of hardcoded old matcher string, preventing duplicate hooks on re-install

## [0.6.2] - 2026-04-24

### Added

- **MCP server config for Cursor and Copilot**: `cursor install` writes `.cursor/mcp.json`, `copilot install` writes `.vscode/mcp.json` with correct VS Code schema (`servers` + `type: "stdio"`)
- **Examples and benchmarks**: `examples/why-madar.md` with real production numbers (384x compression, 656-node blast radius), `examples/mcp-tool-examples.md` with real MCP tool input/output, and `examples/quick-benchmark.sh` for quick evaluation
- **README benchmarks section**: real numbers from a production NestJS + Next.js SaaS

### Fixed

- **VS Code MCP schema**: copilot install uses `servers` key with `type: "stdio"` instead of `mcpServers` which VS Code rejects

### Added

- **MCP server config for Cursor and Copilot**: `cursor install` now writes to `.cursor/mcp.json`, `copilot install` writes to `.vscode/mcp.json` — MCP tools work across all three platforms

## [0.6.1] - 2026-04-24

### Fixed

- **MCP server config location**: `claude install` now writes MCP server config to `.mcp.json` (project root) instead of `.claude/settings.json`, which is the correct location for Claude Code project-level MCP servers; existing legacy entries are cleaned up automatically
- **Hook update**: `claude install` now updates stale hook commands instead of skipping with "already registered"

## [0.6.0] - 2026-04-24

### Added

- **Blast radius analysis**: new `impact` MCP tool — analyzes what breaks if you change a node, with direct/transitive dependents, affected files, and affected communities
- **Call chain tracing**: new `call_chain` MCP tool — finds all execution paths between two nodes filtered by edge type (calls, imports_from)
- **PR impact analysis**: new `pr_impact` MCP tool — parses git diff, maps changed files to graph nodes, computes aggregate blast radius across all changes
- **Hierarchical community data**: new `community_details` MCP tool with micro/mid/macro zoom levels for token-efficient codebase exploration
- **Community overview**: new `community_overview` MCP tool for quick overview of all communities
- **Multi-repo federation**: new `madar federate` command merges graphs from multiple repos into a single queryable super-graph with cross-repo edge inference
- **Auto-generated docs**: new `--docs` flag generates per-community markdown documentation in `out/docs/` with key components, entry/exit points, bridges, and code snippets
- **Related nodes panel**: selecting a node in the HTML community explorer now shows its neighbors with edge types
- **README rewrite**: comprehensive documentation of all MCP tools, federation, and AI agent integration

## [0.5.3] - 2026-04-23

### Changed

- **Community naming disambiguation**: duplicate community names now use operation or node-based suffixes (e.g. `Pipeline Extract — Rust`, `Pipeline Extract — Python`) instead of raw community IDs (`Pipeline Extract (27)`)
- **MCP server auto-start**: `madar claude install` now registers an `mcpServers` entry in `.claude/settings.json` so the MCP server starts automatically when Claude Code opens the project — no manual `serve --stdio` needed

## [0.5.2] - 2026-04-23

### Fixed

- **Install idempotency**: `madar claude install` (and other platforms) now updates the existing rules section instead of printing "already configured" and leaving stale instructions

## [0.5.1] - 2026-04-23

### Changed

- **Louvain community detection**: replaced the bridge-edge-removal algorithm with proper Louvain modularity optimization, eliminating the mega-community problem where 79% of nodes collapsed into a single cluster; communities now have a max size of ~150 nodes with automatic hierarchical sub-clustering for oversized groups
- **Install templates updated**: `madar claude install` (and other platforms) now instructs agents to use the `retrieve` MCP tool as the primary context source, falling back to `GRAPH_REPORT.md` when the MCP server is unavailable
- **Postinstall reminder**: global installs now print a reminder to re-run platform install commands for the latest agent rules

### Fixed

- **Graph physics stabilization**: vis-network interactive graphs now freeze after layout stabilization instead of continuously bouncing; stabilization iterations increased from 100 to 300
- **Graph container sizing**: summary-mode community pages now use `80vh` height instead of fixed `600px`, filling the viewport

## [0.5.0] - 2026-04-23

### Added

- **RAG retrieval tool**: new `retrieve` MCP tool that takes a natural language question and token budget, finds relevant nodes via token-based prefix matching, expands through graph neighbors, reads code snippets from disk, and returns a structured context bundle with matched nodes, relationships, community context, and structural signals (god nodes, bridge nodes)
- **`--include-docs` flag**: document files (`.md`, `.txt`, `.rst`) are now excluded from graph generation by default to reduce noise; pass `--include-docs` to opt in

### Fixed

- **Summary-mode edge rendering**: fixed field name mismatch (`e.source`/`e.target`/`e.relation` to `e.from`/`e.to`/`e.label`) in the "Load interactive graph" button handler for oversized community pages, which caused edges to not render at all in summary mode

## [0.4.2] - 2026-04-20

### Fixed

- Moved `typescript` from `devDependencies` to `dependencies` so the TypeScript compiler API (used for JS/TS AST extraction) is available when the package is installed by end users who do not have TypeScript installed globally

## [0.4.1] - 2026-04-20

### Fixed

- Fixed `SyntaxError: Invalid or unexpected token` in community summary pages: the warning message string in the `loadInteractiveGraph` client function contained literal newlines (from the TypeScript template literal) which are invalid inside single-quoted JavaScript strings; escaped as `\n` sequences so the generated HTML is valid

## [0.4.0] - 2026-04-20

### Added

- **Detection hygiene**: corpus traversal now skips common non-semantic directories (`test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `cypress`, `playwright`, `coverage`, `storybook-static`, `fixtures`, `__fixtures__`, `__mocks__`, `mocks`) and noise file patterns (test/spec files, stories, mocks, framework config files, setup files) so those do not pollute the knowledge graph
- **Interactive graph toggle for oversized communities**: summary-only community pages now include an opt-in "⚡ Load interactive graph" button that shows a performance warning dialog and lazy-loads vis-network from CDN on confirmation, with an error recovery handler for offline environments
- **React component classification**: uppercase JSX-returning functions in `.tsx`/`.jsx` files are now tagged `node_kind: 'component'` so they are identifiable as React components in the graph
- **JSX `renders` edges**: component functions now emit outgoing `renders` edges for every uppercase JSX tag they use (e.g. `<Button />` → edge to `Button`), enabling component-level usage graphs in React projects
- **Cross-file `renders` stitching**: `renders` proxy edges are resolved across file boundaries onto real imported component nodes so the final graph shows concrete component-to-component relationships rather than unresolved proxies

### Changed

- `EXTRACTOR_CACHE_VERSION` bumped to 61 to invalidate stale pre-React-classification extraction payloads

### Fixed

- Graph data embedded in community summary HTML pages is now serialized with `serializeForInlineScript` (escaping `<`, `>`, `&`, line-separator characters) to prevent premature `</script>` tag termination on adversarially-named file paths

## [0.3.0] - 2026-04-18

### Added

- Workspace-scale parity baseline harness: reproducible mixed-workspace benchmark corpus, parity scorecard, and benchmark question coverage using shared `scoreNodes`, `queryGraph`, and `estimateQueryTokens` runtime paths
- Cross-file relationship extraction covering import/export chains, type references, call graphs, and shared-module cohesion signals across multi-package workspaces
- Fragmentation signals in `GRAPH_REPORT.md`: weakly-connected-component count, singleton-component count, isolated-node rate, largest-component share, and low-cohesion community count for workspace-scale diagnostics
- Modular HTML export helpers for community summaries (`export/community-summary.ts`), overview bridge detection (`export/overview-bridges.ts`), and overview navigation links (`export/overview-navigation.ts`)
- Stdio server MCP tool/resource definitions extracted into a dedicated `src/runtime/stdio/definitions.ts` module to reduce hotspot growth

### Changed

- `GRAPH_REPORT.md` now emits entity-level structure signals using shared analysis helpers instead of file-node heuristics, improving workspace-scale diagnostic accuracy
- Benchmark prints entity-level structure signals when `source_file` provenance is available, with an explicit unavailable note otherwise
- Enhanced `analyze.ts` cohesion and bridge-detection logic to cover cross-workspace import patterns and multi-service shared modules
- Refactored `stdio-server.ts` to delegate definitions to the new dedicated module, reducing its size and isolating protocol-level changes
- `generate --update` now preserves workspace-parity provenance contracts across incremental rebuilds

## [0.2.2] - 2026-04-17

### Fixed

- Prevented overview-first HTML exports from opening browser-freezing interactive pages for oversized single communities by falling back to summary/search views with safe deep links

## [0.2.1] - 2026-04-17

### Added

- Schema-v2 extraction metadata with layered provenance contracts, immutable normalization helpers, and regression coverage for legacy payload upgrades and `generate --update` preservation
- Registry-driven ingestion for structured webpages plus exact GitHub repository/issue/pull-request/discussion/commit, Reddit thread/comment, Hacker News item, and YouTube video/playlist/channel routes
- Broader deterministic non-code and media extraction, including DOCX/XLSX metadata and citation handling, richer PDF bibliography/source URL lifting, sidecar-backed binary provenance, and bounded metadata for AAC, M4A, FLAC, Ogg Vorbis/Opus, MP4-family, AVI, and Matroska/WebM assets
- A first bounded Rust tree-sitter extraction slice covering trait signatures, `impl Trait for Type` conformance, aliased `use ... as ...` imports, nested import scoping, and WASM grammar-load isolation
- Deterministic bibliography `source_url` lifting for numbered Markdown/PDF/DOCX reference entries when plain external URLs are present without DOI/arXiv metadata

### Changed

- Refactored extraction and ingest plumbing into more modular registry-driven paths, including dedicated `extract/` helper modules and a larger `non-code` extraction module for the active document/media path
- Expanded README and maintainer-facing release documentation to better reflect the package's strongest current workflows, bounded capability matrix, and npm-safe repository links
- Improved large-corpus detection messaging to recommend smaller high-value slices without advertising nonexistent flags or provider-specific token costs

### Fixed

- Hardened bounded Matroska/WebM metadata discovery and stale-metadata clearing across direct scans, `SeekHead` rereads, and later top-level fallback paths
- Preserved correct ingest provenance and sidecar-aware incremental rebuild behavior for binary assets, including direct audio/video URLs and saved sidecar metadata

### Notes

- `v0.2.0` was tagged accidentally and was not published to npm or turned into a GitHub release. `0.2.1` is the first published package for the post-`0.1.5` change set and includes the release-documentation corrections made after that accidental tag.

## [0.1.5] - 2026-04-12

### Added

- MCP resource subscriptions for the stdio runtime via `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`, and `notifications/resources/list_changed`
- Deeper deterministic non-code extraction for PDF metadata and `Tj`/`TJ` text recovery, DOCX core metadata, and XLSX workbook/sheet structure
- Citation and bibliography enrichment that derives deterministic external `source_url` values for DOI and arXiv references
- A dedicated `src/pipeline/extract/non-code.ts` module to own the active non-code extraction path
- Regression coverage for stdio subscriptions, mixed-corpus watch rebuilds, and richer PDF/DOCX/XLSX extraction behavior

### Changed

- Watch mode now rebuilds supported code, document, paper, image, and office-document changes automatically, including mixed supported batches
- README, roadmap notes, and bundled installer guidance now reflect the expanded MCP/runtime and office-document capabilities
- Refactored `extract.ts` to route active non-code extraction through the new dedicated module and bumped the extractor cache version

### Fixed

- Hardened non-code parsing with bounded markdown-link matching and structured-text line caps
- Added a defensive stdio resource-subscription cap to avoid unbounded session growth

## [0.1.4] - 2026-04-12

### Fixed

- Prevented semantic community naming from crashing when labels include Object prototype property names such as `constructor` or `toString`
- Added regression coverage for prototype-chain label handling in `buildCommunityLabels`

## [0.1.3] - 2026-04-12

### Added

- Automatic overview-first HTML export for large graphs, with lightweight `graph.html` landing pages and focused per-community pages under `graph-pages/`
- Deterministic semantic community naming based on dominant paths, file themes, and representative graph nodes
- `community_labels` metadata in `graph.json` for downstream tooling and report consumers

### Changed

- Improved generated reports and HTML output to show meaningful community names instead of generic `Community N` placeholders when heuristics can infer a better label
- Expanded regression coverage for semantic labels, overview-mode export behavior, and generator propagation of HTML mode choices

## [0.1.2] - 2026-04-11

### Changed

- Renamed the installed Claude skill and slash command to `madar` consistently across built-in templates, installer output, and README usage examples
- Simplified assistant installer behavior to use only the current `madar` naming for skill paths, section markers, hooks, and generated helper files
- Renamed generated OpenCode and Cursor integration helper files to `madar`-specific filenames for clearer project ownership

## [0.1.1] - 2026-04-11

### Added

- Open-source contribution scaffolding via `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue forms, a pull request template, `CODEOWNERS`, and a CI workflow
- Maintainer documentation for repository protections, branch/tag handling, and release process management
- A tag-driven GitHub release workflow for `v*` tags that validates tag format, package-version alignment, changelog coverage, and local-equivalent verification steps before creating a GitHub release

### Changed

- Clarified npm installation, package-scope, and end-user setup guidance in the README
- Added Claude integration documentation explaining the difference between global skill installation, project-local integration, and graph generation
- Expanded README contribution guidance and linked maintainer-facing repository settings documentation

### Notes

- This patch release focuses on packaging, documentation, contribution workflow, and release-management improvements rather than runtime graph-extraction changes

## [0.1.0] - 2026-04-11

### Added

- Initial npm-ready TypeScript release of `madar`
- Global CLI command support via `madar`
- `generate`, `watch`, `serve`, `query`, `path`, `explain`, `add`, `save-result`, `benchmark`, `install`, and `hook` commands
- JavaScript / TypeScript extraction via the TypeScript compiler API
- Portable tree-sitter extraction for Python, Go, and Java
- Lightweight structural extraction for additional languages including Ruby, Lua, Elixir, Julia, PowerShell, Objective-C, and several brace-style languages
- Deterministic extraction for Markdown, RST, DOCX, PDF-like paper corpora, and image assets
- Interactive HTML graph explorer, JSON export, GraphML/Cypher export, Obsidian/wiki output, and Neo4j push support
- Lightweight HTTP and stdio/MCP-style serving
- Publish-ready packaging with scoped npm metadata, a prepack build, and a constrained tarball allowlist
