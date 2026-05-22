# Sample workspace tutorial

Use `examples/sample-workspace/` when you want a fast, reproducible TypeScript workspace for demos without the larger benchmark-oriented `examples/demo-repo/`.

## Generate the graph

```bash
npm run build # run from the repository root to build sadeem locally
sadeem generate examples/sample-workspace --no-html
```

This creates `examples/sample-workspace/out/graph.json`.

## Run a compact pack query

```bash
sadeem pack "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/out/graph.json \
  --task explain
```

That prompt should surface the route → service → queue-like job flow around password reset email delivery.

## Prompt examples

The sample workspace ships checked-in prompt examples in [`examples/sample-workspace/prompt-examples.json`](../../examples/sample-workspace/prompt-examples.json):

- how does password reset request enqueue the reset email
- where is reset token persisted before the email job runs
- what updates the password after a reset token is verified
