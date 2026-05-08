# Why graphify-ts? Real Numbers from a Real Codebase

These benchmarks were measured on [GoValidate](https://govalidate.app), a production NestJS + Next.js SaaS with 1,268 files and ~860,000 words of code.

The product surface is no longer "just export a graph." graphify-ts is now a cost-first **context plane** with a **context compiler** layered on top: the graph is the substrate, while the shipped value is compact retrieval, provider-aware prompts, and proof surfaces that show smaller context still meets the required coverage contract.

## The Problem

You have a large codebase. Your AI agent (Claude, Copilot, Cursor) can read files, but:

- **It can't fit everything in context** — 860K words ≈ 1.1M tokens. No context window holds that.
- **It doesn't know what to read** — asking "how does auth work?" requires knowing which 15 of 1,268 files matter.
- **It can't see structure** — who depends on what, what breaks if you change something, how modules connect.

## What graphify-ts Does

Generate the graph once, then use graphify-ts as both the local context plane and the context compiler:

```bash
graphify-ts generate .
graphify-ts claude install   # or cursor, copilot
graphify-ts pack "how does auth work?" --task explain
graphify-ts prompt "how does auth work?" --provider claude
```

The agent gets a lean 6-tool MCP surface by default (retrieve, impact, call_chain, community_overview, pr_impact, graph_stats). Set `GRAPHIFY_TOOL_PROFILE=full` in your MCP config (`.mcp.json` for Claude, `.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code Copilot) to opt into the full 25-tool advanced surface, including `context_pack`, `context_expand`, `context_prompt`, and `context_session_reset`.

`pack` is the CLI context payload surface. `prompt` is the provider-aware context compiler: Claude payloads expose `effective_token_count`, `reused_context_tokens`, and `session_state`; Gemini payloads stay plain-text. The matching MCP tools expose the same flows inside the active agent session, with `context_pack` now returning not only `claims`, `coverage`, and `missing_context`, but also planner-driven **semantic coverage** and stable expandable handles that agents can reopen with `context_expand`.

That planner layer matters because the product is no longer doing only "compact retrieval." It now classifies the prompt into a richer task intent, selects a task-specific evidence recipe, and reports whether the selected context still covers the right semantic buckets for the job — for example `changes` + `impact` for review, or `implementation` + `structure` + `tests` for test-generation. The same proof story now extends to benchmark surfaces too: compare/benchmark reports say whether the token win came from provider-reported usage or from local estimate + session-reuse accounting, instead of mixing those together.

---

### 1. Fewer turns, faster sessions, fewer total tokens

The credible measurement is end-to-end against a real coding agent, not against a synthetic baseline prompt. Numbers below are from `claude --output-format json` runs on a production NestJS + Next.js SaaS, captured 2026-04-30.

| Metric | Baseline (no graphify) | Graphify | Δ |
|---|---|---|---|
| Tool-call turns | 9 | **3** | 3× fewer |
| Latency | 96s | **35s** | ~2.8× faster |
| Total input tokens (Anthropic-reported) | 615,190 | **233,508** | 2.63× less |
| Cost per session | $0.62 | $0.70 | +13% on cold start; cheaper on multi-question sessions |

Headline: **3× fewer turns**, ~2.8× faster, 2.6× fewer total input tokens. Graphify is unambiguously faster and uses fewer turns. Cold-start sessions pay an MCP-overhead premium of ~13%; multi-question sessions amortize and flip below baseline. That is why the honest cost language here is **effective cost**: once stable context is reused across prompt-compiler follow-ups, the number that matters is effective tokens after cache reuse rather than raw cold-start bytes.

Raw evidence (both `claude --output-format json` outputs and a `verify.sh` reproducer) is committed under [`docs/benchmarks/2026-04-30-govalidate/`](../docs/benchmarks/2026-04-30-govalidate/).

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

| Metric | GoValidate (production SaaS, 2026-04-30) |
|--------|------------------------------------------|
| Corpus | 1,268 files · ~860K words |
| Graph | 10,474 nodes · 14,687 edges |
| Communities | 2,244 (Louvain) |
| Tool-call turns | baseline 9 → graphify **3** (3× fewer) |
| Avg session latency | baseline 96s → graphify **35s** (~2.8× faster) |
| Total input tokens (Anthropic-reported) | baseline 615,190 → graphify **233,508** (2.63× less) |
| Cost per session | baseline $0.62 → graphify $0.70 cold start (~+13%); amortizes on multi-question sessions |
| Impact analysis (User entity) | 67 direct + 589 transitive dependents |
| API keys required | **0** |
| Cloud services required | **0** |

## Reproducible Demo Proof (in this repo)

The production numbers above come from GoValidate. This repo also ships a tiny checked-in proof kit at `examples/demo-repo/` so anyone can reproduce the workflow end-to-end. From the repo root, run `npm install && npm run build` once, then:

```bash
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

What each command proves:

- `benchmark` proves the **coverage contract** for the smaller context bundle: question coverage, expected-evidence coverage, structure-signal reporting, and runner-backed token deltas on a known question set. On the checked-in demo repo it should report `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, and roughly `1.7x` fewer tokens per query.
- `eval` proves the retrieval-quality side of that same coverage contract: recall, ranking quality (MRR), and snippet coverage. On the checked-in demo repo it should report `Recall: 100.0%`, `MRR: 1.000`, `Snippet coverage: 100.0%`, and roughly `2.7x` fewer tokens at query time.

The demo repo is intentionally tiny, so its token-reduction numbers are modest. It exists to make the flow reproducible, not to maximize the headline ratio. Demo outputs land in `examples/demo-repo/graphify-out/`, which is ignored so you can rerun the flow locally without polluting git status.

If you want the exact command-level proof ladder and when to use each command, see [`docs/proof-workflows.md`](../docs/proof-workflows.md).

## Real A/B Proof with Your Own Model Command

`benchmark` and `eval` now use the same runner-backed prompt surface as `compare`, but they score a labeled question set instead of writing paired answer bundles. If you want a real "same question, same model, with and without graphify" run, use `compare`:

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

Important: `compare` may spend paid model tokens. It prints a warning before execution and requires `--yes` in non-interactive runs. For large prompts, use stdin or file redirection with `{prompt_file}`; avoid shell command substitution around `{prompt_file}` (for example `$(cat {prompt_file})`) because shell argument expansion can fail on full-repo baselines. If Gemini emits structured JSON with `usageMetadata`, `compare` records real reported input and total tokens. If the runner only returns answer text or malformed JSON, `compare` falls back to labeled local `cl100k_base` prompt estimates instead. Runner-backed `benchmark` and `eval` follow the same reported-usage vs. labeled-estimate fallback rules.

## Real PR review proof with the current diff

If your question is "is compact review mode actually small enough on a real PR?" use `review-compare` instead of question-based `compare`:

```bash
graphify-ts review-compare graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

This produces:

- one verbose `pr_impact` prompt and one compact `pr_impact` prompt for the current git diff
- optional model answers for both review prompts
- a saved artifact bundle in `graphify-out/review-compare/<timestamp>/`
- prompt-token and payload-token deltas in `report.json`

Use this proof when you are validating PR-review ergonomics rather than general question-answering. It is especially useful on large repos or multi-project workspaces because it can target an external graph path and still write output inside that target workspace's own `graphify-out/`.

## Run It on Your Own Codebase

```bash
# Install
npm install -g @mohammednagy/graphify-ts

# Generate graph for your project
graphify-ts generate .

# Run the built-in benchmark
graphify-ts benchmark graphify-out/graph.json --exec 'cat {prompt_file} | claude -p' --yes

# If you have a labeled question set, also measure recall + MRR
graphify-ts eval graphify-out/graph.json --questions benchmark-questions.json --exec 'cat {prompt_file} | claude -p' --yes

# If you want a real same-model A/B proof run
graphify-ts compare "How does auth work?" --exec 'cat {prompt_file} | claude -p' --yes

# If you want a real PR-review compact-vs-verbose proof run
graphify-ts review-compare graphify-out/graph.json --exec 'cat {prompt_file} | claude -p' --yes

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

1. Run `benchmark` and `eval` on one repo with your chosen runner to prove the graph is smaller to query and still retrieves the expected evidence.
2. Run `compare` with your real model command to produce a saved baseline-vs-graphify answer bundle.
3. If PR-review cost is the concern, run `review-compare` on a real diff to measure verbose-vs-compact review prompts directly.
4. If your system spans multiple repos, generate each graph separately and use `federate` before showing the agent workflow.

That progression keeps the proof honest:

- `benchmark` and `eval` are runner-backed graph-quality measurements on labeled prompts
- `compare` is the model-facing proof, with reported usage when the runner emits structured JSON, labeled estimates otherwise, and effective-cost framing for cache-aware follow-ups
- `review-compare` is the PR-review proof, comparing verbose and compact `pr_impact` prompts on the same diff while preserving the same review coverage contract
- `federate` is the production architecture proof for frontend/backend/shared or microservice splits

## Capability Coverage Matters

`graphify-ts` does not use one extractor for everything. Today the strongest code path is TypeScript/JavaScript via the TypeScript compiler API plus a framework-semantic pass for Express, Redux Toolkit, React Router, NestJS, and Next.js; Go, Java, Python, Ruby, and Rust use tree-sitter first with local fallback; several other languages use heuristic extractors; and images/audio/video are metadata only.

For JS/TS specifically, the promise is deep support for **mainstream framework conventions**: Express routing/middleware, Redux Toolkit slices/selectors/store wiring, React Router routes/loaders/actions, NestJS modules/controllers/providers, and Next.js App Router + Pages Router ownership. If a codebase relies on highly dynamic wrappers, runtime-generated routes, or custom decorator meta-programming, graphify-ts still extracts the underlying AST structure but does not overclaim first-class framework semantics for those cases.

The exact matrix is published in [`docs/language-capability-matrix.md`](../docs/language-capability-matrix.md). That distinction is important when you are evaluating the tool for a polyglot codebase rather than a single TypeScript repo.
