# Public roadmap

Madar is executing an accepted Core Reset. The roadmap is outcome-driven: work advances only when its predecessor is complete and its technical or business exit gate has evidence.

## Sources of truth

- [Core Reset RFC #577](https://github.com/mohanagy/madar/issues/577) — discussion, acceptance, and weekly checkpoints
- [`v0.40.0 — Core Reset` milestone](https://github.com/mohanagy/madar/milestone/7) — release-blocking work
- [Madar Roadmap project](https://github.com/users/mohanagy/projects/8) — execution status and dependencies
- [Versioned design](designs/2026-07-19-core-reset.md) — normative product and architecture contract after acceptance
- [Removal manifest](core-reset/removal-manifest.yml) — keep, rebuild, move, delete, and defer decisions
- [Scorecard](core-reset/scorecard.md) — technical and business evidence gates

The RFC is **accepted**. Scope and baseline, Directed multigraph, Canonical TypeScript/JavaScript index, the combined legacy/non-code deletion, and Generation and reconciliation have passed. The latest phase completed through [#592](https://github.com/mohanagy/madar/issues/592) and merged [PR #594](https://github.com/mohanagy/madar/pull/594). No phase is In progress; Evidence-path query is Ready but not active.

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

The owner accepted the exact contract in [#592](https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506) and amended [RFC #577](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586). The completed phase shipped cold no-op plus full canonical reconciliation; Evidence-path query is now Ready but not active, while thin delivery remains blocked.

The phase removed 15 predecessor files / 3,839 LOC, transferred three mixed query files to `evidence-path-query` and `doctor.ts` to `thin-delivery`, and added the six permitted replacements. It finished net `-2,536` LOC at 130 production files / 66,418 LOC, added no runtime or development dependency, and reduced the npm package to 276 files / 2,699,851 unpacked bytes without increasing packed bytes.

The fixed 500-file performance gate stopped the proposed incremental path. Candidate checkpoint `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d` at worktree tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda` measured warm index p50 ratio `0.824`, refresh p50 `1.047`, and refresh p95 `1.029`, missing all three required ratios. These sealed receipt values supersede the provisional ratios posted earlier in #592/#577. Held-out timing was intentionally skipped because it could not reverse the mandatory fixed-gate stop. The failed Program/fact/closure path was deleted.

The shipping architecture is cold no-op plus one full canonical reconcile for every changed source state. It has no in-memory or disk session cache. `graph.json` is the sole authoritative artifact and commits last; diagnostic sidecars are derived/non-blocking. Clean-equivalent add/change/delete/rename/control/ignore/recognized-unsupported-file/symlink/worktree behavior, zero stale facts, and publication fault/concurrency safety passed. Only successful `.ts/.tsx/.js/.jsx` indexing determines completeness; supported failures are incomplete, unsupported files are informational, and safety exclusions remain separate.

Exact runtime commit `1be24dc45a5f07c352c74fc374feb95a9440df8e` records all 15 predecessors absent and all six replacements present. The [inventory receipt](core-reset/evidence/generation-incremental-inventory.json) measures 130 production TypeScript files / 66,418 LOC with `+2,190 / -4,726 / net -2,536`, and an npm dry-run of 276 files / 572,143 packed bytes / 2,699,851 unpacked bytes. The compatible [shipping receipt](core-reset/evidence/generation-full-reconcile-500.json) passes cold no-op at `0.067` of clean generation with zero parse/invalidation/publication and clean regression at `1.045`. The [hermetic mutation-equivalence receipt](core-reset/evidence/generation-mutation-equivalence.json) records 5 focused files / 92 passing tests across clean equivalence, zero-stale-fact, publication-failure, worktree, and concurrency cases. The [failed-gate receipt](core-reset/evidence/generation-incremental-stop-500.json) and [protected-base receipt](core-reset/evidence/generation-incremental-protected-base-500.json) preserve why the incremental path was deleted.

[PR #594](https://github.com/mohanagy/madar/pull/594) was squash-merged at `b56966c06c0ae1b04c252f297036f332fa1b384c` from final head `3f40c5b64cdd63054c52ed67588b782034f8b935`. All six jobs in [CI run 29942216697](https://github.com/mohanagy/madar/actions/runs/29942216697) passed, including 156 files / 1,885 tests passed with 2 skipped under coverage. Three independent P0/P1 audits found no blocker and zero review threads remained. CodeRabbit explicitly skipped the non-default base; the owner-approved exception is documented in the [exact-head review receipt](https://github.com/mohanagy/madar/pull/594#issuecomment-5049404550) without claiming a completed CodeRabbit review.

## Ready — evidence-path query

No phase is In progress. `evidence-path-query` is Ready, but work cannot start until a separately accepted issue freezes its deletion boundary, held-out correctness and one-call completeness gates, production LOC budget, non-goals, and explicit owner activation. Existing #565 and #574 are inputs to that contract, not implementation authorization.

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
| [#565](https://github.com/mohanagy/madar/issues/565) | Retain as a real acceptance failure and held-out retrieval input |
| [#574](https://github.com/mohanagy/madar/issues/574) | Do not implement as another patch; absorb its outcome into generic retrieval replacement |
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
