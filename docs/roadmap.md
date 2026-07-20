# Public roadmap

Madar is executing an accepted Core Reset. The roadmap is outcome-driven: work advances only when its predecessor is complete and its technical or business exit gate has evidence.

## Sources of truth

- [Core Reset RFC #577](https://github.com/mohanagy/madar/issues/577) — discussion, acceptance, and weekly checkpoints
- [`v0.40.0 — Core Reset` milestone](https://github.com/mohanagy/madar/milestone/7) — release-blocking work
- [Madar Roadmap project](https://github.com/users/mohanagy/projects/8) — execution status and dependencies
- [Versioned design](designs/2026-07-19-core-reset.md) — normative product and architecture contract after acceptance
- [Removal manifest](core-reset/removal-manifest.yml) — keep, rebuild, move, delete, and defer decisions
- [Scorecard](core-reset/scorecard.md) — technical and business evidence gates

The RFC is **accepted**. Scope and baseline has passed with a [committed evidence receipt](core-reset/evidence/baseline-v0.32.0.json). Directed multigraph is the only **In progress** phase and is still under merge verification. Canonical TypeScript/JavaScript index and every later replacement phase remain blocked until that PR merges with green checks and resolved review threads.

## In progress — directed multigraph

The `directed-multigraph` removal-manifest entry delivered:

1. Preserve multiple typed edges between the same ordered node pair.
2. Give nodes and edges deterministic IDs and preserve direction and provenance through serialization.
3. Replace the owned graph path under the accepted destination rather than creating a permanent V1/V2 split.
4. Delete the predecessor graph path when the phase gate passes, with net-negative production LOC.

The five predecessor files and obsolete exporter surfaces are absent on the working branch. Current measurements are 178 production TypeScript files / 93,832 LOC with a `+1,193 / -4,127 / net -2,934` source delta and no dependency additions. Final CI and review gates are still open; the frozen baseline receipt remains unchanged.

## Blocked — canonical TypeScript/JavaScript index

After the Directed multigraph PR merges, the next authorized work item is limited to the `canonical-typescript-index` removal-manifest entry. It must write canonical graph facts directly, satisfy the labelled language/framework fixtures, and make legacy augmentation removable. Until then, canonical indexing, incremental refresh, retrieval replacement, and delivery remain blocked.

## Next — dependency-ordered replacement

Only one technical phase may be active at a time. After Directed multigraph merges and passes, the remaining order is:

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
- Resolve every required CI check and review thread before merge.
- Amend #577 before implementing any scope expansion.

The roadmap is a decision system, not a feature list or release-date promise.
