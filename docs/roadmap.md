# Public roadmap

Madar is executing an accepted Core Reset. The roadmap is outcome-driven: work advances only when its predecessor is complete and its technical or business exit gate has evidence.

## Sources of truth

- [Core Reset RFC #577](https://github.com/mohanagy/madar/issues/577) — discussion, acceptance, and weekly checkpoints
- [`v0.40.0 — Core Reset` milestone](https://github.com/mohanagy/madar/milestone/7) — release-blocking work
- [Madar Roadmap project](https://github.com/users/mohanagy/projects/8) — execution status and dependencies
- [Versioned design](designs/2026-07-19-core-reset.md) — normative product and architecture contract after acceptance
- [Removal manifest](core-reset/removal-manifest.yml) — keep, rebuild, move, delete, and defer decisions
- [Scorecard](core-reset/scorecard.md) — technical and business evidence gates

The RFC is **accepted**. Scope and baseline, Directed multigraph, Canonical TypeScript/JavaScript index, the combined legacy/non-code deletion, and Generation and reconciliation have passed. [#596](https://github.com/mohanagy/madar/issues/596) is accepted and `evidence-path-query` is the sole phase In progress from protected base `bce4f4fb1520a582bfedf5eab9133e9befbc79f7`. Thin delivery and every later phase remain blocked.

## Passed — directed multigraph

The `directed-multigraph` removal-manifest entry delivered:

1. Preserve multiple typed edges between the same ordered node pair.
2. Give nodes and edges deterministic IDs and preserve direction and provenance through serialization.
3. Replace the owned graph path under the accepted destination rather than creating a permanent V1/V2 split.
4. Delete the predecessor graph path when the phase gate passes, with net-negative production LOC.

The five predecessor files and obsolete exporter surfaces are absent. PR #583 was squash-merged into the protected `core-reset` branch at `63c59049178e82bd6bd1c928f6666ef159365bbe`. Final measurements are 178 production TypeScript files / 93,792 LOC with a `+1,197 / -4,171 / net -2,974` source delta, five new production files, and no dependency additions. All six CI matrix jobs passed, CodeRabbit completed successfully, every review thread was resolved, and the frozen baseline receipt remains unchanged.

## Passed — canonical TypeScript/JavaScript index

The `canonical-typescript-index` removal-manifest entry accepted in [#585](https://github.com/mohanagy/madar/issues/585) now writes canonical graph facts directly from one scanner-scoped TypeScript Program. It deleted the 20-file SPI and projection contract, satisfies the labelled language/framework fixtures without legacy augmentation, and adds no runtime dependency.

PR #586 was squash-merged into protected `core-reset` at `4dfd48194f2fab00b2cd2271a6f7917909dde9d4`. Final measurements are 170 production TypeScript files / 91,539 LOC with a `+5,538 / -7,791 / net -2,253` delta from protected phase base `f68d64482578f0c7992ec63095fa00e19ac25880`. The strengthened gold harness reports 100% import/re-export recall and 100% call/framework-edge recall; all eight accepted framework buckets report 100% recall and precision with no unexpected facts. All six CI jobs passed, all nine actionable CodeRabbit comments and both review-body nitpicks were addressed, eight of the nine actionable remediations were confirmed by CodeRabbit, and every review thread was resolved. The final CodeRabbit rerun was rate-limited, so the owner approved an explicit exception after an [independent adversarial review passed](https://github.com/mohanagy/madar/pull/586#issuecomment-5036311350); the final automation result is not represented as green.

## Passed — delete legacy extraction and non-code/other-language ingestion

[#588](https://github.com/mohanagy/madar/issues/588) completed one deletion work item covering both `legacy-extraction` and `non-code-and-other-language-ingest`. The latter remains a distinct manifest ownership ID but was absorbed by the single phase because the unsupported and non-code routes depended on the same legacy companion path.

PR #590 was squash-merged into protected `core-reset` at `d46031eed7b0cf2d8bb7b7b6267a51322d9e2490` from final PR head `0d5aab99b9aeaf01a17830bacafd6e8027ded72f`. The phase removed 31 production files and finished at 139 production TypeScript files / 68,954 LOC, a `+815 / -23,400 / net -22,585` delta from protected base `9a762d0a4e10a0ae210ba3f53bb1d4468367e81e`. The three legacy runtime dependencies and five extraction flags are absent. The full local suite reported 1,907 passed / 2 skipped with 85.17% statement, 76.97% branch, 90.59% function, and 85.85% line coverage. All six jobs in [CI run 29899357806](https://github.com/mohanagy/madar/actions/runs/29899357806) passed and zero review threads remained. CodeRabbit skipped the actual review because reviews are disabled for the `core-reset` base branch; the owner approved an explicit exception backed by a passing [independent strict review](https://github.com/mohanagy/madar/pull/590#issuecomment-5043069972).

The resulting npm package has 314 files, 592,783 packed bytes, and 2,794,076 unpacked bytes. It is materially smaller than baseline but still fails the final `<150` files / `<1,500,000` unpacked-byte package gate; deletion completion does not claim otherwise.

## Passed — generation and reconciliation

The owner accepted the exact contract in [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and amended [RFC #577](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586). The completed phase shipped cold no-op plus full canonical reconciliation. Its successor Evidence-path query is now active under a separately accepted contract, while thin delivery remains blocked.

The phase removed 15 predecessor files / 3,839 LOC, transferred three mixed query files to `evidence-path-query` and `doctor.ts` to `thin-delivery`, and added the six permitted replacements. It finished net `-2,536` LOC at 130 production files / 66,418 LOC, added no runtime or development dependency, and reduced the npm package to 276 files / 2,699,851 unpacked bytes without increasing packed bytes.

The fixed 500-file performance gate stopped the proposed incremental path. Candidate checkpoint `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d` at worktree tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda` measured warm index p50 ratio `0.824`, refresh p50 `1.047`, and refresh p95 `1.029`, missing all three required ratios. These sealed receipt values supersede the provisional ratios posted earlier in #592/#577. Held-out timing was intentionally skipped because it could not reverse the mandatory fixed-gate stop. The failed Program/fact/closure path was deleted.

The shipping architecture is cold no-op plus one full canonical reconcile for every changed source state. It has no in-memory or disk session cache. `graph.json` is the sole authoritative artifact and commits last; diagnostic sidecars are derived/non-blocking. Clean-equivalent add/change/delete/rename/control/ignore/recognized-unsupported-file/symlink/worktree behavior, zero stale facts, and publication fault/concurrency safety passed. Only successful `.ts/.tsx/.js/.jsx` indexing determines completeness; supported failures are incomplete, unsupported files are informational, and safety exclusions remain separate.

Exact runtime commit `1be24dc45a5f07c352c74fc374feb95a9440df8e` records all 15 predecessors absent and all six replacements present. The [inventory receipt](core-reset/evidence/generation-incremental-inventory.json) measures 130 production TypeScript files / 66,418 LOC with `+2,190 / -4,726 / net -2,536`, and an npm dry-run of 276 files / 572,143 packed bytes / 2,699,851 unpacked bytes. The compatible [shipping receipt](core-reset/evidence/generation-full-reconcile-500.json) passes cold no-op at `0.067` of clean generation with zero parse/invalidation/publication and clean regression at `1.045`. The [hermetic mutation-equivalence receipt](core-reset/evidence/generation-mutation-equivalence.json) records 5 focused files / 92 passing tests across clean equivalence, zero-stale-fact, publication-failure, worktree, and concurrency cases. The [failed-gate receipt](core-reset/evidence/generation-incremental-stop-500.json) and [protected-base receipt](core-reset/evidence/generation-incremental-protected-base-500.json) preserve why the incremental path was deleted.

[PR #594](https://github.com/mohanagy/madar/pull/594) was squash-merged at `b56966c06c0ae1b04c252f297036f332fa1b384c` from final head `3f40c5b64cdd63054c52ed67588b782034f8b935`. All six jobs in [CI run 29942216697](https://github.com/mohanagy/madar/actions/runs/29942216697) passed, including 156 files / 1,885 tests passed with 2 skipped under coverage. Three independent P0/P1 audits found no blocker and zero review threads remained. CodeRabbit explicitly skipped the non-default base; the owner-approved exception is documented in the [exact-head review receipt](https://github.com/mohanagy/madar/pull/594#issuecomment-5049404550) without claiming a completed CodeRabbit review.

## In progress — evidence-path query

The owner approved the exact contract in [#596](https://github.com/mohanagy/madar/issues/596#issuecomment-5050888977) and the linked [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198) on 2026-07-23. After the implementation audit fired the graph-only snippet/determinism stop condition, the owner also approved the exact [graph-authenticated source amendment](https://github.com/mohanagy/madar/issues/596#issuecomment-5052210144), its [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5052210334), and the durable [owner](https://github.com/mohanagy/madar/issues/596#issuecomment-5054853667) / [RFC](https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815) receipts. `evidence-path-query` is the sole active phase from protected base `bce4f4fb1520a582bfedf5eab9133e9befbc79f7`. Activation and this correction change no production source or package metadata: the phase begins at 130 production files / 66,418 LOC and 276 npm files / 2,699,851 unpacked bytes with `+0 / -0 / net 0` production LOC.

The implementation must replace the accumulated query/governance surface with one deterministic TypeScript/JavaScript evidence-path query. It deletes 54 predecessor files / 29,441 LOC, including the fully absorbed context-governance and derived-wrapper handles plus ten partial transfers from later owners. At most seven production files / 3,500 LOC may replace them; the final phase ceiling is 83 production files / 40,500 LOC, net production delta at most `-25,900`, zero runtime/development dependency additions, removal of the optional semantic peer, at most 210 npm files / 2,200,000 unpacked bytes, and fewer packed bytes.

`graph.json` remains authoritative for selection and every node, relationship, path, range, provenance record, and hash. Source bytes may only render an exact graph-range excerpt from a file beneath the graph root whose complete UTF-8 SHA-256 matches the canonical file-node `content_hash`. Missing, unreadable, or escaped source is unavailable; a hash mismatch or invalid range is stale; every authentication failure returns no snippet. Determinism covers the normalized retrieve request, canonical graph bytes, and identical authenticated source snapshot.

One evaluator `retrieve` invocation must directly cover every required phase in the frozen Documenso and Formbricks questions with graph-authenticated source excerpts, at least 70% selected-file precision, no more than two unrelated files, no more than 12 files and 25 snippets, at most 4,000 serialized tokens, and zero incorrect load-bearing paths or relationships. OpenStatus is diagnostic only: every in-scope TypeScript phase must be covered, Go checker/Tinybird phases must be explicit unsupported boundaries, and the result cannot claim complete mixed-language coverage.

The owner-approved [performance correction](https://github.com/mohanagy/madar/issues/596#issuecomment-5051857404) and [RFC record](https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542) freeze a development-only descriptor with exactly 15,000 nodes / 30,000 directed edges, four exact positive evidence paths, and one exact missing boundary. One untimed correctness invocation per query must pass before warmup, and every warmup/measured result must remain correct; an empty positive result fails. On the reference Node 22 / Darwin arm64 / Apple M3 Max environment, warm retrieval p95 must be below 500 ms after three warm-ups and at least 20 measurements, closure-pass count at most one, and every result within the file/snippet/token caps.

Every implementation, deletion, held-out, performance, package, CI, and review result remains pending. The active contract forbids a facade or V1/V2 fallback, repository-specific tuning, global top-k inflation, another planner/recovery/confidence/session/mode, a second internal query or model call, invented graph relationships, and new dependencies. Passing this phase will prove the narrow query; it will not prove agent behavior, comparator advantage, external demand, or release readiness.

After Evidence-path query, the remaining dependency order is:

1. Thin MCP, CLI, Claude Code, and Codex delivery.
2. Move evaluation tooling outside runtime and reduce the npm package.
3. Publish a beta under npm tag `next` for external validation.

Every replacement issue has an exact deletion contract. New and old implementations may coexist only temporarily on the reset integration branch; the old path cannot survive the phase.

## Validation — release decision

The stable release depends on two separate evidence tracks:

### Capability

- Compare native Claude/Codex search, Graphify, and Madar on frozen held-out TypeScript repositories.
- Require correctness no worse than the best comparator.
- Require material provider-input and end-to-end latency improvement.
- Count graph generation and refresh cost separately and report amortized break-even.
- Reject repository-specific production tuning.

### Activation and retention

- Interview 15 qualified users and recruit five real design partners.
- Observe natural installation and tool invocation rather than forcing Madar use.
- Measure time to first useful result, broad-search restart, voluntary reuse, and paid intent.
- Treat downloads, stars, registry listings, and graph generations as distribution signals, not retention evidence.

If the narrow reset cannot beat native search or produce voluntary repeat use, the decision is to pivot or stop—not add more surfaces.

## Later — only after validation

These are deliberately outside the reset:

- additional languages and non-code ingestion;
- more agent-specific installers;
- hosted dashboards or enterprise administration;
- federation, Neo4j, time travel, and broader graph exports;
- general implementation, PR-review, and security products;
- a cloud control plane.

A deferred capability returns to the roadmap only after at least three independent target users request it and the change fits the accepted product job and architecture.

## Existing tracked issues

| Issue | Accepted reset disposition |
| --- | --- |
| [#565](https://github.com/mohanagy/madar/issues/565) | Retain as the real acceptance failure; treat its Go prefix as diagnostic/unsupported and keep supported-scope plus later Claude/Codex/human validation open |
| [#574](https://github.com/mohanagy/madar/issues/574) | Superseded by the generic, scope-correct replacement in [#596](https://github.com/mohanagy/madar/issues/596), not another patch |
| [#567](https://github.com/mohanagy/madar/issues/567) | Fold into thin Codex delivery and keep as a beta activation blocker |
| [#571](https://github.com/mohanagy/madar/issues/571) | Closed as obsolete by the extraction-mode deletion in #588 and PR #590 |

The remaining issues' milestone, project, and closure state changes only through the dependency-ordered phase that owns each issue.

## Contribution and drift rules

- Start from an accepted RFC requirement and one ready issue.
- Keep at most one technical phase in progress, and activate it only after its implementation issue is accepted and the owner explicitly approves activation.
- State the user outcome, removal-manifest IDs, dependency, exit gate, and non-goals.
- Record production LOC added and removed.
- Do not add a permanent fallback, parallel engine, repository-specific rule, or runtime dependency on evaluation tooling.
- Do not close an issue merely because code merged; deletion and evidence gates must pass.
- Resolve every required CI check and review thread before merge. If review automation is unavailable or rate-limited, record explicit owner approval and a completed independent review instead of representing the automation as passed.
- Amend #577 before implementing any scope expansion.

The roadmap is a decision system, not a feature list or release-date promise.
