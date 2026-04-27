# Why graphify-ts? Real Numbers from a Real Codebase

These benchmarks were measured on [GoValidate](https://govalidate.app), a production NestJS + Next.js SaaS with 1,268 files and ~860,000 words of code.

## The Problem

You have a large codebase. Your AI agent (Claude, Copilot, Cursor) can read files, but:

- **It can't fit everything in context** — 860K words ≈ 1.1M tokens. No context window holds that.
- **It doesn't know what to read** — asking "how does auth work?" requires knowing which 15 of 1,268 files matter.
- **It can't see structure** — who depends on what, what breaks if you change something, how modules connect.

## What graphify-ts Does

One command generates a knowledge graph:

```bash
graphify-ts generate .
graphify-ts claude install   # or cursor, copilot
```

The agent gets 17 MCP tools. Here's what changes:

---

### 1. Token Efficiency — 384x Compression

**Without graphify-ts:**
Agent reads files one by one. To answer "How does the AI pipeline work?", it might read 20+ files (~50K tokens) and still miss connections.

**With graphify-ts (retrieve tool):**
```
Question: "How does the AI pipeline process an idea from submission to report?"
Tokens used: 2,988
Corpus size: 1,146,953 tokens
Compression: 384x
```

One MCP call returns 56 relevant nodes with code snippets, relationships, and community context — in 3K tokens instead of 1.1M.

---

### 2. Impact Analysis — Know What Breaks

**Without graphify-ts:**
Agent greps for `User` across files. Finds some imports. Misses transitive dependencies. You refactor and break 12 services you didn't know about.

**With graphify-ts (impact tool):**
```
Target: User entity
Direct dependents: 67 files
Transitive dependents: 589 nodes
Affected files: 318 (of 1,268)
Affected communities: 42 modules
```

One call shows the full blast radius. The agent tells you: "This touches auth, billing, credits, domains, email, and 36 more modules. Recommend incremental migration."

---

### 3. Community Detection — See Module Boundaries

**Without graphify-ts:**
Agent reads folder structure. `src/modules/admin/` looks like one module, but actually contains 5 unrelated services with 0.1 cohesion.

**With graphify-ts (community_details tool):**
```
10,474 nodes clustered into 2,244 communities via Louvain algorithm
Low-cohesion warnings: WebSocketService (0.10), ProductOverview (0.07)
God nodes: User (67 edges), Button (56), WebSocketService (42)
```

The graph reveals structural problems invisible from file paths alone.

---

### 4. Cross-Module Understanding

**Without graphify-ts:**
Agent can't see how the frontend auth flow connects to the backend session service without reading both codebases.

**With graphify-ts (community_overview + retrieve):**
The agent sees all 2,244 modules, their sizes, connections, and bridge nodes in one call. Then drills into specific modules with `community_details` at micro/mid/macro zoom levels.

---

### 5. Multi-Repo Federation

**Without graphify-ts:**
Each repo is a black box. Agent can't answer "which backend services does the frontend depend on?"

**With graphify-ts (federate command):**
```bash
graphify-ts federate frontend/graphify-out/graph.json backend/graphify-out/graph.json
```

Merges graphs, infers cross-repo edges from shared types, and all MCP tools work on the unified graph.

---

## Benchmark Summary

| Metric | GoValidate (production SaaS) |
|--------|------------------------------|
| Corpus | 1,268 files · ~860K words |
| Graph | 10,474 nodes · 14,687 edges |
| Communities | 2,244 (Louvain) |
| Retrieve compression | **384x** (3K tokens vs 1.1M) |
| Impact analysis (User entity) | 67 direct + 589 transitive dependents |
| Generation time | ~30 seconds |
| API keys required | **0** |
| Cloud services required | **0** |

## Reproducible Demo Proof (in this repo)

The production numbers above come from GoValidate. This repo also ships a tiny checked-in proof kit at `examples/demo-repo/` so anyone can reproduce the workflow end-to-end. From the repo root, run `npm install && npm run build` once, then:

```bash
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
```

What each command proves:

- `benchmark` proves token reduction, question coverage, expected-evidence coverage, and structure-signal reporting on a known question set. On the checked-in demo repo it should report `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, and roughly `1.7x` fewer tokens per query.
- `eval` proves retrieval quality on that same labeled question set: recall plus ranking quality (MRR). On the checked-in demo repo it should report `Recall: 100.0%`, `MRR: 1.000`, and roughly `2.7x` fewer tokens at query time.

The demo repo is intentionally tiny, so its token-reduction numbers are modest. It exists to make the flow reproducible, not to maximize the headline ratio. Demo outputs land in `examples/demo-repo/graphify-out/`, which is ignored so you can rerun the flow locally without polluting git status.

If you want the exact command-level proof ladder and when to use each command, see [`docs/proof-workflows.md`](../docs/proof-workflows.md).

## Real A/B Proof with Your Own Model Command

`benchmark` and `eval` prove graph quality offline. If you want a real "same question, same model, with and without graphify" run, use `compare`:

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

What this gives you:

- one baseline prompt and one graphify prompt for the same question
- two real model answers from your own terminal runner
- a saved proof bundle in `graphify-out/compare/<timestamp>/`
- prompt-token counts, usage-source labels, and run statuses in `report.json`

Important: `compare` may spend paid model tokens. It prints a warning before execution and requires `--yes` in non-interactive runs. For large prompts, use stdin or file redirection with `{prompt_file}`; avoid shell command substitution around `{prompt_file}` (for example `$(cat {prompt_file})`) because shell argument expansion can fail on full-repo baselines. If Gemini emits structured JSON with `usageMetadata`, `compare` records real reported input and total tokens. If the runner only returns answer text or malformed JSON, `compare` falls back to labeled local `cl100k_base` prompt estimates instead. `benchmark` and `eval` stay offline estimate surfaces.

## Run It on Your Own Codebase

```bash
# Install
npm install -g @mohammednagy/graphify-ts

# Generate graph for your project
graphify-ts generate .

# Run the built-in benchmark
graphify-ts benchmark graphify-out/graph.json

# If you have a labeled question set, also measure recall + MRR
graphify-ts eval graphify-out/graph.json --questions benchmark-questions.json

# If you want a real same-model A/B proof run
graphify-ts compare "How does auth work?" --exec 'cat {prompt_file} | claude -p' --yes

# Gemini-safe compare runner with structured usage capture
graphify-ts compare "How does auth work?" \
  --exec 'cat {prompt_file} | gemini -p "" --output-format json' \
  --yes

# Set up your AI agent
graphify-ts claude install    # writes .mcp.json with MCP server
graphify-ts cursor install    # writes .cursor/mcp.json
graphify-ts copilot install   # writes .vscode/mcp.json

# Ask your agent a question — it will use retrieve, impact, etc. automatically
```

## What to Prove First in a Real Team

For an internal team rollout, the most convincing sequence is usually:

1. Run `benchmark` and `eval` on one repo to prove the graph is smaller to query and still retrieves the expected evidence.
2. Run `compare` with your real model command to produce a saved baseline-vs-graphify answer bundle.
3. If your system spans multiple repos, generate each graph separately and use `federate` before showing the agent workflow.

That progression keeps the proof honest:

- `benchmark` and `eval` are local graph-quality measurements
- `compare` is the model-facing proof, with reported usage when the runner emits structured JSON and labeled estimates otherwise
- `federate` is the production architecture proof for frontend/backend/shared or microservice splits

## Capability Coverage Matters

`graphify-ts` does not use one extractor for everything. Today the strongest code path is TypeScript/JavaScript via the TypeScript compiler API; Go, Java, Python, Ruby, and Rust use tree-sitter first with local fallback; several other languages use heuristic extractors; and images/audio/video are metadata only.

The exact matrix is published in [`docs/language-capability-matrix.md`](../docs/language-capability-matrix.md). That distinction is important when you are evaluating the tool for a polyglot codebase rather than a single TypeScript repo.
