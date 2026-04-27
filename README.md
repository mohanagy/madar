# graphify-ts

[![npm](https://img.shields.io/npm/v/@mohammednagy/graphify-ts)](https://www.npmjs.com/package/@mohammednagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-3178c6)](https://www.typescriptlang.org/)
[![Vitest 3.2](https://img.shields.io/badge/tests-Vitest%203.2-6e9f18)](https://vitest.dev/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#what-this-package-is-best-at-today)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#what-this-package-is-best-at-today)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/graphify-ts/blob/main/LICENSE)

`graphify-ts` is a local TypeScript CLI that turns codebases and mixed project folders into queryable knowledge graphs. It generates graph artifacts that AI agents (Claude, Copilot, Cursor, Gemini) use to answer codebase questions with structural awareness — impact analysis, call chains, cross-repo connections — without sending your code anywhere.

**Zero cloud. Zero API keys. The agent you already have does the intelligence work.**

## What this package is best at today

- **Generate local graph artifacts** for a repository or mixed project folder
- **Give AI agents structured codebase context** via MCP tools (`retrieve`, `impact`, `call_chain`, `pr_impact`)
- **Explore the graph** through interactive HTML, reports, and CLI commands
- **Analyze blast radius** before making changes — know what breaks across modules and repos
- **Federate multiple repos** into a single queryable super-graph

## Install

```bash
npm install -g @mohammednagy/graphify-ts
```

## Quick start

```bash
# Generate the graph
graphify-ts generate .

# Set up your AI agent integration
graphify-ts claude install    # or cursor, copilot, gemini

# Now your agent can use retrieve, impact, call_chain, and other MCP tools
```

Need the exact support matrix? See [docs/language-capability-matrix.md](docs/language-capability-matrix.md). Need the reproducible proof ladder? See [docs/proof-workflows.md](docs/proof-workflows.md) and [examples/why-graphify.md](examples/why-graphify.md).

What you get in `graphify-out/`:

```text
graphify-out/
├── graph.html       interactive explorer (overview + community pages)
├── GRAPH_REPORT.md  structure signals, god nodes, anomalies, suggested questions
├── graph.json       machine-readable graph for MCP tools and queries
├── graph-pages/     per-community explorer pages
├── docs/            auto-generated module documentation (with --docs)
└── cache/           content-addressed extraction cache
```

## 3-command proof (demo workspace)

This repo includes a tiny checked-in workspace at `examples/demo-repo/` plus a labeled question set. From the repo root, run `npm install && npm run build` once, then:

```bash
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
```

Outputs land in `examples/demo-repo/graphify-out/`, which is ignored so you can rerun the demo without polluting git status.

- `benchmark` proves the graph is cheaper to query than reading the corpus naively, while still covering the labeled demo questions and their expected evidence. On the checked-in demo repo you should see `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, and about `1.7x` fewer tokens per query.
- `eval` proves retrieval quality on the same labeled questions: recall plus ranking quality (MRR). On the checked-in demo repo you should see `Recall: 100.0%`, `MRR: 1.000`, and about `2.7x` fewer tokens at query time.
- The demo repo is intentionally tiny, so these ratios are lower than the production benchmark below. The point is that the proof is fully reproducible from this repo.

## Real A/B compare (same question, same model)

`benchmark` and `eval` are offline graph measurements. `compare` is the paid, real-world proof path: it builds a naive baseline prompt plus a graphify-guided prompt for the same question, runs both through your own terminal LLM command, and saves both answers.

```bash
node dist/src/cli/bin.js compare "How does login create a session?" \
  --graph examples/demo-repo/graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

Gemini-safe installed-CLI invocation:

```bash
graphify-ts compare "How does auth work?" \
  --exec 'cat {prompt_file} | gemini -p "" --output-format json' \
  --yes
```

What `compare` does:

- Prints a warning before execution because it may consume paid model tokens. Use `--yes` for non-interactive runs and CI.
- Expands runner placeholders: `{prompt_file}`, `{question}`, `{mode}`, and `{output_file}`.
- For large prompts, pass `{prompt_file}` through stdin or file redirection. Avoid shell command substitution around `{prompt_file}` (for example `$(cat {prompt_file})`), which can hit OS argument-length limits.
- Writes a proof bundle under `graphify-out/compare/<timestamp>/` with `baseline-prompt.txt`, `graphify-prompt.txt`, `baseline-answer.txt`, `graphify-answer.txt`, and `report.json`.
- Promotes provider-reported usage into `report.json` and the terminal summary when the runner emits structured JSON with usage (for Gemini, `usageMetadata` from `--output-format json`; for Claude, structured JSON with `usage`).
- Falls back to labeled local `cl100k_base` prompt estimates when the runner only returns answer text or malformed JSON, so the token source stays explicit.
- Preserves partial artifacts when one side fails, and classifies prompt-size failures such as `Prompt is too long` as `context_overflow` evidence in `report.json`.

Use `compare` when you want a showcase or a customer-proof run. Use `benchmark` and `eval` when you want repeatable local measurements without calling a model; they remain offline estimate surfaces rather than provider-reported usage surfaces.

## Graph time travel (ref-to-ref graph compare)

Use `graphify-ts time-travel <from> <to>` to compare two git refs through local graph snapshots:

```bash
graphify-ts time-travel main HEAD
graphify-ts time-travel v0.8.2 HEAD --view risk
graphify-ts time-travel main HEAD --view timeline --json
```

How it works today:

- On first use, graphify-ts materializes each ref on demand, builds a local snapshot, and stores it under `graphify-out/time-travel/snapshots/<commit-sha>/`
- Later runs reuse compatible cached snapshots automatically; pass `--refresh` to rebuild both refs
- There is no background history daemon or persistent snapshot service — snapshots are built only when you request a compare

Views:

- `summary` (default): headline, why-it-matters bullets, node/edge deltas, and changed communities
- `risk`: changed labels ranked by transitive dependents
- `drift`: nodes that moved between communities
- `timeline`: added/removed nodes and edges plus community-move events

The CLI defaults to the `summary` view. Pass `--json` when you want the raw result object instead of terminal formatting.

## MCP Tools for AI Agents

When an agent connects via `graphify-ts serve --stdio`, it gets these tools:

| Tool | What it does |
|------|-------------|
| `retrieve` | One-call context retrieval — question + token budget → matched nodes with code snippets, relationships, community context, and relevance bands |
| `impact` | Blast radius analysis — "if I change X, what could break?" with directed dependents, affected communities, and path evidence |
| `call_chain` | Execution path tracing — all paths from A to B filtered by edge type |
| `pr_impact` | PR risk analysis — git diff → affected nodes → aggregate blast radius |
| `community_details` | Hierarchical community data at micro/mid/macro zoom levels |
| `community_overview` | Quick overview of all communities — names, sizes, top nodes |
| `query_graph` | Graph traversal for a natural language question |
| `time_travel_compare` | Compare two refs using on-demand cached graph snapshots and return `summary`, `risk`, `drift`, or `timeline` JSON |
| `get_node` | Node details |
| `explain_node` | Node + neighborhood summary |
| `shortest_path` | Shortest path between two concepts |
| `graph_diff` | Compare two graph snapshots |
| `god_nodes` | Most connected non-file nodes |
| `semantic_anomalies` | Structural anomalies and coupling signals |
| `get_community` | Community members |

The agent uses these tools to answer questions like:
- "How does authentication work?" → `retrieve` returns relevant nodes with code snippets
- "What breaks if I refactor SessionManager?" → `impact` shows directed dependents, affected communities, and the highest-signal propagation paths
- "How does a request flow from the API to the database?" → `call_chain` traces the execution path
- "Is this PR safe to merge?" → `pr_impact` computes blast radius of all changes
- "What changed between main and HEAD?" → `time_travel_compare` builds or reuses local snapshots and returns a summary, risk, drift, or timeline view

## Multi-Repo Federation

For teams with multiple repos (microservices, frontend/backend splits):

```bash
graphify-ts federate \
  frontend/graphify-out/graph.json \
  backend/graphify-out/graph.json \
  shared/graphify-out/graph.json \
  --output federated-out
```

This merges graphs and infers cross-repo connections from shared types and function names. All MCP tools work on the federated graph.

## Common commands

| Command | What it does |
|---|---|
| `generate [path]` | Build graph artifacts for a folder |
| `generate [path] --docs` | Also generate per-community module documentation |
| `generate [path] --include-docs` | Include .md/.txt/.rst files (excluded by default) |
| `federate <g1> <g2> ...` | Merge graphs from multiple repos |
| `watch [path]` | Build once, then watch for changes |
| `serve [graph.json]` | Serve graph via HTTP or stdio (MCP) |
| `query "<question>"` | Traverse the graph for a question |
| `diff <baseline.json>` | Compare two graph snapshots |
| `path <source> <target>` | Find shortest path between concepts |
| `explain <label>` | Explain one node and its neighborhood |
| `add <url> [path]` | Ingest a URL and rebuild |
| `benchmark [graph.json]` | Measure token reduction and structure signals |
| `eval [graph.json]` | Measure retrieval quality: recall and MRR |
| `compare [question]` | Run a real baseline-vs-graphify prompt comparison through your own terminal LLM command |
| `time-travel <from> <to>` | Compare two refs via on-demand local graph snapshots (`summary` default; `risk`, `drift`, `timeline` optional) |
| `install --platform claude` | Install home-level Claude skill |
| `claude install` | Install project-local Claude integration with MCP auto-start |

For the full command surface: `graphify-ts --help`

## AI Platform Integration

```bash
# Once per machine
npm install -g @mohammednagy/graphify-ts
graphify-ts install --platform claude    # home-level skill

# Once per repository
graphify-ts claude install               # project-local rules + MCP server auto-start

# Regenerate whenever the code changes
graphify-ts generate .
```

`claude install` does three things:
1. Writes rules to `CLAUDE.md` telling the agent to use `retrieve` for codebase questions
2. Registers a PreToolUse hook that reminds the agent about the graph
3. Configures the MCP server to auto-start in `.mcp.json`

The generated `.mcp.json` is project-local setup for your machine. Keep it out of version control, rerun `graphify-ts claude install` after upgrading `graphify-ts` so the pinned MCP package version stays current, and regenerate it locally instead of committing a user-specific graph path.

Other platforms: `cursor install`, `copilot install`, `gemini install`, `aider install`

## Capability coverage

The public support matrix is in [docs/language-capability-matrix.md](docs/language-capability-matrix.md). The short version:

| Area | Current implementation |
|---|---|
| TypeScript / JavaScript | TypeScript compiler API |
| Python / Ruby / Go / Java / Rust | Tree-sitter WASM primary path with local fallback |
| C-family / Kotlin / C# / Scala / PHP / Swift / Zig | Generic structural extractor |
| Lua / Elixir / Julia / PowerShell / Objective-C / TOC | Lightweight language-specific scanners |
| Markdown / text / PDF / DOCX / XLSX | Structured document extractors |
| Images / audio / video | Metadata-only asset nodes |
| URL ingest | GitHub, Reddit, Hacker News, X/Twitter, arXiv, YouTube, PDF, image, audio, video, webpage |
| Everything else | No registered capability yet |

That distinction matters: some paths are AST-backed, some are tree-sitter-backed with fallback, some are heuristic, and some asset types are metadata only. The matrix document is the precise source of truth.

## Optional generate flags

```bash
graphify-ts generate . --wiki          # crawlable wiki
graphify-ts generate . --obsidian      # Obsidian vault
graphify-ts generate . --svg           # SVG export
graphify-ts generate . --graphml       # GraphML for graph tools
graphify-ts generate . --neo4j         # Cypher file for Neo4j
graphify-ts generate . --neo4j-push bolt://localhost:7687  # direct push
graphify-ts generate . --docs          # per-community documentation
graphify-ts generate . --include-docs  # include markdown/text files
```

## Benchmarks — Real Numbers from a Production Codebase

Measured on a production NestJS + Next.js SaaS (1,268 files, ~860K words):

| Metric | Value |
|--------|-------|
| Retrieve compression | **384x** (3K tokens vs 1.1M corpus) |
| Impact analysis (User entity) | 67 direct + 589 transitive dependents across 318 files |
| Community detection | 10,474 nodes → 2,244 communities (Louvain) |
| Generation time | ~30 seconds |
| API keys required | **0** |

See [`examples/why-graphify.md`](examples/why-graphify.md) for detailed benchmarks and [`examples/mcp-tool-examples.md`](examples/mcp-tool-examples.md) for real MCP tool input/output.

Run the quick benchmark on your own project:

```bash
cd your-project
npx @mohammednagy/graphify-ts generate .
npx @mohammednagy/graphify-ts benchmark graphify-out/graph.json
```

## Credit

`graphify-ts` gives full credit to the original [`graphify`](https://github.com/safishamsi/graphify) project by [Safi Shamsi](https://github.com/safishamsi). This is a Node/TypeScript implementation of that vision, adapted for local graph workflows and AI agent integration.

## Contributing

Contributions welcome — parser fixes, regression coverage, docs, install-flow polish, and graph-quality improvements.

- [CONTRIBUTING.md](https://github.com/mohanagy/graphify-ts/blob/main/CONTRIBUTING.md)
- [SECURITY.md](https://github.com/mohanagy/graphify-ts/blob/main/SECURITY.md)

## License

`graphify-ts` is licensed under **MIT**. See [`LICENSE`](LICENSE) for the full terms.
