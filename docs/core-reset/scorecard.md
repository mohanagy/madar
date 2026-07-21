# Core Reset scorecard

> **RFC:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Status:** accepted; Scope/Baseline and Directed multigraph passed; Canonical TypeScript index is the single In progress phase

This is the phase-gate evidence ledger. An issue or PR link is not evidence by itself; each gate needs a reproducible test, receipt, measurement, or external-user record.

## Baseline

| Metric | Current baseline | Target | Evidence |
| --- | ---: | ---: | --- |
| Production TypeScript source | 181 files / 96,766 LOC; `+0 / -0 / net 0` in baseline phase | <=80 files / 25,000–35,000 LOC | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| npm package | 398 files / 3,777,995 unpacked bytes (fails) | <150 files / <1,500,000 bytes | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| CLI startup | 315.601 ms median / 220,151,808 bytes max RSS (fails) | <100 ms / <83,886,080 bytes | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| MCP startup and public surface | 308.235 ms median `tools/list` (passes); 7 tools (fails) | <1,000 ms / <=5 tools | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| Directed multigraph contract | Directed, reverse edge, and provenance pass; parallel edges, edge IDs, and exact serialization fail; 2 of 3 fixture edges survive | Every invariant passes | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| Default extraction for supported JS/TS | Auto routes 8 files through SPI and all 8 through legacy augmentation; `.js`, `.jsx`, `.ts`, and `.tsx` symbols are found; node IDs are stable but edge IDs are absent/unstable | One canonical indexer with stable node and edge IDs | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| Incremental fixture equivalence | Add/change/delete/rename/linked-worktree all equal clean generation; linked-worktree artifact is outside the worktree | Full-rebuild equivalence for every operation | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| Untuned strict OpenStatus flow | 2 of 4 in-scope phases covered (50%); partial / `verify_targets`; 9 matched files, 8 snippets, and 3 verification targets | Complete in one call plus <=2 focused reads | [Baseline receipt](evidence/baseline-v0.32.0.json), #565, and #574 |
| OpenStatus graph build | 224,485.466 ms / 36,310,715-byte graph / 20,137 nodes / 23,452 edges | Report separately and amortize | [Baseline receipt](evidence/baseline-v0.32.0.json) |
| OpenStatus retrieval | Cold startup plus one retrieve: 79,372.482 ms / 1,522 reported context tokens / 16,324 response bytes. **Warm p95 unknown:** the receipt records one cold run; reproduce with the frozen warm comparator trials. | Warm p95 <500 ms; typical result <=4,000 input tokens | [Baseline receipt](evidence/baseline-v0.32.0.json) and [evaluation contract](../../tools/eval/core-reset/contracts/evaluation-contract.json) |
| Provider input for one-call retrieval | **Unknown:** direct MCP probing has no provider session usage; reproduce with the frozen agent comparator protocol | >=25–30% below native | [Baseline receipt](evidence/baseline-v0.32.0.json) and [evaluation contract](../../tools/eval/core-reset/contracts/evaluation-contract.json) |
| Held-out refresh and break-even cost | **Unknown:** the three-sample Graphify/Madar refresh protocol and formula are frozen but not yet run | Report refresh separately and calculate amortized break-even | [Evaluation contract](../../tools/eval/core-reset/contracts/evaluation-contract.json) |
| Verified live design partners | 0 of 5 | 5 trials; >=3 retained | `docs/claims-and-evidence.md` |

The schema-validated, share-safe receipt was recorded at tooling checkout `250a637e03b736ab0146c9f87c102e90bca2af2e`; it proves `src/**` exactly matches frozen runtime baseline `33951d6cb57f6f4c33c8a8610fd61dcc94443f1f`. Unknown values remain unknown rather than being estimated or treated as zero.

## Phase gates

