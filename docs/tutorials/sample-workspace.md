# Sample workspace tutorial

Use `examples/sample-workspace/` when you want a fast, reproducible TypeScript workspace for demos without the larger benchmark-oriented `examples/demo-repo/`.

## Generate the graph

```bash
cd examples/sample-workspace
npm run graph:generate
```

This creates `examples/sample-workspace/graphify-out/graph.json`.

## Run a compact pack query

```bash
npm run graph:pack:enqueue
```

That prompt should surface the route → service → queue-like job flow around password reset email delivery.

## Prompt examples

The sample workspace ships checked-in prompt examples in [`examples/sample-workspace/prompt-examples.json`](../../examples/sample-workspace/prompt-examples.json):

- how does password reset request enqueue the reset email
- where is reset token persisted before the email job runs
- what updates the password after a reset token is verified
