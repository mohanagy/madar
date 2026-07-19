# Madar Core Reset

> **Tracking issue:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Project:** [Madar Roadmap](https://github.com/users/mohanagy/projects/8)
> **Status:** accepted — scope and baseline is the only authorized phase

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
Workspace scanner
      |
TypeScript Program indexer + framework adapters
      |
Directed typed multigraph + incremental store
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
    mcp/
    cli/
```

Dependency direction is `adapters -> application -> domain`. Domain code must not import the filesystem, MCP, CLI, TypeScript compiler, or evaluation tooling.

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
- Graph schema changes require users to regenerate artifacts.
- Compatibility is provided through release notes and a migration table, not permanent adapters.
- Betas publish only under npm tag `next`.
- `0.40.0` publishes as `latest` only after every release gate passes.

## Dependency order

1. Freeze scope and record the current baseline.
2. Establish held-out graph and answer fixtures.
3. Replace the graph with a directed multigraph schema.
4. Make the TypeScript Program index canonical and delete legacy extraction.
5. Implement correct incremental add/change/delete/rename behavior.
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
- incremental output equivalent to a clean rebuild;
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

The repository owner accepted this RFC on 2026-07-19 in [#577](https://github.com/mohanagy/madar/issues/577) after the governance review passed. Merging the governing documentation PR makes this contract authoritative and authorizes only the scope-and-baseline phase. Acceptance does not waive any later phase gate.

## Decision log

| Date | Status | Decision |
| --- | --- | --- |
| 2026-07-19 | Proposed | Opened #577 and created the deletion-led product, architecture, validation, and change-control contract. |
| 2026-07-19 | Accepted | The repository owner approved the complete checklist; scope and baseline may begin after the governing documentation PR merges. |
