# Incremental-index performance gate

> Tracking issue: [#592](https://github.com/mohanagy/madar/issues/592)

The acceptance evaluator is
[`tools/eval/core-reset/incremental-performance.mjs`](../../../tools/eval/core-reset/incremental-performance.mjs).
It is development-only and is excluded from the npm package.

The evaluator measures the actual Core Reset contract:

- clean whole generation;
- clean canonical index stage;
- a cold one-shot no-op update;
- a warm no-op through one retained in-process update session;
- a private leaf edit through that same retained session;
- the private leaf edit at the canonical index-stage boundary.

Every eligible run uses at least three warmups and 20 measured trials. Receipts
include raw samples, nearest-rank p50/p95, parsed/reused/invalidated and
dependency-closure counts, hardware, OS, Node version, the exact command and
configuration, corpus fingerprint, and pinned repository commit.

The candidate receipt fails closed unless it has a compatible clean-generation
baseline recorded from protected base
`8886a0299ee30765ce149ca7ad5d1779496b78b5` on the same corpus and machine.
Receipt objects use sorted canonical JSON for their SHA-256 identity; no
timestamp participates. The subject is authenticated by HEAD commit/tree,
an exact Git worktree tree OID that includes dirty and untracked files, the
porcelain-status digest, and a compiled-distribution fingerprint. A source or
distribution change during measurement invalidates the run.

## Build both subjects

Build the candidate normally:

```bash
npm run build
```

Create a detached checkout of the protected base outside this worktree, install
the locked dependencies, and build it. The examples below call its compiled
tree `<protected-base>/dist/src`.

## Fixed 500-file fixture

Record the protected-base clean-generation distribution first:

```bash
node tools/eval/core-reset/incremental-performance.mjs \
  --mode baseline \
  --dist-root <protected-base>/dist/src \
  --subject-worktree <protected-base> \
  --fixture-files 500 \
  --warmups 3 \
  --trials 20 \
  --output /tmp/madar-perf/fixed-baseline.json
```

Then measure the candidate:

```bash
node tools/eval/core-reset/incremental-performance.mjs \
  --mode candidate \
  --dist-root ./dist/src \
  --subject-worktree . \
  --fixture-files 500 \
  --warmups 3 \
  --trials 20 \
  --baseline-receipt /tmp/madar-perf/fixed-baseline.json \
  --output /tmp/madar-perf/fixed-candidate.json
```

The synthetic corpus has exactly 500 supported TypeScript files. Its leaf body
changes without changing the exported surface, so the expected measured update
counts are one parsed/invalidated file, 499 reused files, and a zero-sized
dependency closure.

## Pinned held-out repository

The evaluator clones only local Git objects into a disposable standalone
checkout and verifies the exact commit. It never fetches or mutates the supplied
checkout.

```bash
node tools/eval/core-reset/incremental-performance.mjs \
  --mode candidate \
  --dist-root ./dist/src \
  --subject-worktree . \
  --repository /absolute/path/to/openstatus \
  --repository-commit 295e5a72f52c172d326aa950e81043e72a4f20c0 \
  --graph-root . \
  --mutation-file apps/workflows/src/checker/alerting.ts \
  --warmups 3 \
  --trials 20 \
  --baseline-receipt /tmp/madar-perf/openstatus-baseline.json \
  --output /tmp/madar-perf/openstatus-candidate.json
```

Record the matching held-out baseline with the same repository, commit, graph
root, mutation file, warmups, and trials while pointing `--dist-root` at the
protected-base build.

## Gates encoded in the receipt

- cold no-op p50 is at most 20% of clean generation p50;
- warm no-op parses and invalidates zero files and does not publish;
- a private leaf edit parses/invalidates one file with zero dependency closure;
- warm index-stage p50 is at most 50% of clean index-stage p50;
- warm refresh p50/p95 are at most 75%/80% of clean generation p50/p95;
- candidate clean-generation p50 is no more than 10% above the protected base;
- the synthetic corpus has at least 500 supported files, or the held-out
  corpus is non-empty and pinned to an exact Git commit; every distribution
  has at least 20 measured samples after at least three warmups.

Exit status `0` means every encoded gate passed. Status `2` means a valid
receipt was written but at least one gate failed. Status `1` means the
measurement itself was invalid.
