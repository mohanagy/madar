# Tier 1 qualification — first independent baseline

> **First Tier 1 measurement — gate not yet activated**
>
> Thresholds in this contract are pre-registered and uncalibrated. A failing cell here is a
> product finding to be triaged by a maintainer, not a reason to edit the frozen contract.
> `sealed holdout unsatisfied; results measure regression only`.

## Totals

| Result | Count |
| --- | --- |
| pass | 2 |
| fail | 6 |
| invalid | 0 |

Invalid cells are reported separately and are never folded into a quality percentage.

## Identity

- Contract version: `1.0.0`
- Frozen-input manifest: 22 files, digest `e0ee3faf8ed2fd4be203a1c9b49fb1a66f4378a80f597197937cbc7a41050abd`
- Madar revision: `72ecb4aa72899c5fa1ba4e2c27795070e74871eb` (version `0.32.1`)
- Semantic digest: `82902a3b6ac0bd7fc28eb849f69def9a52ab2482d3fceb647297f4d78216a959`

## Per-cell results

| Cell | Kind | Target | Target SHA | State | Path recall | Symbol recall | Answerability |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `arch-unstorage-driver-seam@unstorage` | task | `unstorage` | `e6be6135832f` | **fail** | 0/4 (0.00) | 0/4 (0.00) | `verify_targets` |
| `flow-hono-request-dispatch@hono` | task | `hono` | `26de73133b85` | **fail** | 0/5 (0.00) | 0/5 (0.00) | `verify_targets` |
| `impact-hono-drop-router-fallback@hono` | task | `hono` | `26de73133b85` | **fail** | 0/4 (0.00) | 0/4 (0.00) | `ready_with_caveat` |
| `neg-hono-absent-matcher-persistence` | negative_probe | `hono` | `26de73133b85` | **pass** | — | — | `verify_targets` |
| `neg-unstorage-absent-encryption` | negative_probe | `unstorage` | `e6be6135832f` | **pass** | — | — | `verify_targets` |
| `plan-unstorage-add-driver@unstorage` | task | `unstorage` | `e6be6135832f` | **fail** | 1/4 (0.25) | 0/3 (0.00) | `verify_targets` |
| `review-hono-error-handling@hono-seeded-error-disclosure` | task | `hono-seeded-error-disclosure` | `26de73133b85` | **fail** | 2/3 (0.67) | 0/3 (0.00) | `verify_targets` |
| `rootcause-hono-middleware-rerun@hono-seeded-compose` | task | `hono-seeded-compose` | `26de73133b85` | **fail** | 0/2 (0.00) | 0/2 (0.00) | `verify_targets` |

## Per-cell detail

### `arch-unstorage-driver-seam@unstorage` — fail

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `5c3722d182b5c36478ecabd2d1fb24f4f3eb40eba6e12032da89bebf12ef1d9f`
- Truth version `1.0.0`
- Expected critical files: `src/drivers/utils/index.ts`, `src/storage.ts`, `src/types.ts`, `src/utils.ts`
- Observed critical files: **none**
- Missing critical files: `src/drivers/utils/index.ts`, `src/storage.ts`, `src/types.ts`, `src/utils.ts`
- Expected critical symbols: `Driver`, `DriverFactory`, `createStorage`, `getMount`
- Observed critical symbols: **none**
- Missing critical symbols: `Driver`, `DriverFactory`, `createStorage`, `getMount`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/drivers/azure-key-vault.ts`, `src/drivers/cloudflare-kv-http.ts`, `src/drivers/memory.ts`, `src/drivers/vercel-runtime-cache.ts`, `test/drivers/azure-key-vault.test.ts`, `test/drivers/cloudflare-cache-binding.test.ts`, `test/drivers/cloudflare-kv-binding.test.ts`, `test/drivers/cloudflare-kv-http.test.ts`, `test/drivers/vercel-runtime-cache.test.ts`
- Reasons:
  - required_evidence_paths recall 0.0000 < min_critical_fact_recall 1; missing ["src/drivers/utils/index.ts","src/storage.ts","src/types.ts","src/utils.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["Driver","DriverFactory","createStorage","getMount"]
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
- Evidence: `logs/pack-impact-hono-drop-router-fallback--hono.log`

### `neg-hono-absent-matcher-persistence` — pass

- Target `hono` at `26de73133b8552f56ba72e025ecd82b08900d796`
- Prompt SHA-256 `6a173a57d204d86260380b3f9fedcb4dcc5c90962258e849b508fddaa3e07116`
- Truth version `1.0.0`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/router/reg-exp-router/router.ts`, `src/router/trie-router/node.ts`
- Measurement limits:
  - Tier 1 observes a context artifact, not an answer. The frozen requirement that the artifact "declare the requested behaviour was not found" in prose is not observable at this tier; only the readiness state, the answerability ceiling and fabricated-path absence are gated here.