| Phase | Status | Exit gate | Evidence |
| --- | --- | --- | --- |
| Scope and baseline | **Passed** | Baseline script/receipt committed; held-out evaluation contract frozen; removal manifest reviewed | [#580](https://github.com/mohanagy/madar/issues/580), [receipt](evidence/baseline-v0.32.0.json), and [manifest](removal-manifest.yml) |
| Directed multigraph | **Passed** | Parallel types, direction, stable IDs, provenance, and serialization pass | [#582](https://github.com/mohanagy/madar/issues/582), merged [PR #583](https://github.com/mohanagy/madar/pull/583), invariant tests, six green CI jobs, successful CodeRabbit review, and zero unresolved threads |
| Canonical TypeScript index | **In progress** | Labelled TS/framework gates pass without legacy augmentation | `npm run test:run -- tests/unit/canonical-index-language.test.ts tests/unit/canonical-index-frameworks.test.ts --maxWorkers=1`; accepted [#585](https://github.com/mohanagy/madar/issues/585), protected base `f68d64482578f0c7992ec63095fa00e19ac25880` |
| Incremental index | Not started | Add/change/delete/rename output equals clean rebuild | Pending |
| Evidence-path query | Not started | Held-out correctness and one-call completeness gates pass without repo-specific logic | Pending |
| Delivery and package | Not started | Thin MCP/CLI, activation, startup, and package budgets pass | Pending |
| Capability validation | Not started | Native vs Graphify vs Madar blinded gates pass | Pending |
| External validation | Not started | Activation, retention, and paid-intent gates pass | Pending |
| Stable release | Not started | Every blocking gate passed; old core absent; migration docs ready | Pending |

Only one technical phase may be `In progress` at a time.

### Directed multigraph phase evidence (passed)

- One always-directed `KnowledgeGraph` implementation now lives under `src/domain/graph/**`; there is no V1/V2 alias, mode, fallback loader, or second graph store.
- The five owned predecessor files are deleted. Obsolete HTML, SVG, GraphML, Cypher, and Obsidian exporter code was not recreated.
- Final protected-branch production inventory: 178 TypeScript files / 93,792 LOC.
- Final delta from protected phase base `647c2912e9ff000b5d92cae3fc61395d9e556062`: `+1,197 / -4,171 / net -2,974`; five new production files; zero dependency changes.
- Deterministic multigraph, build-adapter, serialization, schema rejection, provenance, collision, traversal, and consumer regressions are committed as tests. The baseline receipt remains unchanged.
- PR #583 was squash-merged at `63c59049178e82bd6bd1c928f6666ef159365bbe` after all six CI matrix jobs passed, CodeRabbit completed successfully, and every review thread was resolved.

### Canonical TypeScript index candidate evidence (pending PR review)

- One scanner-scoped TypeScript Program writes supported `.js`, `.jsx`, `.ts`, and `.tsx` facts directly to the canonical graph; no SPI projector, cache, diff overlay, test layer, or legacy augmentation participates.
- The 20 owned predecessor files are deleted. The candidate adds 12 production files and no runtime dependency.
- Candidate inventory is 170 production TypeScript files / 91,539 LOC. Delta from protected base `f68d64482578f0c7992ec63095fa00e19ac25880` is `+5,538 / -7,791 / net -2,253`, within the accepted phase budget.
- The gold harness uses one-to-one fact matching, forbidden facts, copied-root and repeated-run determinism, scanner-read isolation, and independent node/edge scoring. Import/re-export and call/framework edge recall are 100%; all eight framework buckets report 100% recall and precision with no unexpected facts.
- Local verification passes 188 test files / 2,525 tests (2 skipped). V8 coverage is 84.62% statements, 75.99% branches, 91.50% functions, and 85.04% lines; typecheck, build, release hygiene, registry validation, packed retrieval parity, package isolation, and high-severity dependency audit also pass.
- Final CI matrix, CodeRabbit, and unresolved-thread evidence remains pending and is not claimed here.

## Graph gates

- [x] Multiple edge kinds between the same two nodes survive build, serialization, and load.
- [x] Directed callers/callees and import/export relationships traverse correctly.
- [x] Node and edge IDs are deterministic across unchanged rebuilds.
- [x] Evidence locations and provenance survive serialization.
- [ ] Deleted and renamed files leave no stale nodes or edges. (Deferred to the accepted incremental-equivalence phase.)

## Index gates

Labelled fixtures cover ESM, CJS, barrel exports, aliases, TypeScript paths, project references, calls, types, classes, interfaces, Express, NestJS, Next.js, tRPC, Prisma, React Router, Fastify, and Hono.

- [x] Import/re-export recall >=95% (canonical gold fixture: 100%).
- [x] Call/framework-edge recall >=90% (canonical gold fixture: 100%; all eight framework edge slices report 100%).
- [x] Precision is independently reported and accepted against the frozen baseline (100% node and edge precision with exact unexpected-fact reporting).
- [x] No legacy augmentation or projector participates in supported JS/TS indexing.
- [x] No evaluation-repository identifier exists under production source.

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

- [x] Production TypeScript remains net-negative in LOC on every replacement PR.
- [ ] Final production source is <=80 files and 25,000–35,000 LOC.
- [ ] No unused-local or unused-parameter diagnostics.
- [ ] No dependency cycles or architecture-boundary violations.
- [ ] Production cannot import `tools/eval`.
- [ ] npm package is <150 files and <1.5 MB unpacked.
- [ ] `madar --version` is <100 ms and <80 MB RSS.
- [ ] MCP handshake and tool listing is <1 second cold.
- [ ] Warm retrieval p95 is <500 ms on an approximately 15,000-node graph.
- [x] All required CI checks and review threads are green/resolved at the current completed phase head.

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
| 2026-07-19 | Scope/Baseline passed; Directed multigraph became ready | Schema-validated clean-checkout receipt, frozen comparator contract, and complete removal-manifest review | #580 |
| 2026-07-20 | Obsolete exporter-helper deletion moved into the active Directed multigraph phase; successor phase remains blocked pending merge | Removal manifest and executable governance checks | #582 |
| 2026-07-21 | Directed multigraph passed; Canonical TypeScript index became ready | Merged PR #583, final source delta, six green CI jobs, successful CodeRabbit review, and zero unresolved threads | #582 and #583 |
| 2026-07-21 | Canonical TypeScript index accepted and moved to In progress | Exact predecessor inventory, source budget, labelled fixture gates, and protected base recorded | #585 |
