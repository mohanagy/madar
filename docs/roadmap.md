# Public roadmap

Updated 5 September 2026. The active roadmap is [#740](https://github.com/mohanagy/madar/issues/740). Historical version buckets are retained below for reference; they are not the current work queue or release promises.

## Current product decision

Madar should help coding agents understand relevant TypeScript/Node behavior and complete correct changes with less total work. We have not established a repeatable advantage over Native exploration or relevant existing tools. Local graph correctness, compact context and fewer ordinary shell calls are useful measurements, but cannot substitute for final-answer correctness and complete-task cost.

The accepted [#736 result](https://github.com/mohanagy/madar/issues/736#issuecomment-5516711380) remains a failed prototype qualification: two of six read-only investigations met its combined evidence, planning and benefit conditions. It was not a 33% coding-success rate. The six exposed tasks remain diagnostic history, not fresh holdouts. Existing package behavior remains available; this roadmap does not authorize a new architecture, package release, or promotion of unreleased changes.

## Work queue

| Work | Status | Purpose |
|---|---|---|
| [#740 roadmap and workspace reconciliation](https://github.com/mohanagy/madar/issues/740) | Coordination | Keep documentation, GitHub and retained work consistent with the actual decisions. |
| [#741 prospective evidence-use contract](https://github.com/mohanagy/madar/issues/741) | Next product-decision work | Define one fixed-evidence handoff experiment, comparison arms, independent scoring, numeric limits and a finite budget before implementation or execution. |
| [#710 test timing and worker lifecycle](https://github.com/mohanagy/madar/issues/710) | Independent maintenance | Make required execution trustworthy; distinguish deterministic timing from worker-start failures. |
| [#697 workspace Git process policy](https://github.com/mohanagy/madar/issues/697) | Independent maintenance | Bound discovery while preserving distinct timeout, command failure and non-repository outcomes. |
| [#739 namespace bracket calls](https://github.com/mohanagy/madar/issues/739) | Blocked; mechanism stopped | Preserve the defect and rejected candidates. A new mechanism decision and corrected control specification are required before another author run. |

These are not a mandatory sequential chain. #710 and #697 do not block preparation of #741. #739 is not required for testing evidence use with an unchanged provider. Dependency PRs remain separate maintenance, requiring their own review and CI evidence.

## What the code review changes

- Retain exact source references, explicit uncertainty, bounded selection, local indexing and existing TypeScript compiler-backed components.
- Default-auto currently retains legacy relations with supplemental SPI metadata. A switch to SPI-owned topology is a separate compatibility decision, not a consequence of a local fixture passing.
- The #736 Language Service navigator remains a frozen prototype. Its session-freshness boundary needs attention before editable-workspace production use.
- Existing context-pack recovery measures retrieval state; it does not inspect the consuming agent's final plan. Evidence can be returned successfully and still be omitted or misused.
- Keep #739's heritage traversal regression, invalid decorator positive and incomplete validation distinct. Neither candidate is accepted for integration.

The pinned source references and complete dispositions are recorded in [#740](https://github.com/mohanagy/madar/issues/740). The revisited code supports investigating the handoff between evidence and decisions; it does not establish that the proposed handoff will succeed.

## How future evidence will be judged

Report tool/source correctness, final-answer/plan correctness, and whole-task benefit separately. Patch/test success applies only to experiments that actually implement and verify patches. Count all ordinary and MCP operations, startup/index/refresh work, elapsed time, tokens/cache and monetary cost. Report per-task outliers as well as aggregates; call reduction cannot conceal a severe time or cost regression.

Before accessing fresh held-out tasks, freeze expected behaviors, semantic equivalents, evaluator controls, compared tools and model settings, execution-validity rules, numeric quality/cost/latency limits, and a finite run budget. The completed #736 verdict is not rescored. [#741](https://github.com/mohanagy/madar/issues/741) owns the prospective contract, without authorizing an experiment or product implementation.

Relevant mechanisms come from [CodePlan](https://www.microsoft.com/en-us/research/publication/codeplan-repository-level-coding-using-llms-and-planning-2/), [RepoGraph](https://arxiv.org/html/2410.14684v2), [SWE-agent](https://arxiv.org/html/2405.15793v3), [Agentless](https://arxiv.org/html/2407.01489v2), and [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/). These papers support testable hypotheses, not guaranteed recovery.

## Boundaries and history

The lead coordinates planning, documentation, issue state and cleanup. Codex CLI owns separately scoped production implementation and tests. No author, benchmark, merge or release starts automatically from this roadmap.

[#734](https://github.com/mohanagy/madar/issues/734), [#735](https://github.com/mohanagy/madar/issues/735), [#736](https://github.com/mohanagy/madar/issues/736), and [#738](https://github.com/mohanagy/madar/issues/738) retain their closed dispositions. Closure may record rejection or a completed investigation, rather than a shipped fix. Broad ranker rewrites, language expansion, hosted services, new general-memory work and release promises remain deferred.

## Historical roadmap archive

The following is the previous contributor roadmap, preserved verbatim for links and context. Its future-tense statements and version headings describe historical planning only. Use the current queue above to select work.

<details>
<summary>Previous roadmap through the v0.26–v0.30 planning buckets</summary>

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

- [#474 — Create a proof-first launch checklist for releases and benchmark milestones](https://github.com/mohanagy/madar/issues/474) so release/distribution work has a **launch checklist**, explicit channel tracking, and benchmark-backed launch drafts before broader promotion.
- [#472 — Create a design-partner feedback loop with reproducible receipts](https://github.com/mohanagy/madar/issues/472) so **design-partner reports**, a public 10-slot tracker, and tagged follow-up issues live in one share-safe program.
- Follow the first **design-partner workflow loops** bundle with stronger partner-approved receipts once the repo can replace some **anonymized workflow notes** with repeated public outcomes.
- Refresh contributor-facing docs, examples, and onboarding after the v0.26-v0.29 work is stable.
- Keep the near-term roadmap centered on runtime trust, answer quality, framework depth, and MCP/session efficiency before expanding into broader polish work.

## Parked / not near-term

- Python extraction now covers conservative FastAPI router composition/dependency semantics and first-pass Django URL-conf mapping, but broader language-parity work still stays outside the near-term roadmap.
- Go first-pass support already shipped in [#234](https://github.com/mohanagy/madar/issues/234), so near-term work stays focused on TypeScript/Node depth instead of starting a new language track.
- [#430 — Evaluate hosted dashboard for share-safe artifacts](https://github.com/mohanagy/madar/issues/430) stays parked until there is **explicit customer demand** beyond the current **local html report** path (`graph.html`, `GRAPH_REPORT.md`, `report.share-safe.json`). Any revisit must stay share-safe and keep the no-cloud-indexing assumption explicit.
- [#432 — Explore plugin and distribution channels for agent ecosystems](https://github.com/mohanagy/madar/issues/432) stays parked until **proof/onboarding readiness** is stronger than the current shipped installer set. Near-term work should deepen current distribution channels first, keep the official MCP Registry publication flow bounded to the current local-first runtime, treat broader **MCP directories** and listing pages as later leverage, and avoid heavy marketplace work before adoption proof exists.
- [#431 — Decide language expansion after TypeScript/Node proof strengthens](https://github.com/mohanagy/madar/issues/431) keeps broader **language expansion** behind explicit **evidence gates**: stronger **TypeScript/Node proof**, language-specific benchmark or fixture evidence, and **no broad parity claim** before those receipts exist.

## Where to start

Start with the open `priority:p0` and `priority:p1` issues first. Before starting work, check the issue for active discussion, confirm there is no open PR already covering it, and keep your branch scoped to a single issue.

</details>
