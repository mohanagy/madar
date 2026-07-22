# Madar Core Reset

> **Tracking issue:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Project:** [Madar Roadmap](https://github.com/users/mohanagy/projects/8)
> **Status:** accepted — phases through `generation-and-incremental` are complete; `evidence-path-query` is the sole active phase through [#596](https://github.com/mohanagy/madar/issues/596); thin delivery and every later phase remain blocked

## Decision

Replace Madar's accumulated core with one narrow TypeScript/JavaScript semantic-path engine. This is a deletion-led replacement, not an additive refactor and not a permanent V1/V2 split.

The reset will:

- preserve a small set of proven safety, workspace, and provenance behaviors;
- replace the graph, index, incremental-update, retrieval, CLI, and MCP center;
- move evaluation infrastructure outside the shipped runtime;
- delete superseded implementations, flags, tests, dependencies, and documentation;
- validate the result against native agent search and Graphify before a stable release.

## Problem

Madar currently contains good local implementations inside an architecture that has accumulated too many responsibilities and compatibility paths:

- the graph cannot represent parallel relationship kinds safely because edge identity is only source plus target;
- automatic generation runs SPI and legacy extraction over the same supported JS/TS corpus, then retains legacy topology;
- production retrieval contains repository- and benchmark-shaped rules;
- evaluation, comparison, proof, media ingestion, federation, time travel, integrations, and retrieval governance share one shipped package;
- untuned production use has not yet established repeatable correctness, token, latency, activation, or retention wins.

Patching these surfaces again would leave the substrate unchanged and add another layer.

## Product contract

### Initial user

A senior TypeScript engineer or technical lead who uses Claude Code or Codex several days per week on a repository with several hundred source files or multiple apps/packages, and regularly asks questions crossing routes, services, queues, persistence, notifications, or public read models.

### One job to be done

> When I ask a coding agent to explain a cross-layer runtime flow in an unfamiliar TypeScript repository, return the smallest complete evidence path on the first pass so the agent can answer correctly without broad repository exploration.

### Product hypothesis

> Madar is a local TypeScript semantic-path engine that gives coding agents the smallest complete cross-layer execution path before broad search.

This is a hypothesis until blinded comparison and voluntary external reuse prove it.

## Non-goals

The reset will not initially build or optimize:

- additional programming languages;
- PDF, image, audio, video, or general document ingestion;
- hosted knowledge bases or dashboards;
- federation, time travel, or Neo4j export;
- general PR review, security analysis, or implementation planning;
- enterprise administration or a cloud control plane;
- more agent-specific installers beyond Claude Code and Codex;
- repository-specific retrieval rules;
- another confidence, recovery, routing, or extraction subsystem.

## Scope disposition

The machine-readable inventory is [`docs/core-reset/removal-manifest.yml`](../core-reset/removal-manifest.yml). Its dispositions mean:

- **keep:** preserve tested behavior, potentially behind a smaller boundary;
- **rebuild:** ship the successor and delete the predecessor in the same phase;
- **move:** retain as development/evaluation tooling but exclude it from production and npm;
- **delete:** remove without a production successor;
- **defer:** reconsider only after external validation.

Nothing is kept merely because it already exists.

## Target architecture

```text
Workspace/source catalog
      |
Canonical TypeScript index session
      |
Directed typed multigraph
      |
Authoritative graph.json
      |
Generic evidence-path query
      |
Thin MCP and CLI adapters
```

Proposed source layout:

```text
src/
  domain/
    graph/
    index/
    query/
  application/
    generate-index.ts
    update-index.ts
    retrieve-context.ts
  adapters/
    typescript/
    filesystem/
      source-catalog.ts
      index-store.ts
    mcp/
    cli/
  infrastructure/
    watch-index.ts
```

Dependency direction is `adapters -> application -> domain`. Domain code must not import the filesystem, MCP, CLI, TypeScript compiler, or evaluation tooling.

## Completed amendment — generation and reconciliation

The repository owner approved the phase contract in [#592](https://github.com/mohanagy/madar/issues/592) and amended [#577](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586) on 2026-07-22, authorizing one deletion-led implementation from protected base `8886a0299ee30765ce149ca7ad5d1779496b78b5`. The mandatory stop amendment narrowed the shipping architecture after the fixed incremental gate failed. [PR #594](https://github.com/mohanagy/madar/pull/594) later passed every accepted replacement, deletion, evidence, CI, and review gate and was squash-merged at `b56966c06c0ae1b04c252f297036f332fa1b384c`.

### Reconciliation boundary

- A cold no-op scans hashes, parses no source, runs no clustering/reporting, publishes nothing, and preserves accepted artifact bytes and identity.
- Every changed source state performs one full canonical reconcile and reports that mode truthfully; it is never described as incremental.
- No in-memory or disk session cache survives. The rejected TypeScript Program/builder state, per-file fact, reverse-dependency closure, and graph-diff path is deleted rather than kept dormant.
- No AST, fact, graph-diff, or dependency cache persists within or across processes. Any future cache requires a later RFC amendment backed by measurements.

### Completeness boundary

Only successfully indexed `.ts`, `.tsx`, `.js`, and `.jsx` inputs determine supported-index completeness. A failed supported input makes the index incomplete with the exact file and reason. Recognized unsupported files and expected policy exclusions are informational; they do not degrade an otherwise complete JS/TS index. Safety-excluded or unreadable sensitive paths remain a separate safety result and are never silently indexed.

### Authoritative artifact and publication

`graph.json` is the sole authoritative index artifact and atomic commit marker. It embeds a deterministic `build_id`, source snapshot, generation-policy/schema identity, supported-index completeness, and source-root/worktree identity. The `build_id` hashes the canonical graph payload excluding the ID field plus normalized source state, policy/schema, and a versioned engine/index identity; timestamps and absolute machine paths do not participate.

`manifest.json`, `watcher-state.json`, and the `needs_update` protocol are retired by this phase. Indexing manifests, share-safe indexing receipts, and `GRAPH_REPORT.md` become derived diagnostics only; they never authorize or block retrieval.

Publication acquires one local build lease, computes the complete graph, attempts diagnostic writes, and atomically renames `graph.json` last. Source discovery/indexing/graph validation or graph-write failure aborts the commit. Diagnostic rendering/write failure is reported but does not block a valid graph commit; readers load the graph first and ignore missing or mismatched diagnostics. Readers may observe the previous graph, the new graph, or an explicit stale/unavailable result, never mixed authoritative state.

There is no generation directory, persistent fact cache, versioned snapshot store, database, WAL, journal, rollback manager, two-phase commit, generalized artifact coordinator, or crash-history subsystem.

### Deletion, ownership, and budget

The phase owned and removed exactly 15 predecessor files / 3,839 LOC recorded in the removal manifest. It added only these six permitted replacements and 2,190 production LOC:

- `src/application/generate-index.ts`
- `src/application/update-index.ts`
- `src/domain/index/build-state.ts`
- `src/adapters/filesystem/source-catalog.ts`
- `src/adapters/filesystem/index-store.ts`
- `src/infrastructure/watch-index.ts`

`src/core/pipeline/stage.ts`, `src/runtime/freshness.ts`, and `src/shared/source-discovery.ts` transferred to `evidence-path-query`; `src/infrastructure/doctor.ts` transferred to `thin-delivery`. Evidence-path query is now active under its separately accepted contract, while thin delivery remains proposed and blocked. Neither recipient behavior was redesigned by the completed generation phase.

The implementation finished at 130 production files / 66,418 production LOC, with net production delta `-2,536`, no new runtime or development dependency, and 276 npm files / 2,699,851 unpacked bytes; packed bytes decreased from the protected-base package.

Exact runtime commit `1be24dc45a5f07c352c74fc374feb95a9440df8e` removes all 15 predecessor files and retains exactly the six replacements. The inventory is 130 production TypeScript files / 66,418 LOC with `+2,190 / -4,726 / net -2,536`. Package dry-run is 276 files / 572,143 packed bytes / 2,699,851 unpacked bytes. The compatible [shipping receipt](../core-reset/evidence/generation-full-reconcile-500.json) passes cold no-op at `0.067` of clean generation, zero parse/invalidation/publication, and clean-generation regression at `1.045`. The [hermetic mutation-equivalence receipt](../core-reset/evidence/generation-mutation-equivalence.json) records 5 focused files / 92 passing tests for clean equivalence, zero stale facts, graph-last failure handling, worktree isolation, and serialized concurrent publication. All six jobs in [CI run 29942216697](https://github.com/mohanagy/madar/actions/runs/29942216697) passed; 1,885 tests passed with 2 skipped under coverage; three independent P0/P1 audits found no blocker; and zero review threads remained. CodeRabbit explicitly skipped the non-default base, so the owner-approved exception is recorded without claiming a completed CodeRabbit review.

### Correctness and performance gates

Add/change/delete/rename, compiler-control, ignore-policy, recognized-unsupported-file add/delete/rename, symlink, and linked-worktree updates must equal clean generation exactly through the full-reconcile path, with zero stale nodes or edges. Fault-injection, edit-during-build, and concurrent-update tests must prove graph-last publication and one complete winner.

Cold no-op median must be at most 20% of clean generation, and clean generation may regress by at most 10% from the protected-base measurement. The fixed 500-file experiment used three warm-ups and 20 measured trials. Candidate checkpoint `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d`, worktree tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda`, measured warm index p50 ratio `0.824` against `<=0.50`, refresh p50 ratio `1.047` against `<=0.75`, and refresh p95 ratio `1.029` against `<=0.80`. The [receipt](../core-reset/evidence/generation-incremental-stop-500.json) is explicitly ineligible for acceptance.

That result triggered the accepted stop condition. Held-out timing was intentionally skipped because it could not reverse a fixed-gate failure. The failed incremental path was deleted, and the implementation simplified to cold no-op plus one honest full canonical reconcile. The stopped warm ratios are historical decision evidence, not continuing acceptance gates. The phase does not keep unused incremental code or add a cache/transaction framework.

## Active amendment — generic evidence-path query

The repository owner approved the exact phase contract in [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977), the linked [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198), and the later [performance-contract correction](https://github.com/mohanagy/madar/issues/596#issuecomment-5051857404) with its [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542) on 2026-07-23. This authorizes one deletion-led implementation from protected base `bce4f4fb1520a582bfedf5eab9133e9befbc79f7`. Activation changes no production source or package metadata: the phase begins at 130 production TypeScript files / 66,418 LOC and 276 npm files / 2,699,851 unpacked bytes with `+0 / -0 / net 0` production LOC.

### Supported scope and result contract

Core Reset retrieval supports `.ts`, `.tsx`, `.js`, and `.jsx`. It does not restore Go, Python, non-code, or mixed-language indexing. The frozen OpenStatus question is a diagnostic scope guard: its Go checker and Tinybird phases must be reported as unsupported, every required TypeScript/JavaScript phase must be directly evidenced, and the result must not claim a complete mixed-language trace.

The replacement has one deterministic path:

1. exact path and symbol anchors plus generic lexical anchors;
2. deterministic candidate ranking and diversity;
3. at most one typed directional traversal or closure pass;
4. the smallest budgeted evidence selection;
5. explicit missing, disconnected, unsupported, stale, unavailable, or truncated boundaries.

Every returned node, relationship, file, range, and snippet must exist in the authoritative `graph.json` with the same direction and relationship kind. Disconnected handoffs are boundaries, not invented edges. Identical question plus identical graph bytes must produce byte-identical output. No global confidence score, task classifier, retrieval level, execution-phase taxonomy, planner, recursive recovery, context session/delta, resolution mode, hidden second query, model call, semantic/rerank branch, repository-specific claim generator, facade, or V1/V2 fallback may survive.

### Deletion, ownership, and budget

The active boundary deletes 54 predecessor production files / 29,441 LOC. It absorbs `context-governance-stack` and `derived-product-wrappers`, and transfers ten additional deletion-owned files from `non-core-graph-products`, `activation-and-extra-integrations`, and `evaluation-tooling`. The existing transfers of `stage.ts`, `freshness.ts`, and `source-discovery.ts` remain query-owned. `SourceDomain`, `classifySourceDomain()`, `isPollutedSourcePath()`, and only their necessary private helpers move to the new query domain with parity tests; the old module cannot remain as a facade.

At most these seven production files / 3,500 LOC may be added:

- `src/domain/query/types.ts`
- `src/domain/query/source-domain.ts`
- `src/domain/query/rank.ts`
- `src/domain/query/traverse.ts`
- `src/domain/query/slice.ts`
- `src/domain/query/index-status.ts`
- `src/application/retrieve-context.ts`

The phase must remove at least 54 production files / 29,441 LOC, finish with net production delta at most `-25,900`, and remain at or below 83 production files / 40,500 LOC. Runtime and development dependency additions are zero. The optional `@huggingface/transformers` peer and metadata are removed. The phase package must contain at most 210 files / 2,200,000 unpacked bytes, and packed bytes must decrease.

Surviving CLI, MCP, installer, and development-only evaluation callers may only remove obsolete imports and invoke the new application use case; they cannot retain a compatibility engine. Thin delivery continues to own its surviving files and remains blocked.

### Frozen correctness and one-call gates

The blocking gate is `core-reset-held-out-v1`, pinned by `tools/eval/core-reset/contracts/evaluation-contract.json` at SHA-256 `3a3272df5c294ab0e3a4f2ace815fbd120941a432f85a616b9624f420de86b3b`. `documenso-document-send` is bound to commit `4ee789ea378d12c85daacf7dceda80b4dec80652` and phases recipient creation, document send, signing completion, and notification delivery. `formbricks-survey-response` is bound to commit `415bd9828ba150f7944fe10422acdbaf3089c707` and phases request handling, response persistence, and event tracking.

Each blocking prompt receives exactly one evaluator `retrieve` invocation and no hidden second query. All required phases need direct snippet-bearing evidence; verification targets do not count as coverage. The result must contain zero incorrect load-bearing paths or relationships, at least 70% selected-file precision, no more than two unrelated files, no more than 12 unique files and 25 snippets, and at most 4,000 serialized tokens.

The diagnostic `openstatus-574-strict-one-call` is pinned to commit `295e5a72f52c172d326aa950e81043e72a4f20c0`. It requires direct TypeScript evidence for incident mutation, notification delivery, public HTML, and JSON feeds, explicitly marks checker detection and Tinybird persistence unsupported, excludes unrelated PNG/test/UI noise, and never claims full mixed-language completeness. Expected paths, repository identifiers, grading data, and scoring terms remain under `tools/eval/**`; production cannot import or embed them.

### Frozen performance gate

The development-only descriptor `tools/eval/core-reset/contracts/evidence-path-performance-v1.json`, SHA-256 `076e655e7b8ab01cc94c4c95c32b13d70f888c02948ff4eb7c1acebb4427953c`, deterministically generates exactly 15,000 nodes and 30,000 directed edges across 150 fixed components, with four positive queries that pin exact node and directed/typed relationship sets, one query that pins an exact missing boundary, and RFC 8785 serialization. The reference environment is Node `v22.9.0`, Darwin `25.3.0` arm64, Apple M3 Max, and 51,539,607,552 bytes RAM; measurements from other environments are diagnostic only.

With the graph parsed and loaded before timing, the accepted runner first performs one untimed correctness invocation per query. All five expectations must pass before warmup, and every warmup and measured result must remain correct; empty positive results, missing/extra nodes or edges, reversed/wrong relationship kinds, or an absent/extra boundary fail the gate. The runner then performs three warm-ups and at least 20 measured queries. Warm retrieval p95 must be below 500 ms, closure-pass count at most one, and every sample within the file, snippet, and token caps. The accepted receipt will live at `docs/core-reset/evidence/evidence-path-performance.json`; it is implementation evidence and does not exist or pass at activation.

### Pending evidence and stop conditions

Every implementation, deletion, held-out, performance, source, package, dependency, CI, and review result remains pending. Activation proves only that the contract is accepted. Thin delivery, native/Graphify/provider-token comparison, three Claude and three Codex trials, blinded human scoring, external validation, and release work remain blocked.

Stop and amend #577 before continuing if implementation requires a predecessor or facade, repository-specific tuning, global top-k inflation, another planner/recovery/confidence/session/mode, a second internal query or model call, invented relationships, a new dependency, a source/package budget failure, Go/non-code ingestion, graph/index/generation redesign, or a release.

## Public surface target

The reset targets no more than five MCP tools:

- `retrieve`
- `get_node`
- `get_neighbors`
- `graph_status`
- `shortest_path`, only if held-out evaluation proves it is needed

The CLI remains narrow and lazy-loaded:

- `generate`
- `query`
- `status`
- `doctor`
- `install`
- internal `mcp` entrypoint

Existing names are preserved only when their meaning remains valid.

## Migration and compatibility

- `main` and `0.32.x` are maintenance-only while the RFC is active.
- Reset work lands through a temporary protected `core-reset` integration branch.
- There will be no permanent `core-v1`, `core-v2`, mode switch, or fallback engine.
- Existing `0.32.x` releases remain pinnable through npm and Git history.
- Graph/build-state changes require users to regenerate artifacts; this phase retires `manifest.json`, `watcher-state.json`, and `needs_update` rather than preserving compatibility adapters.
- Compatibility is provided through release notes and a migration table, not permanent adapters.
- Betas publish only under npm tag `next`.
- `0.40.0` publishes as `latest` only after every release gate passes.

## Dependency order

1. Freeze scope and record the current baseline.
2. Establish held-out graph and answer fixtures.
3. Replace the graph with a directed multigraph schema.
4. Make the TypeScript Program index canonical and delete legacy extraction.
5. Implement clean-equivalent cold no-op and changed-state full reconciliation with coherent graph-last publication; delete the failed incremental experiment.
6. Replace retrieval and delete the context/governance stack.
7. Replace CLI/MCP and remove extra transports and integrations.
8. Move evaluation tooling outside runtime and reduce the npm package.
9. Run blinded native vs Graphify vs Madar evaluation.
10. Run external design-partner trials.
11. Release, pivot, or stop from the evidence.

No phase starts before the previous phase's exit gate is recorded in [`scorecard.md`](../core-reset/scorecard.md).

## Completion rules

An implementation issue is complete only when:

1. its successor behavior passes the declared tests and held-out evidence;
2. the predecessor implementation, imports, flags, obsolete tests, documentation, and dependencies are removed;
3. its production LOC delta is recorded;
4. its scorecard gate is updated;
5. no repository-specific production rule was introduced.

Merging code alone is not completion.

## Release gates

The detailed scorecard is [`docs/core-reset/scorecard.md`](../core-reset/scorecard.md). The stable release requires:

- correct directed multigraph behavior and deterministic serialization;
- changed-state output equivalent to a clean rebuild, a true cold no-op, and no retained failed incremental or session-cache path;
- labelled TypeScript/framework extraction gates;
- held-out answer correctness no worse than the best comparator;
- material provider-input and end-to-end latency improvement;
- a smaller production source and npm package;
- successful natural activation and voluntary reuse by external design partners;
- no unresolved release-blocking RFC issue or review comment.

## Existing open issues

- [#565](https://github.com/mohanagy/madar/issues/565) remains the real acceptance failure; its Go prefix is diagnostic/unsupported, while supported-scope TypeScript acceptance and later Claude/Codex/human trials remain open.
- [#574](https://github.com/mohanagy/madar/issues/574) is superseded by the generic, scope-correct replacement in [#596](https://github.com/mohanagy/madar/issues/596), not implemented as another patch.
- [#571](https://github.com/mohanagy/madar/issues/571) is superseded if extraction modes are removed.
- [#567](https://github.com/mohanagy/madar/issues/567) is folded into thin Codex delivery and remains a beta activation blocker.

Their final disposition is applied only through the dependency-ordered phase that owns each issue.

## Risks and stop conditions

- A rewrite can hide regressions behind cleaner code. Frozen graph and answer fixtures must precede replacement work.
- TypeScript static analysis cannot prove all dynamic runtime behavior. Missing edges must remain explicit rather than guessed.
- Removing broad features may affect existing users. The pre-1.0 migration notes must name every removed command, tool, language, and artifact.
- Evaluation can contaminate production retrieval. Held-out expected paths remain outside production and are checked by CI.
- A technically cleaner engine may still have no durable demand. If it cannot match comparator correctness, materially reduce discovery cost, or earn voluntary repeat use, the project stops or pivots instead of broadening again.

## Superseded direction

This RFC supersedes the additive architecture direction in the earlier SPI design and the compatibility/fallback direction in `docs/decisions/2026-05-11-spi-default-readiness.md`. Those documents remain as historical records; they do not authorize a surviving legacy engine.

## Amendment rule

Any change to the product job, non-goals, architecture boundary, compatibility policy, removal manifest, or release gates requires:

1. an explicit amendment in [#577](https://github.com/mohanagy/madar/issues/577);
2. evidence supporting the change;
3. an update to this document, the manifest, and the scorecard before implementation.

## Acceptance

The repository owner accepted this RFC on 2026-07-19 in [#577](https://github.com/mohanagy/madar/issues/577) after the governance review passed. Scope/baseline, directed-multigraph, canonical-index, legacy/non-code deletion, and generation/reconciliation phases later passed their gates. On 2026-07-22 the owner accepted [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and the linked RFC amendment, then approved the recorded stop amendment after its fixed incremental gate failed. PR #594 completed that narrowed contract. On 2026-07-23 the owner accepted [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977) and the linked [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198). Evidence-path query is now the sole active phase; thin delivery and every later phase remain blocked.

## Decision log

| Date | Status | Decision |
| --- | --- | --- |
| 2026-07-19 | Proposed | Opened #577 and created the deletion-led product, architecture, validation, and change-control contract. |
| 2026-07-19 | Accepted | The repository owner approved the complete checklist; scope and baseline may begin after the governing documentation PR merges. |
| 2026-07-22 | Accepted amendment | The owner approved [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and the [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586): a bounded warm in-memory experiment, honest cold reconciliation, one authoritative graph artifact, graph-last publication, four ownership transfers, strict deletion/size/performance gates, and no persistent cache or transaction subsystem. The following stop amendment supersedes the experiment. |
| 2026-07-22 | Stop amendment and runtime proof | The fixed 500-file gate failed at candidate `1d3c9b6` / tree `6bd1ae` with ratios `0.824`, `1.047`, and `1.029`. Held-out timing was intentionally skipped and the failed path was deleted. Exact runtime `1be24dc` ships only cold no-op plus full canonical reconciliation with no session cache and passes the compatible shipping receipt at cold-noop ratio `0.067`, zero parse/invalidation/publication, and clean regression `1.045`. |
| 2026-07-22 | Generation and reconciliation complete | PR #594 was squash-merged at `b56966c06c0ae1b04c252f297036f332fa1b384c` after all six CI jobs, coverage, package, performance, independent-review, and zero-thread gates passed. No phase is active; Evidence-path query is Ready but not activated. |
| 2026-07-23 | Accepted amendment | The owner approved [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977) and the [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198): one generic deterministic evidence-path query, exact 54-file deletion, seven-file replacement ceiling, scope-correct held-outs, pinned performance contract, and no planner/confidence/recovery/fallback subsystem. Evidence-path query is the sole active phase; implementation evidence is pending. |
| 2026-07-23 | Performance-contract correction | Independent review found that latency/output maxima alone could false-green an empty retriever. The owner approved the [corrected contract](https://github.com/mohanagy/madar/issues/596#issuecomment-5051857404) and [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542): four exact positive evidence paths, one exact missing boundary, preflight before warmup, and correctness on every measured result. Implementation evidence remains pending. |
