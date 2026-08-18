# Performance rerun at production head `02a111aa`

A review finding proved to be a new blocking surface rather than an inherited
one: workspace classification opens the `graph.v1.json` backup on every default
load, and the base binary never opened that path at all, so a FIFO there hung a
command that previously answered in 736 ms. The fix changes how every artifact
file is opened, so `a8a94a8c` is superseded and the receipt was measured again.

**This is the measurement in force. The default-path load ratio is above 2.00×
and requires an explicit maintainer decision. The acceptance recorded for
`a8a94a8c` does not carry forward.**

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| B1 comparator binary | `677ba81d498c1d23dd74285e2515917df4448cc8` |
| **#705 production-code head** | **`02a111aa`** |
| Superseded production heads | `a8a94a8c`, `86bd5b31`, `851f92ba`, `78e7acd4`, `1fcc8d88` |
| Pinned input | `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f` |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Node / npm | v22.22.3 / 12.0.2 |

## Artifact parity, checked before measuring

| Field | `a8a94a8c` | `02a111aa` |
|---|---:|---:|
| Nodes | 12,669 | 12,669 |
| Facts | 17,940 | 17,940 |
| Occurrences | 17,964 | 17,964 |
| Artifact bytes | 47,030,676 | 47,030,676 |

The fix changes how files are opened, not what is written. Only `generated_at`
and the freshness/completeness provenance differ between the two, as for every
regeneration.

## Summary

| Metric | #705 vs base | Threshold | Verdict |
|---|---:|---:|---|
| Generation wall | **0.996×** | 2.00× | **passed** |
| Peak RSS | **1.338×** | 2.00× | **passed** |
| Canonical artifact | **1.799×** | 2.00× | **passed** |
| **Load latency (default path)** | **2.624×–2.632×** | 2.00× | **exceeds — decision required** |
| Output directory | 1.546× | — | reported |

## Load latency

### Default path

| Session | n | base | #705 | **#705/base** |
|---|---:|---:|---:|---:|
| 1 | 9 | 319.30 ms | 837.97 ms | **2.624×** |
| 2 | 11 | 314.93 ms | 828.83 ms | **2.632×** |

### Same artifact, both binaries — the controlled comparison

Both loaders on one byte-identical file, SHA-256 `80f1b6caadb099c7aaab0d53…`.
The driver asserts both arms report the same byte count before reporting a
ratio.

| Session | n | B1 | #705 | **#705/B1** |
|---|---:|---:|---:|---:|
| 1 | 9 | 704.45 ms | 700.19 ms | **0.994×** |
| 2 | 11 | 706.74 ms | 687.25 ms | **0.972×** |

This reads below 1.0, and **that is not a claim that the fix made loading
faster.** Across three heads the same control has measured:

| Head | #705/B1 on identical bytes |
|---|---:|
| `86bd5b31` | 1.008×–1.023× |
| `a8a94a8c` | 1.009×–1.010× |
| `02a111aa` | 0.972×–0.994× |

That is roughly ±3% around parity on a host that is not quiescent. The
defensible statement is that the #705 loader is at parity with B1 on identical
bytes, not that it is ahead of it.

### Explicit canonical path, each binary on its own artifact

| Session | n | base | #705 | #705/base |
|---|---:|---:|---:|---:|
| 1 | 9 | 285.97 ms | 697.40 ms | 2.439× |
| 2 | 11 | 287.03 ms | 693.71 ms | 2.417× |

### What the FIFO fix cost

| Measurement | `a8a94a8c` | `02a111aa` |
|---|---:|---:|
| Default load vs base | 2.640×–2.678× | 2.624×–2.632× |
| Same artifact vs B1 | 1.009×–1.010× | 0.972×–0.994× |

Nothing measurable. The opener performs one extra `fstat` on a descriptor it
already holds, against a read of tens of megabytes.

## Generation, memory and footprint

Four interleaved rounds per arm, medians. Raw wall times across all twelve runs
span 139.6–143.8 s.

| Arm | Wall | Peak RSS | Canonical | Legacy | Output dir |
|---|---:|---:|---:|---:|---:|
| base | 140.9 s | 903 MiB | — | 26,228,961 B | 37,532 KB |
| B1 | 141.2 s | 1,260 MiB | 47,029,832 B | 26,193,508 B | 83,428 KB |
| #705 | 140.3 s | 1,208 MiB | 47,192,126 B | 81 B | 58,012 KB |

| Ratio | #705/base | B1/base |
|---|---:|---:|
| Generation wall | 0.996× | 1.002× |
| Peak RSS | 1.338× | 1.395× |
| Canonical artifact | 1.799× | 1.793× |
| Output directory | 1.546× | 2.223× |

### Peak RSS across four sweeps

The ratio moves on the denominator, which is why the absolute figures are
tabulated beside it.

| Sweep | base | B1 | #705 | #705/base |
|---|---:|---:|---:|---:|
| `851f92ba` | 961 MiB | 1,223 MiB | 1,148 MiB | 1.194× |
| `86bd5b31` | 881 MiB | 1,239 MiB | 1,146 MiB | 1.300× |
| `a8a94a8c` | 960 MiB | 1,272 MiB | 1,170 MiB | 1.219× |
| `02a111aa` | 903 MiB | 1,260 MiB | 1,208 MiB | 1.338× |

#705's own peak spans 1,146–1,208 MiB across all four while the base arm swings
881–961 MiB. Read the absolute numbers, not the ratio alone.

## Carried forward

The base binary produces a 26.10–26.23 MB v1 artifact on this host against B1's
recorded 20.78 MB for the same revision, tree, command and host. Two candidate
explanations were tested and ruled out during an earlier receipt. It remains
disclosed and nothing is derived from it.

Relationship counts differ by arm — 17,835 for base against 17,940 for B1 and
#705 — the already-documented unregistered-relation loss in the v1 format.

## Gate

Generation wall, peak RSS and canonical artifact size all pass. Default-path
load latency is **2.624×–2.632×**, above the 2.00× threshold, so this requires
an **explicit maintainer decision**. No earlier acceptance carries forward.

The larger canonical artifact is a major contributor to that gap. Default-path
artifact selection and workspace classification also contribute — the default
path classifies the workspace before reading anything, which the explicit path
does not. The controlled same-artifact result puts the loader itself at parity
with B1. The remaining parse duplication — 2 full parses on a canonical load,
3 on a tombstone load, 2 for metadata — is deferred to #706.
