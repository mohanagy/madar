# graphify-ts

**Stop making AI agents re-read your repo.** A local **context plane** and **context compiler** for Claude Code, Codex CLI, Copilot CLI, Cursor, Windsurf, and Aider — turn your TypeScript/Node workspace and PR diffs into compact, verifiable context packs.

[![npm](https://img.shields.io/npm/v/@mohammednagy/graphify-ts)](https://www.npmjs.com/package/@mohammednagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#trust--limitations)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#trust--limitations)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)

---

## Demo

[![▶ Watch the 30-second demo](https://img.shields.io/badge/%E2%96%B6%EF%B8%8E-Watch%20the%2030%E2%80%91second%20demo-3c873a?style=for-the-badge)](https://github.com/mohanagy/graphify-ts#demo)

<!-- GitHub auto-embeds the user-attachment video below; npm renders it as a link only.
     The shields.io button above is the npm-visible affordance back to the inline player on GitHub. -->

https://github.com/user-attachments/assets/a502185f-fa12-4a8f-80d2-172847f209fd

30 seconds: install → `graphify-ts generate .` on the GoValidate repo (1,048 files) → `graphify-ts claude install --profile core` → `graphify-ts compare "Explain the auth flow End to End"`. Anthropic-reported on the same Claude Opus run: **31 → 14 turns (2.21× fewer)**, **170 s → 107 s (1.58× faster)**, **2,811,682 → 532,021 input tokens (5.28× fewer)**. Receipts: [`docs/benchmarks/2026-05-09-govalidate-auth-e2e/`](docs/benchmarks/2026-05-09-govalidate-auth-e2e/).

---

## Quickstart

```bash
npm install -g @mohammednagy/graphify-ts

cd your-project
graphify-ts generate .          # builds graphify-out/graph.json (no API key, no cloud)
graphify-ts claude install      # wires Claude Code to use it via MCP

# Or use the opt-in SPI pipeline for framework-aware metadata + disk cache:
graphify-ts generate . --spi
```

Now ask Claude something about your codebase. It calls `retrieve` once, gets back labeled snippets with file paths and community context, and answers — instead of running multiple `Read` / `Grep` / `Glob` calls and accumulating tokens at every turn.

**Other agents:**

```bash
graphify-ts cursor install      # Cursor
graphify-ts copilot install     # GitHub Copilot CLI
graphify-ts gemini install      # Gemini CLI
graphify-ts aider install       # Aider
graphify-ts opencode install    # OpenCode
```

**Or use it without MCP** — pipe the compiled prompt directly to your agent's CLI:

```bash
graphify-ts pack "how does auth work?" --task explain          # compact CLI context payload
graphify-ts prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
```

---

## What graphify-ts is

Modern AI coding agents have one expensive habit: they discover your codebase from scratch every session. They `grep`, then `Read`, then summarize, then forget, then repeat — every prompt.

graphify-ts fixes that loop. It indexes a TypeScript/Node workspace (and PR diffs) into a local knowledge graph, then compiles that graph into the **smallest verifiable context pack** the agent actually needs for the task at hand.

```
your prompt
  → workspace graph (built once, reused)
    → relevant nodes + edges + snippets
      → compact context pack (claims, coverage, missing_context)
        → AI coding agent
```

When the agent says "tell me more," it expands a stable `handle_id` inside the same MCP session instead of re-reading the repo from scratch.

**What it's good at:**
- Cutting per-session input tokens on codebase questions (measured 2.6× fewer on the GoValidate benchmark below).
- PR review via `pr_impact` and `review-compare` — turns the *current git diff* into ranked review risks, structural hotspots, and likely test files (measured 7.25× smaller review prompt on a real PR).
- Local-first by design: tree-sitter AST, BM25 retrieval, optional ONNX embeddings — all on your machine. Your code never leaves the laptop unless you explicitly invoke a model.

> Deepest extraction is **TypeScript/JavaScript** with framework-aware passes for Express, NestJS, Next.js, React Router, Redux Toolkit, **Hono, Fastify, tRPC, Prisma** (9 substrates via `--spi`). Python, Ruby, Go, Java, Rust use tree-sitter AST. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor. Full matrix: [`docs/language-capability-matrix.md`](docs/language-capability-matrix.md).

---

## Measured results

NestJS + Next.js SaaS, 1,268 files, ~860K words. Same question, same Claude Opus 4.7, captured from `claude --output-format json`. Receipts: [`docs/benchmarks/2026-04-30-govalidate/`](docs/benchmarks/2026-04-30-govalidate/).

|                        | Without graphify-ts | With graphify-ts | Difference |
|------------------------|---------------------|------------------|------------|
| **Tool-call turns**    | 9                   | **3**            | **3× fewer** |
| **Latency**            | 96 sec              | **35 sec**       | **2.8× faster** |
| **Input tokens** (provider-reported) | 615,190 | **233,508**      | **2.6× fewer** |

PR-review proof on a real diff: prompt tokens 63,024 → **8,690** (**7.25× fewer**). Receipts: [`docs/benchmarks/2026-05-02-govalidate-pr-review/`](docs/benchmarks/2026-05-02-govalidate-pr-review/).

`--spi` benchmark (bundled fixture, 7 prompts): **better framework-shaped correctness**, **operational retrieval-level expansion**, **graph.json size −32%**, **cache-hit rebuild −27% vs legacy**, but **no measured explain-pack token win on that fixture**. Receipts: [`docs/benchmarks/2026-05-11-spi-vs-legacy/`](docs/benchmarks/2026-05-11-spi-vs-legacy/).

[Reproduce them](docs/benchmarks/2026-04-30-govalidate/verify.sh) with one shell script against the committed evidence files.

---

## Works with your AI tools

graphify-ts produces local context packs that any modern coding agent can consume — over MCP or by piping the compiled prompt to its CLI.

| Agent | Connection | Install command |
|---|---|---|
| Claude Code | MCP via `.mcp.json` | `graphify-ts claude install` |
| Cursor | MCP via `.cursor/mcp.json` | `graphify-ts cursor install` |
| GitHub Copilot CLI | MCP via `.vscode/mcp.json` | `graphify-ts copilot install` |
| Gemini CLI | MCP server | `graphify-ts gemini install` |
| Aider | MCP server | `graphify-ts aider install` |
| OpenCode | MCP server | `graphify-ts opencode install` |
| Codex CLI / Windsurf / others | Pipe `graphify-ts prompt` output | `graphify-ts prompt "..." --provider claude` |

These are local installers that write the agent's own MCP config to point at the graphify-ts subprocess. No code is uploaded.

---

## MCP tools

These six MCP tools handle the most common agent workflows in the default **core** profile. The full surface is 25 tools, opt-in via `GRAPHIFY_TOOL_PROFILE=full` or `--profile full` on install.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" — ranked nodes + code snippets + community context |
| `pr_impact` | "Is this PR safe to merge?" — diff-aware blast radius + ranked review risks |
| `impact` | "What breaks if I refactor X?" — directed dependents + affected communities |
| `call_chain` | "How does request flow from X to Y?" — shortest execution paths |
| `community_overview` | "Show me the architecture" — communities + sizes + bridges |
| `graph_stats` | "How big is this graph?" — node/edge counts, density, file-type mix |

Full-profile additions: `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`. Full reference: [examples/mcp-tool-examples.md](examples/mcp-tool-examples.md).

---

## Common commands

```bash
graphify-ts generate .                          # build the graph
graphify-ts generate . --spi                    # opt-in SPI pipeline (framework metadata + disk cache)
graphify-ts watch .                             # rebuild on file change
graphify-ts pack "how does auth work?" --task explain          # compact CLI context payload
graphify-ts pack "why does auth fail?" --task explain --retrieval-strategy slice-v1
graphify-ts prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
graphify-ts review-compare graphify-out/graph.json --exec '...' --yes  # PR review benchmark
graphify-ts compare "How does auth work?" --exec '...' --yes           # general benchmark
graphify-ts time-travel main HEAD --view risk   # what changed between two refs
graphify-ts federate frontend/graph.json backend/graph.json  # multi-repo merge
graphify-ts --help                              # full surface
```

---

## Default discovery rules

`graphify-ts generate` now hard-ignores nested VCS/worktree copies and generated/build output by default: `.worktrees/`, `worktrees/`, `.git/`, `graphify-out/`, `node_modules/`, `dist/`, `build/`, `coverage/`, cache folders, source maps, lock/build artifacts, and temp/log files.

Tests, benchmarks, fixtures, mocks, and config files are **not** hard-ignored anymore. They still get indexed so retrieval can use them when you ask for them, but production/runtime prompts now soft-penalize them and honor prompt exclusions like "exclude tests, benchmarks, fixtures".

`.graphifyignore` still adds extra ignore rules, and negated entries such as `!vendor/**` or `!lib/**` can re-include a default hard-ignore when you intentionally want it indexed.

---

## Trust + limitations

Everything stays local by default. No telemetry, no cloud upload, no API key required.

- **Build:** tree-sitter AST extraction + Louvain community detection — all CPU-local.
- **Query:** BM25 lexical scoring + reciprocal-rank fusion + optional ONNX embeddings (`Xenova/all-MiniLM-L6-v2`, ~25 MB) + optional cross-encoder reranker.
- **Integration:** MCP stdio server runs as a local subprocess of your agent. Your code never crosses an HTTP boundary unless you explicitly invoke `compare` against a model you've configured yourself.

**Limitations to know:**

1. **Cold-start sessions add a one-time MCP/tool-schema cost.** Core profile is ~3,000 bytes / ~750 tokens (down 30% from the original 4,270-byte surface). Multi-question sessions amortize this and end up cheaper.
2. **Deep extraction is best on JS/TS.** Python / Ruby / Go / Java / Rust use tree-sitter AST. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor.
3. **Static analysis can't resolve every dynamic runtime behavior.** Runtime-generated routes, heavy meta-programmed decorators, and string-built imports fall back to the base AST graph.
4. **Token reduction depends on project + task.** "How does auth work?" benefits more than "fix this typo." Always validate important code changes with tests and review.
5. **Some workflows still need full file reads** — large multi-file refactors, generated-code spelunking. graphify narrows the agent's first read; it doesn't replace its ability to read.

---

## Documentation & receipts

- [Quick start guide](docs/proof-workflows.md) — three reproducible workflows: local proof, A/B compare, federated proof
- [Language and capability matrix](docs/language-capability-matrix.md) — exactly what each file type and language gets
- [MCP tool examples](examples/mcp-tool-examples.md) — real input/output for every tool
- [Benchmark hub](https://github.com/mohanagy/graphify-ts/tree/main/docs/benchmarks) — committed wrappers and provider-reported evidence
- [Changelog](CHANGELOG.md) — full per-release notes
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

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

---

## Credit

graphify-ts is a Node/TypeScript implementation of the [original `graphify`](https://github.com/safishamsi/graphify) by [Safi Shamsi](https://github.com/safishamsi), adapted for local graph workflows and AI agent integration.

## License

MIT. Use it, fork it, ship it.
