# SPI default-readiness criteria + legacy-extractor fallback plan

> **Tracking issue:** [#134](https://github.com/mohanagy/madar/issues/134).
> **Status:** superseded by the accepted Core Reset ([#577](https://github.com/mohanagy/madar/issues/577), [#588](https://github.com/mohanagy/madar/issues/588)). Everything below is preserved as historical context for the removed extraction architectures and commands; it is not current usage guidance.

## What this document is

A concrete, measurable contract that originally described when `madar generate --spi` could graduate to a **pure** default pipeline, and what fallback escape hatch would remain after that flip.

This is not the contract for capability-aware auto mode. Auto mode combines SPI metadata with mature legacy semantics for supported JS/TS and keeps legacy fallback for languages SPI does not support, so it does not claim that SPI has reached universal language parity.

## Current mode contract

`madar generate <path>` now defaults to **auto**:

- SPI extracts supported `.ts`, `.tsx`, `.js`, and `.jsx` files, including its framework-aware metadata; auto mode retains the legacy relationships for those files as semantic augmentation.
- The legacy extractor handles every other supported language and non-code artifact in the same graph.
- `madar generate <path> --legacy` is strict legacy-only extraction.
- `madar generate <path> --spi` is strict SPI code extraction; it intentionally omits legacy semantic augmentation and does not fall back to legacy languages, while eligible non-code evidence remains included.

The selected mode is stored in the generation policy, so automatic refresh preserves an explicit `--legacy` or `--spi` choice and preserves the auto partition for normal generation.

The rest of this document is retained as the historical gate for a future **pure SPI** default that would eliminate the language fallback. It is not a claim that the current auto mode passed every pure-SPI benchmark criterion.

## Historical state (v0.19 reference)

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

## Historical pure-SPI fallback proposal (not implemented)

If Madar ever adopts a pure SPI default, this older proposal must be revisited. The current supported escape hatches are `--legacy` and strict `--spi`; there is no `--no-spi` command today.

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
