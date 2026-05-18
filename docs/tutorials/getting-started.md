# End-to-end getting started tutorial

Use this walkthrough when you want to evaluate `graphify-ts` end to end without a private repository or paid model calls. It uses the checked-in `examples/sample-workspace/` demo so every step stays local and reproducible.

## 1. Install graphify-ts

```bash
npm install -g @mohammednagy/graphify-ts
```

If you are working from this repository instead of a published npm install, run `npm run build` from the repository root first so the local CLI is up to date.

## 2. Generate a graph for the sample workspace

```bash
graphify-ts generate examples/sample-workspace --no-html
```

This creates `examples/sample-workspace/graphify-out/graph.json`.

## 3. Build a compact pack

```bash
graphify-ts pack "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/graphify-out/graph.json \
  --task explain
```

This is the fastest way to confirm the route → service → job flow is represented in the graph.

## 4. Compile a provider-ready prompt

```bash
graphify-ts prompt "where is reset token persisted before the email job runs" \
  --provider claude \
  --graph examples/sample-workspace/graphify-out/graph.json
```

`prompt` only compiles the prompt payload. It does **not** call Claude or spend paid model tokens by itself.

## 5. Run a safe compare smoke check

If you want to exercise `compare` without calling a paid model, use a local echo-style runner:

```bash
graphify-ts compare "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/graphify-out/graph.json \
  --exec 'cat {prompt_file}' \
  --yes
```

This does **not** measure model quality. It is a safe local smoke check that proves `compare` can build both prompts and save the artifact bundle without requiring a hosted model. Real model-backed compare runs are optional.

## Expected output

- `generate` should write `examples/sample-workspace/graphify-out/graph.json`
- `pack` should print a compact JSON payload with matched nodes from the password reset flow
- `prompt` should print a provider-ready prompt payload
- `compare` should create an artifact directory under `graphify-out/compare/` containing prompt and answer files plus both `report.json` and `report.share-safe.json`

## Troubleshooting

- **`graphify-ts: command not found`**: make sure the global npm install succeeded, or run from a local repo checkout after `npm run build`.
- **`graph.json` missing**: rerun `graphify-ts generate examples/sample-workspace --no-html` before `pack`, `prompt`, or `compare`.
- **`compare` looks noisy**: the `cat {prompt_file}` runner is only a local smoke check. Use a real terminal model runner later if you want meaningful answer comparisons.
- **Need more questions?** Start with `examples/sample-workspace/prompt-examples.json`.

## Optional next steps

- Replace the local compare runner with your real CLI model command from [`docs/proof-workflows.md`](../proof-workflows.md).
- Install one of the agent profiles from the README after the sample graph is generated.
- Move from `examples/sample-workspace/` to your own workspace and rerun the same `generate` → `pack` → `prompt` flow.
