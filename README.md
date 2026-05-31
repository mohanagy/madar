# madar

**Madar is a local, task-aware context-pack compiler for AI coding agents.**

A structural graph tells the agent what exists in your codebase. Madar tells the agent **what runs for this task** — usually a much smaller execution slice or structural subset — then returns a compact pack with inline snippets so the agent can answer from the pack before it starts searching the repo by hand.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#trust--limitations)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#trust--limitations)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/main/LICENSE)

---

## Demo

[![▶ Watch the 30-second demo](https://img.shields.io/badge/%E2%96%B6%EF%B8%8E-Watch%20the%2030%E2%80%91second%20demo-3c873a?style=for-the-badge)](https://github.com/mohanagy/madar#demo)

<!-- GitHub auto-embeds the user-attachment video below; npm renders it as a link only.
     The shields.io button above is the npm-visible affordance back to the inline player on GitHub. -->

https://github.com/user-attachments/assets/a502185f-fa12-4a8f-80d2-172847f209fd

30 seconds: install → `madar generate .` on the GoValidate repo (1,048 files) → `madar claude install --profile core` → `madar compare "Explain the auth flow End to End"`. The repo includes the saved artifact for that run plus the follow-up benchmark notes and caveats. Treat it as a worked receipt, not a universal benchmark headline. Receipts: [`docs/benchmarks/2026-05-09-govalidate-auth-e2e/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/2026-05-09-govalidate-auth-e2e/).

---

## Requirements

Madar is two steps and requires both. Running `madar generate` alone produces a local graph artifact that nothing consumes until you install the agent integration that exposes the Madar MCP tools or prompt flow.

```bash
madar generate .              # produces out/graph.json
madar <agent> install         # registers the MCP server / local install rules
```

Without `<agent> install` (or the equivalent manual wiring for your runtime), the agent has no Madar MCP tools available and the measured benchmark cell below does not apply.

## Quickstart

```bash
npm install -g @lubab/madar

cd your-project
madar generate .          # builds out/graph.json (no API key, no cloud)
madar summary             # bounded repo overview before deeper retrieval
madar claude install      # wires Claude Code to use it via MCP
madar doctor              # checks graph freshness + agent/MCP wiring
madar status              # compact readiness summary + next commands

# Or use the opt-in SPI pipeline for framework-aware metadata + disk cache:
madar generate . --spi
```

Now ask Claude something about your codebase. It can start with one bounded `retrieve` or `context_pack` call, get labeled snippets with file paths and community context, and then decide whether focused follow-up reads are still needed.

## Choose your agent

Pick one install target, then rerun `madar doctor` and `madar status` so the first result is verified before you ask a broader question:

- Claude Code — `madar claude install`
- Codex CLI — `madar codex install`
- Cursor — `madar cursor install`
- GitHub Copilot CLI — `madar copilot install`
- Gemini CLI — `madar gemini install`
- Aider — `madar aider install`
- OpenCode — `madar opencode install`

For Claude Code, Cursor, Gemini CLI, and GitHub Copilot CLI, `madar doctor` and `madar status` verify the local install wiring after you generate `out/graph.json`. Codex CLI, Aider, and OpenCode still install correctly, but those verification commands do not report them yet.

Want the opt-in semantic retrieval / rerank path too? Install the optional local model runtime in the same environment:

```bash
npm install @huggingface/transformers
```

`madar prompt` stays local and only compiles a prompt payload. By contrast, compare and benchmark flows can spend paid model tokens when you swap the local smoke-check runner for a real model CLI or hosted model configuration.

**Install commands:**

```bash
madar cursor install      # Cursor
madar copilot install     # GitHub Copilot CLI
madar gemini install      # Gemini CLI
madar aider install       # Aider
madar codex install       # Codex CLI
madar opencode install    # OpenCode
```

**Or use it without MCP** — pipe the compiled prompt directly to your agent's CLI:

```bash
madar summary                             # bounded JSON overview before pack/prompt
madar pack "how does auth work?" --task explain --format text   # human-readable execution brief
madar pack "add auth telemetry" --task implement --format json  # Pack Schema v1 for automation
madar prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
```

If you enable `--semantic` or `--rerank` without that optional package installed, madar now fails with an explicit install hint instead of pulling the transformer/native stack into every default install.

Want a tiny reproducible workspace for local demos? Start with [`examples/sample-workspace/`](https://github.com/mohanagy/madar/tree/main/examples/sample-workspace/) and the [sample workspace tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/sample-workspace.md).

Want a broader local-first walkthrough that also covers install, one verified pack, and a safe `compare` smoke check? Use the [end-to-end getting started tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md).

---

## What's new in 0.27.4

See the [`0.27.4` changelog entry](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0274---2026-05-29) for the full release notes.

The larger **What's new in 0.23.0** additions are still part of the main flow too: `madar summary`, the core MCP `graph_summary` tool, runtime `execution_slice` output, share-safe `report.share-safe.json` compare artifacts, and `compare --baseline-mode pack_only`.

If you want the broader proof-oriented workflow behind the current surfaces, start with [proof workflows](https://github.com/mohanagy/madar/blob/main/docs/proof-workflows.md) and the [GoValidate shared benchmark suite](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/govalidate-suite/README.md).

### When to use `--spi`

`--spi` is **still opt-in** in 0.27.4. Use it when your repo is framework-heavy TypeScript/JavaScript and you want the extra framework-shaped metadata plus disk cache behavior.

`--spi` is usually worth it for NestJS, Next.js App Router, Prisma, tRPC, Hono, Fastify, and similar repos where users ask storage-oriented prompts, client/server boundary questions, or request-flow questions. The default pipeline is still fine for simpler repos, non-JS/TS workspaces, or quick first runs when you do not need the extra framework detail yet.

---

## What madar is

A structural graph tells you what exists, but what the agent actually needs is **what runs for this task**, which is usually a much smaller set.

madar indexes a TypeScript/Node workspace (and PR diffs) into local graph artifacts, then compiles those artifacts into a task-aware pack the agent can start from before it decides whether deeper reads are still necessary.

```
your prompt
  → workspace graph (built once, reused)
    → relevant nodes + edges + snippets
      → compact context pack (claims, coverage, missing_context)
        → AI coding agent
```

When the agent says "tell me more," it expands a stable `handle_id` inside the same MCP session instead of reconstructing the same first-pass context from scratch.

### Pack Schema v1

`madar pack` now emits a stable **Pack Schema v1** envelope around the compiled evidence bundle. In JSON mode (`--format json`), the response includes `schema_version`, `task`, `task_intent`, `workflow_centers`, `recommended_first_read`, `likely_edit_files`, `likely_test_files`, `public_contracts`, `risk_boundaries`, `validation_commands`, `negative_guidance`, `confidence_score`, and `why_explanation`, alongside the existing `pack`, `coverage`, and planner metadata.

For `--task implement`, `workflow_centers` are scored workflow-owner candidates with a `path`, numeric `score`, and structural `reasons`, so orchestration files can outrank lexically louder helpers when the brief recommends where to start editing.

The implement brief also keeps `recommended_first_read` separate from ranked `likely_edit_files` and `likely_test_files`. The edit/test sections now carry explicit `score` and `reason` fields so agents can tell orientation reads apart from the files most likely to change or validate.

`negative_guidance` is also task-aware now: implementation packs can explicitly call out helper-like or generated files as supporting context instead of silently letting lexical matches drift into the default edit path.

Use `--format json` when another tool or script will consume the pack directly. Use `--format text` when you want the same schema rendered as a short human/agent-readable execution brief.

### Adaptive context-pack representations

Compiled context packs now have a first-pass **rendering-only** adaptive layer. Retrieval still selects the same nodes and paths first; the runtime only changes how those already-selected nodes are emitted for the task.

That renderer is now budget-aware: tighter budgets compress already-selected nodes down toward summary/signature views, while explain packs only preserve full detail when the budget is large enough to justify it.

The current deterministic core modes are:

- `signature`
- `behavior_sketch`
- `call_chain`
- `contract_view`
- `implementation_excerpt`
- `dependency_record`

That means the same selected nodes can render differently for `explain`, `review`, and `impact` work without changing retrieval selection. The tradeoff is explicit: lower-token renderings carry less raw implementation detail, while explain-oriented packs keep full code snippets when the runtime already has them.

**What it's good at today:**
- Giving agents a bounded first pass for explain / review / impact work instead of starting from arbitrary repo-wide search.
- Turning the current git diff into ranked review risks, structural hotspots, and likely test files with `pr_impact` and `review-compare`.
- Producing deterministic, share-safe artifacts (`report.share-safe.json`, Pack Schema v1, static `execution_slice` output) that can be reviewed without sharing workstation paths.
- Staying local-first: tree-sitter AST, BM25 retrieval, optional ONNX embeddings — all on your machine unless you explicitly invoke a model you configured yourself.

> Deepest extraction is still **TypeScript/JavaScript** with framework-aware passes for Express, NestJS, Next.js, React Router, Redux Toolkit, **Hono, Fastify, tRPC, Prisma, and routing-controllers** (10 substrates via `--spi`). Python now has a conservative semantic layer for cross-file import/call resolution, FastAPI router composition plus route/dependency semantics, and first-pass Django URL-conf route-to-view mapping. Go now has a conservative first semantic pass for local-package import resolution, receiver/method call edges, and statically visible `net/http` / Gin / Chi route relationships. Ruby, Java, and Rust still use the tree-sitter AST baseline. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor. Full matrix: [`docs/language-capability-matrix.md`](https://github.com/mohanagy/madar/blob/main/docs/language-capability-matrix.md).

---

## Demonstrated today

On the GoValidate backend service (NestJS + BullMQ, SPI graph, install verified), for the prompt *"How idea report is being generated"*, Madar produced this measured release cell versus the same agent without Madar:

| metric | baseline | Madar | delta |
| --- | --- | --- | --- |
| total tool calls | 28 | 7 | **4x fewer** |
| broad search (`Glob`/`Grep`/`Bash`) after first Madar call | 11 | 0 | eliminated |
| input tokens (Anthropic-reported) | 2,366,946 | 498,688 | **4.75x less** |
| uncached input tokens | 229,691 | 103,764 | 125,927 fewer |
| wall-clock latency | 158,995 ms | 72,420 ms | **2.2x faster** |
| cost (USD) | 2.6595 | 0.9728 | **2.73x cheaper** |
| `measurement_validity` | n/a | `valid` | — |
| `token_regression` | n/a | `false` | — |

This cell also recorded `install_verified: true`, `madar_mcp_call_count: 1`, and `exploration_outcome: madar_invoked`, meaning the first Madar tool call was `mcp__madar__retrieve` and there was no broad exploration after it. Trace artifact: [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/).

This is **one cell**: one prompt, one repo, one agent runtime, one verified install path. Your results will vary by repo shape, prompt type, agent runtime, and what other MCPs or skills you have loaded.

Runtime-generation prompts stay compact: the pack shaping follows the strongest backend path first and suppresses sibling-route noise plus shared-hub fan-out on broad runtime-generation questions.

## In progress

- **Reproducible benchmark suite with per-repo spread.** The public suite now ships fixed manifests, methodology, and the `madar bench:suite` runner under [`docs/benchmarks/suite/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/suite/).
- **Exploration behavior across more repos and prompts.** Strict install guidance now pushes agents toward one graph/pack-first pass, but the public evidence is still mixed. The current counterexample note is in [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/2026-05-25-founder-command-center-auth-flow/).
- **Clearer compare evidence.** Native-agent compare traces now preserve more machine-readable metadata, but we still treat them as repo/task-specific receipts rather than a universal claim.

## Not yet measured

- **Implement tasks.** The demonstrated release cell is an `explain` prompt. Whether Madar improves implementation work or wrong-file edit rates is still unmeasured and belongs under [#332](https://github.com/mohanagy/madar/issues/332).
- **Lower-confidence packs.** This release cell is a strong-path, install-verified receipt; lower-confidence prompt behavior still needs its own measured cells.
- **Repos beyond the demonstrated GoValidate backend cell.** Current public artifacts do not justify a universal turns / latency / exploration claim across repo shapes.
- **Cross-repo aggregate benchmark marketing.** We do not publish a single-number cross-repo headline.

## What Madar does not do today

- It does **not** control the agent runtime. The agent can still ignore the pack and keep exploring.
- It does **not** guarantee fewer tool calls, fewer turns, or lower latency on every repo or prompt.
- It does **not** turn static analysis into live instrumentation. `execution_slice` stays a static runtime-path hypothesis, not a trace.
- It does **not** replace targeted reads, tests, or review when you are changing code.

## How we measure

- We publish dated artifact folders under [`docs/benchmarks/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/) and map each public claim to evidence in [`docs/claims-and-evidence.md`](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md).
- This release README cites one verified cell under [`docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/regression/0.27.0-next.4-govalidate-explain/), not a universal benchmark headline.
- The benchmark-suite direction is **per-repo spread**, fixed tasks, and reproducible artifacts under [`docs/benchmarks/suite/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/suite/). There is **no single-number cross-repo headline** in the public docs.
- Suite runs use the same prompt against a baseline path and an install-verified Madar path, capture verbose tool traces, and keep multi-trial reporting attached to the specific repo/task cell rather than flattening it into one marketing number.
- Published benchmark cells run in isolation mode ([`docs/benchmarks/suite/isolation/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/suite/isolation/)). Your local numbers may differ if your Claude Code config differs.
- Run `madar bench:suite --dry-run` to inspect the current matrix, then `madar bench:suite --repo nestjs-mid --task explain-runtime ...` to populate a wired cell.
- Any stronger public claim belongs behind a reproducible suite artifact, not a one-off anecdote.

---

## Works with your AI tools

madar produces local context packs that any modern coding agent can consume — over MCP or by piping the compiled prompt to its CLI.

| Agent | Connection | Install command |
|---|---|---|
| Claude Code | MCP via `.mcp.json` | `madar claude <install|uninstall> [--profile core|full|strict]` |
| Cursor | MCP via `.cursor/mcp.json` | `madar cursor <install|uninstall> [--profile core|full|strict]` |
| GitHub Copilot CLI | MCP via `.vscode/mcp.json` | `madar copilot <install|uninstall> [--profile core|full|strict]` |
| Gemini CLI | MCP server | `madar gemini <install|uninstall> [--profile core|full|strict]` |
| Aider | AGENTS.md context-pack-first profile | `madar aider install` |
| OpenCode | AGENTS.md + `.opencode/plugins/madar.js` + MCP via `opencode.json` / `opencode.jsonc` | `madar opencode install` |
| Codex CLI | AGENTS.md + `.codex/hooks.json` context-pack-first profile | `madar codex install` |
| Windsurf / others | Pipe `madar prompt` output | `madar prompt "..." --provider claude` |

These are local installers that write project instructions and, when the platform supports it, local MCP config or plugin files that point at the madar subprocess. No code is uploaded.

For Claude, Cursor, Copilot, and Gemini, `--profile strict` keeps the lean core MCP tool surface but rewrites the generated guidance into a compact flow: call `context_pack` once for the task before broader exploration, answer after one high- or medium-confidence pack when `diagnostics.quality_score >= 0.5` and `missing_context` is empty, do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps after that strong pack, prefer Madar over non-Madar MCPs for codebase questions unless Madar returns `agent_directive: explore_with_caution`, let that Madar guidance override conflicting auto-activated exploration skills, expand only when `missing_context` / `missing_semantic` or diagnostics justify it (or the user asks for deeper verification), and keep `out/GRAPH_REPORT.md` as a fallback-only read when the pack or graph tools are unavailable, stale, or insufficient. Strict mode is about a bounded first pass, not a guarantee that exploration will always decrease.

Aider and OpenCode are intentionally context-pack-first: run `madar generate .`, install the profile, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. In those installed profiles, `out/GRAPH_REPORT.md` stays a fallback-only read when the pack or graph tools are unavailable, stale, or insufficient, rather than a default first file. `madar aider install` writes an AGENTS.md profile only; remove it with `madar aider uninstall`. `madar opencode install` writes the AGENTS.md profile, `.opencode/plugins/madar.js`, and the madar MCP entry in `opencode.json` or `opencode.jsonc`; remove only madar-owned content with `madar opencode uninstall`. Manual verification does not require either agent binary: inspect the generated files after install, then confirm uninstall removes only the madar entries.

Codex is intentionally context-pack-first: run `madar generate .`, install with `madar codex install`, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. In the installed guidance, `out/GRAPH_REPORT.md` remains fallback-only when the pack or graph tools are unavailable, stale, or insufficient. To remove the profile, run `madar codex uninstall`; it removes the madar AGENTS.md section and Codex hook while preserving unrelated content. Manual verification does not require Codex to be installed: inspect `AGENTS.md` and `.codex/hooks.json` after install, then confirm uninstall removes only madar content.

For practical multi-agent workflows across Claude Code, Codex, Copilot, Cursor, and Gemini, see the [agent orchestration guide](https://github.com/mohanagy/madar/blob/main/docs/integrations/agent-orchestration.md).

### MCP Registry metadata

The checked-in public registry manifest lives at [`docs/mcp-registry/server.json`](https://github.com/mohanagy/madar/blob/main/docs/mcp-registry/server.json). Validate it locally with `npm run registry:validate`.

The official MCP Registry hosts metadata, not Madar code or your local graph artifact. Madar's registry entry still points back to the public npm package and the same local-first runtime flow: run `madar generate .` to create `out/graph.json`, then start the local stdio server with `npx @lubab/madar serve --stdio out/graph.json` (or let `madar <agent> install` write that wiring for you).

Private registry usage stays out of scope for the public Madar listing because the official MCP Registry only accepts public package sources. Keep private or self-hosted registry workflows separate from this metadata file.

---

## MCP tools

These seven MCP tools handle the most common agent workflows in the default **core** profile. The full surface is 26 tools, opt-in via `MADAR_TOOL_PROFILE=full` or `--profile full` on install. `--profile strict` still uses the lean core tool surface, but changes the installed guidance so the agent starts with one `context_pack` call and expands only when the pack diagnostics say evidence is missing. Start with `graph_summary` for a bounded deterministic first-turn overview, then use `retrieve` or `context_pack` when you need task-specific evidence. It is intentionally a compact at-a-glance summary, not a full runtime trace.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" — ranked nodes + code snippets + community context |
| `pr_impact` | "Is this PR safe to merge?" — diff-aware blast radius + ranked review risks |
| `impact` | "What breaks if I refactor X?" — directed dependents + affected communities |
| `call_chain` | "How does request flow from X to Y?" — shortest execution paths |
| `community_overview` | "Show me the architecture" — communities + sizes + bridges |
| `graph_stats` | "How big is this graph?" — node/edge counts, density, file-type mix |
| `graph_summary` | "Give me the repo at a glance" — bounded deterministic overview of counts, domains, top modules, entrypoints, frameworks, and runtime paths |

Full-profile additions: `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`. Full reference: [examples/mcp-tool-examples.md](https://github.com/mohanagy/madar/blob/main/examples/mcp-tool-examples.md).

Within one MCP stdio session, identical `context_pack` requests for `task=explain` are reused automatically when the graph version and relevant prompt/options match. The cache is memory-only, skips delta-session packs, and invalidates itself when `graph.json` changes.

When the selected question is a runtime-generation flow, the shared compact response can also carry an `execution_slice` section with ordered steps and partial-path signaling. That gives agents a stable "what happens next" sketch without forcing them to read the full raw slice first. It is a static runtime-path hypothesis from graph evidence, not a live trace. Its nested `phase_coverage` is the same kind of static, prompt-scoped model, so broad report-generation questions can surface planner/research/report-builder/scoring/renderer/persistence phases without implying live instrumentation.

---

## Common commands

```bash
madar generate .                          # build the graph
madar generate . --spi                    # opt-in SPI pipeline (framework metadata + disk cache)
madar watch .                             # rebuild on file change
madar summary                             # bounded JSON overview before deeper retrieval
madar pack "how does auth work?" --task explain --format text   # human-readable execution brief
madar pack "add auth telemetry" --task implement --format json  # Pack Schema v1 for automation
madar pack "why does auth fail?" --task explain --retrieval-strategy slice-v1
madar prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
madar review-compare out/graph.json --exec '...' --yes  # PR review benchmark
madar compare "How does auth work?" --exec '...' --yes           # general benchmark
madar compare "How does auth work?" --baseline-mode pack_only --exec '...' --yes  # bounded raw context vs compiled madar pack
madar time-travel main HEAD --view risk   # what changed between two refs
madar federate frontend/graph.json backend/graph.json  # multi-repo merge
madar --help                              # full surface
```

---

## Default discovery rules

`madar generate` now hard-ignores nested VCS/worktree copies and generated/build output by default: `.worktrees/`, `worktrees/`, `.git/`, `out/`, `node_modules/`, `dist/`, `build/`, `coverage/`, cache folders, source maps, lock/build artifacts, and temp/log files.

Tests, benchmarks, fixtures, mocks, and config files are **not** hard-ignored anymore. They still get indexed so retrieval can use them when you ask for them, but production/runtime prompts now soft-penalize them and honor prompt exclusions like "exclude tests, benchmarks, fixtures".

`.madarignore` still adds extra ignore rules, and negated entries such as `!vendor/**` or `!lib/**` can re-include a default hard-ignore when you intentionally want it indexed.

---

## Trust + limitations

Everything stays local by default. No telemetry, no cloud upload, no API key required.

- **Build:** tree-sitter AST extraction + Louvain community detection — all CPU-local.
- **Query:** BM25 lexical scoring + reciprocal-rank fusion + optional ONNX embeddings (`Xenova/all-MiniLM-L6-v2`, ~25 MB) + optional cross-encoder reranker.
- **Integration:** MCP stdio server runs as a local subprocess of your agent. Your code never crosses an HTTP boundary unless you explicitly invoke `compare` against a model you've configured yourself.

**Limitations to know:**

1. **Cold-start sessions add a one-time MCP/tool-schema cost.** Core profile is ~3,200 bytes / ~800 tokens (still down about 25% from the original 4,270-byte surface). Multi-question sessions amortize this and end up cheaper.
2. **Deep extraction is still best on JS/TS.** Python now has conservative cross-file import/call resolution, FastAPI router composition plus route/dependency semantics, and first-pass Django URL-conf route-to-view mapping. Go now has a conservative first-pass semantic layer for local-package imports, receiver calls, and statically visible `net/http` / Gin / Chi routes, but Python and Go are still not near JS/TS parity. Ruby / Java / Rust still use the tree-sitter AST baseline. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor.
3. **Static analysis can't resolve every dynamic runtime behavior.** Runtime-generated routes, heavy meta-programmed decorators, and string-built imports fall back to the base AST graph. SPI can tag common Prisma model operations and repository read/write methods so persistence-oriented prompts prefer likely storage endpoints, but that remains first-pass static coverage rather than full ORM/dataflow understanding.
4. **Token reduction depends on project + task.** "How does auth work?" benefits more than "fix this typo." Always validate important code changes with tests and review.
5. **Some workflows still need full file reads** — large multi-file refactors, generated-code spelunking. madar narrows the agent's first read; it doesn't replace its ability to read.

---

## Documentation & receipts

- [Quick start guide](https://github.com/mohanagy/madar/blob/main/docs/proof-workflows.md) — three reproducible workflows: local proof, A/B compare, federated proof
- [Claims and evidence map](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md) — which public claims are demonstrated, in progress, or not yet measured
- [Benchmark suite](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/suite/README.md) — fixed manifests, methodology, CLI runner, and per-repo spread results
- [GoValidate shared benchmark suite](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/govalidate-suite/README.md) — public prompt set plus deterministic pack/answer quality gates
- [Public roadmap](https://github.com/mohanagy/madar/blob/main/docs/roadmap.md) — contributor-facing priority tracks and issue links
- [Language and capability matrix](https://github.com/mohanagy/madar/blob/main/docs/language-capability-matrix.md) — exactly what each file type and language gets
- [Performance benchmark harness](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/performance/README.md) — repeatable `generate` / `update` / `cluster-only` measurements
- [MCP tool examples](https://github.com/mohanagy/madar/blob/main/examples/mcp-tool-examples.md) — real input/output for every tool
- [Benchmark hub](https://github.com/mohanagy/madar/tree/main/docs/benchmarks) — committed wrappers and provider-reported evidence
- [Changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md) — full per-release notes
- [Contributing](https://github.com/mohanagy/madar/blob/main/CONTRIBUTING.md) · [Security](https://github.com/mohanagy/madar/blob/main/SECURITY.md)

---

## Contributors

Thanks to everyone shaping madar. The list below is regenerated automatically on every push to `main` by [`.github/workflows/contributors.yml`](https://github.com/mohanagy/madar/blob/main/.github/workflows/contributors.yml).

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/mohanagy">
                    <img src="https://avatars.githubusercontent.com/u/11216054?v=4" width="80;" alt="mohanagy"/>
                    <br />
                    <sub><b>mohanagy</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Gunselheli">
                    <img src="https://avatars.githubusercontent.com/u/125200242?v=4" width="80;" alt="Gunselheli"/>
                    <br />
                    <sub><b>Gunselheli</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/qorexdevs">
                    <img src="https://avatars.githubusercontent.com/u/277760369?v=4" width="80;" alt="qorexdevs"/>
                    <br />
                    <sub><b>qorexdevs</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/zhengjynicolas">
                    <img src="https://avatars.githubusercontent.com/u/32067765?v=4" width="80;" alt="zhengjynicolas"/>
                    <br />
                    <sub><b>zhengjynicolas</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/jamemackson">
                    <img src="https://avatars.githubusercontent.com/u/7982720?v=4" width="80;" alt="jamemackson"/>
                    <br />
                    <sub><b>jamemackson</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

A specific shout-out to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/madar/pull/54) — adding OpenCode MCP installer support, the first community-contributed feature in madar.

---

## License

MIT. Use it, fork it, ship it.
