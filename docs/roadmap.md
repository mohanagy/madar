# Public roadmap

This page is the contributor-facing view of the `graphify-ts` roadmap. It complements the main tracker in [issue #155](https://github.com/mohanagy/graphify-ts/issues/155): use the GitHub issue for the long-form versioned roadmap, and use this page for the current priority queue and contribution hints.

## How to read the labels

- `priority:p0` / `priority:p1` / `priority:p2` tell you how urgent the work is.
- `area:*` points at the subsystem, such as `area:mcp`, `area:retrieval`, or `area:docs`.
- `type:*` explains the work shape, such as `type:feature`, `type:benchmark`, or `type:docs`.
- `help wanted` means the issue is open for contributors.
- `good first issue` marks smaller, lower-risk tasks that are better entry points for new contributors.

## P0

Highest-priority roadmap work. These issues usually change the benchmark story or the core MCP/compare flow.

- [#160 — Add pack-only compare mode](https://github.com/mohanagy/graphify-ts/issues/160) (`priority:p0`, `type:feature`, `area:benchmarks`)
- [#159 — Add strict MCP mode to prevent agent over-exploration](https://github.com/mohanagy/graphify-ts/issues/159) (`priority:p0`, `type:feature`, `area:mcp`)
- [#158 — Add compare-suite aggregation for wins, losses, median, and regressions](https://github.com/mohanagy/graphify-ts/issues/158) (`priority:p0`, `type:feature`, `area:benchmarks`)
- [#157 — Add pack-quality gates for benchmark prompts](https://github.com/mohanagy/graphify-ts/issues/157) (`priority:p0`, `type:benchmark`, `area:benchmarks`)
- [#156 — Add GoValidate benchmark suite with realistic prompt set](https://github.com/mohanagy/graphify-ts/issues/156) (`priority:p0`, `type:benchmark`, `area:benchmarks`)

## P1

Important follow-up work for cost control, runtime slicing, benchmarks, and artifact safety.

- [#189 — Add share-safe report mode](https://github.com/mohanagy/graphify-ts/issues/189) (`priority:p1`, `type:feature`)
- [#178 — Add incremental SPI and cache benchmarks](https://github.com/mohanagy/graphify-ts/issues/178) (`priority:p1`, `type:benchmark`)
- [#177 — Add deterministic answer-quality rubric skeleton](https://github.com/mohanagy/graphify-ts/issues/177) (`priority:p1`, `type:feature`, `area:benchmarks`)
- [#176 — Add adaptive context representations](https://github.com/mohanagy/graphify-ts/issues/176) (`priority:p1`, `type:feature`, `area:retrieval`)
- [#174 — Add deterministic answer quality checks](https://github.com/mohanagy/graphify-ts/issues/174) (`priority:p1`, `type:feature`, `area:benchmarks`)
- [#173 — Add deterministic answer-quality rubric skeleton](https://github.com/mohanagy/graphify-ts/issues/173) (`priority:p1`, `type:feature`, `area:benchmarks`)
- [#172 — Add adaptive context representations by task type](https://github.com/mohanagy/graphify-ts/issues/172) (`priority:p1`, `type:feature`, `area:retrieval`)
- [#169 — Add cache-aware token accounting in compare reports](https://github.com/mohanagy/graphify-ts/issues/169) (`priority:p1`, `type:feature`, `area:benchmarks`)
- [#164 — Add execution-slice output format](https://github.com/mohanagy/graphify-ts/issues/164) (`priority:p1`, `type:feature`, `area:retrieval`)
- [#163 — Add queue/job semantic edges for runtime pipeline reconstruction](https://github.com/mohanagy/graphify-ts/issues/163) (`priority:p1`, `type:feature`, `area:spi`, `area:retrieval`)
- [#162 — Track MCP tool-call counts and trace summaries in compare reports](https://github.com/mohanagy/graphify-ts/issues/162) (`priority:p1`, `type:feature`, `area:benchmarks`, `area:mcp`)
- [#161 — Add MCP call cache and duplicate suppression](https://github.com/mohanagy/graphify-ts/issues/161) (`priority:p1`, `type:feature`, `area:mcp`)

## P2

Good next issues for docs, examples, DX, integrations, and smaller framework retrieval improvements.

- [#190 — Add public roadmap page](https://github.com/mohanagy/graphify-ts/issues/190) (`priority:p2`, `type:docs`, `area:docs`)
- [#188 — Add compact graph summary format for agents](https://github.com/mohanagy/graphify-ts/issues/188) (`priority:p2`, `type:feature`, `area:retrieval`)
- [#186 — Add end-to-end tutorial with a small sample app](https://github.com/mohanagy/graphify-ts/issues/186) (`priority:p2`, `type:docs`, `area:docs`, `good first issue`)
- [#185 — Improve database operation semantics](https://github.com/mohanagy/graphify-ts/issues/185) (`priority:p2`, `type:feature`, `area:spi`, `area:retrieval`)
- [#184 — Improve Next.js App Router and React Server Component detection](https://github.com/mohanagy/graphify-ts/issues/184) (`priority:p2`, `type:feature`, `area:spi`, `area:retrieval`)
- [#166 — Add graphify-ts doctor and status commands](https://github.com/mohanagy/graphify-ts/issues/166) (`priority:p2`, `type:feature`, `area:dx`, `good first issue`)
- [#165 — Design local project memory layer](https://github.com/mohanagy/graphify-ts/issues/165) (`priority:p2`, `type:research`, `area:memory`)

## Where to start

If you want the smallest on-ramp, start with issues tagged `good first issue` and `help wanted`. If you want the biggest near-term leverage, look at the open `priority:p0` and `priority:p1` items first. Before starting work, check the issue for active discussion, confirm there is no open PR already covering it, and keep your branch scoped to a single issue.
