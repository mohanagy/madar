# Public roadmap

Madar is executing an accepted Core Reset. The roadmap is outcome-driven: work advances only when its predecessor is complete and its technical or business exit gate has evidence.

## Sources of truth

- [Core Reset RFC #577](https://github.com/mohanagy/madar/issues/577) — discussion, acceptance, and weekly checkpoints
- [`v0.40.0 — Core Reset` milestone](https://github.com/mohanagy/madar/milestone/7) — release-blocking work
- [Madar Roadmap project](https://github.com/users/mohanagy/projects/8) — execution status and dependencies
- [Versioned design](designs/2026-07-19-core-reset.md) — normative product and architecture contract after acceptance
- [Removal manifest](core-reset/removal-manifest.yml) — keep, rebuild, move, delete, and defer decisions
- [Scorecard](core-reset/scorecard.md) — technical and business evidence gates

The RFC is **accepted**. Scope and baseline has passed with a [committed evidence receipt](core-reset/evidence/baseline-v0.32.0.json), Directed multigraph passed through [#582](https://github.com/mohanagy/madar/issues/582) and [PR #583](https://github.com/mohanagy/madar/pull/583), and the Canonical TypeScript/JavaScript index passed through [#585](https://github.com/mohanagy/madar/issues/585) and [PR #586](https://github.com/mohanagy/madar/pull/586). The combined deletion of legacy extraction and non-code/other-language ingestion is the single In progress phase through [#588](https://github.com/mohanagy/madar/issues/588); every later replacement phase remains blocked.

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

## In progress — delete legacy extraction and non-code/other-language ingestion

[#588](https://github.com/mohanagy/madar/issues/588) is one accepted deletion work item covering both `legacy-extraction` and `non-code-and-other-language-ingest`. The latter remains a distinct manifest ownership ID but is absorbed by the single active phase because current unsupported and non-code routes depend on the same legacy companion path.

The protected base is `9a762d0a4e10a0ae210ba3f53bb1d4468367e81e`: 170 production TypeScript files / 91,539 LOC. The accepted contract deletes at least 31 production files and 20,951 LOC, removes three runtime dependencies and five extraction flags, adds at most one production file / 900 LOC, and finishes at net `-20,000` LOC or lower. Four guaranteed extraction orphans transfer into this phase so no compatibility adapter survives. Incremental refresh remains blocked until both deletion IDs are complete and the old engine cannot be reached from production.

## Next — dependency-ordered replacement

Only one technical phase may be active at a time. After the combined deletion passes, the remaining order is:

1. Full-rebuild-equivalent incremental refresh.
2. Generic evidence-path retrieval and deletion of the context/governance stack.
3. Thin MCP, CLI, Claude Code, and Codex delivery.
4. Move evaluation tooling outside runtime and reduce the npm package.
5. Publish a beta under npm tag `next` for external validation.

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

## Existing open issues

| Issue | Accepted reset disposition |
| --- | --- |
| [#565](https://github.com/mohanagy/madar/issues/565) | Retain as a real acceptance failure and held-out retrieval input |
| [#574](https://github.com/mohanagy/madar/issues/574) | Do not implement as another patch; absorb its outcome into generic retrieval replacement |
| [#567](https://github.com/mohanagy/madar/issues/567) | Fold into thin Codex delivery and keep as a beta activation blocker |
| [#571](https://github.com/mohanagy/madar/issues/571) | Supersede if the accepted reset removes extraction modes |

Their milestone, project, and closure state changes only through the dependency-ordered phase that owns each issue.

## Contribution and drift rules

- Start from an accepted RFC requirement and one ready issue.
- Keep one technical phase in progress.
- State the user outcome, removal-manifest IDs, dependency, exit gate, and non-goals.
- Record production LOC added and removed.
- Do not add a permanent fallback, parallel engine, repository-specific rule, or runtime dependency on evaluation tooling.
- Do not close an issue merely because code merged; deletion and evidence gates must pass.
- Resolve every required CI check and review thread before merge. If review automation is unavailable or rate-limited, record explicit owner approval and a completed independent review instead of representing the automation as passed.
- Amend #577 before implementing any scope expansion.

The roadmap is a decision system, not a feature list or release-date promise.
