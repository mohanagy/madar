# Incremental experiment: mandatory stop

> Tracking issue: [#592](https://github.com/mohanagy/madar/issues/592)

The fixed 500-file experiment failed its required performance gates. That result
triggered the issue's mandatory simplification rule: current production keeps
the canonical full-reconciliation path and does not expose the experimental
warm/session APIs.

The development-only evaluator at
[`tools/eval/core-reset/incremental-performance.mjs`](../../../tools/eval/core-reset/incremental-performance.mjs)
is retained only to audit or reproduce the stopped checkpoint. It is excluded
from the npm package. Do not run it against the current production `dist`;
the current implementation intentionally no longer provides the session API
that this historical experiment measured.

## Immutable evidence

| Receipt | Authenticated subject | SHA-256 |
| --- | --- | --- |
| [Protected base](../../core-reset/evidence/generation-incremental-protected-base-500.json) | commit `8886a0299ee30765ce149ca7ad5d1779496b78b5`, tree `48e43267adbb9d858c6540cd049b614fa35eee4a` | `eb664578ddccfcf4961b68496a4201ee665ca6b3bab6c20bc37c87c5dbc7eb8c` |
| [Stopped candidate](../../core-reset/evidence/generation-incremental-stop-500.json) | checkpoint commit `1d3c9b6d264a5c76d212b93da7c63718cbe49b3d`, tree `6bd1ae5762afaa868d5cf6ce165b061aa290bfda` | `493a780c7d39977d3fda754ee3d9dc7891091e22aae2f8f2a877e8e7afe39b65` |

The candidate was measured while that exact tree was a dirty worktree over
HEAD `64c4d240f7561210a8170ea629b7692f3a7ed466`. After the measurement and its
source/distribution postcheck passed, the exact measured tree was committed as
`1d3c9b6d264a5c76d212b93da7c63718cbe49b3d`. Git reports that checkpoint's
tree as `6bd1ae5762afaa868d5cf6ce165b061aa290bfda`, matching the receipt.

Both receipts use sorted canonical JSON for their SHA-256 identity. They include
the raw 20-trial samples, three warmups, nearest-rank p50/p95, corpus and
environment fingerprints, exact Git identities, compiled-distribution
fingerprints, commands, and update-scope counts. No timestamp or local absolute
path participates.

## Decisive 500-file result

The deterministic corpus contains exactly 500 supported TypeScript files. Its
private leaf mutation does not change an exported surface.

| Gate | Observed | Required | Result |
| --- | ---: | ---: | --- |
| Clean generation p50 regression | `1.012×` | at most `1.10×` protected base | pass |
| Cold no-op p50 / clean p50 | `0.032×` | at most `0.20×` | pass |
| Warm no-op scope | 0 parsed, 500 reused, 0 invalidated | zero parse/invalidation/publication | pass |
| Private-leaf scope | 1 parsed, 499 reused, 1 invalidated, closure 0 | exactly that scope | pass |
| Warm index-stage p50 / clean index-stage p50 | `0.824×` | at most `0.50×` | **fail** |
| Warm refresh p50 / clean generation p50 | `1.047×` | at most `0.75×` | **fail** |
| Warm refresh p95 / clean generation p95 | `1.029×` | at most `0.80×` | **fail** |

Correct invalidation scope therefore did not produce an acceptable end-to-end
speedup. The candidate receipt has `eligible_for_acceptance: false`,
`stop_condition.triggered: true`, and records all three failed ratios.

The held-out repository run was **intentionally skipped**. Issue #592 makes the
fixed 500-file failure decisive, so held-out timing cannot reverse the stop
decision. This is recorded directly in
`stop_condition.held_out.status: "intentionally_skipped"`.

## Current production contract

Current source is deliberately simpler:

- unchanged updates may return without parsing or publishing;
- any detected source change uses the full canonical reconcile;
- no update-session, canonical TypeScript session, per-file AST/fact cache, or
  `warm_incremental` production API remains.

The focused performance-evidence test authenticates both receipt checksums,
verifies that checkpoint commit `1d3c9b6…` resolves to the measured tree,
requires the failed gates and explicit held-out skip, and scans current
production source for the removed warm/session API names. It does not execute
the evaluator against the current build.

## Reproducing the historical timing experiment

Reproduction requires separate detached worktrees for the protected base and
the stopped checkpoint. It creates a new machine-specific receipt; it does not
change the immutable evidence above.

```bash
git worktree add --detach /tmp/madar-592-base \
  8886a0299ee30765ce149ca7ad5d1779496b78b5
git worktree add --detach /tmp/madar-592-checkpoint \
  1d3c9b6d264a5c76d212b93da7c63718cbe49b3d

(cd /tmp/madar-592-base && npm ci && npm run clean && npm run build)
(cd /tmp/madar-592-checkpoint && npm ci && npm run clean && npm run build)

cd /tmp/madar-592-checkpoint
node tools/eval/core-reset/incremental-performance.mjs \
  --mode baseline \
  --dist-root /tmp/madar-592-base/dist/src \
  --subject-worktree /tmp/madar-592-base \
  --fixture-files 500 \
  --warmups 3 \
  --trials 20 \
  --output /tmp/madar-592-baseline.json

node tools/eval/core-reset/incremental-performance.mjs \
  --mode candidate \
  --dist-root ./dist/src \
  --subject-worktree . \
  --fixture-files 500 \
  --warmups 3 \
  --trials 20 \
  --baseline-receipt /tmp/madar-592-baseline.json \
  --output /tmp/madar-592-candidate.json
```

Exit status `0` means all encoded gates passed, `2` means a valid receipt
was written but at least one gate failed, and `1` means the measurement was
invalid. The authoritative checked-in candidate result exited with status `2`.