- Evidence: `logs/pack-neg-hono-absent-matcher-persistence.log`

### `neg-unstorage-absent-encryption` — pass

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `cab0b45defcdcaf0b88c5613384f84b237c1d365e0a1f3b3bbd16543fe6db37d`
- Truth version `1.0.0`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/drivers/azure-key-vault.ts`
- Measurement limits:
  - Tier 1 observes a context artifact, not an answer. The frozen requirement that the artifact "declare the requested behaviour was not found" in prose is not observable at this tier; only the readiness state, the answerability ceiling and fabricated-path absence are gated here.
- Evidence: `logs/pack-neg-unstorage-absent-encryption.log`

### `plan-unstorage-add-driver@unstorage` — fail

- Target `unstorage` at `e6be6135832f350ca16f9a77432e1d4f0aa85ed7`
- Prompt SHA-256 `b8a0a2b4a0593346d1333d96ada6c339a0763611df1ddab51079369e0c62c7ff`
- Truth version `1.0.0`
- Expected critical files: `src/_drivers.ts`, `src/drivers/memory.ts`, `src/drivers/utils/index.ts`, `src/types.ts`
- Observed critical files: `src/_drivers.ts`
- Missing critical files: `src/drivers/memory.ts`, `src/drivers/utils/index.ts`, `src/types.ts`
- Expected critical symbols: `Driver`, `DriverFactory`, `createRequiredError`
- Observed critical symbols: **none**
- Missing critical symbols: `Driver`, `DriverFactory`, `createRequiredError`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/_drivers.ts`, `src/drivers/planetscale.ts`, `src/drivers/s3.ts`, `src/server.ts`, `src/utils.ts`
- Reasons:
  - required_evidence_paths recall 0.2500 < min_critical_fact_recall 1; missing ["src/drivers/memory.ts","src/drivers/utils/index.ts","src/types.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["Driver","DriverFactory","createRequiredError"]
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
- Observed critical symbols: **none**
- Missing critical symbols: `HTTPException`, `compose`, `errorHandler`
- Observed answerability: `verify_targets`
- Unsupported claims / citation failures: 0 / 0
- Evidence set actually presented (generous): `src/compose.ts`, `src/context.ts`, `src/hono-base.ts`, `src/router.ts`, `src/types.ts`
- Reasons:
  - required_evidence_paths recall 0.6667 < min_critical_fact_recall 1; missing ["src/http-exception.ts"]
  - required_evidence_symbols recall 0.0000 < min_critical_fact_recall 1; missing ["HTTPException","compose","errorHandler"]
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
- Evidence: `logs/pack-rootcause-hono-middleware-rerun--hono-seeded-compose.log`

## Inherited #660 signal observation (read-only)

No frozen Tier 1 cell or negative-trust probe measurably changed because of the name-driven signals disclosed by #660. Three of the four disclosed signals have their named symbol present in source at this revision, and 2 signal group(s) had a co-occurring retrieval classification flag on at least one cell. Neither fact establishes attribution: the flag-to-symbol mapping is a hypothesis, and proving a cell state depends on one of these symbols would require a production change, which Phase 1 forbids. Every one of the six task-cell failures below is fully explained by evidence-obligation recall against the frozen truth, with no appeal to these signals. A source-only suspicion is not a Tier 1 product failure.

| Signal | Present in source | Co-occurring flag on cells | Measurably changed a cell? |
| --- | --- | --- | --- |
| src/runtime/retrieve.ts :: pipelineBridgeText | yes: pipelineBridgeText | arch-unstorage-driver-seam@unstorage, neg-hono-absent-matcher-persistence, neg-unstorage-absent-encryption, plan-unstorage-add-driver@unstorage | **no** (not_established_in_phase_1) |
| src/runtime/context-pack-diagnostics.ts :: report-stage-like names (planenforcement, requireideasuserid, callllm) | yes: callllm, planenforcement, requireideasuserid | none | **no** (not_established_in_phase_1) |
| src/runtime/graph-summary.ts :: addjob | yes: addjob | rootcause-hono-middleware-rerun@hono-seeded-compose | **no** (not_established_in_phase_1) |
| regex-alternation anchoring (a middle alternative can match the tail of a longer word) | n/a (pattern, not a symbol) | none | **no** (not_established_in_phase_1) |

