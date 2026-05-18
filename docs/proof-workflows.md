# Proof workflows

`graphify-ts` now has three distinct proof surfaces. They answer different questions, and they are meant to be used together rather than treated as one benchmark.

## 1. Reproducible local proof from this repo

This repo ships a checked-in demo workspace plus a labeled question set under `examples/demo-repo/`.

```bash
npm install
npm run build
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

Expected signals on the checked-in demo:

- `benchmark`: `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, about `1.7x` fewer tokens per query
- `eval`: `Recall: 100.0%`, `MRR: 1.000`, `Snippet coverage: 100.0%`, about `2.7x` fewer tokens at query time

This is still the most reproducible question-set proof path because the corpus, labels, and expected signals are checked in here. It now runs through your configured terminal runner, so use `--yes` for CI/non-interactive runs and expect model-token usage unless your runner is purely local.

`benchmark` keeps the per-run prompt/answer files and full `report.json` as local artifacts. It also writes a companion `report.share-safe.json` with stable placeholders so you can publish token and coverage metrics without exposing real local artifact paths. Treat that share-safe report as publishing evidence, not as a guarantee that every possible project detail has been fully redacted.

## 2. Same-question, same-model A/B proof

`compare` is the real showcase path. It builds one baseline prompt and one graph-guided prompt for the same question, runs both through your own terminal model command, and saves the artifact bundle.

```bash
node dist/src/cli/bin.js compare "How does login create a session?" \
  --graph examples/demo-repo/graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

If you want to isolate the context-compiler claim without MCP/tool-call behavior, switch to `--baseline-mode pack_only`. That mode compares one bounded raw-context baseline prompt against one compiled graphify pack and persists the compact pack audit fields (`token_count`, matched nodes, relationships, coverage, and selection diagnostics) in `report.json`.

If you switch to `--baseline-mode native_agent`, prefer a structured Anthropic runner such as `cat {prompt_file} | claude -p --output-format json`. Plain-text Claude runs still save paired answers, but the report cannot compute Anthropic-billed reductions without the trailing JSON usage block.

Gemini-safe installed-CLI invocation:

```bash
graphify-ts compare "How does auth work?" \
  --exec 'cat {prompt_file} | gemini -p "" --output-format json' \
  --yes
```

What gets saved under `graphify-out/compare/<timestamp>/`:

- `baseline-prompt.txt`
- `graphify-prompt.txt`
- `baseline-answer.txt`
- `graphify-answer.txt`
- `report.json`
- `report.share-safe.json`

When Gemini emits structured JSON with `usageMetadata`, `compare` captures real reported input and total tokens in `report.json` and the terminal summary. If the runner only returns answer text or malformed JSON, `compare` falls back to labeled local `cl100k_base` prompt estimates instead.

`report.json` keeps the real local artifact paths. `report.share-safe.json` preserves the compare metrics with stable placeholders for sharing, while the prompt and answer text files remain local-only artifacts. That makes the companion report safe to publish for path hygiene, but it still does not promise perfect redaction of every possible project detail.

Recent report versions also add a **provider/runtime proof** block so you can see whether a reduction is backed by provider-reported input/cache/total-token numbers or by local estimate + session-reuse accounting. Use this when you need customer-facing proof or your own apples-to-apples answer comparison.

Like runner-backed `benchmark` and `eval`, `compare` can spend paid model tokens. The difference is that `compare` saves paired answers, while `benchmark` and `eval` score a labeled question set.

## 3. PR-review proof on a real diff

`review-compare` is the proof path for review mode. It compares the **verbose** and **compact** `pr_impact` prompts for the current git diff, saves both payload-backed prompts, and can optionally run both through your own model runner.

```bash
graphify-ts review-compare graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

What gets saved under `graphify-out/review-compare/<timestamp>/`:

- `verbose-prompt.txt`
- `compact-prompt.txt`
- `verbose-answer.txt`
- `compact-answer.txt`
- `report.json`
- `report.share-safe.json`

Use this when the question is not "graphify vs. naive baseline", but "did compact review mode make the PR-review prompt materially smaller while keeping the same review surface shape?" The report includes prompt-token deltas, payload-token deltas, run statuses, elapsed times for both modes, and a provider/runtime proof block that makes it explicit when review-compare is using local estimate + session-reuse accounting rather than provider-billed usage.

As with `compare` and `benchmark`, the prompt and answer files stay local, while `report.share-safe.json` keeps the review metrics with stable placeholders so you can share evidence without publishing your exact local artifact paths.

## 4. Production and multi-repo proof

For real systems, the strongest proof is usually:

1. Generate one graph per repo.
2. Federate them.
3. Point your agent at the federated graph.
4. Ask a cross-repo question or run `compare` against that federated graph.

```bash
graphify-ts generate frontend
graphify-ts generate backend
graphify-ts generate shared

graphify-ts federate \
  frontend/graphify-out/graph.json \
  backend/graphify-out/graph.json \
  shared/graphify-out/graph.json \
  --output federated-out

graphify-ts serve federated-out/graph.json --stdio
```

What this proves that a single-repo demo cannot:

- cross-repo type and symbol stitching
- blast-radius analysis across repo boundaries
- one MCP surface for frontend + backend + shared code
- a realistic privacy-preserving workflow for internal systems

## Which proof to use

| Question | Best command |
|---|---|
| "Does the graph improve retrieval quality on a labeled set?" | `eval` |
| "Does the graph reduce prompt size while keeping expected evidence?" | `benchmark` |
| "Will my actual model answer better with graphify than with a naive baseline, and optionally capture provider-reported usage + proof metadata?" | `compare` |
| "Did compact review mode actually shrink the real PR-review prompt on my current diff?" | `review-compare` |
| "Can this work across frontend/backend/shared repos?" | `federate` + `serve --stdio` |

For the narrative production benchmark and the GoValidate numbers, see [`examples/why-graphify.md`](../examples/why-graphify.md). For exact support coverage by language and file type, see [`language-capability-matrix.md`](./language-capability-matrix.md).
