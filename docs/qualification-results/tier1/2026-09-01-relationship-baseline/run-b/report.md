# Tier 1 qualification — first independent baseline

> **First Tier 1 measurement — gate not yet activated**
>
> Thresholds in this contract are pre-registered and uncalibrated. A failing cell here is a
> product finding to be triaged by a maintainer, not a reason to edit the frozen contract.
> `sealed holdout unsatisfied; results measure regression only`.

## Totals

| Result | Count |
| --- | --- |
| pass | 0 |
| fail | 8 |
| invalid | 0 |

Invalid cells are reported separately and are never folded into a quality percentage.

## Identity

- Contract version: `1.0.0`
- Frozen-input manifest: 23 files, digest `0a90b77b97cae20b886d70de28b9cf66a8ba540655e17d893fa586ad275922ef`
- Madar revision: `25b2b97fc60d55fc4a6ddb5b8d63ef067655a8ef` (version `0.32.1`)
- Semantic digest: `d8afb8edd5bf291cf469aa081ac46ec08b2d850d159dae29b42b988a55930960`

## Per-cell results

| Cell | Kind | Target | Target SHA | State | Path recall | Symbol recall | Answerability |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `arch-unstorage-driver-seam@unstorage` | task | `unstorage` | `e6be6135832f` | **fail** | 1/4 (0.25) | 0/4 (0.00) | `verify_targets` |
| `flow-hono-request-dispatch@hono` | task | `hono` | `26de73133b85` | **fail** | 0/5 (0.00) | 0/5 (0.00) | `verify_targets` |
| `impact-hono-drop-router-fallback@hono` | task | `hono` | `26de73133b85` | **fail** | 0/4 (0.00) | 0/4 (0.00) | `ready_with_caveat` |
| `neg-hono-absent-matcher-persistence` | negative_probe | `hono` | `26de73133b85` | **fail** | — | — | `verify_targets` |
| `neg-unstorage-absent-encryption` | negative_probe | `unstorage` | `e6be6135832f` | **fail** | — | — | `verify_targets` |
| `plan-unstorage-add-driver@unstorage` | task | `unstorage` | `e6be6135832f` | **fail** | 1/4 (0.25) | 1/3 (0.33) | `verify_targets` |
| `review-hono-error-handling@hono-seeded-error-disclosure` | task | `hono-seeded-error-disclosure` | `26de73133b85` | **fail** | 2/3 (0.67) | 2/3 (0.67) | `verify_targets` |
| `rootcause-hono-middleware-rerun@hono-seeded-compose` | task | `hono-seeded-compose` | `26de73133b85` | **fail** | 0/2 (0.00) | 0/2 (0.00) | `verify_targets` |

## Per-cell detail

