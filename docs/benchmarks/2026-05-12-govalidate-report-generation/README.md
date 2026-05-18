# 2026-05-12 — GoValidate report-generation explanation benchmark

This directory records a **single real-world** `graphify-ts compare --baseline-mode native_agent` benchmark on GoValidate for the prompt:

> `"Explain how idea report is getting generated"`

The goal is not to claim a universal win. The goal is to publish one reproducible, sober benchmark note for the first strong real token reduction after the runtime-pack quality fixes in `v0.22.7`.

## Summary

- **Project:** GoValidate backend / monorepo
- **Version under test:** `@mohammednagy/graphify-ts@0.22.7`
- **Mode:** `graphify-ts compare --baseline-mode native_agent`
- **Model/runtime:** Claude CLI via `cat {prompt_file} | claude -p --output-format json`
- **Token source:** Anthropic-reported input/cache/total token usage captured by `graphify-ts compare`

### Result

| Metric | Baseline | Graphify | Derived change |
|---|---:|---:|---:|
| Input tokens (Anthropic-reported) | 1,653,307 | 498,280 | 1,155,027 saved (**~69.9% reduction**) |
| Turns | 19 | 8 | 11 saved (**~57.9% reduction**) |
| Latency | 116,029 ms | 67,454 ms | 48,575 ms saved (**~41.9% reduction**, **1.72x faster**) |

This is the exact compare summary captured for the run:

```text
[graphify compare] completed 1 native_agent question(s)
- Output: /Users/mohammednaji/Desktop/projects/works/govalidate/graphify-out/compare/2026-05-12T19-18-26
- "Explain how idea report is getting generated"
    num_turns: baseline 19 → graphify 8 (2.38x fewer)
    latency:   baseline 116029ms → graphify 67454ms (1.72x faster)
    input_tokens (Anthropic-reported): baseline 1653307 → graphify 498280 (3.32x less)
    provider/runtime proof: Anthropic reported input, cache, and total tokens for both runs
```

Current `compare --baseline-mode native_agent` reports keep the raw Anthropic `usage` block and also persist derived token-accounting fields for each run:

- `total_input_tokens_anthropic_exact` = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- `uncached_input_tokens_anthropic_exact` = `input_tokens + cache_creation_input_tokens`
- `cached_input_tokens_anthropic_exact` = `cache_read_input_tokens`

The terminal summary only prints the extra uncached/cache lines when at least one run reported non-zero cache activity, so zero-cache runs stay compact while cached runs make the cold-vs-reused split explicit.

## Commands

`0.22.7` is the version used for this benchmark. Future versions may improve or regress; do not read this as “install 0.22.7 forever.”

```bash
npm install -g @mohammednagy/graphify-ts@0.22.7

rm -rf graphify-out
graphify-ts generate . --spi

graphify-ts pack "Explain how idea report is getting generated" \
  --task explain \
  --retrieval-level 4 \
  --retrieval-strategy slice-v1 \
  --budget 4000 \
  --graph graphify-out/graph.json

graphify-ts compare "Explain how idea report is getting generated " \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes \
  --baseline-mode native_agent
```

If you want a machine-readable copy of the pack output for archival, redirect the `pack` command to a file yourself (for example `> pack.json`). This directory does **not** ship a synthetic `pack.json`.

## Pack quality gate

The compare win only became credible after the runtime pack stopped filling the full 4000-token budget and returned a compact runtime slice instead of near-whole-backend noise.

The `v0.22.7` pack quality gate for this prompt was:

```text
token_count: 1456
matched_nodes: 38
relationships: 57
missing required runtime path nodes: none
forbidden sibling/script/share nodes: none
script sources: none
LLM fanout: none
coverage: primary/supporting/structural/implementation/structure covered
diagnostics: none
```

Exact labels used for that gate:

- required runtime path labels: `IdeaReportController`, `GenerateIdeaReportService`
- forbidden sibling/script/share labels: `IdeaReportSharePage`, `GenerateIdeaReportScript`

Why this matters: a 3.32x input-token reduction is not persuasive if the compiled pack still expands to the full budget. Here the pack stayed compact **and** preserved the required runtime path.

## Reproducing from this directory

Drop the `report.json` from:

```text
graphify-out/compare/2026-05-12T19-18-26/report.json
```

into this directory, then run:

```bash
bash docs/benchmarks/2026-05-12-govalidate-report-generation/verify.sh
```

The script recomputes the saved-token, saved-turn, and latency deltas directly from the compare report. It does **not** rely on local `cl100k_base` estimates.

## Caveats

- This is a **single prompt / single project** benchmark.
- Native-agent behavior is stochastic; reruns can vary.
- Claude MCP/tool usage can change turn count and token totals.
- Anthropic provider-reported tokens include cache creation/read details; `compare` records the raw provider `usage` block plus derived total/uncached/cached input-token fields for both runs.
- This benchmark does **not** prove universal token reduction.
- More benchmark cases are needed across prompts, repositories, and task types.

## Safe interpretation

In this one real GoValidate benchmark, graphify-ts provided a compact runtime context that reduced Claude Code input tokens by ~70%, reduced turns by ~58%, and reduced latency by ~42% compared with the native-agent baseline.

## Unsafe claims

- “Always 70% token reduction”
- “Guaranteed faster”
- “Works equally on every repo”
- “Graphify replaces code search entirely”
