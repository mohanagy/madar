# Why Madar

Large repositories make coding agents spend early turns rediscovering routes, services, jobs, persistence, and tests. Madar gives the agent a smaller authenticated starting path.

## What it does

```text
madar generate .
madar <agent> install
retrieve(question, budget?)
```

For one repository question, Madar ranks graph anchors, follows one bounded directed closure, verifies source bytes against the canonical graph, and returns exact excerpts plus relationships.

The same call can return explicit missing, disconnected, unsupported, stale, unavailable, corrupt, or truncated boundaries. That is more useful than hiding an incomplete path behind a confidence label.

## What it does not do

Madar does not:

- run the application
- observe production state
- review a pull request by itself
- scan for vulnerabilities
- support load-bearing non-JavaScript/TypeScript code
- guarantee a complete answer for every repository

## Evidence

Historical benchmark receipts show what earlier recorded workflows achieved, including controlled experiments that used task-specific assistance. They remain valid receipts for those versions but are not current universal performance claims.

Core Reset uses pinned held-out repositories, exact-source grading, deterministic performance gates, and package/deletion budgets before making new claims. See [`docs/core-reset/scorecard.md`](../docs/core-reset/scorecard.md).
