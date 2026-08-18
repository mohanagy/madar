# #705 artifact v2 cutover — performance receipt

Direct three-arm measurement.

> **Superseded for the current head.** This receipt was measured at production
> head `1fcc8d88`. The head has since moved twice. The measurement in force is
> [`rerun-851f92ba.md`](./rerun-851f92ba.md), at production head `851f92ba`,
> which reports a **2.647×–2.666×** default-path load band and **awaits a new
> maintainer decision**. The intermediate rerun at `78e7acd4` is
> [`rerun-78e7acd4.md`](./rerun-78e7acd4.md).
>
> Every measurement below is retained as recorded. Accepted exceptions are bound
> to the head they were measured at and are never carried forward.

**Verdict at `1fcc8d88`: four formal gates pass. The 2.64×–2.71× default-path
load ratio was referred for a maintainer decision and was ACCEPTED as an
explicit exception to the 2.00× threshold — see
[`maintainer-decision.md`](./maintainer-decision.md).**

| Metric | #705 vs base | Verdict |
|---|---:|---|
| Generation wall | 0.979× | **passed** |
| Peak RSS | 1.115× | **passed** |
| Canonical artifact | 1.799× | **passed** |
| Load latency (default path) | **2.643×–2.707×** | **accepted exception** |
| Output directory | 1.546× | reported (disclosure) |

## Correction to the B1 historical record

An earlier draft of this receipt called **5.183×** B1's accepted load result. It
is not. That figure comes from B1's initial pre-optimization receipt and was
superseded by one-pass receipt validation, verify-once hydration, comparator
allocation fixes and endpoint-entry memoization.

| Item | Value |
|---|---|
| Initial, superseded | 5.183× |
| **Accepted B1 load** | **2.256×** |
| Accepted reproducible band | 2.25×–2.29× |
| Recorded in | `aeaad961`, at final B1 head `677ba81d` |

B1's other accepted final-head ratios: generation 0.980×, peak RSS 1.250×,
canonical artifact 1.899×, transitional total output 2.212×.

B1's exception does not transfer. #705 changed artifact selection, default
intent, `loadGraph` behaviour, resolved-size checks, canonical path resolution,
mixed-state handling, time-travel and federate loading, freshness access, raw
HTTP/MCP artifact access, and output layout. Every ratio below is measured
directly at the #705 head.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| B1 comparator binary | `5bfdb869e4ed7b4d1c63d18cb4ddecc140f3f082` (squash of #707; content-equivalent to final B1 head `677ba81d`) |
| **#705 production-code head** | **`1fcc8d88fec85b30a22d1729be6d7800cad23bb7`** |
| #705 branch/docs head | `fae5b2351ba694145da15a4c92dbb68fa0d2d666` (this receipt is later) |
| Pinned input | `ee2115a2`, tree `bd235fe6146256556c93db0f9c32037fd796359f` |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Input files / indexed | 1596 / 619 (identical for all arms) |
| Node / npm | v22.22.3 / 12.0.2 |

### Harness SHA-256

| File | Digest |
|---|---|
| `load-sample.mjs` | `a8a393fe3d873edad259b9b323dd9687634329dc5b7b5d111e485f1fa34218c8` |
| `load-default-sample.mjs` | `7c0ca8f116c7f2eb208e9724d107125ccb979d8137a5baf972323a9faddf9e3e` |
| `load-driver.mjs` | `391ec15f9ccf31975592ab6857f0091dd2d6b686017b37d7b13c3dfeb28d9f42` |
| `load-default-driver.mjs` | `184c2fd88b26fd1a8d08048559f703824293727d12c0b01b667273603865d262` |
| `rss-sampler.mjs` | `d99752b125104ba28caba087ea33cd7778ba924323eb0fa05f1ef439970a5464` |
| `gen-run.sh` | `7678b57868672b2385f99380082a946187278d5948b5a7cffadabd4e9fa23c05` |

Invalidated attempts and their reasons:
[`invalidated-attempts.md`](./invalidated-attempts.md).

## Load latency — accepted exception

Process-isolated, one fresh process per sample, arms interleaved, two sessions
with opposite starting arms, one unrecorded warm-up per arm.

### Explicit canonical load

Each arm loads the artifact its own binary generated.

| Session | base | B1 | #705 | B1/base | #705/base | #705/B1 |
|---|---:|---:|---:|---:|---:|---:|
| 1 (n=9) | 284.50 ms | 695.97 ms | 702.28 ms | 2.446× | 2.469× | 1.009× |
| 2 (n=11) | 280.64 ms | 687.62 ms | 688.53 ms | 2.450× | 2.453× | 1.001× |

### Default-path load — the formal gate

Resolves the artifact the way a command with no `--graph` resolves it, then
loads it. This is what normal current use costs.

| Session | base | B1 | #705 | B1/base | **#705/base** | #705/B1 |
|---|---:|---:|---:|---:|---:|---:|
| 1 (n=9) | 319.11 ms | 702.83 ms | 863.91 ms | 2.202× | **2.707×** | 1.229× |
| 2 (n=11) | 315.49 ms | 665.44 ms | 833.73 ms | 2.109× | **2.643×** | 1.253× |

Resolved paths — this is the whole story:

| Arm | Default resolves to | Bytes loaded |
|---|---|---:|
| base | `out/graph.json` (the graph) | 26,105,161 |
| B1 | `out/graph.json` (**the v1 mirror**) | 26,069,288 |
| #705 | `out/graph.madar` (canonical) | 47,030,652 |

