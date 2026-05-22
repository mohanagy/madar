# End-to-end getting started tutorial

Use this walkthrough when you want to evaluate `sadeem` end to end without a private repository or paid model calls. It uses the checked-in `examples/sample-workspace/` demo so every step stays local and reproducible.

## 1. Install sadeem

```bash
npm install -g sadeem
```

If you are working from this repository instead of a published npm install, run `npm run build` from the repository root first so the local CLI is up to date.

## 2. Generate a graph for the sample workspace

```bash
sadeem generate examples/sample-workspace --no-html
```

This creates `examples/sample-workspace/out/graph.json`.

If your real repo is framework-heavy TypeScript/JavaScript and you care about richer NestJS / Next.js / Prisma / tRPC retrieval hints, rerun the same step with the still-opt-in SPI pipeline:

```bash
sadeem generate examples/sample-workspace --spi --no-html
```

## 3. Start with a bounded summary

```bash
sadeem summary examples/sample-workspace/out/graph.json
```

This prints the deterministic high-signal overview first: graph counts, source domains, top modules, frameworks, entrypoints, and runtime paths. It is the fastest way to decide whether you need a deeper `pack`, `prompt`, or MCP retrieval call.

## 4. Build a compact pack

```bash
sadeem pack "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/out/graph.json \
  --task explain
```

This is the fastest way to confirm the route → service → job flow is represented in the graph. On runtime-generation questions like this one, newer reports can also preserve an `execution_slice` so you can inspect ordered steps without reading the whole raw slice.

## 5. Compile a provider-ready prompt

```bash
sadeem prompt "where is reset token persisted before the email job runs" \
  --provider claude \
  --graph examples/sample-workspace/out/graph.json
```

`prompt` only compiles the prompt payload. It does **not** call Claude or spend paid model tokens by itself.

## 6. Run a safe compare smoke check

If you want to exercise `compare` without calling a paid model, use a local echo-style runner:

```bash
sadeem compare "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/out/graph.json \
  --baseline-mode pack_only \
  --exec 'cat {prompt_file}' \
  --yes
```

This does **not** measure model quality. It is a safe local smoke check that proves `compare` can build both prompts, isolate one bounded raw-context baseline against one compiled sadeem pack rendered from the same explain-pack core as `sadeem pack --task explain`, and save the artifact bundle without requiring a hosted model. Real model-backed compare runs are optional.

## Expected output

- `generate` should write `examples/sample-workspace/out/graph.json`
- `summary` should print the bounded overview before any deeper retrieval
- `pack` should print a compact JSON payload with matched nodes from the password reset flow
- `prompt` should print a provider-ready prompt payload
- `compare` should create an artifact directory under `out/compare/` containing prompt and answer files plus both `report.json` and `report.share-safe.json`
- runtime-generation compare reports may also carry an `execution_slice` inside `report.json` when sadeem can preserve the ordered backend flow compactly

## Troubleshooting

- **`sadeem: command not found`**: make sure the global npm install succeeded, or run from a local repo checkout after `npm run build`.
- **`graph.json` missing**: rerun `sadeem generate examples/sample-workspace --no-html` before `pack`, `prompt`, or `compare`.
- **Need stronger framework-aware hints?** Regenerate with `sadeem generate examples/sample-workspace --spi --no-html` if your real workspace relies on Next.js App Router, NestJS, Prisma, or similar framework-specific boundaries.
- **`compare` looks noisy**: the `cat {prompt_file}` runner is only a local smoke check. Use a real terminal model runner later if you want meaningful answer comparisons.
- **Need more questions?** Start with `examples/sample-workspace/prompt-examples.json`.

## Optional next steps

- Replace the local compare runner with your real CLI model command from [`docs/proof-workflows.md`](../proof-workflows.md).
- Install one of the agent profiles from the README after the sample graph is generated.
- Move from `examples/sample-workspace/` to your own workspace and rerun the same `generate` → `pack` → `prompt` flow.
