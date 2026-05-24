# madar

**Stop making AI agents re-read your repo.** A local **context plane** and **context compiler** for Claude Code, Codex CLI, Copilot CLI, Cursor, Windsurf, and Aider — turn your TypeScript/Node workspace and PR diffs into compact, verifiable context packs.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#trust--limitations)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#trust--limitations)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)

---

## Demo

[![▶ Watch the 30-second demo](https://img.shields.io/badge/%E2%96%B6%EF%B8%8E-Watch%20the%2030%E2%80%91second%20demo-3c873a?style=for-the-badge)](https://github.com/mohanagy/madar#demo)

<!-- GitHub auto-embeds the user-attachment video below; npm renders it as a link only.
     The shields.io button above is the npm-visible affordance back to the inline player on GitHub. -->

https://github.com/user-attachments/assets/a502185f-fa12-4a8f-80d2-172847f209fd

30 seconds: install → `madar generate .` on the GoValidate repo (1,048 files) → `madar claude install --profile core` → `madar compare "Explain the auth flow End to End"`. Anthropic-reported on the same Claude Opus run: **31 → 14 turns (2.21× fewer)**, **170 s → 107 s (1.58× faster)**, **2,811,682 → 532,021 input tokens (5.28× fewer)**. Receipts: [`docs/benchmarks/2026-05-09-govalidate-auth-e2e/`](docs/benchmarks/2026-05-09-govalidate-auth-e2e/).

---

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

Now ask Claude something about your codebase. It calls `retrieve` once, gets back labeled snippets with file paths and community context, and answers — instead of running multiple `Read` / `Grep` / `Glob` calls and accumulating tokens at every turn.

**Other agents:**

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
madar pack "how does auth work?" --task explain          # compact CLI context payload
madar prompt "how does auth work?" --provider claude     # provider-ready compiled prompt
```

Want a tiny reproducible workspace for local demos? Start with [`examples/sample-workspace/`](examples/sample-workspace/) and the [sample workspace tutorial](docs/tutorials/sample-workspace.md).

Want a broader local-first walkthrough that also covers install, `prompt`, and a safe `compare` smoke check? Use the [end-to-end getting started tutorial](docs/tutorials/getting-started.md).

---

## What's new in 0.25.1

- Natural-language runtime-generation prompts like `How idea report is being generated` now route to behavior-slice retrieval automatically, so users do not need special trace phrasing to get backend runtime answers.
- `madar pack --task explain` now defaults to `slice-v1` for those runtime-generation prompts, which means `execution_slice` shows up without asking users to discover the extra retrieval flag. Treat that slice as a static runtime-path hypothesis from the graph, not a live trace.
- `madar compare` now uses the same runtime-generation defaults as `madar pack`, so compare artifacts stay aligned with the actual CLI behavior.

The larger **0.25.0** feature release is still the main capability jump: richer backend `execution_slice` output plus first-pass Go semantic indexing for handler → service → repository style flows. See the [`0.25.0` changelog entry](CHANGELOG.md#0250---2026-05-23) for that broader release.

The larger **What's new in 0.23.0** additions are still part of the main flow too: `madar summary`, the core MCP `graph_summary` tool, runtime `execution_slice` output, share-safe `report.share-safe.json` compare artifacts, and `compare --baseline-mode pack_only`.

If you want the broader proof-oriented workflow behind the current surfaces, start with [proof workflows](docs/proof-workflows.md) and the [GoValidate shared benchmark suite](docs/benchmarks/govalidate-suite/README.md).

### When to use `--spi`

`--spi` is **still opt-in** in 0.25.1. Use it when your repo is framework-heavy TypeScript/JavaScript and you want the extra framework-shaped metadata plus disk cache behavior.

`--spi` is usually worth it for NestJS, Next.js App Router, Prisma, tRPC, Hono, Fastify, and similar repos where users ask storage-oriented prompts, client/server boundary questions, or request-flow questions. The default pipeline is still fine for simpler repos, non-JS/TS workspaces, or quick first runs when you do not need the extra framework detail yet.

---

## What madar is

Modern AI coding agents have one expensive habit: they discover your codebase from scratch every session. They `grep`, then `Read`, then summarize, then forget, then repeat — every prompt.

madar fixes that loop. It indexes a TypeScript/Node workspace (and PR diffs) into a local knowledge graph, then compiles that graph into the **smallest verifiable context pack** the agent actually needs for the task at hand.

```
your prompt
  → workspace graph (built once, reused)
    → relevant nodes + edges + snippets
      → compact context pack (claims, coverage, missing_context)
        → AI coding agent
```

When the agent says "tell me more," it expands a stable `handle_id` inside the same MCP session instead of re-reading the repo from scratch.

### Adaptive context-pack representations

Compiled context packs now have a first-pass **rendering-only** adaptive layer. Retrieval still selects the same nodes and paths first; the runtime only changes how those already-selected nodes are emitted for the task.

The current deterministic core modes are:

- `signature`
- `behavior_sketch`
- `call_chain`
- `contract_view`
- `implementation_excerpt`
- `dependency_record`

That means the same selected nodes can render differently for `explain`, `review`, and `impact` work without changing retrieval selection. The tradeoff is explicit: lower-token renderings carry less raw implementation detail, while explain-oriented packs keep full code snippets when the runtime already has them.

**What it's good at:**
- Cutting per-session input tokens on codebase questions (measured 2.6× fewer on the GoValidate benchmark below).
- PR review via `pr_impact` and `review-compare` — turns the *current git diff* into ranked review risks, structural hotspots, and likely test files (measured 7.25× smaller review prompt on a real PR).
- Local-first by design: tree-sitter AST, BM25 retrieval, optional ONNX embeddings — all on your machine. Your code never leaves the laptop unless you explicitly invoke a model.

> Deepest extraction is still **TypeScript/JavaScript** with framework-aware passes for Express, NestJS, Next.js, React Router, Redux Toolkit, **Hono, Fastify, tRPC, Prisma, and routing-controllers** (10 substrates via `--spi`). Python now has a conservative semantic layer for cross-file import/call resolution, FastAPI router composition plus route/dependency semantics, and first-pass Django URL-conf route-to-view mapping. Go now has a conservative first semantic pass for local-package import resolution, receiver/method call edges, and statically visible `net/http` / Gin / Chi route relationships. Ruby, Java, and Rust still use the tree-sitter AST baseline. C / Kotlin / C# / Scala / PHP / Swift / Zig use a generic structural extractor. Full matrix: [`docs/language-capability-matrix.md`](docs/language-capability-matrix.md).

---

## Measured results

NestJS + Next.js SaaS, 1,268 files, ~860K words. Same question, same Claude Opus 4.7, captured from `claude --output-format json`. Receipts: [`docs/benchmarks/2026-04-30-govalidate/`](docs/benchmarks/2026-04-30-govalidate/).

|                        | Without madar | With madar | Difference |
|------------------------|---------------------|------------------|------------|
| **Tool-call turns**    | 9                   | **3**            | **3× fewer** |
| **Latency**            | 96 sec              | **35 sec**       | **2.8× faster** |
| **Input tokens** (provider-reported) | 615,190 | **233,508**      | **2.6× fewer** |

PR-review proof on a real diff: prompt tokens 63,024 → **8,690** (**7.25× fewer**). Receipts: [`docs/benchmarks/2026-05-02-govalidate-pr-review/`](docs/benchmarks/2026-05-02-govalidate-pr-review/).

`--spi` benchmark (bundled fixture, 7 prompts): **better framework-shaped correctness**, **operational retrieval-level expansion**, **graph.json size −32%**, **cache-hit rebuild −27% vs legacy**, but **no measured explain-pack token win on that fixture**. Receipts: [`docs/benchmarks/2026-05-11-spi-vs-legacy/`](docs/benchmarks/2026-05-11-spi-vs-legacy/).

Latest runtime-pack refinement: **runtime-generation prompts stay compact** by following the strongest backend runtime path and suppressing sibling routes, script/migration noise, and shared-hub fan-out on broad backend-generation questions.

Single-prompt backend benchmark snapshot: in one real GoValidate `compare --baseline-mode native_agent` run for `"Explain how idea report is getting generated"`, madar reduced Anthropic-reported input tokens from **1,653,307** to **498,280** (~**69.9%** lower). Multi-question native-agent compare runs now also roll up suite wins/losses for input tokens, turns, and latency, report mean/median input-token reduction, call out comparable-question counts when some runs are excluded from the aggregate, and highlight the best win and worst regression prompt. Details and caveats: [`docs/benchmarks/2026-05-12-govalidate-report-generation/`](docs/benchmarks/2026-05-12-govalidate-report-generation/).

[Reproduce them](docs/benchmarks/2026-04-30-govalidate/verify.sh) with one shell script against the committed evidence files.

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

For Claude, Cursor, Copilot, and Gemini, `--profile strict` keeps the lean core MCP tool surface but rewrites the generated guidance into a compact flow: call `context_pack` once for the task before broader exploration, answer from the pack when coverage is complete, expand only when diagnostics show missing evidence, and avoid raw file search unless the pack is insufficient.

Aider and OpenCode are intentionally context-pack-first: run `madar generate .`, install the profile, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. `madar aider install` writes an AGENTS.md profile only; remove it with `madar aider uninstall`. `madar opencode install` writes the AGENTS.md profile, `.opencode/plugins/madar.js`, and the madar MCP entry in `opencode.json` or `opencode.jsonc`; remove only madar-owned content with `madar opencode uninstall`. Manual verification does not require either agent binary: inspect the generated files after install, then confirm uninstall removes only the madar entries.

Codex is intentionally context-pack-first: run `madar generate .`, install with `madar codex install`, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. To remove the profile, run `madar codex uninstall`; it removes the madar AGENTS.md section and Codex hook while preserving unrelated content. Manual verification does not require Codex to be installed: inspect `AGENTS.md` and `.codex/hooks.json` after install, then confirm uninstall removes only madar content.

For practical multi-agent workflows across Claude Code, Codex, Copilot, Cursor, and Gemini, see the [agent orchestration guide](docs/integrations/agent-orchestration.md).

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

Full-profile additions: `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`. Full reference: [examples/mcp-tool-examples.md](examples/mcp-tool-examples.md).

Within one MCP stdio session, identical `context_pack` requests for `task=explain` are reused automatically when the graph version and relevant prompt/options match. The cache is memory-only, skips delta-session packs, and invalidates itself when `graph.json` changes.

When the selected question is a runtime-generation flow, the shared compact response can also carry an `execution_slice` section with ordered steps and partial-path signaling. That gives agents a stable "what happens next" sketch without forcing them to read the full raw slice first. It is a static runtime-path hypothesis from graph evidence, not a live trace. Its nested `phase_coverage` is the same kind of static, prompt-scoped model, so broad report-generation questions can surface planner/research/report-builder/scoring/renderer/persistence phases without implying live instrumentation.

---

## Common commands

```bash
madar generate .                          # build the graph
madar generate . --spi                    # opt-in SPI pipeline (framework metadata + disk cache)
madar watch .                             # rebuild on file change
madar summary                             # bounded JSON overview before deeper retrieval
madar pack "how does auth work?" --task explain          # compact CLI context payload
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

- [Quick start guide](docs/proof-workflows.md) — three reproducible workflows: local proof, A/B compare, federated proof
- [GoValidate shared benchmark suite](docs/benchmarks/govalidate-suite/README.md) — public prompt set plus deterministic pack/answer quality gates
- [Public roadmap](docs/roadmap.md) — contributor-facing priority tracks and issue links
- [Language and capability matrix](docs/language-capability-matrix.md) — exactly what each file type and language gets
- [Performance benchmark harness](docs/benchmarks/performance/README.md) — repeatable `generate` / `update` / `cluster-only` measurements
- [MCP tool examples](examples/mcp-tool-examples.md) — real input/output for every tool
- [Benchmark hub](https://github.com/mohanagy/madar/tree/main/docs/benchmarks) — committed wrappers and provider-reported evidence
- [Changelog](CHANGELOG.md) — full per-release notes
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## Contributors

Thanks to everyone shaping madar. The list below is regenerated automatically on every push to `main` by [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml).

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
