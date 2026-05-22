# 2026-05-10 — Current retrieval vs task-conditioned slicing experiment

> **Tracking issue:** [#71](https://github.com/mohanagy/sadeem/issues/71) — *Research spike: compare current graph retrieval vs task-conditioned program slicing.*
> **Milestone:** `v0.14-substrate`. Findings here inform follow-up retrieval tuning and the longer-term substrate / SPI direction.
> **Scope of this scaffold:** all four strategies are runnable today against the committed `examples/demo-repo/` corpus, so the comparison is reproducible in a fresh checkout.

## Why this exists

#71 asks: *should sadeem move from `repo → graph → retrieval` to `task → anchors → program slice → budgeted context pack`?* That's an architectural pivot, not an optimization. Before any rewrite, we need a measured comparison of:

1. **Current sadeem retrieval** (`sadeem pack`) — today's behavior.
2. **Lexical baseline** — ripgrep + window expansion. The dumb-but-fast strawman.
3. **Task-conditioned slicer prototype** (`sadeem pack --retrieval-strategy slice-v1`) — the candidate tighter path-selection behavior.
4. **Full-context baseline** *(optional)* — concatenate every TS file under a budget. The "what could the agent have known" upper bound.

The experiment compares the four context packs side-by-side on the same prompt set. If strategy 1 ≈ strategy 2 in quality, the current retrieval isn't pulling its weight. If strategy 4 ≫ strategy 1, the agent is starving for context. If strategy 3 consistently preserves the same critical path with fewer tokens than strategy 1, the slicing direction is justified.

## Strategy adapter contract

Every strategy is a script under `strategies/` that accepts:

```bash
strategies/<name>.sh \
  --prompt "<text>" \
  --task <explain|debug|review|impact> \
  --workspace <abs path to repo under test> \
  --out <abs path to output dir>
```

…and writes:

- `<out>/context.txt` — the context pack as plain text (concatenated snippets, code blocks, summaries; the literal bytes that would be sent to the model).
- `<out>/meta.json` — `{ strategy, duration_ms, est_tokens, file_count, notes }`. `est_tokens` uses the same `gpt-tokenizer` (`cl100k_base`) shape as the rest of sadeem so numbers are comparable across strategies.

The orchestrator (`run.sh`) calls each adapter for each prompt, optionally pipes the resulting `context.txt` through a model runner via `--exec`, and writes one `summary.json` per run bundle.

For the graph-backed adapters, the harness normalizes unsupported task kinds to the closest shipped pack mode so the comparison stays about retrieval rather than CLI surface gaps:

- `debug` prompts run through `sadeem pack --task explain`
- `review` prompts run through `sadeem pack --task impact`

The original prompt task is still preserved in `prompts.json`, and the adapter records both the requested task and the effective pack task in `meta.json`.

## How to run

> **You need:** `sadeem` on PATH for strategies 1 and 3, `rg` (ripgrep) for strategy 2, `node` ≥ 20, and `jq`. This scaffold is wired to the committed `examples/demo-repo/` workspace so a fresh checkout can reproduce the run exactly. If you pass `--exec`, you also need that runner installed (for example `claude -p`).

Prepare the demo workspace once:

```bash
cd examples/demo-repo
sadeem generate .
cd ../..
```

Quick run, no model spend (just produce context packs):

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/run.sh \
  --workspace "$PWD/examples/demo-repo" \
  --strategies current-sadeem,lexical-baseline,slice-v1,full-context
```

Quick run, with model answers (recommended for the actual recommendation):

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/run.sh \
  --workspace "$PWD/examples/demo-repo" \
  --strategies current-sadeem,lexical-baseline,slice-v1,full-context \
  --exec 'cat {prompt_file} | claude -p --output-format json'
```

After the harness finishes, summarize:

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/aggregate.sh \
  results/<timestamp>
```

## What to capture in the report

This is a **research spike**, not an engine rewrite. The deliverable is a `findings.md` next to this README that answers:

| Question | Where to look |
|---|---|
| Is current retrieval materially better than ripgrep on the same budget? | `summary.json → per_prompt[*].current-sadeem.est_tokens` vs `…lexical-baseline…`, plus side-by-side `context.txt` for the same prompt |
| Is current retrieval close to full-context quality at a fraction of the tokens? | `est_tokens` ratio + qualitative answer comparison if `--exec` was used |
| What does current retrieval miss that lexical catches (or vice versa)? | Diff `context.txt` files for the same prompt — record systematic gaps |
| Where does retrieval pull in noise (hubs, barrels, generated files)? | Inspect `current-sadeem` `context.txt` for top-token contributors |
| Recommendation: keep current method, adjust it, or pivot to slicing? | Concluding paragraph in `findings.md` with concrete next-steps for retrieval tuning / slice-v1 follow-up |

The recommendation is the load-bearing output. Without it, this spike has not paid back the work that went into running it.

## Files in this directory

- `README.md` — this file
- `prompts.json` — the prompt set (8 prompts spanning explain / debug / review / impact tasks against `examples/demo-repo/`)
- `strategies/`
  - `current-sadeem.sh` — strategy 1, runnable today
  - `lexical-baseline.sh` — strategy 2, runnable today (needs `rg`)
  - `slice-v1.sh` — strategy 3, runnable today via `sadeem pack --retrieval-strategy slice-v1`
  - `full-context.sh` — strategy 4, runnable today
- `run.sh` — orchestrator
- `aggregate.sh` — side-by-side summary printer
- `results/` — gitignored; run outputs land here
- `findings.md` — the user-facing deliverable for #71

## Honesty notes

- All token estimates use `cl100k_base` (the existing sadeem tokenizer). They're not provider-billed unless you also pass `--exec` and the runner emits a JSON usage block.
- `--exec` calls spend real model tokens. Always use `--strategies` to limit the run; don't let an accidentally broad set 4× your bill.
- This is a single-codebase, single-prompt-set measurement. The committed demo corpus is intentionally reproducible, but smaller and tidier than a production monorepo. The report should say so explicitly instead of overselling the result.
- The graph-backed adapters intentionally map `debug → explain` and `review → impact` because the current pack surface does not expose a stable `debug` mode and `slice-v1` is only comparable on the explain / impact path today.
