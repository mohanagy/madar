# Performance rerun at production head `86bd5b31`

The CodeRabbit re-review raised two valid findings on the previous remediation:
artifact selection accepted any JSON body after the magic header, and artifact
reads sized a file with one call and read it with another. Both are on the load
path, so head `851f92ba` is superseded and every figure was measured again.

**This rerun does not carry any previous acceptance. The default-path load
ratio remains above 2.00× and requires an explicit maintainer decision.**

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| B1 comparator binary | `677ba81d498c1d23dd74285e2515917df4448cc8` |
| **#705 production-code head** | **`86bd5b31`** |
| Superseded production heads | `851f92ba`, `78e7acd4`, `1fcc8d88` |
| Pinned input | `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f` |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Node / npm | v22.22.3 / 12.0.2 |
| Node count, every arm | 12,669 |

The candidate `dist` was rebuilt from this head before measuring. Base and B1
binaries and their workspaces are unchanged from the `851f92ba` rerun; only the
candidate arm was rebuilt and regenerated.

## Summary

| Metric | #705 vs base | Threshold | Verdict |
|---|---:|---:|---|
| Generation wall | **0.999×** | 2.00× | **passed** |
| Peak RSS | **1.300×** | 2.00× | **passed** |
| Canonical artifact | **1.799×** | 2.00× | **passed** |
| **Load latency (default path)** | **2.650×–2.663×** | 2.00× | **exceeds — decision required** |
| Output directory | 1.546× | — | reported |

## Load latency

Process-isolated, one fresh process per sample, arms interleaved, two sessions
with the arm order reversed in the second.

### Default path

| Session | n | base | B1 | #705 | **#705/base** | B1/base |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 9 | 321.00 ms | 710.89 ms | 850.80 ms | **2.650×** | 2.215× |
| 2 | 11 | 324.59 ms | 699.42 ms | 864.46 ms | **2.663×** | 2.155× |

### Explicit canonical path — each binary on its own artifact

| Session | n | base | B1 | #705 | #705/B1 |
|---|---:|---:|---:|---:|---:|
| 1 | 9 | 296.28 ms | 715.50 ms | 722.24 ms | 1.009× |
| 2 | 11 | 291.62 ms | 698.07 ms | 699.47 ms | 1.002× |

**This is not same-artifact evidence, and earlier receipts described it as if it
were.** Each arm reads the artifact its own binary produced: 46,868,382 bytes
for B1 against 47,030,676 for #705, with different digests. The two are 0.35%
apart, which is close enough to be suggestive and not close enough to support a
causal claim about the loader.

### Same artifact, both binaries — the controlled comparison

Both loaders were pointed at one byte-identical file, the artifact #705
produced, SHA-256 `d25d898e303da785f8417c9a…`, 47,030,676 bytes. The driver
asserts both arms report the same byte count before reporting a ratio.

| Session | n | B1 | #705 | **#705/B1** |
|---|---:|---:|---:|---:|
| 1 | 9 | 686.90 ms | 702.38 ms | **1.023×** |
| 2 | 11 | 702.64 ms | 708.44 ms | **1.008×** |

**#705's loader is 1.008×–1.023× of B1 on identical input** — up to 2.3%
slower, not the "within 1%" the uncontrolled comparison suggested. That the
B1 binary reads a #705-produced artifact at all, and vice versa, is itself
recorded: both directions were checked before this measurement was designed.

### What the two remediations cost

Nothing measurable, and the reason is structural rather than lucky.

| Measurement | `851f92ba` | `86bd5b31` |
|---|---:|---:|
| Default load vs base | 2.647×–2.666× | 2.650×–2.663× |
| Explicit canonical vs B1 (own artifacts) | 1.007×–1.008× | 1.002×–1.009× |
| Same artifact, both binaries | not measured | 1.008×–1.023× |

Structural validation inspects an object the classifier had already parsed, so
it adds no read and no parse. The bounded read performs the same single
allocation and the same single read `readFileSync` did; it sizes from the
descriptor it reads from rather than from a separate path lookup.

The controlled comparison locates the cost. On identical input the loader
accounts for at most 2.3%, which cannot produce a 2.65× default-path ratio. The
default-path difference is which artifact each binary reaches for: B1's default
read the 26 MB v1 mirror, #705's default reads the 47 MB canonical artifact,
because the cutover removed the mirror. A 1.80× larger artifact read by a
loader that is within a few percent is the whole of it.

## Generation, memory and footprint

Four interleaved rounds per arm, medians. No outlier in this sweep; walls fell
within 140.9–141.7 s across all twelve runs.

| Arm | Wall | Peak RSS | Canonical | Legacy | Output dir |
|---|---:|---:|---:|---:|---:|
| base | 141.7 s | 881 MiB | — | 26,228,961 B | 37,532 KB |
| B1 | 140.9 s | 1,239 MiB | 47,029,832 B | 26,193,508 B | 83,428 KB |
| #705 | 141.6 s | 1,146 MiB | 47,192,126 B | 81 B | 58,012 KB |

| Ratio | #705/base | B1/base |
|---|---:|---:|
| Generation wall | 0.999× | 0.994× |
| Peak RSS | 1.300× | 1.405× |
| Canonical artifact | 1.799× | 1.793× |
| Output directory | 1.546× | 2.223× |

### The peak-RSS ratio moved; #705's memory did not

The ratio reads 1.300× here against 1.194× at `851f92ba`, which looks like a
regression and is not one. **#705's own peak RSS is unchanged: 1,148 MiB then,
1,146 MiB now.** The base arm measured 961 MiB then and 881 MiB now, and the
ratio moved entirely on that denominator.

| Arm | at `851f92ba` | at `86bd5b31` |
|---|---:|---:|
| base | 961 MiB | 881 MiB |
| B1 | 1,223 MiB | 1,239 MiB |
| #705 | 1,148 MiB | 1,146 MiB |

This is host variance in the comparator, on a machine that is not quiescent. It
is recorded rather than smoothed, and it is a reason to read the absolute
numbers alongside the ratio.

## Carried forward

The base binary produces a 26.10–26.23 MB v1 artifact on this host against B1's
recorded 20.78 MB for the same revision, tree, command and host. Two candidate
explanations were tested and ruled out during an earlier receipt. It remains
disclosed and nothing is derived from it.

Relationship counts differ by arm — 17,835 for base against 17,940 for B1 and
#705 — the already-documented unregistered-relation loss in the v1 format.

## Gate

Generation wall, peak RSS and canonical artifact size all pass. Default-path
load latency is **2.650×–2.663×**, above the 2.00× threshold, so this requires
an **explicit maintainer decision**. No earlier acceptance carries forward.
