# Findings — current retrieval vs task-conditioned slicing

This report compares `current-graphify`, `slice-v1`, `lexical-baseline`, and `full-context` on the committed `examples/demo-repo` corpus. The goal is not to prove production-grade absolute quality from a tiny workspace. The goal is to produce a reproducible, honest read on whether `slice-v1` keeps the same critical paths as default retrieval while reducing context size, and whether either graph-backed strategy clearly beats a lexical strawman.

## Recommendation

Keep the current graph-backed retrieval as the safer default and continue tuning `slice-v1`; do **not** treat this experiment as evidence for a slicing pivot yet. On this corpus, `slice-v1` is dramatically smaller than default retrieval, but it often trims away bridge nodes that matter for end-to-end explanations. `current-graphify` stays far below lexical and full-context token cost while preserving more of the auth, billing, and reporting path shape. The right next step is targeted `slice-v1` tuning, especially around bridge-node retention and impact target selection, not a default flip.

## Run details

- Corpus: `examples/demo-repo`
- Prompt set: `docs/experiments/2026-05-10-current-vs-slicing/prompts.json`
- Results bundle: `docs/experiments/2026-05-10-current-vs-slicing/results/2026-05-20T19-21-39Z`
- Graph-backed task normalization:
  - `debug` prompts were measured via `pack --task explain`
  - `review` prompts were measured via `pack --task impact`

## Aggregate numbers

| Strategy | Avg tokens | Avg runtime | Read |
|---|---:|---:|---|
| `slice-v1` | 55.9 | 369.3 ms | Smallest packs, but often too aggressive |
| `current-graphify` | 267.1 | 371.5 ms | Best overall balance on this corpus |
| `full-context` | 1274.0 | 94.6 ms | Reliable ceiling, but not scalable beyond this tiny repo |
| `lexical-baseline` | 4952.8 | 73.0 ms | Very noisy; repeated grep windows are much larger than either graph-backed strategy |

## Key observations

1. `current-graphify` beats the lexical baseline comfortably on size and signal. Its average pack is about **18.5x smaller** than lexical on this run while retaining connected workflow evidence instead of repeated grep windows.
2. `slice-v1` is promising on efficiency but not yet on completeness. It averaged about **4.8x fewer tokens** than `current-graphify`, but repeatedly collapsed multi-hop questions into a single terminal method or type.
3. `full-context` remains the correctness ceiling on this tiny demo repo, but that is mostly because the corpus is only ~2.3k words. The same strategy would not scale to the backend-shaped repos that originally motivated #71.
4. Non-explain prompts still expose a separate weakness in compact graph packs: impact target selection can under-target the real entrypoint. The `PasswordPolicy` impact prompt is the clearest example; both graph-backed strategies centered `.createSession()` instead of the password policy call chain.

## Prompt-by-prompt notes

| Prompt | Best low-token context | Main miss / noise pattern | Notes |
|---|---|---|---|
| `explain-auth-session` | `current-graphify` | `slice-v1` collapsed the flow to `.createSession()` and lost most of the auth entry path; lexical repeated large overlapping windows | Default retrieval kept `AuthService`, `TenantContext`, and `SessionStore` together at 663 tokens |
| `explain-monthly-close` | `current-graphify` | `slice-v1` kept `collectOutstandingInvoices()` but dropped most of the reporting path; lexical was >5k tokens | Default retrieval preserved the invoice → close job → report-builder shape |
| `debug-missing-receipt` | `current-graphify` | `slice-v1` reduced the question to `EmailNotifier.sendReceiptEmail()`; lexical was noisy but at least multi-file | Good example of a prompt where the slice found the terminal action but lost upstream cause |
| `debug-report-snapshot` | `current-graphify` | `slice-v1` underfit to `TenantContext`; lexical over-expanded on generic report terms | Default retrieval kept report builder plus invoice collection with manageable size |
| `review-invoice-service-change` | No strong low-token winner | Graph packs were too thin after review→impact normalization; lexical was much larger but still mostly term-expanded windows | On this prompt, `full-context` was the only clearly safe answer surface |
| `review-tenant-context-change` | No strong low-token winner | Graph packs underfit the review surface; lexical found more files but stayed noisy and unfocused | This needs better impact/review target selection more than raw token budget |
| `impact-password-policy-contract` | No strong winner | Both graph packs missed `PasswordPolicy` and centered session creation; lexical matched more password-policy text but at very high token cost | Good follow-up test for impact target resolution |
| `impact-tenant-context-shape` | `current-graphify` / `slice-v1` tie | Lexical found related files but paid ~4.3k tokens to do it | Both graph-backed strategies compactly surfaced `tenant-context.ts` and the affected auth/billing files |

## Practical takeaway

This spike paid off as a reproducible benchmark harness and as an honest calibration point for `slice-v1`, not as proof that slicing should replace the default retrieval path. The evidence here supports three concrete follow-ups:

1. Keep `current-graphify` as the default retrieval path.
2. Continue improving `slice-v1`, with explicit regression checks for bridge-node retention on end-to-end explain/debug prompts.
3. Add target-resolution coverage for impact/review prompts like `PasswordPolicy` and `TenantContext`, because compact packs are only useful when they center the right symbol in the first place.
