# 2026-06-01 federation flagship

This folder publishes a **synthetic federation receipt** for the smallest reproducible **frontend/backend/shared** workflow that makes the enterprise case for `madar federate` concrete.

Why this matters: federation is an **enterprise differentiator** when a team needs one local, auditable graph for frontend, backend, and shared code instead of hopping between separate repo indexes. The checked-in fixture keeps that use case reproducible without claiming that one synthetic setup is already a broad customer benchmark.

## Included surfaces

- `tests/fixtures/federation-flagship/` — three checked-in repo-local `graph.json` fixtures for `frontend`, `backend`, and `shared`.
- `federation-receipt.json` — the bounded receipt for federating those three graphs with the current `madar federate` command.

## Reproduce the receipt

```bash
mkdir -p out/federation-flagship/{frontend,backend,shared}/out
cp tests/fixtures/federation-flagship/frontend/graph.json out/federation-flagship/frontend/out/graph.json
cp tests/fixtures/federation-flagship/backend/graph.json out/federation-flagship/backend/out/graph.json
cp tests/fixtures/federation-flagship/shared/graph.json out/federation-flagship/shared/out/graph.json

madar federate \
  out/federation-flagship/frontend/out/graph.json \
  out/federation-flagship/backend/out/graph.json \
  out/federation-flagship/shared/out/graph.json \
  --output out/federation-flagship
```

The fixture is intentionally small and synthetic. The checked-in `tests/fixtures/federation-flagship/` files are the source fixtures; the copy step stages them inside `out/`, which is the path boundary the current federation command accepts. Its cross-repo edges come from **shared labels** (`SessionContract`, `UserProfile`) across the three repos, which is exactly what the current federation implementation infers today. That makes this a reproducible federation proof surface, **not a broad cross-repo benchmark headline** and not a claim that real enterprise repos will all behave the same way.

## Safe interpretation

- Treat this as a reproducible federation receipt, not a universal performance claim.
- Use it to explain why one graph across **frontend/backend/shared** repos is useful.
- Do not describe it as proof of broad cross-repo implementation outcomes or a production benchmark.
