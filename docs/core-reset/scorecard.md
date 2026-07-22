# Core Reset scorecard

> **RFC:** [#577](https://github.com/mohanagy/madar/issues/577)
> **Milestone:** [`v0.40.0 — Core Reset`](https://github.com/mohanagy/madar/milestone/7)
> **Status:** accepted; Scope/Baseline, Directed multigraph, Canonical TypeScript index, and the combined legacy/non-code deletion passed; Generation and incremental index is the sole phase In progress through [#592](https://github.com/mohanagy/madar/issues/592)

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
| Refresh fixture equivalence | Add/change/delete/rename/linked-worktree all equal clean generation because `--update` performed another full rebuild; this proves graph equality only, not whole-artifact coherence or atomic publication | Clean-equivalent full reconciliation, a true cold no-op, and graph-last publication; no retained incremental engine | [Baseline receipt](evidence/baseline-v0.32.0.json), [failed fixed gate](evidence/generation-incremental-stop-500.json), and [#592](https://github.com/mohanagy/madar/issues/592) |
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
| Canonical TypeScript index | **Passed** | Labelled TS/framework gates pass without legacy augmentation | [#585](https://github.com/mohanagy/madar/issues/585), merged [PR #586](https://github.com/mohanagy/madar/pull/586), merge commit `4dfd48194f2fab00b2cd2271a6f7917909dde9d4`, six green CI jobs, [independent review passed](https://github.com/mohanagy/madar/pull/586#issuecomment-5036311350), nine actionable CodeRabbit comments and two review-body nitpicks addressed, and zero unresolved threads; the final CodeRabbit rerun was rate-limited and merged under an explicit owner-approved exception |
| Legacy extraction plus non-code/other-language ingestion | **Passed** | Delete both manifest-owned paths in one work item while canonical JS/TS fixtures remain green and no package/docs/flag claims unsupported ingestion | [#588](https://github.com/mohanagy/madar/issues/588), merged [PR #590](https://github.com/mohanagy/madar/pull/590), merge commit `d46031eed7b0cf2d8bb7b7b6267a51322d9e2490`, [six-job CI run](https://github.com/mohanagy/madar/actions/runs/29899357806), [independent review](https://github.com/mohanagy/madar/pull/590#issuecomment-5043069972), and zero review threads |
| Generation and reconciliation | **In progress** | Clean-equivalent changed-state full reconciliation, cold no-op, coherent graph-last publication, predecessor deletion, and accepted source/package budgets pass without any retained session cache | [#592](https://github.com/mohanagy/madar/issues/592), [fixed-gate stop receipt](evidence/generation-incremental-stop-500.json), and [current inventory](evidence/generation-incremental-inventory.json); final phase evidence remains open |
| Evidence-path query | Not started | Held-out correctness and one-call completeness gates pass without repo-specific logic | Pending |
| Delivery and package | Not started | Thin MCP/CLI, activation, startup, and package budgets pass | Pending |
| Capability validation | Not started | Native vs Graphify vs Madar blinded gates pass | Pending |
| External validation | Not started | Activation, retention, and paid-intent gates pass | Pending |
| Stable release | Not started | Every blocking gate passed; old core absent; migration docs ready | Pending |

Only one technical phase may be `In progress` at a time. `generation-and-incremental` is the single In progress phase through #592 from protected base `8886a0299ee30765ce149ca7ad5d1779496b78b5`. `legacy-extraction` and its absorbed `non-code-and-other-language-ingest` item are complete. Evidence-path query and thin delivery remain proposed and blocked. Activation is not implementation or completion.

### Directed multigraph phase evidence (passed)

- One always-directed `KnowledgeGraph` implementation now lives under `src/domain/graph/**`; there is no V1/V2 alias, mode, fallback loader, or second graph store.
- The five owned predecessor files are deleted. Obsolete HTML, SVG, GraphML, Cypher, and Obsidian exporter code was not recreated.
- Final protected-branch production inventory: 178 TypeScript files / 93,792 LOC.
- Final delta from protected phase base `647c2912e9ff000b5d92cae3fc61395d9e556062`: `+1,197 / -4,171 / net -2,974`; five new production files; zero dependency changes.
- Deterministic multigraph, build-adapter, serialization, schema rejection, provenance, collision, traversal, and consumer regressions are committed as tests. The baseline receipt remains unchanged.
- PR #583 was squash-merged at `63c59049178e82bd6bd1c928f6666ef159365bbe` after all six CI matrix jobs passed, CodeRabbit completed successfully, and every review thread was resolved.

### Canonical TypeScript index phase evidence (passed)

- One scanner-scoped TypeScript Program writes supported `.js`, `.jsx`, `.ts`, and `.tsx` facts directly to the canonical graph; no SPI projector, cache, diff overlay, test layer, or legacy augmentation participates.
- The 20 owned predecessor files are deleted. The completed phase adds 12 production files and no runtime dependency.
- Final protected-branch inventory is 170 production TypeScript files / 91,539 LOC. Delta from protected base `f68d64482578f0c7992ec63095fa00e19ac25880` is `+5,538 / -7,791 / net -2,253`, within the accepted phase budget.
- The gold harness uses one-to-one fact matching, forbidden facts, copied-root and repeated-run determinism, scanner-read isolation, and independent node/edge scoring. Import/re-export and call/framework edge recall are 100%; all eight framework buckets report 100% recall and precision with no unexpected facts.
- Local verification passes 188 test files / 2,525 tests (2 skipped). V8 coverage is 84.62% statements, 75.99% branches, 91.50% functions, and 85.04% lines; typecheck, build, release hygiene, registry validation, packed retrieval parity, package isolation, and high-severity dependency audit also pass.
- PR #586 was squash-merged at `4dfd48194f2fab00b2cd2271a6f7917909dde9d4` after all six CI matrix jobs passed and every review thread was resolved. All nine actionable CodeRabbit comments and both review-body nitpicks were addressed; eight of the nine actionable remediations were confirmed by CodeRabbit before its final rerun was rate-limited. An [independent adversarial review passed](https://github.com/mohanagy/madar/pull/586#issuecomment-5036311350), and the owner explicitly approved merging under that review-automation exception. This record does not claim that the final CodeRabbit rerun passed.

### Legacy and non-code deletion evidence (passed)

- [PR #590](https://github.com/mohanagy/madar/pull/590) was squash-merged into protected `core-reset` at `d46031eed7b0cf2d8bb7b7b6267a51322d9e2490` from final PR head `0d5aab99b9aeaf01a17830bacafd6e8027ded72f`. It completes [#588](https://github.com/mohanagy/madar/issues/588) and both removal-manifest ownership IDs.
- The phase removed 31 production files. Final protected-branch inventory is 139 production TypeScript files / 68,954 LOC; delta from protected base `9a762d0a4e10a0ae210ba3f53bb1d4468367e81e` is `+815 / -23,400 / net -22,585`, satisfying the accepted deletion and source budgets.
- The legacy and non-code engines, their three runtime dependencies, and `--legacy`, `--spi`, `--include-docs`, `--docs`, and `--wiki` are absent. Canonical TypeScript/JavaScript generation is the only supported index path, and predecessor artifacts fail closed with regeneration guidance.
- The full local suite reports 1,907 passed / 2 skipped. V8 coverage is 85.17% statements, 76.97% branches, 90.59% functions, and 85.85% lines; typecheck, build, release verification, registry validation, packed retrieval parity, and high-severity dependency audit also pass.
- The post-deletion npm package contains 314 files, 592,783 packed bytes, and 2,794,076 unpacked bytes. This improves the baseline but still fails the final `<150` files / `<1,500,000` unpacked-byte package gate; that gate remains open.
- All six jobs in [CI run 29899357806](https://github.com/mohanagy/madar/actions/runs/29899357806) passed and zero review threads remained. CodeRabbit did not review the final change because reviews are disabled for the `core-reset` base branch; the owner approved an explicit exception backed by a passing [independent strict review](https://github.com/mohanagy/madar/pull/590#issuecomment-5043069972). This record does not represent CodeRabbit as green.
- Cross-artifact transactional publication was deliberately not added to this deletion phase. #592 now accepts a narrower successor contract: `graph.json` is authoritative and commits last, while diagnostics are derived/non-blocking; no transaction framework or versioned snapshot store is allowed.

### Generation and incremental index phase evidence (active)

- [#592](https://github.com/mohanagy/madar/issues/592) and the [RFC amendment](https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586) are owner-approved. Protected phase base is `8886a0299ee30765ce149ca7ad5d1779496b78b5`.
- The active boundary owns 15 predecessor files / 3,839 LOC. It permits at most six replacement production files / 2,200 LOC, requires net production delta `<= -1,500`, and must finish at `<=130` production files / `<=67,454` LOC.
- Runtime and development dependency additions are both zero. The npm package must finish at `<=296` files / `<=2,700,000` unpacked bytes, with packed bytes no higher than the 592,783-byte phase base.
- The fixed 500-file experiment stopped the incremental design. Candidate checkpoint `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d`, worktree tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda`, measured warm index p50 ratio `0.824` against the required `<=0.50`, refresh p50 `1.047` against `<=0.75`, and refresh p95 `1.029` against `<=0.80`. The [stop receipt](evidence/generation-incremental-stop-500.json) is ineligible for acceptance and records the mandatory simplification.
- Held-out timing was intentionally skipped because the fixed gate had already triggered the stop condition and a held-out result could not reverse it. The failed in-memory incremental Program/fact/closure path was deleted rather than tuned or retained.
- The shipping architecture is now only: unchanged source state takes a cold no-op that parses and publishes nothing; changed source state performs one full canonical reconcile and reports it truthfully. There is no in-memory or disk session cache, persistent AST/fact/dependency cache, versioned store, WAL, journal, rollback manager, or generalized transaction subsystem.
- `graph.json` is the sole authoritative artifact and atomic commit marker. Derived diagnostic failure is reported but does not block a valid graph commit; fault-injection, concurrent-update, edit-during-build, and strict-index failure tests remain required.
- No-op cold median remains required at `<=20%` of clean generation with zero parsing/clustering/reporting/publication, and clean generation may regress at most 10% from the protected-base measurement. The stopped warm thresholds remain evidence of why the path was removed, not acceptance gates for the simplified implementation.
- Add/change/delete/rename/compiler-control/ignore/recognized-unsupported-file/symlink/worktree outputs must exactly equal clean generation with zero stale facts through the one full-reconcile path.
- Only successfully indexed `.ts`, `.tsx`, `.js`, and `.jsx` inputs determine completeness. A failed supported input is incomplete with exact file/reason; recognized unsupported files and expected policy exclusions are informational; safety exclusions remain separate and are never indexed.
- Exact runtime commit `1be24dc45a5f07c352c74fc374feb95a9440df8e` deletes all 15 predecessors and contains the six accepted replacements. The [inventory receipt](evidence/generation-incremental-inventory.json) records 130 production TypeScript files / 66,418 LOC and `+2,190 / -4,726 / net -2,536`; package dry-run is 276 files / 572,143 packed bytes / 2,699,851 unpacked bytes.
- The [exact-commit shipping receipt](evidence/generation-full-reconcile-500.json) is eligible: clean subject/tree identity passes, cold no-op p50 is 408.184 ms / `0.067` of clean generation with zero parse/invalidation/publication, and compatible clean-generation regression is `1.045` against the `<=1.10` limit. Source, package, and performance gates pass; final CI, PR, merge, and completion evidence remains open, so the phase stays **In progress**.

## Graph gates

- [x] Multiple edge kinds between the same two nodes survive build, serialization, and load.
- [x] Directed callers/callees and import/export relationships traverse correctly.
- [x] Node and edge IDs are deterministic across unchanged rebuilds.
- [x] Evidence locations and provenance survive serialization.
- [ ] Deleted and renamed files leave no stale nodes or edges. (Active under #592; evidence pending.)

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
- [ ] npm package is <150 files and <1.5 MB unpacked. (Current post-deletion package: 314 files / 2,794,076 unpacked bytes; still failing.)
- [ ] `madar --version` is <100 ms and <80 MB RSS.
- [ ] MCP handshake and tool listing is <1 second cold.
- [ ] Warm retrieval p95 is <500 ms on an approximately 15,000-node graph.
- [x] At the current completed phase head, all six CI jobs passed and zero review threads remained; CodeRabbit skipped review because reviews are disabled for the `core-reset` base branch, and the owner-approved exception is backed by an independent strict review rather than represented as a completed CodeRabbit review.

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
| 2026-07-21 | Canonical TypeScript index passed; combined legacy/non-code deletion became Ready with no active phase | Merged PR #586, final source delta, six green CI jobs, nine actionable CodeRabbit comments and two review-body nitpicks addressed, eight actionable remediations confirmed before rate limiting, independent review receipt, explicit owner exception, and zero unresolved threads | #585 and #586 |
| 2026-07-21 | Combined legacy/non-code deletion accepted and moved to In progress | #588 records the protected base, exact 31-file / 20,951-LOC deletion, four ownership transfers, three dependency removals, five retired flags, source budget, and exit gates | #588 |
| 2026-07-22 | Combined legacy/non-code deletion passed; Generation and incremental index became Ready with no active phase | Merged PR #590 at `d46031eed7b0cf2d8bb7b7b6267a51322d9e2490`; 31 production files removed; `+815 / -23,400 / net -22,585`; full suite 1,907 passed / 2 skipped; six green CI jobs; independent review; explicit owner-approved CodeRabbit exception; zero review threads; final package gate still failing | #588 and #590 |
| 2026-07-22 | Generation and incremental index accepted and moved to In progress | #592 originally recorded protected base `8886a0299ee30765ce149ca7ad5d1779496b78b5`, a warm-only experiment, graph-last publication, exact 15-file deletion, four ownership transfers, source/package/performance budgets, and strict non-goals. The later stop amendment supersedes the warm experiment. | #592 and #577 amendment |
| 2026-07-22 | Fixed incremental gate failed; active phase simplified and exact runtime passed | Candidate checkpoint `1d3c9b6` / tree `6bd1ae` missed all three warm thresholds, so the failed path was deleted. Exact runtime `1be24dc` passes the compatible 500-file shipping gates at cold-noop ratio `0.067`, zero parse/invalidation/publication, and clean regression `1.045`; CI, PR, merge, and completion evidence remain open. | [stop receipt](evidence/generation-incremental-stop-500.json), [shipping receipt](evidence/generation-full-reconcile-500.json), and [inventory](evidence/generation-incremental-inventory.json) |
