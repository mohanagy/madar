# SPI default-readiness criteria + legacy-extractor fallback plan

> **Tracking issue:** [#134](https://github.com/mohanagy/madar/issues/134).
> **Status:** decision framework — codified, not yet acted on.

## What this document is

A concrete, measurable contract for when `madar generate --spi` graduates from an opt-in flag (today's state, v0.18+) to the default pipeline, and what fallback escape hatch remains after the flip.

This is **not** a code change. It's the criteria the next code change (the default flip itself) has to meet.

## Current state (v0.19 reference)

- `madar generate <path>` uses the legacy `extract()` pipeline.
- `madar generate <path> --spi` opts into the SPI pipeline.
- Benchmark on the bundled `2026-05-11-spi-vs-legacy/fixture`:

| Metric | Legacy | `--spi` | Δ |
|---|---|---|---|
| Build time (cold) | 506 ms | 710 ms | +40% (cost) |
| Build time (cache-hit) | n/a | 368 ms | −27% vs legacy |
| `graph.json` size | 62.8 KB | 42.8 KB | −32% |
| Total pack tokens (7 prompts) | 1284 | 946 | −26% |

The 40% cold-build cost is the headline risk. The cache-hit recovery + token reduction is the headline payoff.

## Graduation criteria (must ALL be met to flip default)

### 1. Build-time parity within 1.5x on representative repos

- **SPI cold build must be ≤ 1.5× legacy cold build** on at least 3 representative repos: a single TS package (≤100 files), a NestJS backend (≥500 files), a TS monorepo (≥2k files).
- **SPI cache-hit must be ≥ 2× faster than legacy `extract()`** on unchanged workspaces of the same 3 repos.
- Measurements committed as benchmark artifacts under `docs/benchmarks/<date>-spi-readiness/`.

### 2. Compatibility — no regression in downstream pipelines

For each existing command, run against the same input with and without `--spi` and verify behaviour:

- [ ] `generate` — produces a graph.json buildFromJson can consume
- [ ] `generate --update` — incremental rebuild still works (with SPI cache as the equivalent fast path)
- [ ] `pack --task explain` — same or better diagnostic quality_score on a fixed prompt set
- [ ] `pack --task review` — pr_impact path unaffected
- [ ] `pack --task impact` — impact target resolution unchanged
- [ ] `prompt` — `stable_prefix_hash` is consistent across re-runs
- [ ] `pr_impact` — `coverage_score_weighted` + severity tiers match between pipelines
- [ ] `compare` and `review-compare` — provider token deltas unchanged
- [ ] MCP `retrieve` / `context_pack` / `pr_impact` — same response shape

A FAILED checkbox in this list blocks the flip until the regression is documented or fixed.

### 3. Project-shape coverage

Verified on at least these project shapes:

- [ ] Single TS package (e.g., utility library)
- [ ] NestJS backend (controllers, modules, providers, decorators)
- [ ] Next.js frontend (app router + pages router mixed)
- [ ] TS monorepo (workspaces or pnpm)
- [ ] Mixed-content workspace (TS code + markdown docs + JSON config + Python sidecars)
- [ ] Workspace with type-only imports / `declare module` ambient modules

Each shape gets a documented run in the benchmark dir.

### 4. Retrieval quality on framework-shaped queries

Using the existing #130 fixture or an expanded version:

- **Median pack tokens with `--spi` ≤ legacy median** across framework-shaped prompts.
- **Top-3 matched_nodes accuracy** — for known-answer prompts ("show me the Express route for GET /api/users"), the top-3 must contain the correct symbol in ≥ 80% of cases with `--spi`. Legacy baseline measured first.

### 5. Diagnostics surface parity

- `context_pack` `diagnostics.quality_score` distribution across the benchmark prompts is **equal or better** under `--spi` than legacy.
- No new `error`-severity warnings (`missing_required_evidence`) introduced.

## Fallback plan after the flip

When the default flips, **legacy `extract()` remains accessible via `--no-spi`** (or `--legacy-extract`) for one release minimum. Specifically:

1. **Same release as the flip**: `--spi` becomes default. `--no-spi` opts out. CLI help text shows both. Release notes mention the flip explicitly and link this doc.
2. **One release after the flip**: `--no-spi` still works. If any users have filed issues citing SPI-specific regressions, they're tagged on a `spi-default-retro` milestone.
3. **Two releases after the flip**: If `spi-default-retro` is empty (no open SPI-specific bug reports), `--no-spi` is announced as deprecated with a 1-release deprecation window.
4. **Three releases after the flip**: `--no-spi` is removed. The legacy `extract()` code remains in the source tree as the SPI projector's fall-back when SPI build fails, but is no longer reachable from the CLI.

If `spi-default-retro` has open issues after release N+1, the deprecation window pauses until they close.

## Out of scope for this decision

- **Whether to ship a v0.21 release that flips the default.** That's the implementation, gated on this checklist. This doc is the gate, not the trigger.
- **What `--spi` behavior to add beyond what v0.19 / v0.20 ship.** This doc grades the existing surface; new SPI features are evaluated when proposed.
- **What to do with the legacy `extract()` code long-term.** Removing it is a separate decision tracked on a separate issue when the time comes.

## Decision log

| Date | Author | Note |
|---|---|---|
| 2026-05-11 | `claude` | Initial draft as part of v0.20 bundle. Criteria proposed, not yet validated against real repos. |
