# graphify-ts

**Make Claude Code, Cursor, and Copilot faster on your codebase — locally, without sending code to anyone.**

[![npm](https://img.shields.io/npm/v/@mohammednagy/graphify-ts)](https://www.npmjs.com/package/@mohammednagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#what-stays-local)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#what-stays-local)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/graphify-ts/blob/main/LICENSE)

graphify-ts builds a local knowledge graph of your code (no upload, no API key) and lets your AI agent answer codebase questions in **fewer turns** by retrieving structured context in a single MCP call instead of running many sequential `Read` / `Grep` / `Glob` calls.

---

## On a real production codebase, measured today

NestJS + Next.js SaaS, 1,268 files, ~860K words. Same question, same Claude Opus 4.7, captured from `claude --output-format json`. Receipts in [`docs/benchmarks/2026-04-30-govalidate/`](docs/benchmarks/2026-04-30-govalidate/).

|                        | Without graphify-ts | With graphify-ts | Difference |
|------------------------|---------------------|------------------|------------|
| **Tool-call turns**    | 9                   | **3**            | **3× fewer** |
| **Latency**            | 96 sec              | **35 sec**       | **2.8× faster** |
| **Input tokens**       | 615,190             | **233,508**      | **2.6× fewer** |
| **API keys**           | —                   | **0**            | local + private |
| **Cloud services**     | —                   | **0**            | local + private |

**[Reproduce these numbers](docs/benchmarks/2026-04-30-govalidate/verify.sh)** with one shell script against the committed evidence files.

> **The honest summary**: graphify-ts adds a one-time MCP/tool overhead at session start, but in the measured run it still cut turns and latency substantially. Cost trade-offs depend on session length; see **Honest disclosure** below.

---

## 60-second quickstart

```bash
npm install -g @mohammednagy/graphify-ts

cd your-project
graphify-ts generate .          # builds graphify-out/graph.json
graphify-ts claude install      # wires Claude Code to use it
```

Now ask Claude something about your codebase. It calls `retrieve` once, gets back labeled snippets with file paths and community context, and answers — instead of running multiple `Read` / `Grep` / `Glob` calls and accumulating tokens at every turn.

Other agents: `cursor install`, `copilot install`, `gemini install`, `aider install`, `opencode install`.

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

## What's it for

graphify-ts is most valuable when one of these is true.

### "Our Claude Code bill is rising and I can't explain why."

A team of 5 engineers asking 20 codebase questions/day each is roughly **$60/day** in baseline Claude session costs. graphify-ts cuts per-session input tokens by 2.6× and finishes in a third of the turns on the codebase the team is asking about. Because cold starts add MCP overhead, the right finance story is **"measure your own session mix: graphify-ts is reliably faster, and multi-question sessions can amortize the overhead"** — verifiable on your own repo with `graphify-ts compare`.

### "Code review takes our seniors hours."

The `pr_impact` MCP tool parses the actual git diff into line-aware seed nodes, returns ranked review risks with severity, supporting paths, likely test files, and structural hotspots — **for the changed lines, not the whole repo**. Pair with the `review-compare` CLI to prove the compact review prompt is materially smaller than the verbose one on your real PRs.

### "We can't ship our codebase to a hosted index."

Regulated industries, defense contractors, enterprise legal, anything covered by NDA or export control. graphify-ts runs **fully local**: tree-sitter, BM25, optional ONNX embeddings — all on your machine. No SaaS dashboard. No "private cloud" tier. Your code never leaves the laptop unless you explicitly invoke a model you've configured yourself.

---

## Honest disclosure

We measure and publish honest numbers, including the trade-offs.

1. **Cold-start sessions cost about 13% more than no-graph baseline** because the MCP server adds ~5K of tool-schema overhead at session init. Multi-question sessions amortize this and end up cheaper. We're tightening it further; watch the changelog.
2. **Deep extraction is best on JS/TS** with framework-aware passes for Express, Redux Toolkit, React Router, NestJS, and Next.js. Python / Ruby / Go / Java / Rust use tree-sitter AST. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor. Full matrix: [`docs/language-capability-matrix.md`](docs/language-capability-matrix.md).
3. **The graph is opinionated, not exhaustive.** It's a structural map for an agent, not a complete program-analysis database. Runtime-generated routes and heavily meta-programmed decorators fall back to the base AST graph rather than pretending to be first-class semantics.
4. **Comparable tools exist.** `token-savior` publishes a stronger benchmark on a different surface (general agent tasks, MCP-only). `aider`'s repo-map ships a battle-tested PageRank approach that doesn't use MCP at all. **Our angle is local-first plus PR-review-specific tools (`pr_impact`, `risk_map`, `review-compare`) plus multi-repo federation.**

---

## How it's different (in two sentences)

The combination we have not found in a single comparable tool today: **local-only** (no cloud, no API key) plus **MCP-protocol native** (works with Claude / Cursor / Copilot / Gemini / Aider via install commands) plus **diff-aware PR-review tools** (`pr_impact`, `risk_map`, `review-compare`) plus **multi-repo federation** (`federate`). aider's repo-map is local but aider-only; Cursor's `@codebase` is MCP-friendly but cloud-indexed; Sourcegraph Cody self-hosts but is enterprise-priced.

The short version: graphify-ts is local-first, MCP-native, diff-aware for PR review, and built to work across multiple repos without sending code to a hosted indexing service.

---

## Common commands

```bash
graphify-ts generate .                          # build the graph
graphify-ts claude install                      # wire to Claude Code
graphify-ts watch .                             # rebuild on file change
graphify-ts review-compare graphify-out/graph.json --exec '...' --yes  # PR review benchmark
graphify-ts compare "How does auth work?" --exec '...' --yes           # general benchmark
graphify-ts time-travel main HEAD --view risk   # what changed between two refs
graphify-ts federate frontend/graph.json backend/graph.json  # multi-repo merge
graphify-ts --help                              # full surface
```

---

## What you actually get

These five MCP tools handle the most common agent workflows. The full surface is 21 tools, opt-in via `GRAPHIFY_TOOL_PROFILE=full`.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" — returns ranked nodes with code snippets and community context |
| `pr_impact` | "Is this PR safe to merge?" — diff-aware blast radius, ranked review risks, structural hotspots |
| `impact` | "What breaks if I refactor X?" — directed dependents, affected communities, top propagation paths |
| `relevant_files` | "Where do I edit to add feature Y?" — ranked starter files with reasoning |
| `community_overview` | "Show me the architecture" — communities + sizes + bridges across the codebase |

Plus `risk_map`, `implementation_checklist`, `call_chain`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`, `graph_stats`. Full reference: [examples/mcp-tool-examples.md](examples/mcp-tool-examples.md).

---

## What stays local

Everything, by default. No telemetry, no cloud, no API key required at any stage.

- **Build time**: tree-sitter AST extraction, NetworkX-style graph, Louvain community detection — all CPU-local.
- **Query time**: BM25 lexical scoring + reciprocal-rank fusion + optional local ONNX embeddings (`Xenova/all-MiniLM-L6-v2`, ~25 MB) + optional local cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`).
- **Agent integration**: an MCP stdio server that runs as a local subprocess of the agent. Your code never crosses an HTTP boundary unless you explicitly invoke `compare` against a model you've configured yourself.

The only command that hits an external service is the optional `compare` / `review-compare` runner, which uses **your own** terminal LLM command (e.g. `claude -p` with your existing subscription). graphify never talks to a model directly.

---

## Public proof

- [Benchmark proof hub (repo artifacts)](https://github.com/mohanagy/graphify-ts/tree/main/docs/benchmarks) — live now; browse the committed benchmark wrappers and evidence in GitHub
- [GitHub Pages benchmark hub](https://mohanagy.github.io/graphify-ts/) — post-deploy wrapper once Pages is live from `main`
- [Retrieval benchmark artifact](docs/benchmarks/2026-04-30-govalidate/) — raw `claude --output-format json` evidence + `verify.sh`
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
<!-- readme: contributors -end -->

A specific shout-out to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/graphify-ts/pull/54) — adding OpenCode MCP installer support, the first community-contributed feature in graphify-ts.

## License

MIT. Use it, fork it, ship it.
