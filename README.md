# graphify-ts

**Stop making AI agents re-read your repo.** A local context compiler for Claude Code, Codex CLI, Copilot CLI, Cursor, Windsurf, and Aider — turn your TypeScript/Node workspace and PR diffs into compact, verifiable context packs.

[![npm](https://img.shields.io/npm/v/@mohammednagy/graphify-ts)](https://www.npmjs.com/package/@mohammednagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#what-stays-local)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#what-stays-local)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/graphify-ts/blob/main/LICENSE)

> **AI coding agents keep re-reading your repo. graphify-ts gives them structural memory.**

graphify-ts indexes a TypeScript/Node workspace (and PR diffs) into a local knowledge graph, then compiles that graph into the **smallest verifiable context pack** the agent actually needs for the task at hand. No cloud upload, no API key for indexing, no SaaS dashboard — just a local subprocess your agent talks to over MCP.

### See it in action

https://github.com/user-attachments/assets/a502185f-fa12-4a8f-80d2-172847f209fd

> 30-second demo: install → `graphify-ts generate .` on the GoValidate repo (1,048 files) → `graphify-ts claude install --profile core` → `graphify-ts compare "Explain the auth flow End to End" --baseline-mode native_agent`. Anthropic-reported result on the same Claude Opus run: **31 → 14 turns (2.21× fewer)**, **170 s → 107 s (1.58× faster)**, **2,811,682 → 532,021 input tokens (5.28× fewer)**. Receipts: [`docs/benchmarks/2026-05-09-govalidate-auth-e2e/`](docs/benchmarks/2026-05-09-govalidate-auth-e2e/).

---

## Why graphify-ts?

Modern AI coding agents have one expensive habit: they discover your codebase from scratch every session.

- They `grep`, then `Read`, then summarize, then forget, then repeat — every prompt.
- Dumping the whole repo as context is too expensive and busts the context window.
- Generic vector RAG loses the structural relationships agents actually need (who calls whom, what depends on what, what changed).
- PR review needs the **changed-code neighborhood** — call sites, dependents, likely test files — not the whole repo.

graphify-ts fixes the loop: build the graph once, then compile a task-specific context pack on demand. The agent answers in fewer turns, reads fewer files, and stays grounded in real structure.

---

## What it does

- **Builds a local graph of your TypeScript/Node workspace** — files, symbols, imports, exports, call edges, dependents, communities, and changed-line ranges.
- **Compiles compact context packs from that graph** for any agent task: explain, review, impact, plan.
- **Diff-aware PR review** via `pr_impact` and `review-compare` — turns the *current git diff* into ranked review risks, structural hotspots, and likely test files.
- **Provider-aware prompt compilation** via `prompt` — Claude payloads expose cache-aware `effective_token_count`, `reused_context_tokens`, and `session_state`; Gemini gets a plain prompt string.
- **Native MCP server** that runs as a local subprocess of Claude Code, Cursor, Copilot CLI, Gemini CLI, Aider, or OpenCode. Default exposes a 6-tool **core** profile; opt into the 25-tool **full** profile when you want the advanced context-plane surface.
- **Multi-repo federation** — merge frontend + backend + shared graphs so one agent session can reason across repo boundaries.
- **Local-first by design**: tree-sitter AST extraction, BM25 lexical retrieval, optional ONNX embeddings (`Xenova/all-MiniLM-L6-v2`), optional cross-encoder reranker — all on your machine.

> Deepest extraction is for **TypeScript/JavaScript** with framework-aware passes for Express, Redux Toolkit, React Router, NestJS, and Next.js. Python, Ruby, Go, Java, and Rust use tree-sitter AST. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor. Full matrix: [`docs/language-capability-matrix.md`](docs/language-capability-matrix.md).

---

## Core concept

graphify-ts does **not** try to send the whole graph to your AI agent.

It compiles the **minimum useful context for one task**:

```
your prompt
  → workspace graph (built once, reused)
    → relevant nodes + edges + snippets
      → compact context pack (claims, coverage, missing_context)
        → AI coding agent
```

When the agent says "tell me more," it expands a stable `handle_id` inside the same MCP session instead of re-reading the repo from scratch.

---

## 60-second quickstart

```bash
npm install -g @mohammednagy/graphify-ts

cd your-project
graphify-ts generate .          # builds graphify-out/graph.json (no API key, no cloud)
graphify-ts claude install      # wires Claude Code to use it via MCP

# graphify-ts claude install --profile full   # opt into the full 25-tool MCP surface
```

Now ask Claude something about your codebase. It calls `retrieve` once, gets back labeled snippets with file paths and community context, and answers — instead of running multiple `Read` / `Grep` / `Glob` calls and accumulating tokens at every turn.

Other agents:

```bash
graphify-ts cursor install
graphify-ts copilot install
graphify-ts gemini install
graphify-ts aider install
graphify-ts opencode install
```

If you only want a one-shot context pack from the CLI (no MCP):

```bash
graphify-ts pack "review the auth flow" --task explain
graphify-ts prompt "review the auth flow" --provider claude
```

`pack` emits a compact JSON context payload for automation. `prompt` is the provider-aware context compiler.

---

## On a real production codebase, measured today

NestJS + Next.js SaaS, 1,268 files, ~860K words. Same question, same Claude Opus 4.7, captured from `claude --output-format json`. Receipts in [`docs/benchmarks/2026-04-30-govalidate/`](docs/benchmarks/2026-04-30-govalidate/).

|                        | Without graphify-ts | With graphify-ts | Difference |
|------------------------|---------------------|------------------|------------|
| **Tool-call turns**    | 9                   | **3**            | **3× fewer** |
| **Latency**            | 96 sec              | **35 sec**       | **2.8× faster** |
| **Input tokens** (provider-reported) | 615,190 | **233,508**      | **2.6× fewer** |
| **API keys**           | —                   | **0**            | local + private |
| **Cloud services**     | —                   | **0**            | local + private |

These are **provider-reported** numbers from `claude --output-format json`, not local estimates. **[Reproduce them](docs/benchmarks/2026-04-30-govalidate/verify.sh)** with one shell script against the committed evidence files.

PR-review proof on a real diff:

|                        | Verbose `pr_impact` | Compact `pr_impact` | Difference |
|------------------------|---------------------|---------------------|------------|
| Prompt tokens          | 63,024              | **8,690**           | **7.25× fewer** |

Receipts: [`docs/benchmarks/2026-05-02-govalidate-pr-review/`](docs/benchmarks/2026-05-02-govalidate-pr-review/).

> **The honest summary**: graphify-ts adds a one-time MCP/tool overhead at session start (now ~750 tokens of tool schema for the core profile, down from ~1,070 after [#82](https://github.com/mohanagy/graphify-ts/pull/?q=is%3Apr+82) — a 30% drop). Multi-question sessions amortize this and end up cheaper. Cost trade-offs depend on session length; see **Honest disclosure** below.

---

## See it work

```text
You ask Claude:  "How does the v2 idea generation pipeline work end-to-end?"

Without graphify-ts (9 turns, 96 sec):
  Turn 1  → Glob "**/pipeline/**"
  Turn 2  → Grep "orchestrator"
  Turn 3  → Read planner/orchestrator.worker.ts
  Turn 4  → Read research-agent.service.ts
  Turn 5  → Read assembly.service.ts
  Turn 6  → Read research-compressor.ts
  Turn 7  → Grep "BullMQ"
  Turn 8  → Read queue-registry.service.ts
  Turn 9  → Synthesize answer

With graphify-ts (3 turns, 35 sec):
  Turn 1  → mcp__graphify-ts__retrieve(question, budget=5000)
  Turn 2  → (returns 15 ranked nodes, snippets, communities, paths in ONE response)
  Turn 3  → Synthesize answer

Same model. Same question. Comparable answer quality — both runs cite the right
files and produce detailed end-to-end explanations of the pipeline.
```

---

## Works with your AI tools

graphify-ts produces **local context packs** that any modern coding agent can consume — either over its native MCP integration or by piping the compiled prompt to its CLI.

| Agent | How it connects | Install command |
|---|---|---|
| Claude Code | MCP via `.mcp.json` | `graphify-ts claude install` |
| Cursor | MCP via `.cursor/mcp.json` | `graphify-ts cursor install` |
| GitHub Copilot CLI | MCP via `.vscode/mcp.json` | `graphify-ts copilot install` |
| Gemini CLI | MCP server | `graphify-ts gemini install` |
| Aider | MCP server | `graphify-ts aider install` |
| OpenCode | MCP server | `graphify-ts opencode install` |
| Codex CLI / Windsurf / others | Pipe `graphify-ts prompt` output | `graphify-ts prompt "..." --provider claude` |

These are local installers that write the agent's own MCP config to point at the graphify-ts subprocess. No code is uploaded; no service-side integration is implied.

---

## What's it for

### "Our AI-agent bill is rising and we can't explain why."

A team of 5 engineers asking 20 codebase questions/day each is roughly **$60/day** in baseline session costs. graphify-ts cuts per-session input tokens by 2.6× and finishes in a third of the turns on the codebase the team is asking about. Because cold starts add MCP overhead, the right finance story is **"measure your own session mix: graphify-ts is reliably faster, and multi-question sessions amortize the overhead"** — verifiable on your own repo with `graphify-ts compare`.

### "Code review takes our seniors hours."

The `pr_impact` MCP tool parses the actual git diff into line-aware seed nodes, returns ranked review risks with severity, supporting paths, likely test files, and structural hotspots — **for the changed lines, not the whole repo**. Pair with `review-compare` to prove the compact review prompt is materially smaller on your real PRs (7.25× smaller on the GoValidate diff above).

### "We can't ship our codebase to a hosted index."

Regulated industries, defense contractors, enterprise legal, anything covered by NDA or export control. graphify-ts runs **fully local**: tree-sitter, BM25, optional ONNX embeddings — all on your machine. No SaaS dashboard. No "private cloud" tier. Your code never leaves the laptop unless you explicitly invoke a model you've configured yourself.

---

## Common commands

```bash
graphify-ts generate .                          # build the graph
graphify-ts claude install                      # wire to Claude Code
graphify-ts watch .                             # rebuild on file change
graphify-ts pack "how does auth work?" --task explain          # compact CLI context payload
graphify-ts prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
graphify-ts review-compare graphify-out/graph.json --exec '...' --yes  # PR review benchmark
graphify-ts compare "How does auth work?" --exec '...' --yes           # general benchmark
graphify-ts time-travel main HEAD --view risk   # what changed between two refs
graphify-ts federate frontend/graph.json backend/graph.json  # multi-repo merge
graphify-ts --help                              # full surface
```

For `compare --baseline-mode native_agent`, use a structured Anthropic runner like `cat {prompt_file} | claude -p --output-format json` when you want billed-token reductions. Plain-text Claude runs still save both answers, but the report becomes answer-only.

---

## What you actually get (MCP tools)

These six MCP tools handle the most common agent workflows in the default **core** profile. The full surface is 25 tools, opt-in via `GRAPHIFY_TOOL_PROFILE=full` or `--profile full` on install.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" — returns ranked nodes with code snippets and community context |
| `pr_impact` | "Is this PR safe to merge?" — diff-aware blast radius, ranked review risks, structural hotspots |
| `impact` | "What breaks if I refactor X?" — directed dependents, affected communities, top propagation paths |
| `call_chain` | "How does request flow from X to Y?" — shortest execution paths across the graph |
| `community_overview` | "Show me the architecture" — communities + sizes + bridges across the codebase |
| `graph_stats` | "How big and deep is this graph?" — node/edge counts, density, file-type mix |

Full-profile additions: `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`. Full reference: [examples/mcp-tool-examples.md](examples/mcp-tool-examples.md).

---

## What stays local

Everything, by default. No telemetry, no cloud, no API key required at any stage.

- **Build time**: tree-sitter AST extraction, NetworkX-style graph, Louvain community detection — all CPU-local.
- **Query time**: BM25 lexical scoring + reciprocal-rank fusion + optional local ONNX embeddings (`Xenova/all-MiniLM-L6-v2`, ~25 MB) + optional local cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`).
- **Agent integration**: an MCP stdio server that runs as a local subprocess of the agent. Your code never crosses an HTTP boundary unless you explicitly invoke `compare` against a model you've configured yourself.

The only command that hits an external service is the optional `compare` / `review-compare` runner, which uses **your own** terminal LLM command (e.g. `claude -p` with your existing subscription). graphify never talks to a model directly.

---

## Honest disclosure / limitations

We measure and publish honest numbers, including the trade-offs. Smaller context is not automatically better unless the selected context is relevant — which is why graphify-ts ships coverage contracts (`benchmark`, `eval`, `review-compare`) that prove the smaller pack still contains the required evidence.

1. **Cold-start sessions add a one-time MCP/tool-schema cost at session init.** As of #82 the core (6-tool) profile emits **~3,000 bytes / ~750 tokens** on `tools/list` (down from ~4,270 bytes / ~1,070 tokens, a 30% reduction). The cold-start premium against the no-graph baseline scales with that number; the previously documented "~13%" figure was measured against the older 5K overhead and will be re-benchmarked in the next release. Multi-question sessions amortize this overhead and end up cheaper. A regression test (`tests/unit/mcp-schema-budget.test.ts`) pins the byte ceiling so future tool additions can't silently re-inflate it.
2. **Deep extraction is best on JS/TS** with framework-aware passes for Express, Redux Toolkit, React Router, NestJS, and Next.js. Python / Ruby / Go / Java / Rust use tree-sitter AST. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor.
3. **Static analysis cannot resolve every dynamic runtime behavior.** Runtime-generated routes, heavy meta-programmed decorators, and string-built imports fall back to the base AST graph rather than pretending to be first-class semantics.
4. **Token reduction depends on project structure and task type.** "How does auth work?" benefits more than "fix this typo." Always validate important code changes with tests and review.
5. **Some workflows still need full file reads** — large multi-file refactors, generated-code spelunking, or anything where you actively need to see whole-file context. graphify-ts narrows the agent's first read; it doesn't replace its ability to read.
6. **Comparable tools exist.** `token-savior` publishes a stronger benchmark on a different surface (general agent tasks, MCP-only). `aider`'s repo-map ships a battle-tested PageRank approach that doesn't use MCP at all. **Our angle is local-first plus PR-review-specific tools (`pr_impact`, `risk_map`, `review-compare`) plus multi-repo federation.**

---

## Roadmap

Implemented today:

- ✅ Local graph build for TS/JS/Python/Ruby/Go/Java/Rust + framework-aware TS/JS
- ✅ Semantic Program Index (SPI) v1 — TypeScript type-checker-backed substrate with NestJS / Express / Next.js / React Router / Redux Toolkit / **Hono / Fastify / tRPC / Prisma** framework metadata (`route_path`, slice/store keys, RTK Query endpoints, mount-prefix resolution, tRPC procedure synthesis)
- ✅ MCP server with core (6 tools) and full (25 tools) profiles
- ✅ `pr_impact` + `review-compare` for diff-aware PR review
- ✅ Provider-aware prompt compiler (`prompt`) with Claude cache-reuse semantics
- ✅ Multi-repo federation (`federate`)
- ✅ Time-travel compare across git refs (`time-travel`)
- ✅ Coverage contracts (`benchmark`, `eval`)
- ✅ Native installers for Claude Code, Cursor, Copilot CLI, Gemini CLI, Aider, OpenCode
- ✅ Tighter cold-start MCP overhead (core profile ~3,000 bytes, down from ~4,270 — 30% drop, see #82)
- ✅ Incremental SPI cache — `buildSpiCached` skips the ts.Program pass on unchanged workspaces (#77)
- ✅ Multi-resolution context — `resolution: detail | summary | mixed` on `context_pack` (#76)
- ✅ Better PR-impact coverage scoring — `coverage_score_weighted` (3x for bridge/god hotspots) + severity tiers (#79)
- ✅ Cache-aware prompt layout — `stable_prefix_hash` makes cache-reuse measurable across runs (#80)
- ✅ Delta-only context packs between runs — `delta_session_id` on `context_pack` ships only new nodes per session (#81)
- ✅ Context-pack quality diagnostics & bad-run detection — `quality_score` + structural warnings on every pack (#78)
- ✅ Budgeted value-per-token selection helper — density-greedy `selectByValuePerToken` (#74)

Planned:

- 🔜 Deeper Python / Go semantic passes beyond tree-sitter AST

---

## Context-plane surfaces

graphify-ts ships two complementary public surfaces:

- **CLI context compiler** — `graphify-ts pack` builds compact explain/review/impact payloads for automation, and `graphify-ts prompt` compiles provider-ready prompts for `claude` or `gemini`.
- **MCP context plane** — by default, graphify-ts exposes the **core** MCP profile with 6 tools. Set `GRAPHIFY_TOOL_PROFILE=full` to expose `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, and the rest of the advanced MCP surface without leaving the session.

Use `context_pack` when you want expandable refs plus `claims`, `coverage`, `missing_context`, and the **semantic coverage** contract. The planner classifies prompt intent, applies a task-specific evidence recipe, and reports both evidence-class coverage and semantic buckets like `implementation`, `impact`, `tests`, `configuration`, and `structure`. Use `context_expand` to expand a stable `handle_id` inside the same MCP session. Use `context_prompt` for the provider-ready prompt directly; for Claude, reuse a `session_id` so follow-up prompts resend only deltas and report `effective_token_count` / `reused_context_tokens`.

---

## Public proof

- [Benchmark proof hub (repo artifacts)](https://github.com/mohanagy/graphify-ts/tree/main/docs/benchmarks) — committed benchmark wrappers and evidence
- [GitHub Pages benchmark hub](https://mohanagy.github.io/graphify-ts/) — post-deploy wrapper once Pages is live from `main`
- [Retrieval benchmark artifact](docs/benchmarks/2026-04-30-govalidate/) — raw `claude --output-format json` evidence + `verify.sh`
- [Auth-flow `compare` benchmark](docs/benchmarks/2026-05-09-govalidate-auth-e2e/) — provider-reported `compare --baseline-mode native_agent` reductions on the same codebase (5.28× input tokens, 2.21× turns, 1.58× latency)
- [PR review benchmark artifact](docs/benchmarks/2026-05-02-govalidate-pr-review/) — `review-compare` report, prompts, answers, `verify.sh`

---

## Documentation

- [Quick start guide](docs/proof-workflows.md) — three reproducible workflows: local proof, A/B compare, federated proof
- [Language and capability matrix](docs/language-capability-matrix.md) — exactly what each file type and language gets
- [Why graphify (with detailed numbers)](examples/why-graphify.md) — the long-form evidence
- [MCP tool examples](examples/mcp-tool-examples.md) — real input/output for every tool
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

---

## Credit

graphify-ts is a Node/TypeScript implementation of the [original `graphify`](https://github.com/safishamsi/graphify) by [Safi Shamsi](https://github.com/safishamsi), adapted for local graph workflows and AI agent integration.

## Contributors

Thanks to everyone shaping graphify-ts. The list below is regenerated automatically on every push to `main` by [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml).

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

A specific shout-out to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/graphify-ts/pull/54) — adding OpenCode MCP installer support, the first community-contributed feature in graphify-ts.

## License

MIT. Use it, fork it, ship it.
