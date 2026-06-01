# Public roadmap

This page is the contributor-facing roadmap for `madar`. It is the current source of truth for post-rename roadmap work, and it intentionally separates **recently shipped** work from the **future roadmap** so contributors do not have to know the rename history to understand what is current.

## How to read the roadmap

- Version headings are planning buckets, not hard release promises.
- `priority:*` tells you how urgent the work is.
- `area:*` points at the subsystem, such as `area:retrieval`, `area:context-pack`, or `area:docs`.
- `type:*` explains the work shape, such as `type:feature`, `type:benchmark`, or `type:docs`.
- `help wanted` means the issue is open for contributors.
- `good first issue` marks smaller, lower-risk tasks that are better entry points for new contributors.

## Recently shipped

These items already landed and are no longer part of the future roadmap:

- [#257 — Improve runtime-generation quality by selecting the semantic generation core](https://github.com/mohanagy/madar/issues/257)
- [#259 — Add runtime-generation false-positive routing regressions](https://github.com/mohanagy/madar/issues/259)
- [#258 — Add v0.25.1 runtime-routing validation benchmark artifact](https://github.com/mohanagy/madar/issues/258)
- [#245 — Plan and validate Madar rebrand migration](https://github.com/mohanagy/madar/issues/245)
- [#236 — Add typestack/routing-controllers framework detector](https://github.com/mohanagy/madar/issues/236)
- [#233 — Add answer-quality scoring to benchmark suite summaries](https://github.com/mohanagy/madar/issues/233)
- [#425 — Run design-partner workflow loops and publish anonymized evidence](https://github.com/mohanagy/madar/issues/425) added **design-partner workflow loops** as **anonymized workflow notes** and synthetic reproductions under `docs/benchmarks/2026-06-01-design-partner-workflow-loops/`.
- [#429 — Make federation a flagship multi-repo enterprise workflow](https://github.com/mohanagy/madar/issues/429) added a **synthetic federation receipt** for a **frontend/backend/shared** fixture so the flagship multi-repo enterprise workflow is reproducible without pretending it is already a broad benchmark.

## v0.26 — Runtime trust and routing precision

Focus: make runtime-generation output easier to trust, audit, and debug before adding broader expansion work.

- [#260 — Add execution_slice confidence scoring and confidence reasons](https://github.com/mohanagy/madar/issues/260)
- [#261 — Expand runtime phase taxonomy beyond controller/service/queue/worker/persistence](https://github.com/mohanagy/madar/issues/261)
- [#263 — Add explain-routing output for pack and compare](https://github.com/mohanagy/madar/issues/263)

## v0.27 — Benchmark credibility, docs honesty, and answer quality

Focus: make benchmark claims safer, keep public docs honest, and make runtime-generation answers easier to compare against an explicit contract.

- [#262 — Add context-pack answer contract for runtime-generation prompts](https://github.com/mohanagy/madar/issues/262)
- [#331 — Align README, package metadata, CHANGELOG and docs with demonstrated behavior](https://github.com/mohanagy/madar/issues/331)
- [#332 — Build the reproducible benchmark suite with per-repo spread](https://github.com/mohanagy/madar/issues/332)
- Build on the shipped validation artifact from [#258](https://github.com/mohanagy/madar/issues/258) instead of treating benchmark credibility as a greenfield problem again.
- Keep docs honesty ahead of benchmark ambition: no single-number cross-repo headline until the suite exists.

## v0.28 — TypeScript/Node framework depth

Focus: deepen TypeScript and Node.js framework coverage now that the basic routing and runtime-generation path is in place.

- Use the shipped framework groundwork from [#236](https://github.com/mohanagy/madar/issues/236) as the baseline.
- Favor real framework/runtime semantics over broad language expansion.
- Cut new framework-depth issues after the v0.26-v0.27 trust and quality work lands.

## v0.29 — MCP/session efficiency

Focus: reduce repeated work across packs, compares, and longer agent sessions once the runtime trust surface is stable.

- Build on the shipped MCP efficiency foundation from [#159](https://github.com/mohanagy/madar/issues/159), [#161](https://github.com/mohanagy/madar/issues/161), and [#162](https://github.com/mohanagy/madar/issues/162).
- Scope new work around duplicate suppression, trace clarity, and session-aware retrieval once current routing/answer work settles.

## v0.30 — Adoption and contributor experience

Focus: make Madar easier to adopt, evaluate, and contribute to after the runtime and benchmark surfaces stop moving quickly.

- Follow the first **design-partner workflow loops** bundle with stronger partner-approved receipts once the repo can replace some **anonymized workflow notes** with repeated public outcomes.
- Refresh contributor-facing docs, examples, and onboarding after the v0.26-v0.29 work is stable.
- Keep the near-term roadmap centered on runtime trust, answer quality, framework depth, and MCP/session efficiency before expanding into broader polish work.

## Parked / not near-term

- Python extraction now covers conservative FastAPI router composition/dependency semantics and first-pass Django URL-conf mapping, but broader language-parity work still stays outside the near-term roadmap.
- Go first-pass support already shipped in [#234](https://github.com/mohanagy/madar/issues/234), so near-term work stays focused on TypeScript/Node depth instead of starting a new language track.
- [#430 — Evaluate hosted dashboard for share-safe artifacts](https://github.com/mohanagy/madar/issues/430) stays parked until there is **explicit customer demand** beyond the current **local html report** path (`graph.html`, `GRAPH_REPORT.md`, `report.share-safe.json`). Any revisit must stay share-safe and keep the no-cloud-indexing assumption explicit.
- [#432 — Explore plugin and distribution channels for agent ecosystems](https://github.com/mohanagy/madar/issues/432) stays parked until **proof/onboarding readiness** is stronger than the current shipped installer set. Near-term work should deepen current distribution channels first, keep the existing MCP Registry metadata bounded to the current local-first flow, treat broader **MCP directories** and listing pages as later leverage, and avoid heavy marketplace work before adoption proof exists.
- [#431 — Decide language expansion after TypeScript/Node proof strengthens](https://github.com/mohanagy/madar/issues/431) keeps broader **language expansion** behind explicit **evidence gates**: stronger **TypeScript/Node proof**, language-specific benchmark or fixture evidence, and **no broad parity claim** before those receipts exist.

## Where to start

Start with the open `priority:p0` and `priority:p1` issues first. Before starting work, check the issue for active discussion, confirm there is no open PR already covering it, and keep your branch scoped to a single issue.
