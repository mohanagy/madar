# Madar Core Reset

> **Tracking issue:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Project:** [Madar Roadmap](https://github.com/users/mohanagy/projects/8)
> **Status:** accepted — phases through `evaluation-tooling` are complete; Capability Validation is stopped and closed as not planned; `retrieval-regression-618` is the sole active technical item

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

`manifest.json`, `watcher-state.json`, and the `needs_update` protocol are retired by this phase. Indexing manifests and share-safe indexing receipts become derived diagnostics only; they never authorize or block retrieval. The later evidence-path deletion closes the remaining finalizer surface and retires `GRAPH_REPORT.md` entirely.

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

`src/core/pipeline/stage.ts`, `src/runtime/freshness.ts`, and `src/shared/source-discovery.ts` transferred to `evidence-path-query`; `src/infrastructure/doctor.ts` transferred to `thin-delivery`. Evidence-path query later completed under its separately accepted contract, and Thin Delivery completed through #602 and PR #604. Neither recipient behavior was redesigned by the completed generation phase.

The implementation finished at 130 production files / 66,418 production LOC, with net production delta `-2,536`, no new runtime or development dependency, and 276 npm files / 2,699,851 unpacked bytes; packed bytes decreased from the protected-base package.

Exact runtime commit `1be24dc45a5f07c352c74fc374feb95a9440df8e` removes all 15 predecessor files and retains exactly the six replacements. The inventory is 130 production TypeScript files / 66,418 LOC with `+2,190 / -4,726 / net -2,536`. Package dry-run is 276 files / 572,143 packed bytes / 2,699,851 unpacked bytes. The compatible [shipping receipt](../core-reset/evidence/generation-full-reconcile-500.json) passes cold no-op at `0.067` of clean generation, zero parse/invalidation/publication, and clean-generation regression at `1.045`. The [hermetic mutation-equivalence receipt](../core-reset/evidence/generation-mutation-equivalence.json) records 5 focused files / 92 passing tests for clean equivalence, zero stale facts, graph-last failure handling, worktree isolation, and serialized concurrent publication. All six jobs in [CI run 29942216697](https://github.com/mohanagy/madar/actions/runs/29942216697) passed; 1,885 tests passed with 2 skipped under coverage; three independent P0/P1 audits found no blocker; and zero review threads remained. CodeRabbit explicitly skipped the non-default base, so the owner-approved exception is recorded without claiming a completed CodeRabbit review.

### Correctness and performance gates

Add/change/delete/rename, compiler-control, ignore-policy, recognized-unsupported-file add/delete/rename, symlink, and linked-worktree updates must equal clean generation exactly through the full-reconcile path, with zero stale nodes or edges. Fault-injection, edit-during-build, and concurrent-update tests must prove graph-last publication and one complete winner.

Cold no-op median must be at most 20% of clean generation, and clean generation may regress by at most 10% from the protected-base measurement. The fixed 500-file experiment used three warm-ups and 20 measured trials. Candidate checkpoint `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d`, worktree tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda`, measured warm index p50 ratio `0.824` against `<=0.50`, refresh p50 ratio `1.047` against `<=0.75`, and refresh p95 ratio `1.029` against `<=0.80`. The [receipt](../core-reset/evidence/generation-incremental-stop-500.json) is explicitly ineligible for acceptance.

That result triggered the accepted stop condition. Held-out timing was intentionally skipped because it could not reverse a fixed-gate failure. The failed incremental path was deleted, and the implementation simplified to cold no-op plus one honest full canonical reconcile. The stopped warm ratios are historical decision evidence, not continuing acceptance gates. The phase does not keep unused incremental code or add a cache/transaction framework.

## Completed amendment — generic evidence-path query

The repository owner approved the exact phase contract in [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977), the linked [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198), and the later [performance-contract correction](https://github.com/mohanagy/madar/issues/596#issuecomment-5051857404) with its [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542) on 2026-07-23. The implementation audit then fired the accepted stop condition because canonical `graph.json` stores source hashes and ranges, not source bytes. The owner approved the exact [graph-authenticated source-excerpt amendment](https://github.com/mohanagy/madar/issues/596#issuecomment-5052210144), its [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5052210334), and the durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5054853667) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815) approval receipts.

Held-out v1 then failed its own acceptance model: path-only phase grading could accept an unrelated tiny symbol, five necessary Documenso definitions alone exceeded the 4,000-token cap, and several real user/job transitions had no directed owner-to-owner edge. The owner approved the replacement [v2 proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5056946202) and [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5056947999), with durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5058567870) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5058568992) approval. This is a correction to the evidence contract, not a relaxation: phase evidence now binds an exact independently reviewed owner declaration, structural file nodes cannot cover phases, and absent runtime/user/async transitions must be reported as disconnected.

The first real v2 run then proved that source-only frozen monorepos could not resolve their tracked local TypeScript config packages, while external ambient types and composite/incremental build settings produced fatal diagnostics unrelated to graph facts. The owner approved the exact [#599 prerequisite](https://github.com/mohanagy/madar/issues/599#issuecomment-5060766685) and its [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5060766863): authenticate only tracked local config packages referenced through compiler `extends`, normalize only external ambient type discovery and composite/incremental build behavior, and add no package manager, network, external dependency, repository rule, compatibility path, publication bypass, or budget increase.

The owner next approved the combined deletion/finalizer dependency in [#599](https://github.com/mohanagy/madar/issues/599#issuecomment-5062879476), [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5062879444), and the [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5062879430). When scalar ranking then failed to select the authentic mixed caller/handler owners already present in the pinned graphs, the owner approved the exact bounded lexical-obligation [proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5064590915) and [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5064592884), with durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5065202635) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5065202781) receipts. The Darwin containment [proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5066594490) and [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5066600460), with durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5066655931) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5066657672) approval, canonicalized only the three already-authorized filesystem argv values and updated the evaluator byte pin; no evaluator semantics, grading, authority, repository, prompt, owner, handoff, limit, contract, schema, or performance gate changed. Punctuation-derived ordered obligations remain one coverage dimension in the existing candidate set and score vector: there is no per-obligation query/top-k, second retrieval, planner, model call, repository fixture, synthetic fact, or limit expansion. The completed deletion-led query finishes at 73 files / 21,687 LOC with +3,500 / -48,231 / net -44,731 against the protected base, zero runtime/development dependency additions, and a 162-file / 231,524-byte packed / 984,434-byte unpacked npm package.

### Supported scope and result contract

Core Reset retrieval supports `.ts`, `.tsx`, `.js`, and `.jsx`. It does not restore Go, Python, non-code, or mixed-language indexing. The frozen OpenStatus question is a diagnostic scope guard: its Go checker and Tinybird phases must be reported as unsupported, every required TypeScript/JavaScript phase must be directly evidenced, and the result must not claim a complete mixed-language trace.

The replacement has one deterministic path:

1. exact path and symbol anchors plus generic lexical anchors;
2. deterministic candidate ranking and diversity;
3. at most one typed directional traversal or closure pass;
4. the smallest budgeted evidence selection;
5. explicit missing, disconnected, unsupported, stale, unavailable, corrupt, or truncated boundaries.

Every returned node, relationship, file, range, provenance record, and content hash must exist in the authoritative `graph.json` with the same direction and relationship kind. A `structural_file` node carries no range or snippet and may participate only in exact directed `imports_from` and `contains` traversal. A `symbol_declaration` carries both its full AST `definition_range` and canonical signature/declaration-prefix `declaration_range`; only the exact declaration slice may be returned as a snippet. The complete UTF-8 source must hash to the canonical file-node `content_hash`, and the declaration must be contained by the definition. Missing, unreadable, or escaped source returns `unavailable`; a hash mismatch or invalid range returns `stale`; every authentication failure returns no snippet. Disconnected handoffs are explicit boundaries, not invented, reversed, or file-projected edges.

The normalized retrieve request contains only required `question` and optional `budget`, and the effective budget is part of that request. Identical normalized request plus identical canonical graph bytes plus the identical authenticated source snapshot must produce byte-identical canonical output.

No global confidence score, task classifier, retrieval level, execution-phase taxonomy, planner, recursive recovery, context session/delta, resolution mode, hidden second query, model call, semantic/rerank branch, repository-specific claim generator, facade, or V1/V2 fallback may survive.

### Deletion, ownership, and budget

The completed boundary combines the original 54 predecessor production files / 29,441 LOC with nine evidence finalizers / 3,590 LOC: 63 files / 33,031 LOC and 22 ownership transfers. The eight non-core finalizers transferred from `non-core-graph-products`; `src/runtime/serve.ts` transferred from `thin-delivery` and changed from rebuild to delete. `src/runtime/stdio/prompts.ts` was the approved supplemental finalizer importer/public-surface cleanup outside the 63-file floor, producing 64 actual production-file deletions. `SourceDomain`, `classifySourceDomain()`, `isPollutedSourcePath()`, and only their necessary private helpers moved to the new query domain with parity tests; the old module does not survive as a facade.

At most these seven production files / 3,500 LOC may be added:

- `src/domain/query/types.ts`
- `src/domain/query/source-domain.ts`
- `src/domain/query/rank.ts`
- `src/domain/query/traverse.ts`
- `src/domain/query/slice.ts`
- `src/domain/query/index-status.ts`
- `src/application/retrieve-context.ts`

The phase must remove at least 63 production files / 33,031 LOC, finish with net production delta at most `-25,900`, and remain at or below 83 production files / 40,500 LOC. Runtime and development dependency additions are zero. The optional `@huggingface/transformers` peer and metadata are removed. The phase package must contain at most 210 files / 2,200,000 unpacked bytes, and packed bytes must decrease.

Canonical declaration facts require narrow changes in three existing index-owned files: `src/domain/index/model.ts`, `src/adapters/typescript/index.ts`, and `src/domain/index/build-state.ts`. The #599 prerequisite also permits `src/adapters/typescript/index.ts` to disable automatic external ambient type discovery and neutralize composite/incremental build behavior during canonical indexing; it does not suppress explicit imports or scanner-owned declarations. Ownership remains exclusively with `canonical-typescript-index`; the graph artifact envelope stays v2, the canonical index format advances to v3, and old indexes require regeneration with no compatibility fallback. These are not additional replacement files, but every added production line counts inside the unchanged 3,500-line phase ceiling.

Surviving CLI, MCP, installer, and development-only evaluation callers only remove obsolete imports and invoke the new application use case; they retain no compatibility engine. MCP `retrieve` accepts required `question` plus optional `budget`; legacy semantic, rerank, strategy, session, and mode controls are removed. `compare.ts` consumes the generic result after deleting its old pack/session/routing/runtime-proof response branches, installer applicability-hook generation is removed with its predecessor, and the held-out and performance runners remain development-only. `src/runtime/serve.ts` was deleted by this completed phase; #602 removes its stale historical Thin Delivery ownership and transfers `src/shared/package-metadata.ts` plus `src/shared/shell.ts` to the surviving evaluation owner.

### Frozen correctness and one-call gates

The blocking gate is `core-reset-held-out-v2`, pinned by `tools/eval/core-reset/contracts/evaluation-contract.json`. It supersedes v1 in place so no dead compatibility contract survives. The immutable `baseline-v0.32.0.json` receipt remains explicitly bound to historical `core-reset-held-out-v1` evidence and cannot satisfy v2. `documenso-document-send` is bound to commit `4ee789ea378d12c85daacf7dceda80b4dec80652` and phases recipient replacement, initial send, token completion, seal execution, and post-seal completed-email delivery. `formbricks-survey-response` is bound to commit `415bd9828ba150f7944fe10422acdbaf3089c707` and phases the public v2 request, actual persistence, event enqueue, worker binding, and event dispatch.

Each blocking prompt receives exactly one evaluator `retrieve` invocation and no hidden second query. A phase passes only with an authenticated `symbol_declaration` matching the hidden accepted owner identity, source-file hash, canonical declaration range, and declaration hash; a file node or unrelated symbol in the expected file fails. Every declared connected or disconnected handoff must also be covered. Verification targets do not count as coverage. The result must contain zero incorrect load-bearing paths or relationships, at least 70% selected-file precision, no more than two unrelated files, no more than 12 unique files and 25 symbol snippets, and at most 4,000 serialized tokens.

The direct held-out evaluator and receipt schema are byte-pinned in the removal manifest. An acceptance-eligible run is Darwin-reference-only: it clean-builds and packs exact `HEAD`, generates from a VCS-free pinned Git archive, and materializes only exact tracked local workspace config packages referenced by compiler `extends`. The temporary config view is byte-attested, summarized by a sorted count and SHA-256 in the receipt, and removed immediately after generation; no package manager, network, cache, external dependency, or repository-specific mapping participates. The runner uses `sandbox-exec` to deny network, process forks, non-runtime executable access, and evaluator-checkout reads, applies Node filesystem allowlists and child-process denial, and starts one fresh contained process per question. Raw response bytes are fsynced and hashed before hidden grading data is loaded. The approved Darwin [proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5066594490), [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5066600460), [owner receipt](https://github.com/mohanagy/madar/issues/596#issuecomment-5066655931), and [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5066657672) pin evaluator SHA-256 `a41a51cbe1853f524e3e05cc91b31016382778f980dbb67ef06f910925892841`; only `runtimeRoot`, `graphPath`, and `requestPath` are declared filesystem argv indexes, and no readable/writable path or grading boundary changes. A clean exact-literal leak scan over production and packed content plus independent adversarial review is mandatory; the scan is not represented as a complete anti-tuning proof.

PR #600 CI exposed a later portability boundary: canonical JSON escapes Windows backslashes, so direct substring comparison did not authenticate the private-root leak check, and `/tmp` graph identities could be discarded before an exact unavailable boundary was emitted. The bounded [owner proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5072454599), [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5072454807), [owner approval](https://github.com/mohanagy/madar/issues/596#issuecomment-5072486888), and [RFC approval](https://github.com/mohanagy/madar/issues/577#issuecomment-5072487113) pin evaluator SHA-256 `b7211c7e56360921a6b8e681ac84b21a1f13963f78a925589ea8611ee25bab97`, compare the same authorized aliases in direct and JSON-escaped form, force deterministic LF checkout bytes, and retain hard-ignored exact graph facts only as non-selectable unavailable targets. Repositories, prompts, owners, handoffs, grading, sandbox permissions, readable/writable paths, gates, budgets, query count, and engine count remain unchanged.

Exact evaluated head `29aba7ebffe14d6a70bde78df1490bf4cded64a4` passes this gate. Both blocking repositories have full phase coverage and selected-file precision, zero unrelated files, and all eight required connected/disconnected handoffs match. The [byte-pinned receipt](../core-reset/evidence/evidence-path-held-out.json) is eligible for acceptance. The OpenStatus scope guard remains a failing non-blocking diagnostic and is not promoted into a correctness claim.

The diagnostic `openstatus-574-strict-one-call` is pinned to commit `295e5a72f52c172d326aa950e81043e72a4f20c0`. It requires direct TypeScript evidence for incident mutation, notification delivery, public HTML, and JSON feeds, explicitly marks checker detection and Tinybird persistence unsupported, excludes unrelated PNG/test/UI noise, and never claims full mixed-language completeness. Expected paths, repository identifiers, grading data, and scoring terms remain under `tools/eval/**`; production cannot import or embed them.

### Frozen performance gate

The development-only descriptor `tools/eval/core-reset/contracts/evidence-path-performance-v2.json`, SHA-256 `4ddba368f5ef17dc059bd8d41c0549e38d6a5ded42e9448ae31aefd0e35506e4`, deterministically generates exactly 15,000 structural file nodes and 30,000 directed file-to-file `imports_from` edges in two fixed offset families across 150 fixed components. Structural nodes omit ranges and snippets; source text is used only for full-file SHA-256 authentication. Four positive queries pin exact node and directed/typed relationship sets, one query pins an exact missing boundary, and serialization is RFC 8785. The reference environment is Node `v22.9.0`, Darwin `25.3.0` arm64, Apple M3 Max, and 51,539,607,552 bytes RAM; measurements from other environments are diagnostic only.

The runner first rejects inherited Node preload paths, authenticates every `src` path and byte against exact `HEAD`, builds in a detached standalone clone of that exact commit and tree, restores the exact lockfile dependencies there, and never replaces the developer checkout's dependencies or build output. With the graph serialized, deserialized, and inspected through the shipping canonical query-index boundary before timing, it requires a ready query index and first performs one untimed correctness invocation per query. All five expectations must pass before warmup, and every warmup and measured result must remain correct; empty positive results, missing/extra nodes or edges, reversed/wrong relationship kinds, or an absent/extra boundary fail the gate. The runner then performs three warm-ups and at least 20 measured queries. Warm retrieval p95 must be below 500 ms, closure-pass count at most one, and every sample must return exactly zero snippets within the 12-file and 4,000-token caps. The accepted receipt lives at `docs/core-reset/evidence/evidence-path-performance.json` and passes at 279.28 ms p95 with every preflight, warmup, and measured result correct. It is public fixed-workload performance evidence, not an independent adversarial correctness proof, and qualified the phase only together with the separately contained held-out-v2 gate, a clean exact-literal leak scan, and independent adversarial review.

### Completed evidence and remaining stop conditions

Query implementation and deletion are complete. Exact evaluated head `29aba7ebffe14d6a70bde78df1490bf4cded64a4` passes held-out-v2 and loaded-graph performance, and the exact source/package inventory passes every phase budget. [PR #600](https://github.com/mohanagy/madar/pull/600) was squash-merged at `596d286cdf4bb53670a6d8c27b2cec5f86137739` from final head `a0ef9003b9bb71a8defb3463ee131e677b32fecc`; all six jobs in [CI run 30124465700](https://github.com/mohanagy/madar/actions/runs/30124465700) passed, an [independent exact-head review](https://github.com/mohanagy/madar/pull/600#issuecomment-5074482136) found no blocker, and zero review threads remained. CodeRabbit skipped the non-default `core-reset` base under the owner-approved exception and is not represented as having reviewed. Thin Delivery later completed under its separate bounded contract, followed by Evaluation Tooling Isolation through #606 and PR #608. At that #608 completion checkpoint, Capability Validation, natural agent trials, external validation, and release work remained blocked; the separately owner-approved #610 activation below supersedes only the Capability Validation status.

Stop and amend #577 before continuing if implementation requires a predecessor or facade, repository-specific tuning, global top-k inflation, another planner/recovery/confidence/session/mode, a second internal query or model call, invented relationships, hidden budget growth, a new dependency, a source/package budget failure, Go/non-code ingestion, an index change beyond the three authorized canonical declaration-range files, graph/generation redesign, or a release.

## Completed amendment — thin delivery

The repository owner approved the exact [#602 Thin Delivery contract](https://github.com/mohanagy/madar/issues/602#issuecomment-5075969972) and the matching [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5075969871) on 2026-07-25. Governance activation started from protected base `8efe41fc665fcea7e625dda0864a72ecf27a111b`, and implementation started from governance merge `edcf3e45b8c8fb76a57531bc74bede2a06189aba`.

[PR #604](https://github.com/mohanagy/madar/pull/604) completed the contract and was squash-merged into protected `core-reset` as `14791cefa195f43e30ec9ec2dd611e38ad2b1b83`. The merge tree `02a059c66a214fe52e31d8fffa2c501a1761bf0f` exactly matches independently reviewed final head `ddd9761b137ef1f07eb362a91f9f2478c1d08c38`. The phase deleted all 16 predecessors, added exactly the six allowlisted replacements, recorded `+2,248 / -7,281 / net -5,033` production LOC, and finished at 63 production TypeScript files / 16,654 LOC. It added no dependency, removed only `neo4j-driver`, and packed as 142 files / 200,310 packed bytes / 812,531 unpacked bytes.

All six Ubuntu/macOS/Windows Node 20/22 jobs passed in [exact-head CI run 30154480779](https://github.com/mohanagy/madar/actions/runs/30154480779). The [independent exact-head review](https://github.com/mohanagy/madar/pull/604#pullrequestreview-4779114409) found no Critical, Important, or Minor finding, and zero review threads remained. [CodeRabbit explicitly skipped review](https://github.com/mohanagy/madar/pull/604#issuecomment-5078118509) because `core-reset` is a non-default target branch; its green skip context was not treated as a review. The exact-head held-out evaluator remained acceptance-eligible with `benchmark_passed: true`, both blocking repositories passing, OpenStatus remaining diagnostic-only, and receipt self-hash `6baed3cfc2b3aa963581613be6cf17ccf1aa261dd29343e27bfe87d52bdaad6c`. The [startup receipt](../core-reset/evidence/thin-delivery-startup.json) records final packed cold-start medians, nearest-rank p95 values, and maximum RSS. The [client receipt](../core-reset/evidence/thin-delivery-client-transport.json) records final sealed-artifact passes from normally launched Claude and Codex clients without configuration or tool overrides.

No #602 stop condition remained active at completion. The durable [#602 completion receipt](https://github.com/mohanagy/madar/issues/602#issuecomment-5078180041) and matching [RFC completion receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5078180116) record the completed phase. #602 is closed as Completed, and #567 closed only after the normal interactive Codex client reached Madar `tools/call`. Evaluation Tooling Isolation was then separately bounded, owner-approved, activated, and completed through #606 and PR #608. At that #608 completion checkpoint no technical phase was active, and Capability Validation, natural activation, external validation, publication, and release remained blocked and unapproved; the separately owner-approved #610 activation below supersedes only the Capability Validation status.

This phase changes delivery, not query semantics. Its user outcome is one fast local executable that exposes one authenticated `retrieve` MCP tool, initializes transport before reconciliation code loads, keeps the active repository or linked worktree graph current, installs safely into Claude Code and Codex, removes only configuration it owns, and reports truthful graph and wiring diagnostics. Forced client calls prove transport only; natural selection, comparator advantage, retention, and paid intent remain later gates.

### Exact deletion, ownership, and source budget

Delete exactly these 16 production files / 7,277 LOC plus obsolete tests, exports, flags, documentation, and package references:

- `src/cli/bin.ts`
- `src/cli/main.ts`
- `src/cli/parser.ts`
- `src/runtime/stdio-server.ts`
- `src/runtime/stdio/definitions.ts`
- `src/runtime/stdio/resources.ts`
- `src/runtime/stdio/tools.ts`
- `src/infrastructure/install.ts`
- `src/shared/env.ts`
- `src/infrastructure/doctor.ts`
- `src/infrastructure/neo4j.ts`
- `src/infrastructure/hooks.ts`
- `src/infrastructure/install-routing-guidance.ts`
- `src/infrastructure/install-skill-templates.ts`
- `src/shared/telemetry.ts`
- `src/shared/update-notifier.ts`

The phase absorbs the remaining production ownership of `non-core-graph-products` and `activation-and-extra-integrations`. It removes stale historical Thin Delivery ownership of already-deleted `src/runtime/serve.ts`. It transfers `src/shared/package-metadata.ts` and `src/shared/shell.ts` to `evaluation-tooling`. Only `src/infrastructure/benchmark/suite.ts`, which imports the old installer, and `src/infrastructure/try-command.ts`, which imports a parser type, survive as production importers requiring narrow rewiring.

At most these six production files may be added:

- `src/adapters/cli/bin.ts`
- `src/adapters/cli/main.ts`
- `src/adapters/cli/install.ts`
- `src/adapters/cli/doctor.ts`
- `src/adapters/mcp/protocol.ts`
- `src/adapters/mcp/server.ts`

All production additions, including edits to retained files, must total at most 2,300 LOC. The phase must remove at least 7,277 LOC, finish net at most `-4,977`, and finish at no more than 63 production files / 16,710 LOC. The obsolete 25,000-LOC lower bound is removed; adding code to meet a minimum is forbidden. Add zero runtime and zero development dependencies. Remove exactly `neo4j-driver`; removing any other declared runtime or development dependency requires an amendment. The final package must contain fewer than 150 files and fewer than 1,500,000 unpacked bytes, and packed bytes cannot increase.

### CLI and MCP contract

The CLI exposes at most six entrypoints, drawn only from:

- `generate`
- `query`
- `status`
- `doctor`
- `install`
- internal `mcp`

`--help` and `--version` remain global. `generate --watch` replaces standalone `watch`; `mcp` always means stdio plus workspace auto-refresh. Retire `watch`, `serve`, `try`, `benchmark`, `bench:suite`, `eval`, `compare`, `hook`, `telemetry`, every client-named platform command, implicit `madar .`, `--stdio`, `--mcp`, `--auto-refresh`, and every `--neo4j-*` flag. Removed surfaces fail with clear usage errors and do not survive as aliases, trampolines, re-exports, wrappers, or compatibility facades. If both `status` and `doctor` remain, they compose one diagnostic implementation.

MCP advertises exactly one tool, `retrieve`, and only the tools capability. No resource or prompt surface survives. Input remains required `question` plus optional positive-integer `budget`, with no additional properties. The 512-character question limit, 4,000-token maximum, 12-file cap, 25-snippet cap, graph-authenticated excerpts, explicit evidence boundaries, initialization, ping, notifications, `tools/list`, `tools/call`, bounded line handling, stream recovery, and graceful shutdown remain. CLI `query`, direct application use, and MCP return byte-identical canonical results for the same accepted graph and normalized request.

No query, ranking, traversal, slicing, source-authentication, graph, index, generation, or held-out grading rule may change in this phase.

### Freshness, installers, and real-client transport

`madar mcp` resolves workspace and external graph identity from process `cwd`, including linked worktrees. Initialize and `tools/list` complete before the TypeScript reconciler is imported. Reconciliation then uses the one existing generation/reconciliation engine. The first graph-backed call waits only within the frozen 25,000 ms request-wait ceiling and configured tool timeout; if the accepted graph is not ready, it returns one truthful terminal `unavailable` boundary before host timeout and never instructs the agent to call Madar again. No second watcher, cache, queue, session, retry planner, or compatibility engine is allowed.

Claude Code receives only supported per-project local MCP registration outside the repository, running `madar mcp` from the exact workspace. Codex receives one workspace-hashed block in `$CODEX_HOME/config.toml` or `~/.codex/config.toml` with `command = "madar"`, `args = ["mcp"]`, exact workspace `cwd`, `startup_timeout_sec = 180`, and `tool_timeout_sec = 60`. Multiple repositories and linked worktrees coexist and uninstall independently. No `CLAUDE.md`, `AGENTS.md`, tracked MCP/config file, hook, script, skill, routing profile, classifier, or generated instruction survives.

Fresh install, idempotent reinstall, and uninstall create or modify zero repository bytes. Legacy migration may remove only byte-recognized, enumerated Madar-owned artifacts and must preserve all unrelated user content, formatting, comments, permissions, TOML constructs, and other MCP servers.

A normally launched Claude session and a normally launched Codex session must each initialize, list, and dispatch exactly one forced `retrieve` without `-c`, injected MCP configuration, or manual tool override. [#567](https://github.com/mohanagy/madar/issues/567) closed only after normal interactive Codex thread `019f984b-e210-76f0-b80c-cf52ac8f1460` completed the real Madar `tools/call`; direct JSON-RPC testing is insufficient, and the earlier cancelled `codex exec` attempts also did not qualify. If a future required real client cancels before `tools/call`, the phase stops and records the external-client blocker rather than weakening the gate.

### Package, startup, review, and stop gates

From a fresh packed install, at least ten isolated cold processes must report median, p95, and maximum RSS. `madar --version` median must be below 100 ms and maximum RSS below 80 MiB. Initialize plus `tools/list` median must be below 1,000 ms and list exactly one tool. Registry package arguments are exactly `["mcp"]`; a packed-tarball Registry launch initializes, lists one tool, and completes one call. Cross-platform Claude/Codex lifecycle, migration, uninstall, worktree, two-registration, first-call, package-isolation, release-hygiene, and byte-parity tests remain blocking.

Every exact-head Node 20/22 Ubuntu/macOS/Windows CI job must pass. Independent exact-head review must find no blocker and zero review threads may remain. CodeRabbit must pass or have an explicitly approved unavailable/rate-limit/non-default-base exception recorded honestly; a skip is never represented as a completed review.

Development-only evaluators may re-pin only the transport path from the old built CLI to the new package bin. Repositories, prompts, grading, expected evidence, query budgets, and query semantics remain frozen.

Stop and amend #577 before continuing if implementation needs more than six replacement files or 2,300 added production LOC; any new dependency; any retained predecessor, facade, alias, fallback, or second engine; any extra command, tool, resource, prompt, hook, skill, telemetry/updater/Neo4j route, or client installer; a retry-Madar instruction; a timeout increase; a semantic or grading change; repository-specific activation logic; or a weakened source, package, startup, client, CI, review, or zero-thread gate. No npm publication, GitHub Release, Registry publication, comparator result, natural-activation claim, external-validation claim, or stable release is authorized.

## Completed amendment — evaluation tooling isolation

The repository owner approved the exact [#606 Evaluation Tooling Isolation contract](https://github.com/mohanagy/madar/issues/606#issuecomment-5078675449) and the matching [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5078676116) on 2026-07-25. Governance activation starts from protected `core-reset` commit `317dda89f2ea5c75e7626a26b104ceca1bd04ce5`, whose audited `src` tree is `b99217c74f6b26daef4ecab12e1cde5f8fe60122`. The governance-only activation merged at `452ad84890c012392c5e6af613e8bfeb17de45db`, and implementation started from that exact merge.

This phase isolates existing evaluation tooling and reduces the production/package boundary. It does not authorize an evaluator redesign, Graphify integration, a capability experiment, a product feature, or any production behavior change.

### Exact move and ownership boundary

Move exactly these 20 production TypeScript files / 4,698 LOC to corresponding paths under `tools/eval/lib/**`, preserving their module grouping, and delete all old `src/**` locations:

- `src/infrastructure/benchmark.ts` — 396 LOC
- `src/infrastructure/benchmark/corpus.ts` — 61 LOC
- `src/infrastructure/benchmark/environment.ts` — 484 LOC
- `src/infrastructure/benchmark/generate-performance.ts` — 199 LOC
- `src/infrastructure/benchmark/quality.ts` — 443 LOC
- `src/infrastructure/benchmark/questions.ts` — 173 LOC
- `src/infrastructure/benchmark/runner.ts` — 280 LOC
- `src/infrastructure/benchmark/runtime-proof.ts` — 30 LOC
- `src/infrastructure/benchmark/suite.ts` — 1,118 LOC
- `src/infrastructure/benchmark/usage.ts` — 76 LOC
- `src/infrastructure/compare.ts` — 433 LOC
- `src/infrastructure/prompt-runner.ts` — 181 LOC
- `src/infrastructure/save-query-result.ts` — 91 LOC
- `src/infrastructure/try-command.ts` — 50 LOC
- `src/runtime/benchmark/probe-calibration.ts` — 12 LOC
- `src/shared/graph-source-root.ts` — 12 LOC
- `src/shared/package-metadata.ts` — 51 LOC
- `src/shared/share-safe-artifacts.ts` — 500 LOC
- `src/shared/shell.ts` — 42 LOC
- `src/shared/workspace-copy.ts` — 66 LOC

`src/shared/graph-source-root.ts` and `src/shared/workspace-copy.ts` transfer from `safe-workspace-primitives` to `evaluation-tooling`. `src/shared/package-metadata.ts` and `src/shared/shell.ts` retain their evaluation ownership transferred by Thin Delivery. No other production source belongs to this phase.

The phase adds zero production TypeScript files / zero production LOC, modifies no surviving production TypeScript file, and changes no dependency. Its exact final inventory is 43 production TypeScript files / 11,956 LOC with `+0 / -4,698 / net -4,698`.

### Development build and package boundary

Add `tsconfig.eval.json` and one `build:eval` package script producing development-only `dist-eval/**`. Keep `tsconfig.build.json` and the production build rooted exclusively in `src/**`. Add `dist-eval/` to ignore rules, and exclude it plus every moved module from `dist/**`, npm `files`, `prepack`, and the fresh packed artifact.

Only mechanical relative-import, test-import, script-path, CI-path, and documentation-path rewrites required by the move are permitted. Rewire only the five audited evaluator scripts/workflows and the directly importing tests. Strengthen package isolation checks to reject each moved module and evaluator output path explicitly. Do not retain a compatibility alias, forwarding module, fallback import, production wrapper, or duplicate copy under `src/**`.

The audited npm projection is 102 files / 159,748 packed bytes / 637,551 unpacked bytes. Blocking ceilings are at most 102 files / 165,000 packed bytes / 640,000 unpacked bytes. These are not contingency budgets and cannot be widened.

The completed implementation moves all 20 files / 4,698 LOC to their corresponding `tools/eval/lib/**` paths and deletes every old location. Production measures exactly 43 TypeScript files / 11,956 LOC with `+0 / -4,698 / net -4,698`, zero surviving production TypeScript edits, and zero dependency changes; `package-lock.json` is unchanged. The separate evaluator config and five audited development callers are rewired, historical Core Reset evaluation evidence remains byte-identical, and the fresh artifact is 102 files / 159,759 packed bytes / 637,602 unpacked bytes with shasum `6eee13af22e8c76113fe578e44d76a9e6d6fd899`, within every fixed ceiling.

### Frozen behavior, successor blocker, and stop gates

Graph, index, generation, reconciliation, retrieval, ranking, traversal, slicing, token budgets, request timeouts, CLI, MCP, installer, and workspace semantics remain unchanged. Production must not import `tools/eval/**` or `dist-eval/**`. Core Reset held-out/performance repositories, prompts, expected evidence, grading rules, schemas, limits, hashes, isolation boundaries, and timeouts remain frozen; historical evaluation contracts and receipts remain byte-identical. Current CI thresholds remain recall >=90%, MRR >=0.95, snippet coverage >=95%, and grounded-match rate report-only.

Existing evaluator unit tests and development-only regression/performance workflows must pass through the separate evaluator build. A clean production build and fresh npm pack must contain none of the moved modules or evaluator output. Checkout and packed retrieval parity, release hygiene, Registry validation, package isolation, typecheck, tests, coverage, build, high-severity audit, all six exact-head CI jobs, independent no-blocker review, honest CodeRabbit disposition, and zero review threads remain blocking.

At the #606 boundary no valid blinded Native-vs-Graphify-vs-Madar capability runner existed: the guided benchmark had no Graphify arm, while the immutable historical contract recorded retired `--no-html` commands. #606 could not design a replacement runner, add Graphify, restore or alias that flag, rewrite historical evidence, run Capability Validation, or claim comparator evidence. The separately owner-approved #610 versioned companion below supersedes that historical blocker without expanding #606.

Stop implementation and amend #577 if the boundary differs from 20 files / 4,698 LOC; any surviving production TypeScript must change; any moved module remains in `src/**`, `dist/**`, or npm; a dependency, compatibility wrapper, duplicate, or fallback is required; any production semantic, public surface, budget, timeout, frozen contract, repository, prompt, expected evidence, grading rule, schema, threshold, or historical receipt would change; a workflow requires restoring `--no-html`; an exact source count or package ceiling fails; the protected `src` tree drifts before activation; or publication becomes necessary. No npm, Registry metadata, GitHub Release, tag, `main` target, or later-phase work is authorized.

[PR #608](https://github.com/mohanagy/madar/pull/608) squash-merged the exact implementation into protected `core-reset` as `565c42bb1b34b67f7fefc7aabd0513e4e391a13b` from exact reviewed head `c0496413518382ca6dff74fa5c81ab72b9edd57c`. Merge tree `225f446ee88ecc74a3226bd17c362458c2312528` exactly equals the reviewed-head tree and the merge has sole parent `452ad84890c012392c5e6af613e8bfeb17de45db`. All six jobs in [exact-head CI run 30162721277](https://github.com/mohanagy/madar/actions/runs/30162721277) passed, including 74 test files / 617 tests passed with 3 skipped and 81.57% statement, 73.05% branch, 89.04% function, and 85.45% line coverage. The [independent exact-head review](https://github.com/mohanagy/madar/pull/608#pullrequestreview-4779465252) found no blocker and zero review threads remained. [CodeRabbit explicitly skipped](https://github.com/mohanagy/madar/pull/608#issuecomment-5078954363) because the required `core-reset` base is non-default; the skip is not represented as a completed review. The [#606 merge receipt](https://github.com/mohanagy/madar/issues/606#issuecomment-5078995452) and matching [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5078995591) record the completed implementation. No #606 stop condition triggered.

Evaluation Tooling Isolation is complete. Capability Validation v1 was separately activated and then stopped below; #606 itself did not authorize either successor runner. No npm package, GitHub Release, Registry metadata, or tag was published, and no phase targets `main`.

## Stopped amendment — capability validation v1

The exact #610 activation head `80e942a8a28e3895465aa9ca432c4a926054055d` merged into protected `core-reset` as `dcb52596a3efa89f9ef5d372231ce97a91ae5f9f`, with tree `d0ca317290dbd6837295f36f36ded5b49855c0fe`. Its immutable assets remain `capability-validation-v1.json` SHA-256 `ae03a6b2cc8675ca66ad0ff67f06e13389cf04e6a6a8167c3404f1c8657f36f5`, contract-schema SHA-256 `6d8679e335730180bee0c9fc62f144ae2086ea16dade800887a0301da27f23b6`, and receipt-schema SHA-256 `a33a6b3532a3e0df62bcd0f3616a9585b2be4ede1f360cf3d55f70c99c29f30e`.

Fresh independent review of the uncommitted implementation draft triggered stop conditions 7, 8, and 13: authorization accepted claims instead of observed evidence, no committed coordinator/relay or campaign entrypoint owned the workflow, the spend ledger was caller-resettable, containment was abstract, provider/MCP evidence was incomplete, and receipt/archive facts remained forgeable. The exact [#610 stop receipt](https://github.com/mohanagy/madar/issues/610#issuecomment-5083281270) and [RFC stop amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5083282711) record body SHA-256 values `115e88cc3e1e00066c92f6ce4b3dd9ed8e0f6eabc1f8dbad918d1125c5cdaef9` and `65ac67ca30f24eb2c9d2741ab12ee42d2f593915220ff1251adb8af97e717ed0`. V1 stopped before an implementation PR, campaign lock, Count Tokens, Create, any provider request, spend, production/package/dependency change, or publication.

## Historical accepted amendment — capability validation v2

The owner approved exact v2 proposal-body SHA-256 `4906405cbb806c850c0612305ef460e023e2060b5338734ae0af12303901cbd0` through the durable [#612 first-stage receipt](https://github.com/mohanagy/madar/issues/612#issuecomment-5083661878) and [matching RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5083662827). The governance anchor is protected `core-reset` commit `dcb52596a3efa89f9ef5d372231ce97a91ae5f9f`, tree `d0ca317290dbd6837295f36f36ded5b49855c0fe`, `src` tree `1a37e3a58ee7b2a75ca034112506590f699b3918`, and `tools/eval` tree `b8ef02da3ce135596e87fdf6252441755061d956`.

The governance candidate adds exactly three closed machine assets: `capability-validation-v2.json`, `capability-validation-contract-v2.schema.json`, and `capability-validation-receipt-v2.schema.json`. The v2 contract recursively preserves the immutable v1 subjects outside a closed execution-control pointer allowlist. The added boundary makes exact the coordinator/relay, observed authorization, one non-resettable ledger, native monitor and sandbox profiles, complete transcript/provider/MCP evidence, semantic receipt derivation, first-stop lifecycle, crash-only stopped finalization, exclusive two-copy archive/fsync/reread, external archive verification, and honest commitment-only public validation.

The three assets may total at most 3,200 lines / 2,097,152 bytes; only the five governance files may change within `+650/-250`, so activation touches exactly eight paths within `+3,850/-250`. A second owner receipt must approve the exact unchanged activation head, all three local asset SHA-256 values, and every newly exact execution-control, evidence, receipt, path, LOC, error, schema, and operational choice before merge. A changed head or asset requires renewed approval.

Only after that exact activation merge may offline implementation start from the merge, on #612's exact 53-path allowlist and `+29,130/-350` ceiling; combined activation plus implementation is `+32,980/-600`. This supersedes only v1's 29-path / `+12,200/-200` development boundary. The provider/model, exact 60 comparison trials, one diagnostic, 12 refresh samples, 20,000,000 input tokens, 2,000,000 output tokens, 12 tool calls, 13 Create requests, 300-second timer, USD $90 runner ledger, USD $100 provider hard cap, comparator identities, grading, review, product, production, package, dependency, graph/index/generation/query, and public semantics remain unchanged.

After the exact offline implementation merge, one governance-only closure PR may touch only these five governance files within `+400/-200`, for full activation-plus-implementation-plus-closure ceilings of `+33,380/-800`. It records only that the v2 offline execution boundary passed, exact implementation merge/tree/review/CI receipts, #610's unchanged stop, the unresolved provider-account observer, zero provider requests/spend, and no active campaign; it cannot change an evaluator, schema, contract, CI, production, package, dependency, receipt, evidence, or historical asset.

The offline v2 implementation has no generic provider-proof acceptance path and cannot create a real campaign lock. A future separately approved proposal must bind an authenticated provider-account hard-cap and zero-use observation mechanism. This activation authorizes no target-repository execution, provider request including Count Tokens or Create, paid spend, campaign, publication, release, Registry metadata, tag, `main`, natural activation, or external validation. Any #612 stop condition requires an RFC #577 amendment; none authorizes widening, retry, matrix reduction, or favorable reinterpretation.

## Cancelled amendment — capability validation

The exact v2 governance head `7c0cff71c512512d534e4d5b011cd27ced5992fe` merged into protected `core-reset` as `5c9d1e2436932f7420169ea4ffa617c6bea4fbd0`, with tree `35b68cd733e07b9306d52e2076a287269f8919eb`. Implementation did not start. On 2026-07-28 the owner closed Capability Validation issues #610, #612, #614, #615, and #616 as not planned and revoked every unconsumed preparation, activation, implementation, campaign, provider, spend, and target-execution authority. No campaign ran, no comparative result exists, provider requests remain zero, and spend remains USD 0. The committed assets remain immutable historical records and supply no release evidence.

## Active amendment — retrieval regression #618

Issue [#618](https://github.com/mohanagy/madar/issues/618) is a bounded post-beta repair anchored to protected `core-reset` commit `5c9d1e2436932f7420169ea4ffa617c6bea4fbd0`. It may modify only `src/adapters/mcp/protocol.ts`, `src/domain/query/rank.ts`, `src/domain/query/slice.ts`, and `src/domain/query/traverse.ts`, add no production file or dependency, and remain within `+100/-0/net +100` production LOC.

The committed JS/TS fixture must identify the first stable-vs-beta divergence. A natural flow question must return grounded evidence in one call or after at most one bounded recovery. If full coverage is unavailable, the result must preserve useful local evidence and name exact verification targets. Repository-specific ranking, graph/index semantics changes, compatibility fallbacks, a second retrieval engine, publication, and `main` are forbidden.

## Public surface target

The active reset target is exactly one MCP tool:

- `retrieve`

The CLI remains narrow and lazy-loaded:

- `generate`
- `query`
- `status`
- `doctor`
- `install`
- internal `mcp` entrypoint

These six names are an allowlist, not a quota. Existing names are preserved only when their meaning remains valid; removed names do not survive as aliases.

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
- [#567](https://github.com/mohanagy/madar/issues/567) was owned and closed by [#602](https://github.com/mohanagy/madar/issues/602) only after a normally launched, normally configured Codex client completed Madar `tools/call`; direct JSON-RPC and cancelled non-interactive calls did not qualify.

Their final disposition is applied only through the dependency-ordered phase that owns each issue.

## Risks and stop conditions

- A rewrite can hide regressions behind cleaner code. Frozen graph and answer fixtures must precede replacement work.
- TypeScript static analysis cannot prove all dynamic runtime behavior. Missing edges must remain explicit rather than guessed.
- Removing broad features may affect existing users. The pre-1.0 migration notes must name every removed command, tool, language, and artifact.
- Evaluation can contaminate production retrieval. Held-out expected paths remain outside production and are checked by CI.
- Thin Delivery can disguise semantic drift as adapter cleanup. CLI/application/MCP parity and frozen query/index/graph/generation contracts prevent delivery work from changing evidence behavior.
- Client configuration can appear correct without a real dispatch. #567 therefore closed only after a normal no-override Codex launch completed Madar `tools/call`.
- A technically cleaner engine may still have no durable demand. If it cannot match comparator correctness, materially reduce discovery cost, or earn voluntary repeat use, the project stops or pivots instead of broadening again.

## Superseded direction

This RFC supersedes the additive architecture direction in the earlier SPI design and the compatibility/fallback direction in `docs/decisions/2026-05-11-spi-default-readiness.md`. Those documents remain as historical records; they do not authorize a surviving legacy engine.

## Amendment rule

Any change to the product job, non-goals, architecture boundary, compatibility policy, removal manifest, or release gates requires:

1. an explicit amendment in [#577](https://github.com/mohanagy/madar/issues/577);
2. evidence supporting the change;
3. an update to this document, the manifest, and the scorecard before implementation.

## Acceptance

The repository owner accepted this RFC on 2026-07-19 in [#577](https://github.com/mohanagy/madar/issues/577) after the governance review passed. Scope/baseline, directed-multigraph, canonical-index, legacy/non-code deletion, generation/reconciliation, and evidence-path-query later passed their gates. The owner accepted [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506), the recorded incremental stop amendment, [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977), its [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198), the graph-authenticated source correction through the durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5054853667) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815) receipts, and the source-only generation prerequisite through [#599](https://github.com/mohanagy/madar/issues/599#issuecomment-5060766685) and its [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5060766863). PRs #594 and #600 completed those contracts. On 2026-07-25 the owner approved the exact [#602 Thin Delivery contract](https://github.com/mohanagy/madar/issues/602#issuecomment-5075969972) and [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5075969871), then the exact [#606 Evaluation Tooling Isolation contract](https://github.com/mohanagy/madar/issues/606#issuecomment-5078675449) and [matching RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5078676116). PR #604 merged Thin Delivery as `14791cefa195f43e30ec9ec2dd611e38ad2b1b83`; PR #608 merged Evaluation Tooling Isolation as `565c42bb1b34b67f7fefc7aabd0513e4e391a13b`, each after exact-head CI, independent review, honest CodeRabbit disposition, and zero-thread gates passed. At that #608 completion checkpoint no technical phase was active and Capability Validation plus every later phase remained blocked and unapproved; the 2026-07-26 approval below supersedes that checkpoint only for Capability Validation.

On 2026-07-26 the owner approved the original Capability Validation proposal hash through [#610](https://github.com/mohanagy/madar/issues/610#issuecomment-5081132612) and the [matching RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5081133199); independent implementation review later triggered the mandatory stop above. The owner then approved the exact v2 proposal hash through [#612](https://github.com/mohanagy/madar/issues/612#issuecomment-5083661878) and its [matching RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5083662827). Its governance-only activation merged at `5c9d1e2436932f7420169ea4ffa617c6bea4fbd0`, but implementation never started. On 2026-07-28 the owner closed Capability Validation and its successors as not planned and revoked every unconsumed authority. The separately authorized issue #618 retrieval regression repair is now the sole active technical item.

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
| 2026-07-23 | Graph-authenticated source-excerpt correction | The implementation audit proved canonical `graph.json` has hashes/ranges but not source bytes, so graph-only snippet and determinism requirements were contradictory. The owner approved the exact [stop-condition amendment](https://github.com/mohanagy/madar/issues/596#issuecomment-5052210144), [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5052210334), and durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5054853667) / [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815) receipts: graph facts select evidence, exact source excerpts authenticate against the canonical file-node `content_hash`, and determinism includes the normalized request and authenticated source snapshot. No production, graph/index, dependency, budget, or release change is authorized by this correction. |
| 2026-07-23 | Held-out v2 correction approved | The v1 path-only grader was invalid because it accepted unrelated symbols in expected files, required definitions that exceeded the result budget, and implicitly demanded graph edges for real runtime/user/async transitions that were absent. The approved [#596 proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5056946202), [#577 proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5056947999), [owner approval](https://github.com/mohanagy/madar/issues/596#issuecomment-5058567870), and [RFC approval](https://github.com/mohanagy/madar/issues/577#issuecomment-5058568992) replace it with exact authenticated declaration-owner grading, structural file evidence that cannot cover phases, and explicit disconnected boundaries. The v1 baseline remains immutable history; production stays paused and all source, dependency, package, query, token, and release limits remain unchanged. |
| 2026-07-23 | Source-only generation prerequisite approved | The first real v2 run could not resolve tracked local workspace config packages and reported external ambient/composite/incremental diagnostics unrelated to graph facts. The owner approved [#599](https://github.com/mohanagy/madar/issues/599#issuecomment-5060766685) and the [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5060766863): create only a byte-attested temporary view of tracked local config packages referenced by compiler `extends`, normalize only external ambient type discovery and composite/incremental build behavior, and add no package manager, network, external dependency, repository-specific rule, compatibility path, publication bypass, or budget increase. |
| 2026-07-24 | Combined evidence-path/finalizer deletion approved and implementation started | The owner approved the combined dependency in [#599](https://github.com/mohanagy/madar/issues/599#issuecomment-5062879476), [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5062879444), and the [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5062879430): one 63-file / 33,031-LOC predecessor floor, 22 transfers, serve.ts rebuild-to-delete, and stdio/prompts.ts as supplemental cleanup outside that floor. Held-out, performance, final inventory, dependencies, CI, and review remain pending. |
| 2026-07-24 | Darwin containment path correction approved | The accepted evaluator reached retrieval but macOS spelled the same temporary request path as `/var/...` in child argv and `/private/var/...` in the Node filesystem allowlist. The approved [#596 proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5066594490), [#577 proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5066600460), [owner receipt](https://github.com/mohanagy/madar/issues/596#issuecomment-5066655931), and [RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5066657672) canonicalize only explicitly declared filesystem argv indexes and pin evaluator SHA-256 `a41a51cbe1853f524e3e05cc91b31016382778f980dbb67ef06f910925892841`. Repositories, prompts, owners, handoffs, grading, limits, readable/writable paths, contracts, schemas, and performance evaluation remain unchanged. |
| 2026-07-24 | PR #600 portability correction approved | The [owner proposal](https://github.com/mohanagy/madar/issues/596#issuecomment-5072454599), [RFC proposal](https://github.com/mohanagy/madar/issues/577#issuecomment-5072454807), [owner approval](https://github.com/mohanagy/madar/issues/596#issuecomment-5072486888), and [RFC approval](https://github.com/mohanagy/madar/issues/577#issuecomment-5072487113) pin evaluator SHA-256 `b7211c7e56360921a6b8e681ac84b21a1f13963f78a925589ea8611ee25bab97`, authenticate JSON-escaped forms of the same private roots, force deterministic LF checkout bytes, and preserve an exact hard-ignored target as unavailable instead of unrelated evidence. No evaluation authority, sandbox access, gate, budget, query pass, or engine changes. |
| 2026-07-24 | Held-out-v2 correctness and loaded-graph performance revalidated | Exact evaluated head `29aba7ebffe14d6a70bde78df1490bf4cded64a4` produced acceptance-eligible [held-out](../core-reset/evidence/evidence-path-held-out.json) and [performance](../core-reset/evidence/evidence-path-performance.json) receipts: Documenso and Formbricks each have full phase coverage and precision, zero unrelated files, every required handoff matches, and the frozen performance workload passes at 279.28 ms p95. OpenStatus remains an explicitly non-blocking failing diagnostic. The package remains within the approved ceiling with no dependency additions; CI, review, and release remain pending. |
| 2026-07-25 | Evidence-path query complete | PR #600 was squash-merged at `596d286cdf4bb53670a6d8c27b2cec5f86137739` from exact head `a0ef9003b9bb71a8defb3463ee131e677b32fecc`. The phase removed 63 contracted predecessors plus one supplemental production file, added seven replacements, finished at 73 files / 21,687 LOC and net `-44,731`, passed 2/2 blocking held-outs and 279.28 ms loaded-graph p95, passed all six exact-head CI jobs, and retained zero review threads. Independent exact-head review found no blocker; CodeRabbit skipped the non-default base and is not represented as having reviewed. No phase is active; Thin Delivery is Ready but requires a bounded issue and explicit owner activation. |
| 2026-07-25 | Thin Delivery accepted and governance-activated | The owner approved [#602](https://github.com/mohanagy/madar/issues/602#issuecomment-5075969972) and the matching [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5075969871). The active contract starts from `8efe41fc665fcea7e625dda0864a72ecf27a111b`, deletes exactly 16 production files / 7,277 LOC, permits at most six replacements / 2,300 total added LOC, adds no dependency, removes exactly `neo4j-driver`, ships at most six allowlisted CLI entrypoints and exactly one MCP tool, preserves query/index/graph/generation semantics, and keeps #567 open until real no-override Codex `tools/call`. Governance activation changes no production code; implementation evidence is pending. |
| 2026-07-25 | Thin Delivery source and package candidate measured | Implementation started from governance merge `edcf3e45b8c8fb76a57531bc74bede2a06189aba`. At this historical checkpoint, the candidate deleted all 16 predecessors, added the six exact replacements, recorded `+2,062 / -7,281 / net -5,219` production LOC, finished at 63 files / 16,468 LOC, removed `neo4j-driver` with no dependency addition, and packed as 142 files / 197,060 packed bytes / 798,815 unpacked bytes. The later completion receipt supersedes the gates that were pending at this checkpoint. |
| 2026-07-25 | Thin Delivery stopped at stock Codex transport | Packed cold starts passed at 36.114 ms median / 43,155,456-byte maximum RSS for `madar --version` and 93.714 ms median for initialize plus exactly one tool. Claude Code 2.1.218 completed the installed `retrieve` call. Stock Codex CLI 0.144.5, launched without configuration or tool overrides, started the installed MCP item but returned `user cancelled MCP tool call` with no Madar result. An owner-authorized isolated retry with current official stable Codex 0.145.0 reproduced the same failure without changing the global client. The [#602 record](https://github.com/mohanagy/madar/issues/602#issuecomment-5077587623), [RFC stop record](https://github.com/mohanagy/madar/issues/577#issuecomment-5077587577), and [client receipt](../core-reset/evidence/thin-delivery-client-transport.json) preserve the unchanged gate: #567 stays open and no implementation PR or merge is authorized. |
| 2026-07-25 | Thin Delivery normal Codex transport passed | The bounded normal interactive official stable Codex 0.145.0 retry used the supported workspace registration without `-c`, profile, injected MCP configuration, manual tool override, direct protocol substitute, dangerous bypass, alpha client, or global upgrade. Thread `019f984b-e210-76f0-b80c-cf52ac8f1460` completed `madar_862f3af6d392.retrieve`, returned authenticated `src/payment-retry.ts:L1-L3` evidence, and answered `evidence — src/payment-retry.ts`. The [#602 pass](https://github.com/mohanagy/madar/issues/602#issuecomment-5077629727), [RFC pass](https://github.com/mohanagy/madar/issues/577#issuecomment-5077629090), and [#567 acceptance](https://github.com/mohanagy/madar/issues/567#issuecomment-5077630691) cleared the historical stop without changing the contract. #567 closed; the later completion receipt records the exact-head merge gates. |
| 2026-07-25 | Thin Delivery final source, package, and startup candidate measured | The final pre-PR source snapshot was 63 files / 16,654 LOC with `+2,248 / -7,281 / net -5,033`; its fresh package was 142 files / 200,310 packed bytes / 812,531 unpacked bytes, a 31,214-byte packed reduction from the preceding phase. Ten fresh packed processes measured `madar --version` at 38.792 ms median / 40.280 ms p95 / 43,532,288-byte maximum RSS and initialize plus `tools/list` at 160.380 ms median / 185.684 ms p95 / 208,977,920-byte maximum RSS, with exactly `retrieve` in every sample. The later completion receipt records the final-artifact client, exact-head CI, review, CodeRabbit, thread, and merge gates. |
| 2026-07-25 | Thin Delivery sealed-artifact clients revalidated | Normally launched Claude Code session `f021741f-b474-438e-a07b-a54ef35e071c` and normal interactive Codex 0.145.0 session `019f9890-e9fb-7610-a379-f3ef19a418ef` used the same sealed package and exact installed registration `madar_6b8bb2115fe0`. Each dispatched exactly one forced `retrieve` for the accepted question and budget, returned authenticated `src/payment-retry.ts` evidence, and produced the exact evidence answer without configuration, profile, or tool override. Supported uninstall restored Codex, Claude, and `CLAUDE.md` bytes exactly and changed no fixture repository bytes. The [#602 final-candidate record](https://github.com/mohanagy/madar/issues/602#issuecomment-5077981356), [RFC final-candidate record](https://github.com/mohanagy/madar/issues/577#issuecomment-5077981401), and [client receipt](../core-reset/evidence/thin-delivery-client-transport.json) bind this pass to the sealed artifact. The later completion receipt records the remaining exact-head gates and merge. |
| 2026-07-25 | Thin Delivery complete; Evaluation tooling Ready | [PR #604](https://github.com/mohanagy/madar/pull/604) was squash-merged into protected `core-reset` at `14791cefa195f43e30ec9ec2dd611e38ad2b1b83` from exact reviewed head `ddd9761b137ef1f07eb362a91f9f2478c1d08c38`; merge tree `02a059c66a214fe52e31d8fffa2c501a1761bf0f` exactly matches the reviewed head tree. All six jobs in [CI run 30154480779](https://github.com/mohanagy/madar/actions/runs/30154480779) passed, the [independent exact-head review](https://github.com/mohanagy/madar/pull/604#pullrequestreview-4779114409) found no blocker, and zero review threads remained. CodeRabbit skipped the non-default `core-reset` base and is not represented as having reviewed. Held-out self-hash `6baed3cfc2b3aa963581613be6cf17ccf1aa261dd29343e27bfe87d52bdaad6c`, the blocking held-outs, the performance receipt, sealed-client transport, and startup/package budgets all passed; OpenStatus remained an explicitly non-blocking failing diagnostic. #602 is complete, #567 is closed, no technical phase is active, `evaluation-tooling` is Ready for a separately bounded issue and explicit owner activation, and capability validation plus every later phase remain blocked. |
| 2026-07-25 | Evaluation Tooling Isolation accepted and governance-activated | The owner approved [#606](https://github.com/mohanagy/madar/issues/606#issuecomment-5078675449) and the matching [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5078676116). The active contract starts from protected `core-reset` `317dda89f2ea5c75e7626a26b104ceca1bd04ce5` / `src` tree `b99217c74f6b26daef4ecab12e1cde5f8fe60122`, moves exactly 20 production TypeScript files / 4,698 LOC to `tools/eval/lib/**`, adds no production source or dependency, finishes at exactly 43 files / 11,956 LOC, and enforces the 102-file / 165,000-packed / 640,000-unpacked npm ceilings. Governance activation changes no production code. Capability Validation remains blocked because no valid blinded Native-vs-Graphify-vs-Madar runner exists; implementation evidence remains pending. |
| 2026-07-25 | Evaluation Tooling Isolation source and package candidate measured | Implementation started from exact governance merge `452ad84890c012392c5e6af613e8bfeb17de45db`. The pre-PR candidate moved all 20 predecessors / 4,698 LOC to corresponding `tools/eval/lib/**` paths, left no old `src/**` copy, changed no surviving production TypeScript or dependency, and finished at 43 production files / 11,956 LOC with `+0 / -4,698 / net -4,698`. Its fresh artifact was 102 files / 159,759 packed bytes / 637,602 unpacked bytes with shasum `6eee13af22e8c76113fe578e44d76a9e6d6fd899`. Source, build-boundary, frozen-evidence, and package candidate gates passed within the accepted ceilings. At this historical checkpoint exact-head CI, independent review, honest CodeRabbit disposition, zero review threads, and merge were pending; the following PR #608 completion row supersedes those pending gates. Capability Validation remained blocked and unapproved. |
| 2026-07-25 | Evaluation Tooling Isolation complete; no technical phase active | [PR #608](https://github.com/mohanagy/madar/pull/608) was squash-merged into protected `core-reset` as `565c42bb1b34b67f7fefc7aabd0513e4e391a13b` from exact reviewed head `c0496413518382ca6dff74fa5c81ab72b9edd57c`; merge tree `225f446ee88ecc74a3226bd17c362458c2312528` exactly equals the reviewed-head tree and has sole parent `452ad84890c012392c5e6af613e8bfeb17de45db`. The implementation moved exactly 20 files / 4,698 LOC, finished at 43 files / 11,956 LOC and 102 package files / 159,759 packed / 637,602 unpacked bytes, and changed no surviving production TypeScript or dependency. All six [exact-head CI jobs](https://github.com/mohanagy/madar/actions/runs/30162721277) passed; the [independent review](https://github.com/mohanagy/madar/pull/608#pullrequestreview-4779465252) found no blocker; zero threads remained; CodeRabbit's [non-default-base skip](https://github.com/mohanagy/madar/pull/608#issuecomment-5078954363) is not represented as a review. The [#606](https://github.com/mohanagy/madar/issues/606#issuecomment-5078995452) and [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5078995591) receipts record the merge. Capability Validation remains blocked and unapproved. |
| 2026-07-26 | Capability Validation proposal accepted for governance activation | The owner approved exact proposal-body SHA-256 `27c04eca61e8c3ae65e2a9eab5c0b7e269313be933cef785b94e9bdca7292ba5` through the [#610 receipt](https://github.com/mohanagy/madar/issues/610#issuecomment-5081132612) and [matching RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5081133199). Governance activation is anchored to protected `core-reset` `e7b3be547bc3f6cfdefdd514f17a1ad229afea03`, changes no production or executable evaluator code, and requires a second owner approval of the exact unchanged activation head plus all three machine-asset hashes before merge. No provider request or implementation is authorized by this first-stage receipt. |
| 2026-07-26 | Capability Validation v1 mandatory stop | Independent review of the uncommitted implementation draft triggered #610 stop conditions 7, 8, and 13. The [issue stop](https://github.com/mohanagy/madar/issues/610#issuecomment-5083281270) and [RFC stop](https://github.com/mohanagy/madar/issues/577#issuecomment-5083282711) preserve the exact activation and asset bytes. No implementation PR, campaign lock, provider request, spend, protected-branch implementation change, or publication occurred. |
| 2026-07-26 | Capability Validation v2 accepted for governance activation preparation | The owner approved exact proposal-body SHA-256 `4906405cbb806c850c0612305ef460e023e2060b5338734ae0af12303901cbd0` through the [#612 receipt](https://github.com/mohanagy/madar/issues/612#issuecomment-5083661878) and [matching RFC receipt](https://github.com/mohanagy/madar/issues/577#issuecomment-5083662827). Governance activation is anchored to protected `core-reset` `dcb52596a3efa89f9ef5d372231ce97a91ae5f9f`, changes no production or executable evaluator code, and requires a separate approval of the exact unchanged head plus all three v2 asset hashes before merge. Only the later offline implementation allowlist and LOC ceiling expand; no implementation, campaign lock, provider request, spend, target-repository run, publication, release, Registry write, tag, or `main` target is authorized. |
| 2026-07-28 | Capability Validation cancelled | The v2 governance activation merged, but implementation never started. The owner closed #610, #612, #614, #615, and #616 as not planned and revoked every unconsumed authority. No campaign ran, no provider request or spend occurred, and no comparator result exists. |
| 2026-07-29 | Retrieval regression #618 activated | The owner authorized the bounded repair from protected `core-reset` `5c9d1e2436932f7420169ea4ffa617c6bea4fbd0`: four exact modified production paths, zero new production files or dependencies, `+100/-0/net +100`, one grounded call or at most one bounded recovery, and no repository-specific, graph/index, fallback, publication, or `main` expansion. |
