# Context packs and task evidence

Madar is deterministic local context compilation for the repo/task boundary. It indexes a workspace into local graph artifacts, then compiles those artifacts into a task-aware pack the agent can start from before it decides whether deeper reads are still necessary.

The core distinction is simple:

- Structural graphs and IDE indexes tell the agent what exists.
- Madar compiles what runs for this task.
- The result is a bounded context pack with evidence, coverage, missing-context notes, and expansion handles.

```text
your prompt
  -> workspace graph built once and reused
    -> relevant nodes + edges + snippets
      -> compact context pack
        -> AI coding agent
```

When the agent says "tell me more," it can expand a stable `handle_id` inside the same MCP session instead of reconstructing the same first-pass context from scratch.

## Pack Schema v1

`madar pack` emits a stable Pack Schema v1 envelope around the compiled evidence bundle. In JSON mode (`--format json`), the response includes `schema_version`, `task`, `task_intent`, `workflow_centers`, `recommended_first_read`, `likely_edit_files`, `likely_test_files`, `public_contracts`, `risk_boundaries`, `validation_commands`, `negative_guidance`, `confidence_score`, and `why_explanation`, alongside the existing `pack`, `coverage`, and planner metadata.

For `--task implement`, `workflow_centers` are scored workflow-owner candidates with a `path`, numeric `score`, and structural `reasons`, so orchestration files can outrank lexically louder helpers when the brief recommends where to start editing.

The implement brief keeps `recommended_first_read` separate from ranked `likely_edit_files` and `likely_test_files`. The edit/test sections carry explicit `score` and `reason` fields so agents can tell orientation reads apart from the files most likely to change or validate.

`negative_guidance` is task-aware too: implementation packs can explicitly call out helper-like or generated files as supporting context instead of silently letting lexical matches drift into the default edit path.

Use `--format json` when another tool or script will consume the pack directly. Use `--format text` when you want the same schema rendered as a short human/agent-readable execution brief.

## Adaptive context-pack representations

Compiled context packs have a first-pass rendering-only adaptive layer. Retrieval still selects the same nodes and paths first; the runtime only changes how those already-selected nodes are emitted for the task.

That renderer is budget-aware: tighter budgets compress already-selected nodes down toward summary/signature views, while explain packs preserve full detail only when the budget is large enough to justify it.

The deterministic core modes are:

- `signature`
- `behavior_sketch`
- `call_chain`
- `contract_view`
- `implementation_excerpt`
- `dependency_record`

That means the same selected nodes can render differently for `explain`, `review`, and `impact` work without changing retrieval selection. Lower-token renderings carry less raw implementation detail, while explain-oriented packs keep full code snippets when the runtime already has them.

## Execution slices

When the selected question is a runtime-generation flow, compact responses can carry an `execution_slice` section with ordered steps and partial-path signaling. This gives agents a stable "what happens next" sketch without forcing them to read the full raw slice first.

`execution_slice` is a static runtime-path hypothesis from graph evidence, not a live trace. Its nested `phase_coverage` is also a static, prompt-scoped phase model, so broad report-generation questions can surface planner/research/report-builder/scoring/renderer/persistence phases without claiming runtime tracing.

Runtime-generation prompts stay compact by following the strongest backend path first and suppressing sibling-route noise plus shared-hub fan-out on broad runtime-generation questions.

## When to use `--spi`

`--spi` is still opt-in in `0.27.7`. Use it when your repo is framework-heavy TypeScript/JavaScript and you want extra framework-shaped metadata plus disk cache behavior.

`--spi` is usually worth it for NestJS, Next.js App Router, Prisma, tRPC, Hono, Fastify, and similar repos where users ask storage-oriented prompts, client/server boundary questions, or request-flow questions. The default pipeline is still fine for simpler repos, non-JS/TS workspaces, or quick first runs when you do not need the extra framework detail yet.

Deepest extraction is still TypeScript/JavaScript with framework-aware passes for Express, NestJS, Next.js, React Router, Redux Toolkit, Hono, Fastify, tRPC, Prisma, and routing-controllers. Python now has conservative cross-file import/call resolution, FastAPI router composition plus route/dependency semantics, and first-pass Django URL-conf route-to-view mapping. Go has conservative local-package import resolution, receiver/method call edges, and statically visible `net/http` / Gin / Chi route relationships. Ruby, Java, and Rust still use the tree-sitter AST baseline. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor.

Full coverage details: [`docs/language-capability-matrix.md`](../language-capability-matrix.md).

## Review and security workflows

Madar is a local context/evidence layer for review and security workflows, not a PR reviewer or vulnerability scanner. CodeRabbit, Qodo, Codex Security, and similar tools still decide findings, policy, and remediation behavior.

Madar's role is to compile a bounded local-first view of the repo or diff before those tools start broader exploration. Use `pr_impact`, `review-compare`, `madar handoff`, and `report.share-safe.json` artifacts to supply workflow ownership, likely test files, compact prompt evidence, and share-safe receipts to the review/security agent or to the human comparing multiple agents.

Madar helps make those workflows more inspectable and reproducible, but it does not claim better findings than CodeRabbit, Qodo, or Codex Security today. Public positioning and benchmark claims stay grounded in [`docs/claims-and-evidence.md`](../claims-and-evidence.md).
