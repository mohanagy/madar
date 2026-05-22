# 2026-04-30 — GoValidate native_agent benchmark

This directory contains the raw evidence for sadeem's headline benchmark numbers. All numbers come from `claude --output-format json` `usage` fields, not from local prompt-token estimates.

## Setup

- **Codebase under test:** [GoValidate](https://govalidate.app), a production NestJS + Next.js SaaS.
  - 1,268 files · ~860,000 words of code · ~1.5M cl100k_base tokens.
- **Agent model:** `claude-opus-4-7`, accessed via the Claude Code CLI's `claude --output-format json` mode.
- **Question:** identical for both runs (held internal).
- **Two runs:**
  1. **baseline-session.json** — `out/`, `.mcp.json`, `CLAUDE.md`, and `.claude/` were renamed out of the working directory before the run, so the agent had no graph and no MCP server. Pure file-tools-only behavior.
  2. **sadeem-session.json** — same project tree restored; the sadeem MCP server (core profile, 6 tools) was available to the agent.

## Headline numbers (computed from this directory's JSON)

| Metric | Baseline (no sadeem) | Sadeem (core profile) | Δ |
|---|---|---|---|
| Tool-call turns | 9 | **3** | 3× fewer |
| Latency | 96,368 ms | **34,744 ms** | ~2.77× faster |
| Total input tokens (Anthropic-reported) | 615,190 | **233,508** | 2.63× less |
| Cost per session | $0.62 | $0.70 | +13% on cold start |

Where the totals come from:

```text
baseline_total_input_tokens = 14 + 40,648 + 574,528 = 615,190
sadeem_total_input_tokens = 13 + 92,833 + 140,662 = 233,508
```

The honest framing is:

- **Sadeem is unambiguously faster** (~2.77×) and uses **3× fewer tool-call turns**.
- **Sadeem uses 2.63× fewer total input tokens** end-to-end.
- **On cold-start sessions, sadeem costs ~13% more** because the MCP server's tool schemas occupy `cache_creation_input_tokens` (priced at 1.25× input rate) that the no-MCP baseline does not pay. This is why the current product ships the `core` tool profile (6 tools instead of 24) by default — it cuts `cache_creation_input_tokens` enough to flip cost parity below baseline at multi-question session lengths.

## Effective-cost framing

This artifact is a cold-start native-agent receipt, so the headline dollar numbers above are still the source of truth. But the public proof language now uses **effective cost** for cache-aware prompt compilation: once a long-lived session can reuse stable context, the more honest number becomes **effective prompt tokens** after reuse, not raw cold-start prompt bytes. That is why newer `prompt`, `compare`, and `review-compare` surfaces report cache-reuse-aware token metrics alongside the raw totals.

## Reproducing the totals from this directory

```bash
bash docs/benchmarks/2026-04-30-govalidate/verify.sh
```

Output:

```text
baseline_total_input_tokens : 615190
sadeem_total_input_tokens : 233508
input_token_reduction        : 2.63x
num_turns_reduction          : 3x
latency_reduction            : 2.77x
baseline_total_cost_usd      : $0.62
sadeem_total_cost_usd      : $0.70
```

## Reproducing end-to-end on your own codebase

```bash
# 1. From inside the repo you want to test against, generate a graph
#    and wire up the MCP server / project rules.
cd /path/to/your/repo
sadeem generate .
sadeem claude install   # writes .mcp.json + CLAUDE.md section + .claude/settings.json hook

# 2. Run a native_agent compare. sadeem will:
#    - snapshot out/graph.json, .mcp.json, CLAUDE.md, .claude/
#    - run --exec once without those files (baseline)
#    - restore them
#    - run --exec once with them in place (sadeem)
#    - parse Anthropic-reported usage from each --output-format json result
sadeem compare "your real question here" \
  --graph out/graph.json \
  --baseline-mode native_agent \
  --exec 'claude --output-format json -p "{question}"' \
  --yes
```

The compare report is written to `out/compare/<timestamp>/report.json` with both Anthropic-reported `usage` blocks preserved verbatim and the same reductions math `verify.sh` computes here.

## Honesty notes

- The committed JSON files preserve the original Anthropic `usage` shape verbatim. Only the `result` body has been redacted because the question was sadeem-internal.
- These two runs are a single point measurement, not a distribution. Larger session lengths and different question types will move the cost gap.
- The benchmark deliberately uses a real production codebase and the real Claude Code CLI — not a synthetic prompt or a mocked client.
