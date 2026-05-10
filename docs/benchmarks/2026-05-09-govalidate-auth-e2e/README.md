# 2026-05-09 — GoValidate auth-flow native_agent compare

This directory contains the raw evidence for the **`compare`-based** auth-flow benchmark featured in the README demo video. All numbers are sourced from Anthropic-reported `usage` blocks in the `compare` report — not local prompt-token estimates.

## Setup

- **Codebase under test:** [GoValidate](https://govalidate.app), a production NestJS + Next.js SaaS.
  - 1,048 files · ~592,940 words of code (graphify-out: 5,921 nodes · 8,797 edges · 1,284 communities).
- **Agent model:** `claude-opus-4-7`, accessed via `claude --output-format json` inside `graphify-ts compare --baseline-mode native_agent`.
- **Question:** `"Explain the auth flow End to End"` (a single end-to-end architecture question).
- **MCP profile:** `core` (6 tools).
- **Two runs (back-to-back, same model, same question):**
  1. **baseline** — `graphify-out/`, `.mcp.json`, `CLAUDE.md`, and `.claude/` were snapshotted out so the agent had no graph and no MCP server. Pure file-tools-only behavior.
  2. **graphify** — same project tree restored; the graphify-ts MCP server (core profile) was available to the agent.

The full reproducer command:

```bash
graphify-ts compare "Explain the auth flow End to End" \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes \
  --baseline-mode native_agent
```

## Headline numbers (Anthropic-reported)

| Metric | Baseline (no graphify) | Graphify (core profile) | Δ |
|---|---|---|---|
| Tool-call turns | 31 | **14** | **2.21× fewer** |
| Latency | 169,998 ms | **107,464 ms** | **1.58× faster** |
| Total input tokens (Anthropic-reported) | 2,811,682 | **532,021** | **5.28× less** |

> **Provider/runtime proof:** Anthropic reported input, cache, and total tokens for both runs — the reduction is provider-billed, not a local `cl100k_base` estimate.

This is a **deeper, more iterative question** than the 2026-04-30 benchmark (which asked about a v2 idea pipeline). The baseline agent burned 31 tool turns and 2.8M input tokens chasing the auth flow across services; with graphify's `retrieve` available, it grounded in 14 turns and 532K input tokens.

## Files in this directory

- `README.md` — this file
- `verify.sh` — reproducer that reads `report.json` and prints headline reductions
- `report.json` — **drop in** the `report.json` produced at `graphify-out/compare/2026-05-09T23-21-35/report.json`
- `baseline-prompt.txt`, `graphify-prompt.txt` — *optional but recommended*: the paired prompts the runner sent to Claude for each run
- `baseline-answer.txt`, `graphify-answer.txt` — *optional but recommended*: the paired answers Claude returned for each run

The compare command writes all of these to its output directory verbatim. To publish this benchmark, copy them in and the verify script becomes runnable end-to-end.

## Reproducing the totals from this directory

Once `report.json` is in place:

```bash
bash docs/benchmarks/2026-05-09-govalidate-auth-e2e/verify.sh
```

Expected output:

```text
num_turns_reduction     : 2.21x
latency_reduction       : 1.58x
input_token_reduction   : 5.28x
```

## Reproducing end-to-end on your own codebase

```bash
cd /path/to/your/repo
graphify-ts generate .
graphify-ts claude install --profile core    # writes .mcp.json + CLAUDE.md section + hook

graphify-ts compare "your real question here" \
  --baseline-mode native_agent \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes
```

The command writes a fresh `report.json` (plus paired prompts and answers) under `graphify-out/compare/<timestamp>/`. Compare against the numbers above on a question of similar end-to-end depth.

## Honesty notes

- These are **provider-reported** numbers, not local estimates — the cache, total, and input token counts come from Anthropic's `usage` block on each run.
- Single-question single-run measurement, not a distribution. Different question depths and session lengths will move both turn counts and token totals.
- The 2026-04-30 benchmark in the sibling directory used a different question (idea-pipeline architecture) and an earlier graph build of the same codebase; both are real, neither replaces the other.
- Cold-start MCP overhead (~13% on the 2026-04-30 run) was overwhelmed by the depth of this question — five-fold input-token savings dwarf the schema overhead at this conversation length.
