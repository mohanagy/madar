# Public roadmap

Updated 10 September 2026. This page records the focused work queue and the limits of the available evidence. The former bundled recovery program [#740](https://github.com/mohanagy/madar/issues/740) is closed as **not planned**, with its unresolved work assigned below. That closure does not mean Madar's product goal was achieved.

## Supported workflow and goal

The initial scope is source-backed context for agents tracing cross-file behavior in TypeScript/Node repositories while making a bounded code change. Madar should help the agent find relevant code, understand relationships and identify what still needs verification. Normal follow-up source reading is allowed and counts toward the work.

The goal is a correct completed task with less total work. This scope is not a claim that every TypeScript/Node task is qualified. Other capabilities remain available, but broad language expansion and competitor-superiority claims are outside this decision.

## What the evidence establishes

Keep three questions separate:

- **Source correctness:** do the returned snippets and relationships match the actual source?
- **Context usefulness:** does the context cover the task's important behavior and make missing or uncertain evidence clear?
- **Completed-task benefit:** does using Madar help the agent finish correctly with less total time or work, including follow-up reading and verification?

Passing an internal check answers only the behavior that check covers. It does not supply a universal trust percentage or prove task-level advantage.

The accepted [#736 result](https://github.com/mohanagy/madar/issues/736#issuecomment-5516711380) remains a failed prototype qualification: two of six read-only investigations met its combined evidence, planning and benefit conditions. This was not a coding-success rate or a measure of overall trust. Those exposed tasks remain diagnostic history.

Later [full-workflow](https://github.com/mohanagy/madar/issues/740#issuecomment-5592971164) and [exploratory Native comparison](https://github.com/mohanagy/madar/issues/740#issuecomment-5593201636) results did not establish a repeatable complete-task advantage. Their failures, missing measurements and original criteria remain unchanged. Madar's overall benefit is still unproved.

## Focused work queue

Each story has one outcome and its own boundary. The current work is documenting this decision through [PR #742](https://github.com/mohanagy/madar/pull/742); source implementation and evaluation runs remain paused.

| Owner | User outcome | Disposition |
|---|---|---|
| [#754 — Task usefulness](https://github.com/mohanagy/madar/issues/754) | Know whether Madar reduces complete task work without material correctness loss. | Deferred; no experiment starts from publication of the story. |
| [#697 — Workspace discovery](https://github.com/mohanagy/madar/issues/697) | Finish discovery within an explicit bound and distinguish a failed Git command from a non-repository directory. | Open; implementation paused. |
| [#739 — Namespace bracket calls](https://github.com/mohanagy/madar/issues/739) | Retain the source-grounded call relationship for a static bracket call equivalent to a dot call. | Blocked; the rejected mechanism remains stopped. |
| [#755 — Recovery-budget assertions](https://github.com/mohanagy/madar/issues/755) | Verify recovery decisions without depending on runner speed. | Backlog only; no implementation or rerun started. |
| [#756 — Test-module startup](https://github.com/mohanagy/madar/issues/756) | Attribute a blocked module startup before changing the runner. | Deferred until a concrete failure prevents necessary validation. |
| [#710 — Remaining session failures](https://github.com/mohanagy/madar/issues/710) | Retain ownership of the unresolved discovery-responsiveness and active-session refresh timeout reports. | Open; neither #755 nor #756 resolves these two cases. |

Maintenance is not a mandatory sequence before usefulness work. A defect blocks a later comparison only if it actually prevents trustworthy execution within that comparison's scope. A same-code retry passing does not prove an infrastructure-only cause. For #739, preserve the heritage traversal regression, invalid positive control and red or incomplete validation; no third repair is automatically authorized.

## Simplification and branch choice

The completed [#753 responsibility inventory](https://github.com/mohanagy/madar/issues/753#issuecomment-5622360023) found duplicated task routing, several owners of final evidence status, repeated release-log checks and an uncalled command parser. These are specific simplification candidates, not a blanket deletion plan.

Existing source-preservation tests, graph-integrity responsibilities and legacy readers still have consumers. Test/script growth is a maintenance concern; those repository trees are outside the configured production package, while evaluation code under source still ships. The review does not establish how much code can safely be removed or a runtime performance benefit from removing it.

For later work, the inventory selects pinned [main](https://github.com/mohanagy/madar/commit/3371ada8425efa7f8cabdac781fa227feaea7a6a) as the control and pinned [next](https://github.com/mohanagy/madar/commit/2b144504ddf924d64cce51db601bb599be0b6c44) as the candidate. Main precedes the reviewed change set; next retains the artifact and source-preservation work being assessed. This choice is not a quality ranking or authorization to promote next.

## How a later usefulness comparison ends

[#754](https://github.com/mohanagy/madar/issues/754) owns this question. Before execution, record the supported task category, representative tasks, exact versions, shared model/settings, order/cache policy, measurable acceptance thresholds and a finite run budget. Start with Native exploration and reuse existing execution facilities. Historical exposed tasks cannot become fresh validation by relabelling them.

Apply common behavioral correctness criteria. Count setup, indexing, retrieval, fallback, errors, verification, complete elapsed time and reported agent work. Record token/cache usage and monetary cost when available, and identify missing measurements. Report all scheduled outcomes and per-task regressions; fewer shell calls or green retrieval checks do not by themselves establish an advantage.

End with **scoped benefit**, **no demonstrated benefit**, or **inconclusive**. A failure or missing measurement does not authorize additional runs, a new evaluator platform or an automatic repair chain. Comparisons with other tools are a later decision if a useful candidate is demonstrated.

## Boundaries and completed work

The lead coordinates planning, documentation and issue state. Codex CLI owns separately scoped source implementation and tests. No code cleanup, test campaign, worktree deletion, merge or release starts automatically from this roadmap.

[#753](https://github.com/mohanagy/madar/issues/753) completed the read-only inventory. [#741](https://github.com/mohanagy/madar/issues/741) and [#743](https://github.com/mohanagy/madar/issues/743) completed bounded specification and offline prototype work; neither establishes product benefit or remains the next execution program. [#734](https://github.com/mohanagy/madar/issues/734), [#735](https://github.com/mohanagy/madar/issues/735), [#736](https://github.com/mohanagy/madar/issues/736), and [#738](https://github.com/mohanagy/madar/issues/738) retain their closed dispositions.

The [5 September roadmap](https://github.com/mohanagy/madar/blob/5af65b1fe236d4d548e21b975bc6c6364bee8213/docs/roadmap.md) and #740 retain the preceding decisions as history. Dependency PRs remain separate maintenance. Broad ranker rewrites, language expansion, hosted services, general-memory work and release promises remain deferred.

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