### `arch-unstorage-driver-seam@unstorage` — fail

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `5c3722d182b5c36478ecabd2d1fb24f4f3eb40eba6e12032da89bebf12ef1d9f`
- Truth version `1.0.0`
- Expected critical files: `src/drivers/utils/index.ts`, `src/storage.ts`, `src/types.ts`, `src/utils.ts`
- Observed critical files: `src/storage.ts`
- Missing critical files: `src/drivers/utils/index.ts`, `src/types.ts`, `src/utils.ts`
- Expected critical symbols: `Driver`, `DriverFactory`, `createStorage`, `getMount`
- Observed critical symbols: **none**
- Missing critical symbols: `Driver`, `DriverFactory`, `createStorage`, `getMount`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/_utils.ts`, `src/drivers/azure-key-vault.ts`, `src/drivers/cloudflare-kv-http.ts`, `src/drivers/memory.ts`, `src/drivers/vercel-runtime-cache.ts`, `src/index.ts`, `src/storage.ts`, `test/drivers/azure-app-configuration.test.ts`, `test/drivers/azure-cosmos.test.ts`, `test/drivers/azure-key-vault.test.ts`, `test/drivers/azure-storage-blob.test.ts`, `test/drivers/azure-storage-table.test.ts`, `test/drivers/capacitor-preferences.test.ts`, `test/drivers/cloudflare-cache-binding.test.ts`, `test/drivers/cloudflare-kv-binding.test.ts`, `test/drivers/cloudflare-kv-http.test.ts`, `test/drivers/cloudflare-r2-binding.test.ts`, `test/drivers/db0.test.ts`, `test/drivers/deno-kv-node.test.ts`, `test/drivers/deno-kv.fixture.ts`, `test/drivers/deno-kv.test.ts`, `test/drivers/fs-lite.test.ts`, `test/drivers/fs.test.ts`, `test/drivers/github.test.ts`, `test/drivers/http.test.ts`, `test/drivers/indexedb.test.ts`, `test/drivers/localstorage.test.ts`, `test/drivers/lru-cache.test.ts`, `test/drivers/memory.test.ts`, `test/drivers/mongodb.test.ts`, `test/drivers/netlify-blobs.test.ts`, `test/drivers/null.test.ts`, `test/drivers/overlay.test.ts`, `test/drivers/redis.test.ts`, `test/drivers/s3.test.ts`, `test/drivers/session-storage.test.ts`, `test/drivers/uploadthing.test.ts`, `test/drivers/upstash.test.ts`, `test/drivers/utils.ts`, `test/drivers/vercel-blob.test.ts`, `test/drivers/vercel-runtime-cache.test.ts`, `test/server.bench.ts`, `test/server.test.ts`, `test/storage.test-d.ts`, `test/storage.test.ts`, `test/tracing.test.ts`
- Reasons:
  - required_evidence_paths recall 0.2500 < min_critical_fact_recall 1; missing ["src/drivers/utils/index.ts","src/types.ts","src/utils.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["Driver","DriverFactory","createStorage","getMount"]
- Frozen relationships:
  - required: `relationship:arch:create-storage-to-driver`
  - present: **none**
  - missing: `relationship:arch:create-storage-to-driver`
  - exactly unresolved: —
  - uncovered: —
  - direction(s) evaluated: forward; relation kind(s): depends_on, param_type, references, uses
  - channels consulted: `.pack.relationships[]`, `.pack.review_bundle.relationships[]`, `.pack.slice.selected_paths[]` (2 typed edge(s) observed)
  - false-ready decision: **false**
- Evidence: `logs/pack-arch-unstorage-driver-seam--unstorage.log`

### `flow-hono-request-dispatch@hono` — fail

- Target `hono` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Prompt SHA-256 `c276d363f0b10c00b75df925f2e658f3ee7af085872bcbcc64a7a4252c7b3b35`
- Truth version `1.0.0`
- Expected critical files: `src/compose.ts`, `src/context.ts`, `src/hono-base.ts`, `src/router/smart-router/router.ts`, `src/utils/url.ts`
- Observed critical files: **none**
- Missing critical files: `src/compose.ts`, `src/context.ts`, `src/hono-base.ts`, `src/router/smart-router/router.ts`, `src/utils/url.ts`
- Expected critical symbols: `Context`, `SmartRouter`, `compose`, `fetch`, `getPath`
- Observed critical symbols: **none**
- Missing critical symbols: `Context`, `SmartRouter`, `compose`, `fetch`, `getPath`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/helper/route/index.test.ts`, `src/helper/route/index.ts`, `src/middleware/method-not-allowed/index.test.ts`, `src/middleware/method-not-allowed/index.ts`
- Reasons:
  - required_evidence_paths recall 0.0000 < min_critical_fact_recall 1; missing ["src/compose.ts","src/context.ts","src/hono-base.ts","src/router/smart-router/router.ts","src/utils/url.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["Context","SmartRouter","compose","fetch","getPath"]
- Frozen relationships:
  - required: `relationship:flow:dispatch-calls-compose`
  - present: **none**
  - missing: `relationship:flow:dispatch-calls-compose`
  - exactly unresolved: —
  - uncovered: —
  - direction(s) evaluated: forward; relation kind(s): calls
  - channels consulted: `.pack.relationships[]`, `.pack.review_bundle.relationships[]`, `.pack.slice.selected_paths[]` (0 typed edge(s) observed)
  - false-ready decision: **false**
- Evidence: `logs/pack-flow-hono-request-dispatch--hono.log`

### `impact-hono-drop-router-fallback@hono` — fail

- Target `hono` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Prompt SHA-256 `4d05391549ee28a142a9f24960e43e415cf6c831c29dce720aa74e72c7ab9ac2`
- Truth version `1.0.0`
- Expected critical files: `src/hono.ts`, `src/router/reg-exp-router/router.ts`, `src/router/smart-router/router.ts`, `src/router/trie-router/router.ts`
- Observed critical files: **none**
- Missing critical files: `src/hono.ts`, `src/router/reg-exp-router/router.ts`, `src/router/smart-router/router.ts`, `src/router/trie-router/router.ts`
- Expected critical symbols: `RegExpRouter`, `SmartRouter`, `TrieRouter`, `UnsupportedPathError`
- Observed critical symbols: **none**
- Missing critical symbols: `RegExpRouter`, `SmartRouter`, `TrieRouter`, `UnsupportedPathError`
- Observed answerability: `ready_with_caveat`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/helper/route/index.test.ts`, `src/helper/route/index.ts`, `src/middleware/method-not-allowed/index.test.ts`, `src/middleware/method-not-allowed/index.ts`
- Reasons:
  - required_evidence_paths recall 0.0000 < min_critical_fact_recall 1; missing ["src/hono.ts","src/router/reg-exp-router/router.ts","src/router/smart-router/router.ts","src/router/trie-router/router.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["RegExpRouter","SmartRouter","TrieRouter","UnsupportedPathError"]
  - [ADJ-IMPACT-RELATIONSHIP must_not_ready_when_relationships_missing] reported ready state 'ready_with_caveat' while relationship(s) ["relationship:impact:hono-constructor-calls-smart-router","relationship:impact:hono-constructor-calls-regexp-router","relationship:impact:hono-constructor-calls-trie-router"] were neither present in any declared relationship channel nor declared unresolved by an exact typed record (0 typed edge(s) observed, policy exact_per_relationship)
- Frozen relationships:
  - required: `relationship:impact:hono-constructor-calls-regexp-router`, `relationship:impact:hono-constructor-calls-smart-router`, `relationship:impact:hono-constructor-calls-trie-router`
  - present: **none**
  - missing: `relationship:impact:hono-constructor-calls-regexp-router`, `relationship:impact:hono-constructor-calls-smart-router`, `relationship:impact:hono-constructor-calls-trie-router`
  - exactly unresolved: —
  - uncovered: `relationship:impact:hono-constructor-calls-regexp-router`, `relationship:impact:hono-constructor-calls-smart-router`, `relationship:impact:hono-constructor-calls-trie-router`
  - direction(s) evaluated: forward; relation kind(s): calls
  - channels consulted: `.pack.relationships[]`, `.pack.review_bundle.relationships[]`, `.pack.slice.selected_paths[]` (0 typed edge(s) observed)
  - false-ready decision: **true**
- Evidence: `logs/pack-impact-hono-drop-router-fallback--hono.log`

### `neg-hono-absent-matcher-persistence` — fail

- Target `hono` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Prompt SHA-256 `6a173a57d204d86260380b3f9fedcb4dcc5c90962258e849b508fddaa3e07116`
- Truth version `1.0.0`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/router/reg-exp-router/router.ts`, `src/router/trie-router/node.ts`
- Reasons:
  - [ADJ-P1-ABSENCE required_typed_absence] missing_required_absence_declaration: no typed channel declares 'capability:on-disk-matcher-cache' absent. Accepted channels: [".evidence.answerability.unresolved_subjects[]",".pack.answer_contract.absent_capabilities[]",".evidence.answerability.missing_obligations[]"]
- Evidence: `logs/pack-neg-hono-absent-matcher-persistence.log`

### `neg-unstorage-absent-encryption` — fail

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `cab0b45defcdcaf0b88c5613384f84b237c1d365e0a1f3b3bbd16543fe6db37d`
- Truth version `1.0.0`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/drivers/azure-key-vault.ts`
- Reasons:
  - [ADJ-P0-ABSENCE required_typed_absence] missing_required_absence_declaration: no typed channel declares 'capability:encryption-at-rest' absent. Accepted channels: [".evidence.answerability.unresolved_subjects[]",".pack.answer_contract.absent_capabilities[]",".evidence.answerability.missing_obligations[]"]
- Evidence: `logs/pack-neg-unstorage-absent-encryption.log`

### `plan-unstorage-add-driver@unstorage` — fail

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `b8a0a2b4a0593346d1333d96ada6c339a0763611df1ddab51079369e0c62c7ff`
- Truth version `1.0.0`
- Expected critical files: `src/_drivers.ts`, `src/drivers/memory.ts`, `src/drivers/utils/index.ts`, `src/types.ts`
- Observed critical files: `src/_drivers.ts`
- Missing critical files: `src/drivers/memory.ts`, `src/drivers/utils/index.ts`, `src/types.ts`
- Expected critical symbols: `Driver`, `DriverFactory`, `createRequiredError`
- Observed critical symbols: `DriverFactory`
- Missing critical symbols: `Driver`, `createRequiredError`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/_drivers.ts`, `src/_utils.ts`, `src/drivers/planetscale.ts`, `src/drivers/s3.ts`, `src/server.ts`, `src/utils.ts`
- Reasons:
  - required_evidence_paths recall 0.2500 < min_critical_fact_recall 1; missing ["src/drivers/memory.ts","src/drivers/utils/index.ts","src/types.ts"]
  - required_evidence_symbols recall 0.3333 < min_critical_fact_recall 1; missing ["Driver","createRequiredError"]
- Evidence: `logs/pack-plan-unstorage-add-driver--unstorage.log`

### `review-hono-error-handling@hono-seeded-error-disclosure` — fail

- Target `hono-seeded-error-disclosure` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Patch digest `edb79059b72b4f27f5dc8341ba2d9a3617901c402da9ef1f9daf5503e6528d6f`
- Prompt SHA-256 `722278ed3fa2386f1e407b4fd53a7d4b89272f2adba4297f878ad3fd645d8e47`
- Truth version `1.0.0`
- Expected critical files: `src/compose.ts`, `src/hono-base.ts`, `src/http-exception.ts`
- Observed critical files: `src/compose.ts`, `src/hono-base.ts`
- Missing critical files: `src/http-exception.ts`
- Expected critical symbols: `HTTPException`, `compose`, `errorHandler`
- Observed critical symbols: `compose`, `errorHandler`
- Missing critical symbols: `HTTPException`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/compose.ts`, `src/context.ts`, `src/hono-base.ts`, `src/hono.test.ts`, `src/hono.ts`, `src/router.ts`, `src/types.ts`, `src/utils/constants.ts`, `src/utils/headers.ts`, `src/utils/http-status.ts`, `src/utils/url.ts`
- Reasons:
  - required_evidence_paths recall 0.6667 < min_critical_fact_recall 1; missing ["src/http-exception.ts"]
  - required_evidence_symbols recall 0.6667 < min_critical_fact_recall 1; missing ["HTTPException"]
- Evidence: `logs/pack-review-hono-error-handling--hono-seeded-error-disclosure.log`

### `rootcause-hono-middleware-rerun@hono-seeded-compose` — fail

- Target `hono-seeded-compose` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Patch digest `9355c5bbb05cd5ae4d998ace18d6381f0cba4fd080203d4d02579da3dcf6dea4`
- Prompt SHA-256 `637cd655712c2e7d96a3566ed0b311d9d7dcfe0d9cfb8b699f5f1c52a721eaf0`
- Truth version `1.0.0`
- Expected critical files: `src/compose.ts`, `src/hono-base.ts`
- Observed critical files: **none**
- Missing critical files: `src/compose.ts`, `src/hono-base.ts`
- Expected critical symbols: `compose`, `dispatch`
- Observed critical symbols: **none**
- Missing critical symbols: `compose`, `dispatch`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/adapter/service-worker/index.ts`
- Reasons:
  - required_evidence_paths recall 0.0000 < min_critical_fact_recall 1; missing ["src/compose.ts","src/hono-base.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["compose","dispatch"]
- Frozen relationships:
  - required: `relationship:rootcause:dispatch-calls-compose`
  - present: **none**
  - missing: `relationship:rootcause:dispatch-calls-compose`
  - exactly unresolved: —
  - uncovered: —
  - direction(s) evaluated: forward; relation kind(s): calls
  - channels consulted: `.pack.relationships[]`, `.pack.review_bundle.relationships[]`, `.pack.slice.selected_paths[]` (0 typed edge(s) observed)
  - false-ready decision: **false**
- Evidence: `logs/pack-rootcause-hono-middleware-rerun--hono-seeded-compose.log`

## Evidence surface

The consumer-visible evidence surface is declared channel by channel in `scripts/lib/qualify-tier1/channels.mjs`: 287 channels — 221 ignored, 28 path, 2 snippet, 36 symbol.

A run refuses to measure a cell whose artifact presents a channel the registry does not classify, so closure is a checked property rather than a claim. Closed on this run: **yes**.

| Channel | Role | Tier | Why ignored |
| --- | --- | --- | --- |
| `.pack.target_file` | path | strict | — |
| `.pack.affected_files[]` | path | strict | — |
| `.pack.direct_dependents[].source_file` | path | strict | — |
| `.pack.transitive_dependents[].source_file` | path | strict | — |
| `.pack.matched_nodes[].source_file` | path | strict | — |
| `.pack.seed_nodes[].source_file` | path | strict | — |
| `.pack.review_bundle.nodes[].source_file` | path | strict | — |
| `.pack.changed_files[]` | path | strict | — |
| `.pack.changed_ranges[].source_file` | path | strict | — |
| `.pack.execution_slice.steps[].source_file` | path | strict | — |
| `.pack.execution_slice.primary_path.steps[].source_file` | path | strict | — |
| `.recommended_first_read[].path` | path | strict | — |
| `.target` | symbol | strict | — |
| `.pack.target` | symbol | strict | — |
| `.pack.direct_dependents[].label` | symbol | strict | — |
| `.pack.transitive_dependents[].label` | symbol | strict | — |
| `.pack.matched_nodes[].label` | symbol | strict | — |
| `.pack.seed_nodes[].label` | symbol | strict | — |
| `.pack.review_bundle.nodes[].label` | symbol | strict | — |
| `.pack.execution_slice.steps[].label` | symbol | strict | — |
| `.pack.execution_slice.primary_path.steps[].label` | symbol | strict | — |
| `.pack.relationships[].from` | symbol | strict | — |
| `.pack.relationships[].to` | symbol | strict | — |
| `.pack.review_bundle.relationships[].from` | symbol | strict | — |
| `.pack.review_bundle.relationships[].to` | symbol | strict | — |
| `.pack.slice.anchors[].label` | symbol | strict | — |
| `.pack.slice.selected_paths[].from` | symbol | strict | — |
| `.pack.slice.selected_paths[].to` | symbol | strict | — |
| `.pack.top_paths_per_community[].path[]` | symbol | strict | — |
| `.pack.per_node_impact[].node` | symbol | strict | — |
| `.claims[].node_labels[]` | symbol | strict | — |
| `.evidence.answerability.verification_targets[].focus_files[]` | path | generous | — |
| `.evidence.answerability.verification_targets[].focus_ranges[].source_file` | path | generous | — |
| `.evidence.covered_workflow_owners[]` | path | generous | — |
| `.expandable[].follow_up.focus_files[]` | path | generous | — |
| `.expandable[].follow_up.focus_ranges[].source_file` | path | generous | — |
| `.expandable[].preview[].source_file` | path | generous | — |
| `.likely_edit_files[].path` | path | generous | — |
| `.likely_test_files[].path` | path | generous | — |
| `.workflow_centers[].path` | path | generous | — |
| `.risk_boundaries[].affected_files[]` | path | generous | — |
| `.implementation.likely_edit_files[].path` | path | generous | — |
| `.implementation.likely_test_files[].path` | path | generous | — |
| `.implementation.workflow_centers[].path` | path | generous | — |
| `.implementation.risk_boundaries[].affected_files[]` | path | generous | — |
| `.pack.review_context.supporting_paths[]` | path | generous | — |
| `.pack.review_context.test_paths[]` | path | generous | — |
| `.recommended_first_read[].label` | symbol | generous | — |
| `.workflow_centers[].label` | symbol | generous | — |
| `.workflow_centers[].matched_symbols[]` | symbol | generous | — |
| `.likely_edit_files[].matched_symbols[]` | symbol | generous | — |
| `.likely_test_files[].matched_symbols[]` | symbol | generous | — |
| `.risk_boundaries[].label` | symbol | generous | — |
| `.implementation.workflow_centers[].label` | symbol | generous | — |
| `.implementation.workflow_centers[].matched_symbols[]` | symbol | generous | — |
| `.implementation.likely_edit_files[].matched_symbols[]` | symbol | generous | — |
| `.implementation.likely_test_files[].matched_symbols[]` | symbol | generous | — |
| `.implementation.risk_boundaries[].label` | symbol | generous | — |
| `.pack.graph_signals.god_nodes[]` | symbol | generous | — |
| `.pack.graph_signals.bridge_nodes[]` | symbol | generous | — |
| `.pack.risk_summary.high_impact_nodes[]` | symbol | generous | — |
| `.pack.risk_summary.top_risks[].label` | symbol | generous | — |
| `.pack.review_context.hotspots[].label` | symbol | generous | — |
| `.expandable[].preview[].label` | symbol | generous | — |
| `.pack.matched_nodes[].snippet` | snippet | — | — |
| `.pack.review_bundle.nodes[].snippet` | snippet | — | — |

<details><summary>Channels deliberately not treated as evidence</summary>

| Channel | Reason |
| --- | --- |
| `.prompt` | the frozen prompt echoed back; the question is not evidence |
| `.plan.prompt` | the frozen prompt echoed back; the question is not evidence |
| `.pack.question` | the frozen prompt echoed back; the question is not evidence |
| `.retrieval_gate.signals.mentioned_paths[]` | tokens lifted from the prompt, not retrieved from the graph |
| `.retrieval_gate.signals.mentioned_symbols[]` | tokens lifted from the prompt, not retrieved from the graph |
| `.pack.retrieval_gate.signals.mentioned_paths[]` | tokens lifted from the prompt, not retrieved from the graph |
| `.pack.retrieval_gate.signals.mentioned_symbols[]` | tokens lifted from the prompt, not retrieved from the graph |
| `.retrieval_gate.signals.excluded_path_hints[]` | exclusion hints derived from the prompt, not retrieved evidence |
| `.retrieval_gate.signals.excluded_terms[]` | exclusion hints derived from the prompt, not retrieved evidence |
| `.pack.retrieval_gate.signals.excluded_path_hints[]` | exclusion hints derived from the prompt, not retrieved evidence |
| `.pack.retrieval_gate.signals.excluded_terms[]` | exclusion hints derived from the prompt, not retrieved evidence |
| `.graph_path` | path of the graph artifact this tool wrote, not a path in the target |
| `.evidence.answerability.unresolved_subjects[].subject_id` | typed absence declaration; consumed by the adjudication contract, never as evidence |
| `.evidence.answerability.unresolved_subjects[].status` | typed absence declaration status |
| `.evidence.answerability.unresolved_requirements[].requirement_id` | typed unresolved declaration; consumed by the adjudication contract, never as evidence |
| `.evidence.answerability.unresolved_requirements[].status` | typed unresolved declaration status |
| `.pack.answer_contract.absent_capabilities[].capability` | typed absence declaration; consumed by the adjudication contract, never as evidence |
| `.pack.answer_contract.absent_capabilities[].status` | typed absence declaration status |
| `.pack.base_branch` | git ref name, not a code symbol or path |
| `.pack.affected_communities[].label` | community/cluster name, not a code symbol. "Drivers Github — Driver" must not satisfy the obligation "Driver". |
| `.pack.community_context[].label` | community/cluster name, not a code symbol |
| `.pack.review_bundle.community_context[].label` | community/cluster name, not a code symbol |
| `.pack.seed_nodes[].community_label` | community/cluster name, not a code symbol |
| `.pack.top_paths_per_community[].label` | community/cluster name, not a code symbol |
| `.workflow_centers[].reason` | prose rationale |
| `.workflow_centers[].reasons[]` | prose rationale |
| `.workflow_centers[].phases[]` | pipeline-phase taxonomy value |
| `.implementation.workflow_centers[].reason` | prose rationale |
| `.implementation.workflow_centers[].reasons[]` | prose rationale |
| `.implementation.workflow_centers[].phases[]` | pipeline-phase taxonomy value |
| `.claims[].evidence_class` | evidence-class taxonomy value |
| `.claims[].text` | prose restatement of node_labels, which are extracted directly |
| `.coverage.entries[].evidence_class` | evidence-class taxonomy value |
| `.coverage.entries[].status` | coverage status enum |
| `.coverage.missing_required[]` | evidence-class taxonomy value |
| `.coverage.missing_semantic[]` | semantic-category taxonomy value |
| `.coverage.required_evidence[]` | evidence-class taxonomy value |
| `.coverage.semantic_entries[].category` | semantic-category taxonomy value |
| `.coverage.semantic_entries[].label` | semantic-category taxonomy value, not a code symbol |
| `.coverage.semantic_entries[].status` | coverage status enum |
| `.coverage.semantic_optional[]` | semantic-category taxonomy value |
| `.coverage.semantic_required[]` | semantic-category taxonomy value |
| `.evidence.agent_directive` | directive enum |
| `.evidence.answerability.answer_scope` | scope enum |
| `.evidence.answerability.broad_search_fallback` | fallback-policy enum |
| `.evidence.answerability.caveats[]` | consumed as an absence-declaration channel, not as evidence for the target |
| `.evidence.answerability.missing_obligations[]` | obligation identifiers; consumed as an unresolved-declaration channel |
| `.evidence.answerability.state` | the published answerability state, read separately |
| `.evidence.answerability.verification_targets[].evidence_class` | evidence-class taxonomy value |
| `.evidence.answerability.verification_targets[].handle_id` | opaque expansion handle identifier |
| `.evidence.answerability.verification_targets[].reason` | prose rationale |
| `.evidence.confidence_reasons[]` | prose rationale |
| `.evidence.coverage` | coverage status enum |
| `.evidence.coverage_detail.covered_obligations[]` | obligation identifiers, not target evidence |
| `.evidence.coverage_detail.missing_obligations[]` | obligation identifiers; consumed as an unresolved-declaration channel |
| `.evidence.coverage_detail.required_obligations[]` | obligation identifiers, not target evidence |
| `.evidence.coverage_detail.status` | coverage status enum |
| `.evidence.discovery_exclusions.policy` | policy enum |
| `.evidence.evidence_strength.level` | strength enum |
| `.evidence.evidence_strength.reasons[]` | diagnostic reason code |
| `.evidence.indexing_completeness.state` | completeness enum |
| `.evidence.missing_phases[]` | pipeline-phase taxonomy value; consumed as an unresolved-declaration channel |
| `.evidence.pack_confidence` | confidence enum |
| `.evidence.recovery.attempts[].status` | recovery status enum |
| `.evidence.recovery.final_state` | answerability enum from the recovery loop |
| `.evidence.recovery.initial_state` | answerability enum from the recovery loop |
| `.evidence.recovery.status` | recovery status enum |
| `.expandable[].evidence_class` | evidence-class taxonomy value |
| `.expandable[].follow_up.evidence_class` | evidence-class taxonomy value |
| `.expandable[].follow_up.kind` | follow-up kind enum |
| `.expandable[].follow_up.task_kind` | task-kind enum |
| `.expandable[].handle_id` | opaque expansion handle identifier |
| `.expandable[].kind` | expansion kind enum |
| `.expandable[].preview[].node_id` | internal node identifier, not a source symbol |
| `.governance.directive.agent_directive` | directive enum |
| `.governance.directive.answerability` | the published answerability state, read separately |
| `.governance.directive.coverage` | coverage status enum |
| `.governance.directive.evidence_strength` | strength enum |
| `.governance.directive.missing_phases[]` | pipeline-phase taxonomy value; consumed as an unresolved-declaration channel |
| `.governance.directive.pack_confidence` | confidence enum |
| `.governance.follow_up.expandable_evidence_classes[]` | evidence-class taxonomy value |
| `.governance.follow_up.expansion_task_kinds[]` | task-kind enum |
| `.governance.graph_freshness.generated_at` | tool timestamp |
| `.governance.graph_freshness.graph_modified_at` | tool timestamp |
| `.governance.graph_freshness.graph_version` | graph artifact version identifier |
| `.governance.graph_freshness.madar_version` | Madar version string |
| `.governance.graph_freshness.recommendation` | prose rationale |
| `.governance.graph_freshness.selected_context_status` | freshness enum |
| `.governance.graph_freshness.status` | freshness enum |
| `.governance.request.retrieval_strategy` | retrieval strategy enum |
| `.governance.request.task` | task-kind enum |
| `.governance.request.task_intent` | task-intent enum |
| `.governance.surface` | invocation surface enum |
| `.implementation.acceptance_criteria_summary[]` | prose implementation guidance |
| `.implementation.cautions[]` | prose implementation guidance |
| `.implementation.likely_edit_files[].phases[]` | pipeline-phase taxonomy value |
| `.implementation.likely_edit_files[].reason` | prose rationale |
| `.implementation.likely_edit_files[].why` | prose rationale |
| `.implementation.likely_test_files[].phases[]` | pipeline-phase taxonomy value |
| `.implementation.likely_test_files[].reason` | prose rationale |
| `.implementation.likely_test_files[].why` | prose rationale |
| `.implementation.retrieval_pipeline.phases[].phase` | pipeline-phase taxonomy value |
| `.implementation.retrieval_pipeline.phases[].summary` | prose rationale |
| `.implementation.risk_boundaries[].affected_communities[]` | community/cluster name, not a code symbol |
| `.implementation.risk_boundaries[].reason` | prose rationale |
| `.implementation.risk_boundaries[].severity` | severity enum |
| `.implementation.summary` | prose implementation guidance |
| `.implementation.validation_commands[]` | shell command suggestion, not target evidence |
| `.implementation.contracts_and_public_surfaces[]` | prose implementation guidance |
| `.implementation.existing_patterns[]` | prose implementation guidance |
| `.likely_edit_files[].phases[]` | pipeline-phase taxonomy value |
| `.likely_edit_files[].reason` | prose rationale |
| `.likely_edit_files[].why` | prose rationale |
| `.likely_test_files[].phases[]` | pipeline-phase taxonomy value |
| `.likely_test_files[].reason` | prose rationale |
| `.likely_test_files[].why` | prose rationale |
| `.missing_context[]` | evidence-class taxonomy value; consumed as an unresolved-declaration channel |
| `.missing_semantic[]` | semantic-category taxonomy value; consumed as an unresolved-declaration channel |
| `.negative_guidance[]` | prose guidance; consumed as an absence-declaration channel |
| `.public_contracts[]` | prose guidance |
| `.pack.answer_contract.answer_focus` | answer-contract enum |
| `.pack.answer_contract.confidence` | confidence enum |
| `.pack.answer_contract.do_not_claim[]` | prohibition identifiers; consumed as an absence-declaration channel |
| `.pack.answer_contract.entrypoint_scope` | answer-contract enum |
| `.pack.answer_contract.missing_phases[]` | pipeline-phase taxonomy value; consumed as an absence-declaration channel |
| `.pack.answer_contract.required_elements[]` | answer-contract element identifiers |
| `.pack.answer_contract.uncertainty_notes[]` | prose; consumed as an absence-declaration channel |
| `.pack.execution_slice.boundary_reason` | diagnostic reason code |
| `.pack.execution_slice.confidence` | confidence enum |
| `.pack.execution_slice.confidence_reasons[]` | diagnostic reason code |
| `.pack.execution_slice.phase_coverage.expected[]` | pipeline-phase taxonomy value |
| `.pack.execution_slice.phase_coverage.missing[]` | pipeline-phase taxonomy value; consumed as an unresolved-declaration channel |
| `.pack.execution_slice.phase_coverage.observed[]` | pipeline-phase taxonomy value |
| `.pack.execution_slice.primary_path.boundary_reason` | diagnostic reason code |
| `.pack.execution_slice.status` | slice status enum |
| `.pack.direct_dependents[].relation` | relation-kind taxonomy value |
| `.pack.transitive_dependents[].relation` | relation-kind taxonomy value |
| `.pack.relationships[].relation` | relation-kind taxonomy value |
| `.pack.relationships[].from_id` | internal node identifier, not a source symbol |
| `.pack.relationships[].to_id` | internal node identifier, not a source symbol |
| `.pack.review_bundle.relationships[].relation` | relation-kind taxonomy value |
| `.pack.review_bundle.nodes[].node_id` | internal node identifier, not a source symbol |
| `.pack.review_bundle.nodes[].node_kind` | node-kind taxonomy value |
| `.pack.review_bundle.nodes[].relevance_band` | relevance band enum |
| `.pack.review_bundle.nodes[].representation_reason` | prose rationale |
| `.pack.review_bundle.nodes[].representation_type` | representation enum |
| `.pack.review_bundle.shared_file_type` | file-type enum |
| `.pack.review_context.hotspots[].type` | hotspot-kind enum |
| `.pack.review_context.hotspots[].why` | prose rationale |
| `.pack.risk_summary.top_risks[].reason` | prose rationale |
| `.pack.risk_summary.top_risks[].severity` | severity enum |
| `.pack.matched_nodes[].node_id` | internal node identifier, not a source symbol |
| `.pack.matched_nodes[].node_kind` | node-kind taxonomy value |
| `.pack.matched_nodes[].relevance_band` | relevance band enum |
| `.pack.matched_nodes[].representation_reason` | prose rationale |
| `.pack.matched_nodes[].representation_type` | representation enum |
| `.pack.matched_nodes[].snippet_scope` | snippet scope enum |
| `.pack.matched_nodes[].source_domain` | source-domain enum |
| `.pack.seed_nodes[].match_kind` | match-kind enum |
| `.pack.seed_nodes[].node_id` | internal node identifier, not a source symbol |
| `.pack.seed_nodes[].node_kind` | node-kind taxonomy value |
| `.pack.seed_nodes[].source_location` | line marker such as "L31", not a path |
| `.pack.slice.anchors[].node_id` | internal node identifier, not a source symbol |
| `.pack.slice.anchors[].reason` | prose rationale |
| `.pack.slice.directions[]` | traversal-direction enum |
| `.pack.slice.mode` | slice mode enum |
| `.pack.slice.selected_paths[].direction` | traversal-direction enum |
| `.pack.slice.selected_paths[].from_id` | internal node identifier, not a source symbol |
| `.pack.slice.selected_paths[].relation` | relation-kind taxonomy value |
| `.pack.slice.selected_paths[].to_id` | internal node identifier, not a source symbol |
| `.pack.retrieval_gate.intent` | retrieval-gate enum |
| `.pack.retrieval_gate.reason` | prose rationale |
| `.pack.retrieval_gate.signals.generation_intent` | retrieval-gate enum |
| `.pack.retrieval_gate.signals.target_domain_hint` | retrieval-gate enum |
| `.pack.retrieval_plan.attempts[].expansion_terms[]` | query expansion terms, derived from the prompt not the graph |
| `.pack.retrieval_plan.attempts[].fallback` | fallback enum |
| `.pack.retrieval_plan.attempts[].reasons[]` | diagnostic reason code |
| `.pack.retrieval_plan.attempts[].status` | retrieval status enum |
| `.pack.retrieval_plan.attempts[].vocabulary_sources[]` | vocabulary source enum |
| `.pack.retrieval_plan.attempts[].promoted_communities[]` | community/cluster name, not a code symbol |
| `.pack.retrieval_plan.reasons[]` | diagnostic reason code |
| `.pack.retrieval_plan.selected_fallback` | fallback enum |
| `.pack.retrieval_plan.status` | retrieval status enum |
| `.pack.retrieval_strategy` | retrieval strategy enum |
| `.pack.recovery.attempts[].status` | recovery status enum |
| `.pack.recovery.final_state` | answerability enum from the recovery loop |
| `.pack.recovery.initial_state` | answerability enum from the recovery loop |
| `.pack.recovery.status` | recovery status enum |
| `.pack.shared_file_type` | file-type enum |
| `.pack.target_file_type` | file-type enum |
| `.pack.uncovered_hotspots[]` | hotspot identifiers reported as NOT covered; an uncovered hotspot is not evidence the pack surfaced |
| `.pack.uncovered_hotspot_severities[]` | severity enum |
| `.plan.evidence.preferred[]` | evidence-class taxonomy value |
| `.plan.evidence.recipe_id` | planner recipe identifier |
| `.plan.evidence.required[]` | evidence-class taxonomy value |
| `.plan.evidence.semantic_optional[]` | semantic-category taxonomy value |
| `.plan.evidence.semantic_required[]` | semantic-category taxonomy value |
| `.plan.scope.changed_paths[]` | planner scope input, not retrieved evidence |
| `.plan.scope.focus_paths[]` | planner scope input, not retrieved evidence |
| `.plan.scope.seed_mode` | planner scope enum |
| `.plan.steps[].evidence[]` | evidence-class taxonomy value |
| `.plan.steps[].id` | planner step identifier |
| `.plan.steps[].kind` | planner step kind enum |
| `.plan.steps[].scope_mode` | planner scope enum |
| `.plan.steps[].scope_paths[]` | planner scope input, not retrieved evidence |
| `.plan.steps[].title` | prose planner step title |
| `.plan.task_kind` | task-kind enum |
| `.recommended_first_read[].reason` | prose rationale |
| `.retrieval_gate.intent` | retrieval-gate enum |
| `.retrieval_gate.reason` | prose rationale |
| `.retrieval_gate.signals.generation_intent` | retrieval-gate enum |
| `.retrieval_gate.signals.target_domain_hint` | retrieval-gate enum |
| `.retrieval_pipeline.phases[].phase` | pipeline-phase taxonomy value |
| `.retrieval_pipeline.phases[].summary` | prose rationale |
| `.risk_boundaries[].affected_communities[]` | community/cluster name, not a code symbol |
| `.risk_boundaries[].reason` | prose rationale |
| `.risk_boundaries[].severity` | severity enum |
| `.task` | task-kind enum |
| `.task_intent` | task-intent enum |
| `.validation_commands[]` | shell command suggestion, not target evidence |
| `.why_explanation[]` | prose rationale. Paths named here are already carried by the structured channels they explain; mining prose would count text, not evidence. |

</details>

## Run independence

Generated state for this arm lives under `.qualification-cache/work-rel-run-b`. The only shared artefact is the bare clone mirror in `.qualification-cache`, which is immutable and identity-verified per run.

| Target | Prepared worktree | HEAD | Clone cache | Graph artifact digest |
| --- | --- | --- | --- | --- |
| `hono` | `.qualification-cache/work-rel-run-b/targets/hono` | `26de73133b85` | warm_mirror_reused | `64c8bd03558b812d` |
| `hono-seeded-compose` | `.qualification-cache/work-rel-run-b/targets/hono-seeded-compose` | `26de73133b85` | warm_mirror_reused | `64c8bd03558b812d` |
| `hono-seeded-error-disclosure` | `.qualification-cache/work-rel-run-b/targets/hono-seeded-error-disclosure` | `26de73133b85` | warm_mirror_reused | `64c8bd03558b812d` |
| `unstorage` | `.qualification-cache/work-rel-run-b/targets/unstorage` | `e6be6135832f` | warm_mirror_reused | `acb77534251573f3` |

| Cell | Artifact digest | Channels observed |
| --- | --- | --- |
| `arch-unstorage-driver-seam@unstorage` | `95137b3c09d7a8f1` | 170 |
| `flow-hono-request-dispatch@hono` | `2d0ee271fcd80fb5` | 91 |
| `impact-hono-drop-router-fallback@hono` | `8dfd922c2468cb7d` | 84 |
| `neg-hono-absent-matcher-persistence` | `7fb9cee7dede6633` | 118 |
| `neg-unstorage-absent-encryption` | `a22f11b1756e6bad` | 133 |
| `plan-unstorage-add-driver@unstorage` | `a16738679d9056b5` | 78 |
| `review-hono-error-handling@hono-seeded-error-disclosure` | `a63e3bae9121960f` | 122 |
| `rootcause-hono-middleware-rerun@hono-seeded-compose` | `9bcc6c6a37cfa2c0` | 88 |

## Inherited #660 signal observation (read-only)

No frozen Tier 1 cell or negative-trust probe measurably changed because of the name-driven signals disclosed by #660. Three of the four disclosed signals have their named symbol present in source at this revision, and 2 signal group(s) had a co-occurring retrieval classification flag on at least one cell. Neither fact establishes attribution: the flag-to-symbol mapping is a hypothesis, and proving a cell state depends on one of these symbols would require a production change, which Phase 1 forbids. Every one of the six task-cell failures below is fully explained by evidence-obligation recall against the frozen truth, with no appeal to these signals. A source-only suspicion is not a Tier 1 product failure.

| Signal | Present in source | Co-occurring flag on cells | Measurably changed a cell? |
| --- | --- | --- | --- |
| src/runtime/retrieve.ts :: pipelineBridgeText | yes: pipelineBridgeText | arch-unstorage-driver-seam@unstorage, neg-hono-absent-matcher-persistence, neg-unstorage-absent-encryption, plan-unstorage-add-driver@unstorage | **no** (not_established_in_phase_1) |
| src/runtime/context-pack-diagnostics.ts :: report-stage-like names (planenforcement, requireideasuserid, callllm) | yes: callllm, planenforcement, requireideasuserid | none | **no** (not_established_in_phase_1) |
| src/runtime/graph-summary.ts :: addjob | yes: addjob | rootcause-hono-middleware-rerun@hono-seeded-compose | **no** (not_established_in_phase_1) |
| regex-alternation anchoring (a middle alternative can match the tail of a longer word) | n/a (pattern, not a symbol) | none | **no** (not_established_in_phase_1) |

