# Password Reset Demo Workspace

This sample workspace is intentionally smaller than `examples/demo-repo/`. It is meant for quick local demos, screenshots, and first-run experiments when you want a believable TypeScript codebase without a large benchmark corpus.

The flow is compact but realistic:

- `src/routes/account-routes.ts` models route-style entrypoints
- `src/services/password-reset-service.ts` coordinates the business logic
- `src/jobs/reset-email-job.ts` stands in for a queue/worker boundary
- `src/persistence/user-repository.ts` stores and updates reset state
- `src/notifications/email-gateway.ts` simulates the external email side

Try it locally:

```bash
graphify-ts generate examples/sample-workspace --no-html
graphify-ts pack "how does password reset request enqueue the reset email" \
  --graph examples/sample-workspace/graphify-out/graph.json \
  --task explain
```

Prompt examples live in [`prompt-examples.json`](./prompt-examples.json).