**#705 adds nothing to the loader.** On the same code path with a canonical
artifact it is 1.001×–1.009× of B1. The default-path difference of 1.23×–1.25×
is not new loader cost: B1's default read the 26 MB v1 mirror, and #705's default
reads the 47 MB canonical artifact because the mirror is gone. Removing that
mirror is what #705 exists to do, so this cost is intrinsic to the cutover rather
than incidental to it.

### B1 control

The B1 default-path control measures 2.109×–2.202× against an accepted band of
2.25×–2.29× — slightly below, on a host that is not quiescent (load average
~2.8, other agents' work running). The control reproduces the accepted band
closely enough to trust the harness; it is not a quiescent-host reproduction.

## Peak RSS — passed

Process-tree sampler: the spawned process plus all descendants, summed, polled
every 100 ms, maximum retained. `/usr/bin/time -l` wrapping was abandoned after
it killed two measurement runs; the measurement method changed, the product
workload did not.

**Method validation.** A control process holding a 600 MB buffer measured
676,069,376 B, so a missing or zero reading cannot pass as a result.

| Arm | Runs (MB) | Median (MB) | vs base |
|---|---|---:|---:|
| base | 1018, 1028, 892 | 1018 | 1.000× |
| B1 | 1368, 1493, 1212 | 1368 | 1.344× |
| **#705** | 1135, 1135, 1072 | **1135** | **1.115×** |

`#705` is 0.830× of B1 — consistent with no longer writing the v1 mirror.

## Generation wall — passed

Nine runs, counterbalanced, each in a fresh copy with no `out/`, every run
`reason=no-cache`, every run exit 0, no base run producing `graph.madar`.

| Arm | Runs (s) | Median (s) | Spread | vs base |
|---|---|---:|---:|---:|
| base | 265.0, 267.1, 265.6 | 265.6 | 0.8% | 1.000× |
| B1 | 258.5, 259.2, 260.6 | 259.2 | 0.8% | 0.976× |
| **#705** | 258.7, 260.2, 311.0 | **260.2** | 20.2% | **0.979×** |

### Bimodality diagnosis

An earlier attempt saw the base arm split between 74–83 s and 173–210 s. That
attempt ran nine generations back-to-back inside one driver process. This one
runs a single generation per invocation with a gap between runs, and the
bimodality disappeared: base spread fell from 185.6% to 0.8%.

The mode therefore tracked **back-to-back batch execution without a recovery
gap**, not the arm, not run order, and not cache state — every run in both
attempts reported `reason=no-cache`. #705's one 311 s run is a single excursion
of this kind, not a second mode; its other two runs are within 0.6% of each
other.

The measured 0.976× B1 control against B1's accepted 0.980× corroborates the
method.

## Artifact and footprint

| Metric | base | B1 | #705 | #705 vs base | #705 vs B1 |
|---|---:|---:|---:|---:|---:|
| Canonical artifact (B) | — | 47,029,832 | 47,192,102 | **1.799×** | 1.004× |
| `out/graph.json` (B) | 26,228,927 | 26,193,474 | **81** | — | 0.000× |
| Output directory (KB) | 37,532 | 83,428 | 58,012 | **1.546×** | **0.695×** |

B1 measures 1.793× canonical here against its recorded 1.899×, and 2.223× output
directory against its recorded 2.212×.

## Semantic-count parity

Identical node counts across all arms, so no arm loaded less.

| Arm | Nodes | Relationships |
|---|---:|---:|
| base | 12,669 | 17,835 links |
| B1 | 12,669 | 17,940 facts |
| #705 | 12,669 | 17,940 facts |

The 105-relationship difference matches B1's recorded figure exactly: the
multigraph preserves facts the collapsed model discarded.

## Fresh versus upgraded workspace

| File | Fresh (B) | Upgraded (B) |
|---|---:|---:|
| `graph.madar` | 9,827 | 9,883 |
| `graph.json` | 81 (tombstone) | 81 (tombstone) |
| `graph.local.json` | 153 | 156 |
| `graph.v1.json` | absent | 6,386 |

The upgraded workspace's `graph.v1.json` is byte-identical to the `graph.json`
its pre-cutover generation produced. A fresh workspace never had a v1, so it gets
no backup.

## Unresolved: base artifact absolute size

The base binary produces a 26.10–26.23 MB v1 artifact here against B1's recorded
20.78 MB, on the same revision, tree, command and host. Two candidate
explanations were tested and both are ruled out: a `.gitignore` exclusion bug in
an earlier harness (fixing it changed nothing), and the presence or absence of
`.git` in the input (619 files indexed either way).

The difference is disclosed, not explained, and is **not** used to derive or
adjust any gate result. It does not affect the conclusions: all three arms share
one verified input, and the B1-against-base ratios reproduce B1's recorded
ratios — canonical 1.793× against 1.899×, output directory 2.223× against
2.212×, generation 0.976× against 0.980×.

## Gate verdicts

| Metric | Ratio | Verdict |
|---|---:|---|
| Generation wall | 0.979× | **passed** |
| Peak RSS | 1.115× | **passed** |
| Canonical artifact | 1.799× | **passed** |
| Load latency (default path) | 2.643×–2.707× | **accepted exception** (maintainer decision) |
| Load latency (explicit canonical) | 2.453×–2.469× | context for the above |
| Output directory | 1.546× | reported |

## Limitations

- Single host, single OS, single Node version.
- The host is not quiescent; other agents' work ran concurrently. Load averages
  are recorded per sample.
- The base arm has no v2 artifact, so the load comparison is v1-loader against
  v2-loader by construction, as it was for B1.
- Metadata-only load was not measured as a ratio: the base binary exposes no
  equivalent API, and inventing a base figure would manufacture a comparison.
