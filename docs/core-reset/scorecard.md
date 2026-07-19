# Core Reset scorecard

> **RFC:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Status:** accepted; scope and baseline is the only authorized phase

This is the phase-gate evidence ledger. An issue or PR link is not evidence by itself; each gate needs a reproducible test, receipt, measurement, or external-user record.

## Baseline

| Metric | Current baseline | Target | Evidence |
| --- | ---: | ---: | --- |
| Production TypeScript source | 181 files / 96,766 LOC | <=80 files / 25,000–35,000 LOC | Repository inventory, 2026-07-19 |
| Parallel edge preservation | Fails: same source/target overwrites | 100% invariant coverage | Pending fixture |
| Default extraction paths for supported JS/TS | SPI plus legacy augmentation | One canonical indexer | `src/infrastructure/generate.ts` |
| Untuned strict OpenStatus flow | Partial | Complete in one call plus <=2 focused reads | #565 and #574 |
| Verified live design partners | 0 of 5 | 5 trials; >=3 retained | `docs/claims-and-evidence.md` |
| npm package | Record in baseline issue | <150 files / <1.5 MB unpacked | Pending baseline receipt |
| CLI startup | Record in baseline issue | <100 ms / <80 MB RSS | Pending baseline receipt |

Baseline values that are not yet reproducible are recorded as unknown rather than estimated.

## Phase gates

| Phase | Status | Exit gate | Evidence |
| --- | --- | --- | --- |
| Scope and baseline | Ready | Baseline script/receipt committed; held-out evaluation contract frozen; removal manifest reviewed | #577 and #579 |
| Directed multigraph | Not started | Parallel types, direction, stable IDs, provenance, and serialization pass | Pending |
| Canonical TypeScript index | Not started | Labelled TS/framework gates pass without legacy augmentation | Pending |
| Incremental index | Not started | Add/change/delete/rename output equals clean rebuild | Pending |
| Evidence-path query | Not started | Held-out correctness and one-call completeness gates pass without repo-specific logic | Pending |
| Delivery and package | Not started | Thin MCP/CLI, activation, startup, and package budgets pass | Pending |
| Capability validation | Not started | Native vs Graphify vs Madar blinded gates pass | Pending |
| External validation | Not started | Activation, retention, and paid-intent gates pass | Pending |
| Stable release | Not started | Every blocking gate passed; old core absent; migration docs ready | Pending |

Only one technical phase may be `In progress` at a time.

## Graph gates

- [ ] Multiple edge kinds between the same two nodes survive build, serialization, and load.
- [ ] Directed callers/callees and import/export relationships traverse correctly.
- [ ] Node and edge IDs are deterministic across unchanged rebuilds.
- [ ] Evidence locations and provenance survive serialization.
- [ ] Deleted and renamed files leave no stale nodes or edges.

## Index gates

Labelled fixtures cover ESM, CJS, barrel exports, aliases, TypeScript paths, project references, calls, types, classes, interfaces, Express, NestJS, Next.js, tRPC, Prisma, React Router, Fastify, and Hono.

- [ ] Import/re-export recall >=95%.
- [ ] Call/framework-edge recall >=90%.
- [ ] Precision is independently reported and accepted against the frozen baseline.
- [ ] No legacy augmentation or projector participates.
- [ ] No evaluation-repository identifier exists under production source.

## Query and product gates

- [ ] Correctness is no worse than the best native/Graphify comparator.
- [ ] One-call evidence completeness >=80% on held-out flows.
- [ ] At least 75% of successful tasks need one Madar call plus <=2 focused reads.
- [ ] Median total provider input is at least 25–30% lower than native search.
- [ ] Median end-to-end time is at least 20% lower than native search.
- [ ] Typical result stays within 12 files, 25 snippets, and 4,000 input tokens.
- [ ] Missing evidence is explicit; no global confidence label hides incomplete phases.
- [ ] Graph build and refresh cost is reported separately and with amortized break-even.

## Engineering gates

- [ ] Production TypeScript remains net-negative in LOC on every replacement PR.
- [ ] Final production source is <=80 files and 25,000–35,000 LOC.
- [ ] No unused-local or unused-parameter diagnostics.
- [ ] No dependency cycles or architecture-boundary violations.
- [ ] Production cannot import `tools/eval`.
- [ ] npm package is <150 files and <1.5 MB unpacked.
- [ ] `madar --version` is <100 ms and <80 MB RSS.
- [ ] MCP handshake and tool listing is <1 second cold.
- [ ] Warm retrieval p95 is <500 ms on an approximately 15,000-node graph.
- [ ] All CI checks and review threads are green/resolved.

## Business gates

### Discovery

- [ ] 15 qualified users interviewed.
- [ ] At least 10 experience the problem weekly.
- [ ] At least 8 rate the pain 4/5 or 5/5.
- [ ] At least 5 provide real tasks or comparable evidence.
- [ ] At least 5 commit to a four-week trial.

### Activation and retention

- [ ] Four of five partners complete setup.
- [ ] Median time to first useful answer is <15 minutes.
- [ ] At least three of five use Madar during three of four trial weeks.
- [ ] Broad-search restart after a Madar result is <25%.
- [ ] Incorrect confident paths are <5%.
- [ ] At least two teams commit to a paid pilot, or three credible buyers sign purchase-intent letters.

Downloads, stars, registry listings, and graph generation counts do not satisfy these gates.

## Weekly checkpoint template

Copy this into a comment on [#577](https://github.com/mohanagy/madar/issues/577):

```markdown
## Core Reset checkpoint — YYYY-MM-DD

### Completed
- Issues/PRs and capability delivered

### Deleted
- Files, production LOC, dependencies, commands, and tools removed

### Quality
- Correctness, one-call completeness, tokens, latency, package, and startup

### Business
- Interviews, active partners, useful sessions, repeat usage, and paid intent

### Drift audit
- Scope requests accepted/rejected, repository-specific logic found, and unused surfaces

### Next gate
- One active phase, issue, and objective exit condition
```

## Amendment history

| Date | Change | Evidence | Approved in |
| --- | --- | --- | --- |
| 2026-07-19 | Initial proposed scorecard | Deep technical and business review | #577 |
| 2026-07-19 | RFC accepted; scope-and-baseline phase authorized | Green governance PR and completed acceptance checklist | #577 and #579 |
