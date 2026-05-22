# 2026-05-10 — Backend-only vs monorepo context-quality spike

> **Tracking issue:** [#69](https://github.com/mohanagy/sadeem/issues/69) — *Spike: benchmark backend-only vs monorepo context quality and runtime.*
> **Milestone:** `v0.14-substrate`. This spike's findings should inform [#70](https://github.com/mohanagy/sadeem/issues/70) (SPI v1 design).

## Why this exists

Recent real usage on GoValidate showed an inconsistent shape:

- Running `sadeem generate` on **only the backend folder** was *slower* and produced *worse / higher-token* answers.
- Running `sadeem generate` on the **full monorepo** was *faster* and produced *better / lower-token* answers.

The hypothesis we want to test or falsify is that the problem is **methodological** (graph topology, hub nodes, workspace boundaries, missing semantic context) rather than just raw repo size.

This directory ships a runnable harness that can prove or disprove the hypothesis on any TypeScript/Node monorepo a reader has locally — including private codebases that can't be uploaded.

## What the harness does

For each prompt in [`prompts.json`](./prompts.json), the harness:

1. Generates a graph for the **backend-only** path (e.g. `apps/backend` or `packages/api`).
2. Generates a graph for the **monorepo** path (the workspace root).
3. Runs `sadeem compare <prompt> --baseline-mode native_agent` against the **backend graph** — captures provider-reported token / turn / latency deltas vs the file-tools-only baseline.
4. Runs the same `compare` against the **monorepo graph** — same baseline shape.
5. Writes both `compare` reports plus a side-by-side `summary.json` under `results/<timestamp>/`.

Both runs use the **same model**, the **same prompt**, and the **same `--exec`** invocation, so the only varying factor is the graph's scope.

## How to run

> **You need:** the `sadeem` CLI on PATH, an installed terminal LLM runner (e.g. `claude -p`), and a TS/Node monorepo to test against. Output bundles land in `results/` and are gitignored — keep them local until you decide to publish a specific run.

Quick run (3 prompts, ~12 model calls):

```bash
bash docs/benchmarks/2026-05-10-backend-vs-monorepo/run.sh \
  --backend-path  /path/to/your-monorepo/apps/backend \
  --monorepo-path /path/to/your-monorepo \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --quick
```

Full run (all 12 prompts, ~48 model calls — expect real token spend):

```bash
bash docs/benchmarks/2026-05-10-backend-vs-monorepo/run.sh \
  --backend-path  /path/to/your-monorepo/apps/backend \
  --monorepo-path /path/to/your-monorepo \
  --exec 'cat {prompt_file} | claude -p --output-format json'
```

After the harness finishes, summarize the deltas:

```bash
bash docs/benchmarks/2026-05-10-backend-vs-monorepo/aggregate.sh \
  results/<timestamp>
```

## What to capture in the report

This is a **measurement spike**, not an engine rewrite. The deliverable per #69 is a short Markdown report that answers:

| Question | Where to look in the harness output |
|---|---|
| Is the backend-only graph slower at generate-time? | `summary.json → generate.backend.duration_ms` vs `summary.json → generate.monorepo.duration_ms` |
| Does the backend-only graph produce more total input tokens per question? | `summary.json → per_prompt[*].backend.sadeem.total_input_tokens` vs `…monorepo…` |
| Does the backend-only graph use more turns per question? | `summary.json → per_prompt[*].backend.sadeem.num_turns` vs `…monorepo…` |
| Are answers materially worse on the backend-only graph? | Read `*-answer.txt` pairs side-by-side; record qualitative notes |
| What graph topology differs? | Compare `out/GRAPH_REPORT.md` for both scopes (god nodes, communities, low-cohesion warnings) |
| Top suspected failure modes? | Cross-reference: hub dominance, low workspace bridges, missing tests/config edges, generic-extractor fallthrough |

When the report is ready, drop it next to this README as `findings.md` and link it from the [issue #69](https://github.com/mohanagy/sadeem/issues/69) thread.

## Files in this directory

- `README.md` — this file
- `prompts.json` — the prompt set (12 prompts; `--quick` runs the first 3)
- `run.sh` — orchestrator that drives generate + compare for both scopes
- `aggregate.sh` — reads a results bundle and prints a side-by-side summary
- `results/` — gitignored; populated by `run.sh` invocations
- `findings.md` — *to be added* once a real run completes; this is the user-facing deliverable for #69

## Honesty notes

- This spike does **not** auto-conclude that backend-only is wrong. The expected outcome is a recorded comparison; the conclusion may be "topology-driven", "scope-detection-driven", or "no real difference outside noise" depending on the data.
- The harness uses the **provider-reported** Anthropic usage block from `claude --output-format json`, not local `cl100k_base` estimates. Reductions reported here are billable, not synthetic.
- Single-codebase, single-question-set measurement. A second monorepo of a different shape may show a different pattern; the report should say so explicitly.
- The harness can spend real model tokens. Always run with `--exec` you're prepared to be billed for.
