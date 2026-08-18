# Performance rerun at production head `a8a94a8c`

The final review round asked the artifact parser to delegate the structural
rule it shares with the workspace classifier. That check runs inside
`parseGraphArtifactV2`, which is on every load, so `86bd5b31` is superseded and
the receipt was measured again.

**This is the measurement in force. The default-path load ratio is above 2.00×
and requires an explicit maintainer decision.**

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| B1 comparator binary | `677ba81d498c1d23dd74285e2515917df4448cc8` |
| **#705 production-code head** | **`a8a94a8c`** |
| Superseded production heads | `86bd5b31`, `851f92ba`, `78e7acd4`, `1fcc8d88` |
| Pinned input | `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f` |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Node / npm | v22.22.3 / 12.0.2 |
| Node count, every arm | 12,669 |

## Summary

| Metric | #705 vs base | Threshold | Verdict |
|---|---:|---:|---|
| Generation wall | **1.007×** | 2.00× | **passed** |
| Peak RSS | **1.219×** | 2.00× | **passed** |
| Canonical artifact | **1.799×** | 2.00× | **passed** |
| **Load latency (default path)** | **2.640×–2.678×** | 2.00× | **exceeds — decision required** |
| Output directory | 1.546× | — | reported |

## Load latency

### Default path

| Session | n | base | #705 | **#705/base** |
|---|---:|---:|---:|---:|
| 1 | 9 | 312.29 ms | 824.40 ms | **2.640×** |
| 2 | 11 | 314.32 ms | 841.86 ms | **2.678×** |

### Same artifact, both binaries — the controlled comparison

Both loaders on one byte-identical file, SHA-256 `f8ab0f6573dbee557cc4b936…`,
47,030,676 bytes. The driver asserts both arms report the same byte count
before reporting a ratio.

| Session | n | B1 | #705 | **#705/B1** |
|---|---:|---:|---:|---:|
| 1 | 9 | 681.65 ms | 688.50 ms | **1.010×** |
| 2 | 11 | 681.44 ms | 687.25 ms | **1.009×** |

**#705's loader is 1.009×–1.010× of B1 on identical input.**

This is tighter than the 1.008×–1.023× measured at `86bd5b31` on the same
comparison. The two runs together suggest the earlier 1.023× upper end was host
noise rather than a loader difference, but both are recorded as measured and
neither is discarded in favour of the flattering one.

A loader within about 1% cannot produce a 2.64× default-path ratio. That
difference is which artifact each binary reaches for: B1's default read the
26 MB v1 mirror, #705's default reads the 47 MB canonical artifact, because the
cutover removed the mirror.

### What each remediation round cost

| Measurement | `851f92ba` | `86bd5b31` | `a8a94a8c` |
|---|---:|---:|---:|
| Default load vs base | 2.647×–2.666× | 2.650×–2.663× | 2.640×–2.678× |
| Same artifact vs B1 | not measured | 1.008×–1.023× | 1.009×–1.010× |

Nothing measurable across three heads. The structural validation inspects an
object that was already parsed; the bounded read performs the same single
allocation and read as before; the delegation replaces two copies of a check
with one call to it.

## Generation, memory and footprint

Four interleaved rounds per arm, medians.

| Arm | Wall | Peak RSS | Canonical | Legacy | Output dir |
|---|---:|---:|---:|---:|---:|
| base | 140.4 s | 960 MiB | — | 26,228,961 B | 37,532 KB |
| B1 | 139.7 s | 1,272 MiB | 47,029,832 B | 26,193,508 B | 83,428 KB |
| #705 | 141.4 s | 1,170 MiB | 47,192,126 B | 81 B | 58,012 KB |

| Ratio | #705/base | B1/base |
|---|---:|---:|
| Generation wall | 1.007× | 0.995× |
| Peak RSS | 1.219× | 1.325× |
| Canonical artifact | 1.799× | 1.793× |
| Output directory | 1.546× | 2.223× |

### The peak-RSS ratio, across three sweeps

`86bd5b31` reported 1.300× and flagged it as denominator variance rather than a
regression. Three sweeps now confirm that reading.

| Sweep | base | B1 | #705 | #705/base |
|---|---:|---:|---:|---:|
| `851f92ba` | 961 MiB | 1,223 MiB | 1,148 MiB | 1.194× |
| `86bd5b31` | 881 MiB | 1,239 MiB | 1,146 MiB | 1.300× |
| `a8a94a8c` | 960 MiB | 1,272 MiB | 1,170 MiB | 1.219× |

#705's own peak sits in a 1,146–1,170 MiB band across all three. The base arm
swings 881–961 MiB, and the ratio follows it. Read the absolute figures, not
the ratio alone, on a host that is not quiescent.

## Carried forward

The base binary produces a 26.10–26.23 MB v1 artifact on this host against B1's
recorded 20.78 MB for the same revision, tree, command and host. Two candidate
explanations were tested and ruled out during an earlier receipt. It remains
disclosed and nothing is derived from it.

Relationship counts differ by arm — 17,835 for base against 17,940 for B1 and
#705 — the already-documented unregistered-relation loss in the v1 format.

## Gate

Generation wall, peak RSS and canonical artifact size all pass. Default-path
load latency is **2.640×–2.678×**, above the 2.00× threshold, so this requires
an **explicit maintainer decision**. No earlier acceptance carries forward.
