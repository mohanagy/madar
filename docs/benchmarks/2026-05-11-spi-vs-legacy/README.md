# 2026-05-11 — `sadeem generate --spi` vs legacy `extract()`

> **Tracking issues:** [#130](https://github.com/mohanagy/sadeem/issues/130) and the v0.21 context-compiler payoff follow-up.

## TL;DR (latest measured run: `results/2026-05-11T163843Z/`)

| Metric | Legacy | `--spi` | Δ |
|---|---:|---:|---:|
| Build time (cold) | 500 ms | 706 ms | **+41.2%** |
| Build time (cache-hit) | n/a | 366 ms | **−26.8% vs legacy**, **−48.2% vs spi-cold** |
| `graph.json` size | 62.8 KB | 42.9 KB | **−31.6%** |
| Node count | 29 | 30 | +1 |
| Total explain-pack tokens (7 prompts, budget 2000) | 330 | 378 | **+14.5%** |

The current v0.21 runtime changes do **not** reduce total explain-pack tokens on this bundled fixture. The benchmark still shows two concrete payoffs:

1. `--spi` keeps returning the structurally correct substrate for framework-shaped prompts (`prisma_client`, `trpc_procedure_*`) while legacy still misroutes some of them.
2. `retrieval_level` is now operational: the same prompt expands from tight seed-only packs at level 1 to materially broader cross-module packs at level 4.

## Base prompt breakdown

| Prompt | Legacy top labels | `--spi` top labels | Token Δ |
|---|---|---|---:|
| `express-route` | `GET /api/users/:id`, `GET /api/users` | `getUserById()`, `listUsers()` | -9 |
| `hono-route` | `listProducts()`, `createProduct()` | `listProducts()`, `createProduct()` | 0 |
| `trpc-mutations` | `app` | `appRouter.cancelOrder()`, `appRouter.createOrder()` | +79 |
| `prisma-client` | `USE /`, `USE /api/users` | `prisma`, `createOrder()` | -9 |
| `auth-middleware` | `authMiddleware()`, `listUsers()` | `authMiddleware()`, `app` | -5 |
| `generic-utils` | `debounce()` | `debounce()` | -1 |
| `cross-framework` | `GET /`, `GET /:id` | `createUser()`, `getUserById()` | -7 |

Two prompts still show the correctness gap clearly:

- `trpc-mutations`: legacy surfaces the generic `app`; `--spi` surfaces `trpc_procedure_mutation` nodes.
- `prisma-client`: legacy surfaces Express middleware; `--spi` surfaces the `prisma_client`.

## Selection strategy comparison (`value-per-token` vs `evidence-order`)

The benchmark runner now emits `spi-cold.analysis.json`, which compares both strategies on the same SPI graph and records ranking reasons, penalties, selected labels, quality score, and warnings.

On the bundled fixture, **there is no measured token or node-count delta across the 7 prompts**. `value-per-token` changes the internal ranking diagnostics, but this workload does not create enough optional-candidate competition to separate the final packs.

That means this fixture is now a **regression baseline for determinism and diagnostics**, not proof of a token win for the strategy itself. The behavioral difference is covered by focused runtime tests instead:

- framework-relevant nodes can beat generic label matches,
- smaller higher-value candidates can beat larger low-value ones,
- selection diagnostics explain why entries were included or omitted.

## Retrieval-level sweep (`retrieval_level`)

The same SPI graph was measured at retrieval levels 1–4 for every prompt. A few representative examples:

| Prompt | Level 1 | Level 4 | What changed |
|---|---|---|---|
| `express-route` | 54 tokens / 2 nodes | 223 tokens / 9 nodes | expands from route seeds to router/app/middleware/file context |
| `trpc-mutations` | 101 tokens / 2 nodes | 303 tokens / 8 nodes | expands from mutation seeds to router, query/subscription siblings, and backing file |
| `prisma-client` | 45 tokens / 2 nodes | 93 tokens / 4 nodes | expands from the client seed to file + dependent usage sites |

Selected framework roles stay explicit in the analysis output:

- level 1 `prisma-client` includes `prisma_client`
- level 1 `trpc-mutations` includes `trpc_procedure_mutation`
- level 4 `trpc-mutations` expands to `trpc_router`, `trpc_procedure_query`, and `trpc_procedure_subscription`
- level 4 `express-route` expands to `express_route`, `express_router`, `express_app`, and `express_middleware`

Diagnostics also become more useful at higher levels on this fixture. For example, `trpc-mutations` carries `undersized_retrieval` / `orphan_nodes` warnings at level 1, but level 4 clears them.

## How to reproduce

```bash
# from repo root
bash docs/benchmarks/2026-05-11-spi-vs-legacy/run.sh
```

The runner now produces:

1. `legacy.json`, `spi-cold.json`, `spi-warm.json`
2. `spi-cold.analysis.json` — strategy comparison + retrieval-level sweep
3. `summary.json` — top-level aggregate report
4. `edge_count` in each variant JSON

### Optional: point the runner at another local repo

If you have a local backend-only or monorepo workspace, you can reuse the same runner without committing private paths:

```bash
SADEEM_BENCH_FIXTURE=/absolute/path/to/repo \
SADEEM_BENCH_PROMPTS=docs/benchmarks/2026-05-11-spi-vs-legacy/prompts.json \
bash docs/benchmarks/2026-05-11-spi-vs-legacy/run.sh
```

For a fully manual flow:

```bash
npm run build
node dist/src/cli/bin.js generate /absolute/path/to/repo --no-html
node dist/src/cli/bin.js generate /absolute/path/to/repo --spi --no-html
node docs/benchmarks/2026-05-11-spi-vs-legacy/probe.mjs \
  /absolute/path/to/repo/out/graph.json \
  docs/benchmarks/2026-05-11-spi-vs-legacy/prompts.json
```

If GoValidate is available locally, use the template above for both the backend-only checkout and the monorepo checkout. This repo does **not** commit any private-path defaults or fake results for those runs.

### Real-workspace matrix runner

You can benchmark two local workspaces side by side without committing private paths or artifacts:

```bash
SADEEM_BENCH_BACKEND=/absolute/path/to/backend \
SADEEM_BENCH_MONOREPO=/absolute/path/to/monorepo \
bash docs/benchmarks/2026-05-11-spi-vs-legacy/run-real-workspace.sh
```

Defaults:

- prompts file: `docs/benchmarks/2026-05-11-spi-vs-legacy/prompts.real-workspace.example.json`
- output bundle: `docs/benchmarks/2026-05-11-spi-vs-legacy/results/real-workspaces/<timestamp>/`

Artifacts:

1. one normal benchmark run per workspace (`backend/summary.json`, `monorepo/summary.json`)
2. `real-workspaces.summary.json` — side-by-side aggregate summary
3. `REAL_WORKSPACE_REPORT_TEMPLATE.md` — sharing template with privacy disclaimer

The aggregate summary keeps objective metrics separate from qualitative notes and does not claim any private-repo numbers unless you run the benchmark locally.

## Caveats / limitations

- **Fixture is synthetic.** It is still small enough that the new `value-per-token` scorer does not beat evidence-order on final pack size.
- **No universal token-win claim.** The current bundled SPI run is **+14.5%** total explain-pack tokens vs legacy.
- **Selection payoff is still real but narrower here.** The main measured benefits on this fixture are substrate correctness, explicit diagnostics, and retrieval-level control.
- **No diff-aware level-5 benchmark here.** The bundled fixture has no PR/change overlay, so the sweep stops at levels 1–4.

## Files

- `fixture/` — synthetic TypeScript workspace covering Express, Hono, tRPC, Prisma, and utility code
- `prompts.json` — benchmark prompts
- `run.sh` — runner (`SADEEM_BENCH_FIXTURE` / `SADEEM_BENCH_PROMPTS` overrides supported)
- `probe.mjs` — strategy comparison + retrieval-level sweep
- `summarize.mjs` — aggregate summary builder
- `results/<timestamp>/` — measured run artifacts
