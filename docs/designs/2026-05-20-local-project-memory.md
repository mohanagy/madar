# Local project memory design

> **Tracking issue:** [#165](https://github.com/mohanagy/madar/issues/165) — *Design local project memory layer.*
> **Status:** design only — no runtime implementation in this PR.

## Problem

madar compiles code evidence well, but it still loses durable repo knowledge between sessions: accepted conventions, prior investigations, known pitfalls, benchmark caveats, and architecture notes. That forces agents to rediscover the same context repeatedly and makes long-lived repo knowledge too fragile.

At the same time, memory is dangerous if it becomes a shadow source of truth. A cached note can be stale, overbroad, or wrong. The design therefore has to preserve madar's core property: code evidence remains primary, and memory can assist only in bounded, inspectable ways.

## Goals

- Preserve durable repo-local knowledge across sessions.
- Keep the editable source of truth local, plain-text, and inspectable.
- Define typed memory records rather than unstructured note dumps.
- Let memory participate in retrieval and context packs without overpowering code evidence.
- Define freshness, supersession, and privacy rules up front.

## Non-goals

- No remote sync or hosted memory service.
- No separate database as the primary source of truth.
- No user-global, cross-repository memory layer in this issue.
- No LLM summarization or semantic grading of memories in the first pass.
- No uncapped injection of memory into every pack.
- No rule that allows memory to replace missing primary code evidence.

## Source of truth

The source of truth should extend the existing local artifact path:

```text
out/memory/*.md
```

madar already writes query-result notes there via `madar save-result`. This design keeps markdown files as the canonical memory records and treats any machine-friendly index as a rebuildable derivative.

That preserves three important properties:

1. users can inspect and edit memory without hidden tooling
2. memory stays local to the repository output tree
3. the system does not need a second storage authority

## Memory record types

The first pass should support these project-scoped record types:

| Type | Purpose |
| --- | --- |
| `decision` | accepted technical decision with rationale and scope |
| `convention` | stable repo convention or workflow expectation |
| `bug` | known pitfall or previously fixed failure pattern |
| `architecture_note` | durable structural/system note |
| `investigation` | preserved result of prior debugging or research |
| `benchmark_note` | benchmark interpretation, caveat, or measurement note |
| `query` / `query_result` | existing saved Q/A artifacts, still supported |

`query_result` remains valid, but structured note types should rank above generic saved answers when both are eligible.

## Markdown schema

Each memory record should use frontmatter. Required fields:

- `type`
- `date`
- `contributor`
- `title` for note-style records, or `question` for query-style records

Optional fields:

- `summary`
- `tags`
- `source_files`
- `source_nodes`
- `confidence`
- `supersedes`
- `expires_at`
- `scope`

Example:

```md
---
type: convention
date: 2026-05-20T12:00:00.000Z
title: Prefer context_pack before raw file search
contributor: madar
tags: ["retrieval", "agent-workflow"]
source_files: ["README.md", "docs/integrations/agent-orchestration.md"]
source_nodes: ["context_pack", "retrieve"]
confidence: high
scope: repo
---

Use one bounded context pack first for broad codebase questions. Expand only
when pack diagnostics show missing evidence.
```

## Derived index

madar may build a small derived index, for example:

```text
out/memory/index.json
```

This index is not a second store. It exists only to avoid reparsing arbitrary markdown on every retrieval. It should store:

- stable memory id
- parsed type and timestamps
- normalized tags
- normalized file/node anchors
- freshness flags (`active`, `expired`, `superseded`)
- short preview text

If the index is missing or stale, madar can rebuild it from the markdown records.

## Retrieval rules

Memory retrieval should happen **after** code/graph evidence selection.

A memory item is eligible only when at least one gate passes:

1. overlap with already-selected code anchors (`source_files` or `source_nodes`)
2. lexical overlap with the prompt **after** code evidence has already been selected for the pack
3. explicit prompt intent around conventions, prior findings, benchmark caveats, known issues, or historical investigation

The ordering matters:

- madar selects code/graph evidence first
- memory ranking runs only after that first selection step
- prompt-only memory matches are allowed only when there is already selected code evidence **or** the prompt explicitly asks for repo norms/history/investigation context

That keeps memory as a second-pass enrichment layer rather than a first-pass retrieval substitute.

Memory should also follow the retrieval gate:

- when retrieval is fully skipped (`retrieval_gate.level === 0` / `skipped_retrieval === true`), memory retrieval is skipped too
- memory is not a standalone knowledge-base query path in this design
- memory only runs when the normal code/graph retrieval flow produced a packable result

Default ranking should prefer:

1. active, unsuperseded memories
2. direct anchor overlap
3. structured records over generic query results
4. recent, high-confidence notes over stale broad notes

## Context-pack participation

Memory should appear in a separate explicit section such as `memory_context`, not be mixed invisibly into ordinary node evidence.

The design implies an extension to the compiled pack contract, for example:

```ts
type MemoryContextEntry = {
  id: string
  type: string
  title?: string
  question?: string
  preview: string
  inclusion_reason: string
  source_files?: string[]
  source_nodes?: string[]
  freshness: 'active' | 'expired' | 'superseded'
}

interface CompiledContextPack {
  // existing fields...
  memory_context?: MemoryContextEntry[]
}
```

Each emitted memory entry should carry:

- memory id
- type
- title or question
- short preview
- inclusion reason (`anchor_overlap`, `convention_match`, `prior_investigation`, etc.)

Hard constraints:

- memory is **secondary evidence**
- memory cannot satisfy required primary evidence on its own
- memory cannot outrank direct code evidence
- only a small capped number of memories may be emitted per pack
- if code evidence is missing, the pack must still report that gap instead of hiding it behind memory

For budgeting, memory should not compete head-to-head with required code evidence:

- required code evidence is selected first
- memory can enter only after required evidence is satisfied
- memory uses a small fixed secondary allowance, for example `min(500 tokens, 10% of pack budget)`
- memory entries are capped numerically as well, for example `max 3` per pack

For `required_overflow` cases, “satisfied” should mean:

- every required evidence class has at least one selected node, even if the pack had to overflow to include required evidence
- if any required evidence class still has zero selected nodes, memory retrieval is skipped entirely
- memory must not create additional overflow beyond what required evidence already forced
- the memory allowance is therefore available only after the pack has met the minimum required-evidence floor

The existing evidence-class system should remain unchanged. Memory does **not** introduce a new `evidence_class`. Instead:

- memory remains outside the normal `nodes` evidence ranking surface
- `memory_context` is its own explicit secondary lane
- if an implementation later needs an evidence-class mapping for diagnostics, `supporting` is the closest fit, but memory should still remain structurally separate from ordinary code evidence

This keeps memory useful without weakening madar's “verifiable context first” contract.

## Lifecycle

### Creation

Memories may be created by:

- the existing `save-result` command
- future explicit memory authoring commands
- carefully scoped automated flows that already have durable, reviewable outputs

### Refresh

The derived index may be refreshed during:

- `generate`
- `watch`
- a future dedicated memory refresh command

### Freshness and supersession

- `supersedes` marks older records inactive
- `expires_at` suppresses time-bounded records by default
- historical retrieval can be explicit later, but default packs should ignore expired or superseded items

## Privacy model

- Memory remains local to the repository output tree.
- No remote service or sync is required.
- Project memory is distinct from transient session artifacts.
- The first design pass is repository-scoped, not user-global.
- Memory files should reference code or artifacts rather than duplicate secrets or sensitive payloads.
- Memory is plaintext and should never be treated as a secret store.

The design should require one of these protections in a follow-up implementation issue:

1. validation/warnings for obvious secret patterns during memory creation
2. explicit command-level warnings that saved memory may later appear in context packs
3. restricted automated memory writers that only persist reviewed, non-sensitive content

The minimum acceptable behavior is an explicit user-facing warning that memory artifacts are plain markdown and may be surfaced to agents during retrieval.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| memory pollution | typed schema, contributor metadata, bounded caps |
| stale guidance | expiry, supersession, freshness filtering |
| authority inversion | code evidence remains primary; explicit `memory_context` section |
| query-result spam | rank structured memory types above generic saved answers |
| slow retrieval | rebuildable derived index from markdown source |
| opaque ranking | explicit inclusion reasons on emitted memories |

## Follow-up implementation split

1. **Schema + parser**
   - define the typed frontmatter contract
   - parse memory markdown safely
2. **Derived index**
   - build and refresh `out/memory/index.json`
3. **Retrieval gating**
   - rank memory only after code evidence
   - apply freshness, anchor, and type filters
4. **Context-pack surface**
   - emit bounded `memory_context` with explicit reasons
5. **Authoring UX**
   - extend or add CLI commands for typed memory creation

## Why this fits madar

madar is already a local context compiler with explicit evidence contracts and bounded output. A markdown-backed, repo-local memory layer fits that architecture better than a hidden service or heavyweight secondary store. By keeping memory typed, inspectable, freshness-aware, and explicitly secondary to code evidence, madar can preserve durable repo knowledge without turning packs into unverifiable folklore.
