# 2026-05-21 — GoValidate v0.23.0 validation run

This folder records a real validation pass of the published `@mohammednagy/madar@0.23.0` CLI against the local GoValidate workspace.

The goal is **not** to manufacture a clean win. The goal is to show what the released `0.23.0` surfaces did on a realistic repo, including regressions, missing context, and cases where one metric improved while another got worse.

## Scope

- **Workspace:** GoValidate root workspace (`backend`, `platform`, `landing-page`, `proxy`, docs, generated artifacts)
- **CLI under test:** published `madar 0.23.0`
- **Model/runtime:** Claude CLI with structured JSON usage (`cat {prompt_file} | claude -p --output-format json`)
- **Validation surfaces:** `generate --spi`, `summary`, `pack`, single-prompt `compare`, `pack_only`, and the public 10-question GoValidate suite

## Graph generation and `graph_summary` sanity check

`generate . --spi` succeeded on the real workspace:

- corpus: **1403 files**, **~892,952 words**
- extracted: **1243 code files** (+ **40 non-code**)
- graph: **7371 nodes**, **12,394 edges**, **1492 communities**
- semantic anomalies: **5**

The bounded `summary` output stayed compact and did **not** elevate fixtures, tests, or benchmark files as first-class runtime paths. The main framework signal was `nestjs`. That said, the summary still returned **no `runtime_paths`** on this workspace, and the raw `summary` JSON included local absolute source paths, so only the findings are published here rather than the raw file.

## Single prompt: report-generation inspection

Prompt:

> `Explain how idea report is getting generated`

### `native_agent` interpretation

This is the provider-reported benchmark path.

| Metric | Baseline | Madar | Outcome |
| --- | ---: | ---: | ---: |
| Input tokens (Anthropic-reported) | 259,912 | 297,784 | **1.15x more** |
| Turns | 4 | 4 | same |
| Latency | 259,985 ms | 49,163 ms | **5.29x faster** |

The deterministic answer-quality gate **failed**:

- missing required answer term: `GenerateIdeaReportService`

See: `report-generation-answer-quality.txt`

### `pack_only` interpretation

This is the context-quality path at a comparable prompt budget. It is **not** provider-reported model usage.

`0.23.0` single-prompt `native_agent` reports do not persist `report.pack`, so the shared pack-quality gate for this prompt was evaluated through a separate `pack_only` compare run.

The direct `pack` command did emit an `execution_slice`, but the raw local output is not committed because it contained absolute paths. The safe summary is captured in `report-generation-pack-inspection.txt`.

Observed direct `pack` inspection:

- retrieval strategy: `slice-v1`
- token_count: **1517**
- matched_nodes: **40**
- relationships: **58**
- `execution_slice.status`: **complete**
- observed path: `.generateFromProblem()` → `.startPipeline()` → `.addJob()` → `.dispatchWave()` → `.plan()` → `.process()` → `.broadcastRunFailed()`

That is useful validation data: the slice exists, but it is not the report-generation route the quality gate expected.

For the separate committed `pack_only` compare artifact, the shared `docs-artifact` gate still failed:

- missing required labels: `IdeaReportController`, `GenerateIdeaReportService`
- committed `pack_only` artifact size: **1456 tokens**, **37 matched nodes**, **57 relationships**

See: `report-generation-pack-quality.txt`

## 3-question smoke suite

The required limit-3 smoke run completed successfully before the full suite.

Those results were used only as an execution gate before spending tokens on the full 10-question run. The published benchmark claims in this folder are based on the **full suite** below, not the smoke pass.

## Full 10-question suite (`native_agent`)

This is the main provider-reported result for `0.23.0` on the public GoValidate suite.

### Aggregate outcome

- input tokens: **7 wins**, **3 losses**
- **mean input-token reduction: 14.7%**
- **median input-token reduction: 26.8%**
- turns: **8 wins**, **2 losses**
- latency: **9 wins**, **1 loss**

Best/worst outcomes:

