# Performance rerun at production head `851f92ba`

> **Superseded.** The re-review found two valid load-path defects after this
> was measured. The measurement in force is
> [`rerun-86bd5b31.md`](./rerun-86bd5b31.md). This receipt is retained exactly
> as measured.

The accepted exception was scoped to production head
`78e7acd4b3724adcc78fe034d94c33526054ae8a` and to that head only. Remediating
the CodeRabbit review changed thirteen production files, including artifact
selection, path intent, state classification, metadata bounds, freshness
hashing, HTTP serving and publication — nine of the thirteen areas on the
invalidation list. The head moved and the whole receipt was rerun.

**This rerun does not carry the previous acceptance. The default-path load
ratio remains above 2.00× and requires a new explicit maintainer decision.**

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| B1 comparator binary | `677ba81d498c1d23dd74285e2515917df4448cc8` (final B1 head) |
| **#705 production-code head** | **`851f92ba0616c3cbbade9d6a744722694b8991f5`** |
| Superseded production heads | `78e7acd4`, `1fcc8d88` |
| Pinned input | `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f` |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Node / npm | v22.22.3 / 12.0.2 |
| Node count, every arm | 12,669 |

Earlier receipts used `5bfdb869` as the B1 comparator, the squash of #707. This
rerun used the final B1 head `677ba81d` directly. `git diff 5bfdb869 677ba81d --
src/` is empty, so the two produce the same binary.

Every arm was rebuilt from its own checked-out source before measuring; no
pre-existing `dist` was reused. `dist` is built from `src/**/*.ts` with tests
excluded, so the candidate `dist` is exactly production head `851f92ba` even
though the branch carries later test and documentation commits.

### Harness SHA-256

| File | Digest |
|---|---|
| `load-sample.mjs` | `a8a393fe3d873edad259b9b323dd9687634329dc5b7b5d111e485f1fa34218c8` |
| `load-default-sample.mjs` | `483e0bfd861946d30cd407ae602eb72de7db6371cc9e2716baa9fd7196f02bcb` |
| `load-driver.mjs` | `aecfded75445af6b809d5ff5973badc83abf9db8b71b0e56c028368ddd5a4923` |
| `load-default-driver.mjs` | `22de03ec6258c34927c90e6637865f0613ec4abec50aa308c20dffb17f133b06` |
| `rss-sampler.mjs` | `d99752b125104ba28caba087ea33cd7778ba924323eb0fa05f1ef439970a5464` |
| `gen-run.sh` | `5a4c1969e643092c09c62a75f4a5cecb61ee4859ed2a8096ae2c365a1a2c79b6` |

Four of the six digests differ from the previous receipt. `load-sample.mjs` and
`rss-sampler.mjs` are byte-identical; the other four were changed by the review
remediation, which removed machine-specific paths and added input validation.

**`gen-run.sh` did not run at all when this rerun began.** Removing its
machine-specific paths introduced an apostrophe inside `"${VAR:?...}"`, and bash
reads that as an opening quote and refuses the entire script. The break was
invisible because a receipt harness is inert until someone reruns it. It is
repaired, and a `bash -n` gate over every committed benchmark harness now fails
if it regresses.

## Summary

| Metric | #705 vs base | Threshold | Verdict |
|---|---:|---:|---|
| Generation wall | **1.000×** | 2.00× | **passed** |
| Peak RSS | **1.194×** | 2.00× | **passed** |
| Canonical artifact | **1.799×** | 2.00× | **passed** |
| **Load latency (default path)** | **2.647×–2.666×** | 2.00× | **exceeds — decision required** |
| Output directory | 1.546× | — | reported |

## Load latency

Process-isolated, one fresh process per sample, arms interleaved, two sessions
with the arm order reversed in the second.

### Default path — what normal use takes

| Session | n | base | B1 | #705 | **#705/base** | B1/base | #705/B1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 9 | 318.27 ms | 674.70 ms | 848.48 ms | **2.666×** | 2.120× | 1.258× |
| 2 | 11 | 319.30 ms | 679.50 ms | 845.15 ms | **2.647×** | 2.128× | 1.244× |

Measured band **2.647×–2.666×**, midpoint 2.657×.

The previously accepted band at head `78e7acd4` was 2.635×–2.732×. This rerun is
narrower and sits inside it.

### Explicit canonical path — the same artifact in both binaries

| Session | n | base | B1 | #705 | **#705/B1** | #705/base |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 9 | 284.45 ms | 695.90 ms | 700.79 ms | **1.007×** | 2.464× |
| 2 | 11 | 289.19 ms | 704.86 ms | 710.59 ms | **1.008×** | 2.457× |

This is the measurement that locates the cost. Handed the same canonical
artifact, #705 is within 1% of B1, so the loader is not the cause. The
default-path difference is the artifact each binary reaches for: B1's default
read the 26 MB v1 mirror, and #705's default reads the 47 MB canonical artifact,
because the cutover removed the mirror. A 1.80× larger artifact read by an
equivalent loader is the whole of it.

Nothing in this rerun's remediation moved the loader: the previous head measured
1.001×–1.009× on the same comparison, and this one measures 1.007×–1.008×.

## Generation, memory and footprint

Four interleaved rounds per arm, medians.

| Arm | Wall | Peak RSS | Canonical | Legacy | Output dir |
|---|---:|---:|---:|---:|---:|
| base | 140.1 s | 961 MiB | — | 26,228,961 B | 37,532 KB |
| B1 | 140.4 s | 1,223 MiB | 47,029,832 B | 26,193,508 B | 83,428 KB |
| #705 | 140.2 s | 1,148 MiB | 47,192,126 B | 81 B | 58,012 KB |

| Ratio | #705/base | B1/base |
|---|---:|---:|
| Generation wall | 1.000× | 1.002× |
| Peak RSS | 1.194× | 1.273× |
| Canonical artifact | 1.799× | 1.793× |
| Output directory | 1.546× | 2.223× |

#705 uses less peak memory and less disk than B1, because the v1 mirror is gone.

### Disclosed: one outlier and one discarded sweep

Round 4 of the #705 arm took 272.2 s against a 139–141 s cluster, at an ambient
load of 2.19. Nothing explains it; it is left in the data and the medians
absorb it. Excluding it moves the wall ratio from 1.000× to 0.998×.

An earlier generation sweep was **discarded in full**. Two sweeps ran
concurrently — a detached launch survived a tool-reported exit and a second was
started — so both generated graphs at once into one file. Walls came out at
roughly double (base 299.5 s against 140.1 s measured alone), load averages
reached 4.7, and the arms ended with uneven sample counts. Those records are
retained as `rerun-851f92ba-generation.discarded.jsonl` and no number from them is used
anywhere. The sweep script now takes an exclusive lock and refuses to start
while another holds it.

The load-latency measurements above were taken before any sweep began, at
ambient load 2.2–3.1, and are unaffected.

## Carried forward

The base binary produces a 26.10–26.23 MB v1 artifact on this host against B1's
recorded 20.78 MB for the same revision, tree, command and host. Two candidate
explanations were tested and ruled out during the previous receipt. It remains
disclosed and nothing is derived from it.

Relationship counts differ by arm — 17,835 for base against 17,940 for B1 and
#705 — which is the already-documented unregistered-relation loss in the v1
format, not a measurement artifact.

## Gate

Generation wall, peak RSS and canonical artifact size all pass. Default-path
load latency is **2.647×–2.666×**, above the 2.00× threshold, so under the
recorded invalidation rule this requires a **new explicit maintainer decision**.
The acceptance recorded for `78e7acd4` is not carried forward.
