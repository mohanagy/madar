# Sample workspace

The sample workspace demonstrates a route-to-service-to-persistence-to-job flow.

```bash
madar generate examples/sample-workspace
cd examples/sample-workspace
madar query "how does password reset request enqueue the reset email?"
```

The expected ready dossier is grounded in:

- `src/routes/account-routes.ts`
- `src/services/password-reset-service.ts`
- `src/persistence/user-repository.ts`
- `src/jobs/reset-email-job.ts`
- `src/notifications/email-gateway.ts`

The exact selected entities and flow links remain graph-derived. If you edit the sample, run `madar generate . --update` before querying again.
