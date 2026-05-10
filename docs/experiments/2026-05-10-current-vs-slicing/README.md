# 2026-05-10 — Current retrieval vs task-conditioned slicing experiment

> **Tracking issue:** [#71](https://github.com/mohanagy/graphify-ts/issues/71) — *Research spike: compare current graph retrieval vs task-conditioned program slicing.*
> **Milestone:** `v0.14-substrate`. Findings here gate [#73](https://github.com/mohanagy/graphify-ts/issues/73) (slicer prototype) and inform [#70](https://github.com/mohanagy/graphify-ts/issues/70) (SPI v1 design).
> **Scope of this scaffold:** strategies 1, 2, and 4 are runnable today. Strategy 3 (slicer) is intentionally a stub — it ships when #73 lands. The honest framing of this experiment is "what we can already measure" plus "what the slicer needs to beat."

## Why this exists

#71 asks: *should graphify-ts move from `repo → graph → retrieval` to `task → anchors → program slice → budgeted context pack`?* That's an architectural pivot, not an optimization. Before any rewrite, we need a measured comparison of:

1. **Current graphify-ts retrieval** (`graphify-ts pack`) — today's behavior.
2. **Lexical baseline** — ripgrep + window expansion. The dumb-but-fast strawman.
3. **Task-conditioned slicer prototype** — the candidate replacement. *Stub only until #73.*
4. **Full-context baseline** *(optional)* — concatenate every TS file under a budget. The "what could the agent have known" upper bound.

The experiment compares the four context packs side-by-side on the same prompt set. If strategy 1 ≈ strategy 2 in quality, the current retrieval isn't pulling its weight. If strategy 4 ≫ strategy 1, the agent is starving for context. If strategy 3 (when it lands) ≫ strategy 1, the slicing pivot is justified.

## Strategy adapter contract

Every strategy is a script under `strategies/` that accepts:

```bash
strategies/<name>.sh \
  --prompt "<text>" \
  --workspace <abs path to repo under test> \
  --out <abs path to output dir>
```

…and writes:

- `<out>/context.txt` — the context pack as plain text (concatenated snippets, code blocks, summaries; the literal bytes that would be sent to the model).
- `<out>/meta.json` — `{ strategy, duration_ms, est_tokens, file_count, notes }`. `est_tokens` uses the same `gpt-tokenizer` (`cl100k_base`) shape as the rest of graphify-ts so numbers are comparable across strategies.

The orchestrator (`run.sh`) calls each adapter for each prompt, optionally pipes the resulting `context.txt` through a model runner via `--exec`, and writes one `summary.json` per run bundle.

## How to run

> **You need:** `graphify-ts` (≥ 0.13.3) on PATH for strategy 1, `rg` (ripgrep) for strategy 2, `node` ≥ 20, `jq`, and a TS/Node monorepo to test against. If you pass `--exec`, you also need that runner installed (e.g. `claude -p`).

Quick run, no model spend (just produce context packs):

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/run.sh \
  --workspace /path/to/your-monorepo \
  --strategies current-graphify,lexical-baseline,full-context
```

Quick run, with model answers (recommended for the actual recommendation):

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/run.sh \
  --workspace /path/to/your-monorepo \
  --strategies current-graphify,lexical-baseline,full-context \
  --exec 'cat {prompt_file} | claude -p --output-format json'
```

Once the slicer prototype from #73 exists, add it:

```bash
bash docs/experiments/2026-05-10-current-vs-slicing/run.sh \
  --workspace /path/to/your-monorepo \
  --strategies current-graphify,lexical-baseline,slicer-stub,full-context \
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
| Is current retrieval materially better than ripgrep on the same budget? | `summary.json → per_prompt[*].current-graphify.est_tokens` vs `…lexical-baseline…`, plus side-by-side `context.txt` for the same prompt |
| Is current retrieval close to full-context quality at a fraction of the tokens? | `est_tokens` ratio + qualitative answer comparison if `--exec` was used |
| What does current retrieval miss that lexical catches (or vice versa)? | Diff `context.txt` files for the same prompt — record systematic gaps |
| Where does retrieval pull in noise (hubs, barrels, generated files)? | Inspect `current-graphify` `context.txt` for top-token contributors |
| Recommendation: keep current method, adjust it, or pivot to slicing? | Concluding paragraph in `findings.md` with concrete next-steps for #73 / #70 |

The recommendation is the load-bearing output. Without it, this spike has not paid back the work that went into running it.

## Files in this directory

- `README.md` — this file
- `prompts.json` — the prompt set (8 prompts spanning explain / debug / review / impact tasks)
- `strategies/`
  - `current-graphify.sh` — strategy 1, runnable today
  - `lexical-baseline.sh` — strategy 2, runnable today (needs `rg`)
  - `slicer-stub.sh` — strategy 3, intentionally exits with "blocked on #73"
  - `full-context.sh` — strategy 4, runnable today
- `run.sh` — orchestrator
- `aggregate.sh` — side-by-side summary printer
- `results/` — gitignored; run outputs land here
- `findings.md` — *to be added* once a real run completes; this is the user-facing deliverable for #71

## Honesty notes

- The slicer adapter is a stub. The recommendation in `findings.md` cannot be "pivot to slicing" until strategy 3 produces measurable output. Until then the spike answers the *narrower* question: "is current retrieval clearly better than dumb lexical at the same budget?"
- All token estimates use `cl100k_base` (the existing graphify-ts tokenizer). They're not provider-billed unless you also pass `--exec` and the runner emits a JSON usage block.
- `--exec` calls spend real model tokens. Always use `--strategies` to limit the run; don't let an accidentally broad set 4× your bill.
- Single-codebase, single-prompt-set measurement. A second monorepo of a different shape may show a different pattern; the report should say so explicitly.