- **Best input-token win:** `credits-accounting` (**74.4% less**)
- **Worst input-token regression:** `waitlist-invite-codes` (**144.2% more**)
- **Best turn win:** `impact-review` (**64.7% fewer**)
- **Worst turn regression:** `waitlist-invite-codes` (**166.7% more**)
- **Best latency win:** `pdf-export` (**74.1% faster**)
- **Worst latency regression:** `ai-landing-pages` (**31.8% slower**)

### Per-prompt outcomes

Percentages below are **baseline-relative change** (`1 - madar / baseline`): positive values mean madar used less/fewer/less time; negative values mean regression.

These rows come from the **full 10-question suite run**, not from the separate single-prompt artifact above. The suite question ids map to the committed files under `suite-share-safe/`. In particular, `report-generation` below refers to the public suite prompt `Explain how idea report generation works end to end.`, which is distinct from the separate single-prompt validation prompt `Explain how idea report is getting generated`.

| Prompt id | Input tokens | Turns | Latency |
| --- | ---: | ---: | ---: |
| `report-generation` | -39.4% | -42.9% | 45.6% |
| `credits-accounting` | 74.4% | 60.0% | 47.0% |
| `waitlist-invite-codes` | -144.2% | -166.7% | 38.0% |
| `pdf-export` | 19.4% | 18.2% | 74.1% |
| `ai-landing-pages` | -0.1% | 10.0% | -31.8% |
| `nda-sharing` | 74.3% | 57.1% | 36.0% |
| `stripe-limits` | 57.0% | 55.0% | 33.8% |
| `pipeline-status-broadcast` | 16.4% | 16.7% | 29.4% |
| `impact-review` | 55.2% | 64.7% | 43.4% |
| `provider-model-calls` | 34.2% | 37.5% | 8.7% |

## Published artifacts in this folder

Only files safe to publish are kept here.

- `report-generation.report.share-safe.json` — single-prompt `native_agent` example
- `report-generation-pack-only.report.share-safe.json` — single-prompt `pack_only` example
- `report-generation-pack-inspection.txt` — safe summary of the raw `pack --retrieval-strategy slice-v1` inspection
- `suite-share-safe/` — all 10 full-suite per-question `report.share-safe.json` artifacts
- `suite-best-win.report.share-safe.json` — `credits-accounting`
- `suite-worst-regression.report.share-safe.json` — `waitlist-invite-codes`
- `report-generation-answer-quality.txt`
- `report-generation-pack-quality.txt`

## Important interpretation notes

1. **`pack_only` and `native_agent` mean different things.**
   - `pack_only` is a context-quality check at roughly comparable prompt budget.
   - `native_agent` is the provider-reported token/turn/latency benchmark path.

2. **A faster run is not automatically a token win.**
   - The single report-generation prompt was much faster, but still used more provider-reported input tokens.

3. **A compact pack still has to follow the right route.**
   - The `execution_slice` existed, but it landed on a planner/orchestrator path instead of the report-generation service path expected by the gate.

4. **This is not a universal marketing claim.**
   - `0.23.0` won on most suite prompts, but it also had clear regressions on specific workflows.

## Reproduction commands

These are the public commands this validation is based on:

```bash
npm install -g @mohammednagy/madar@0.23.0
madar --version

rm -rf out
madar generate . --spi

madar summary out/graph.json

madar pack "Explain how idea report is getting generated" \
  --task explain \
  --retrieval-level 4 \
  --retrieval-strategy slice-v1 \
  --budget 4000 \
  --graph out/graph.json

madar compare "Explain how idea report is getting generated" \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes \
  --baseline-mode native_agent

madar compare "Explain how idea report is getting generated" \
  --exec 'cat {prompt_file}' \
  --yes \
  --baseline-mode pack_only

madar compare \
  --questions docs/benchmarks/govalidate-suite/questions.json \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes \
  --baseline-mode native_agent
```

## Bottom line

The released `0.23.0` build is **not** a clean universal win on GoValidate.

- It produced meaningful wins on **7/10** suite prompts for input tokens and **9/10** for latency.
- It also had real regressions, especially on **report-generation** and **waitlist/invite-code** flows.
- The report-generation `execution_slice` existed, but it did **not** follow the service path expected by the shared gate.

That makes this a credible validation artifact: it shows where `0.23.0` helped, where it regressed, and why `pack_only` and `native_agent` must be interpreted separately.
