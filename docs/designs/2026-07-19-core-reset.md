# Madar Core Reset

> **Tracking issue:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Project:** [Madar Roadmap](https://github.com/users/mohanagy/projects/8)
> **Status:** accepted — `generation-and-incremental` is the sole active phase under [#592](https://github.com/mohanagy/madar/issues/592) from protected base `8886a0299ee30765ce149ca7ad5d1779496b78b5`; retrieval and delivery remain blocked

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

## Active amendment — generation and incremental index

The repository owner approved the exact phase contract in [#592](https://github.com/mohanagy/madar/issues/592) and amended [#577](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586) on 2026-07-22. Activation itself delivers no runtime behavior; it authorizes one deletion-led implementation from protected base `8886a0299ee30765ce149ca7ad5d1779496b78b5`.

### Incremental boundary

- Real reuse exists only inside a long-lived MCP/watch process. That process may retain the TypeScript Program/builder state, file versions, per-file canonical facts, and reverse dependencies in memory.
- A cold no-op scans hashes, parses no source, runs no clustering/reporting, publishes nothing, and preserves accepted artifact bytes and identity.
- A cold process with source changes performs a full canonical reconcile and reports `fallback_reason: cold_process`; it is never described as incremental.
- No AST, fact, graph-diff, or dependency cache persists across processes. Cross-process caching requires a later RFC amendment backed by measurements.

### Completeness boundary

Only successfully indexed `.ts`, `.tsx`, `.js`, and `.jsx` inputs determine supported-index completeness. A failed supported input makes the index incomplete with the exact file and reason. Recognized unsupported files and expected policy exclusions are informational; they do not degrade an otherwise complete JS/TS index. Safety-excluded or unreadable sensitive paths remain a separate safety result and are never silently indexed.

### Authoritative artifact and publication

`graph.json` is the sole authoritative index artifact and atomic commit marker. It embeds a deterministic `build_id`, source snapshot, generation-policy/schema identity, supported-index completeness, and source-root/worktree identity. The `build_id` hashes the canonical graph payload excluding the ID field plus normalized source state, policy/schema, and a versioned engine/index identity; timestamps and absolute machine paths do not participate.

`manifest.json`, `watcher-state.json`, and the `needs_update` protocol are retired by this phase. Indexing manifests, share-safe indexing receipts, and `GRAPH_REPORT.md` become derived diagnostics only; they never authorize or block retrieval.

Publication acquires one local build lease, computes the complete graph, attempts diagnostic writes, and atomically renames `graph.json` last. Source discovery/indexing/graph validation or graph-write failure aborts the commit. Diagnostic rendering/write failure is reported but does not block a valid graph commit; readers load the graph first and ignore missing or mismatched diagnostics. Readers may observe the previous graph, the new graph, or an explicit stale/unavailable result, never mixed authoritative state.

There is no generation directory, persistent fact cache, versioned snapshot store, database, WAL, journal, rollback manager, two-phase commit, generalized artifact coordinator, or crash-history subsystem.

### Deletion, ownership, and budget

The phase owns exactly 15 predecessor files / 3,839 LOC recorded in the removal manifest. It may add at most these six replacements and 2,200 production LOC:

- `src/application/generate-index.ts`
- `src/application/update-index.ts`
- `src/domain/index/build-state.ts`
- `src/adapters/filesystem/source-catalog.ts`
- `src/adapters/filesystem/index-store.ts`
- `src/infrastructure/watch-index.ts`

`src/core/pipeline/stage.ts`, `src/runtime/freshness.ts`, and `src/shared/source-discovery.ts` transfer to `evidence-path-query`; `src/infrastructure/doctor.ts` transfers to `thin-delivery`. Those recipient phases remain proposed and blocked. The active phase may mechanically rewire their index-facing imports, but cannot redesign their deferred query or delivery behavior.

The implementation must finish at no more than 130 production files / 67,454 production LOC, with net production delta at most `-1,500`, no new runtime or development dependency, and no more than 296 npm files / 2,700,000 unpacked bytes; packed bytes cannot increase.

### Correctness and performance gates

Add/change/delete/rename, compiler-control, ignore-policy, recognized-unsupported-file add/delete/rename, symlink, and linked-worktree updates must equal clean generation exactly, with zero stale nodes or edges. Fault-injection, edit-during-build, and concurrent-update tests must prove graph-last publication and one complete winner.

Cold no-op median must be at most 20% of clean generation. Warm index-stage median must be at most 50% of clean indexing on a fixed 500+ file fixture. Clean generation may regress by at most 10% from the protected-base measurement. After at least three warm-ups, at least 20 measured trials must report p50/p95, environment, parsed/reused/invalidated counts, and a pinned held-out repository commit. User-visible warm leaf-edit p50 must be at most 75% and p95 at most 80% of clean generation on both corpora; no other measured warm mutation may be more than 10% slower than clean.

If real reuse, clean equivalence, end-to-end improvement, deletion, or size gates fail, the phase stops and simplifies to one honest full reconcile. It does not keep unused incremental code or add a cache/transaction framework.

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
5. Implement clean-equivalent warm-session add/change/delete/rename/worktree refresh with honest cold reconciliation and coherent graph-last publication.
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
- incremental output equivalent to a clean rebuild with proven warm reuse and user-visible refresh improvement;
- labelled TypeScript/framework extraction gates;
- held-out answer correctness no worse than the best comparator;
- material provider-input and end-to-end latency improvement;
- a smaller production source and npm package;
- successful natural activation and voluntary reuse by external design partners;
- no unresolved release-blocking RFC issue or review comment.

## Existing open issues

- [#565](https://github.com/mohanagy/madar/issues/565) remains an acceptance failure and held-out retrieval input.
- [#574](https://github.com/mohanagy/madar/issues/574) contributes the required retrieval outcome, but must not add another layer to the old stack.
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

The repository owner accepted this RFC on 2026-07-19 in [#577](https://github.com/mohanagy/madar/issues/577) after the governance review passed. Scope/baseline, directed-multigraph, canonical-index, and legacy/non-code deletion phases later passed their gates. On 2026-07-22 the owner accepted [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and the linked RFC amendment, authorizing only `generation-and-incremental` after this governance amendment merges. Acceptance does not waive its implementation, deletion, evidence, review, or completion gates.

## Decision log

| Date | Status | Decision |
| --- | --- | --- |
| 2026-07-19 | Proposed | Opened #577 and created the deletion-led product, architecture, validation, and change-control contract. |
| 2026-07-19 | Accepted | The repository owner approved the complete checklist; scope and baseline may begin after the governing documentation PR merges. |
| 2026-07-22 | Accepted amendment | The owner approved [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and the [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586): warm in-memory reuse only, honest cold reconciliation, one authoritative graph artifact, graph-last publication, four ownership transfers, strict deletion/size/performance gates, and no persistent cache or transaction subsystem. |
