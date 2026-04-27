# Proof workflows

`graphify-ts` now has three distinct proof surfaces. They answer different questions, and they are meant to be used together rather than treated as one benchmark.

## 1. Reproducible local proof from this repo

This repo ships a checked-in demo workspace plus a labeled question set under `examples/demo-repo/`.

```bash
npm install
npm run build
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json
```

Expected signals on the checked-in demo:

- `benchmark`: `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, about `1.7x` fewer tokens per query
- `eval`: `Recall: 100.0%`, `MRR: 1.000`, about `2.7x` fewer tokens at query time

This is the safest proof path for CI and release gates because it is local, deterministic, and does not call a paid model.

## 2. Same-question, same-model A/B proof

`compare` is the real showcase path. It builds one baseline prompt and one graph-guided prompt for the same question, runs both through your own terminal model command, and saves the artifact bundle.

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

What gets saved under `graphify-out/compare/<timestamp>/`:

- `baseline-prompt.txt`
- `graphify-prompt.txt`
- `baseline-answer.txt`
- `graphify-answer.txt`
- `report.json`

When Gemini emits structured JSON with `usageMetadata`, `compare` captures real reported input and total tokens in `report.json` and the terminal summary. If the runner only returns answer text or malformed JSON, `compare` falls back to labeled local `cl100k_base` prompt estimates instead. Use this when you need customer-proof or your own apples-to-apples answer comparison. It can spend paid model tokens, so it is intentionally separate from the local benchmark/eval path. `benchmark` and `eval` remain offline estimate surfaces.

## 3. Production and multi-repo proof

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
| "Will my actual model answer better with graphify than with a naive baseline, and optionally capture provider-reported usage?" | `compare` |
| "Can this work across frontend/backend/shared repos?" | `federate` + `serve --stdio` |

For the narrative production benchmark and the GoValidate numbers, see [`examples/why-graphify.md`](../examples/why-graphify.md). For exact support coverage by language and file type, see [`language-capability-matrix.md`](./language-capability-matrix.md).
