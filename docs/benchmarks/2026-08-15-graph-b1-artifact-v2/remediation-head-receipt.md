# Remediation-head receipt — B1 at `c4f65972`

Sixth receipt for PR #707, and the first at a head where semantic identity,
graph construction, artifact load, metadata load, publication and snapshots all
changed. The five earlier receipts are unmodified.

**This receipt does not accept anything. Load is above the 2× gate and a new
maintainer decision is required for this head.**

## What invalidated the previous receipt

| Commit | Measured path it changes |
|---|---|
| `7fb49551` | occurrence path normalization — runs per occurrence on load |
| `3e6a8299` | identity factory ownership — graph construction and artifact load |
| `5dd19721` | publication staging, restore and directory sync |
| `fba1eb8a` | metadata load gains a resolved-artifact size check |
| `020fbfdf` | snapshot copies the canonical artifact |
| `c4f65972` | discovery-safety ceiling threading |

## Protocol

Base `ee2115a2465c86306735494f526dca8baf0383bc`, candidate
`c4f65972a19ae272e37d9e9dcfd3e93bfb32d619`. Frozen harness `measure.sh`
`7e8f51ca…`, resolver `bb54880a…`. Six input worktrees **recreated fresh** at
the base SHA, all clean. Counterbalanced `a1→b1→b2→a2→a3→b3`, quiescence gate
before every measurement, spread validator afterwards. Every run retained.

Attribution controls all held: no base run produced a `graph.madar`, every
counted file was born inside its run window, and semantic counts were identical
within each arm.

## Generation

```
base       44.05  45.13  44.23   mean 44.47s   spread 2.4%   ok
candidate  43.94  43.50  43.36   mean 43.60s   spread 1.3%   ok
```

The tightest arms measured across all six receipts.

| Metric | Base | Candidate | Ratio | Gate |
|---|---:|---:|---:|---|
| Generation wall (s) | 44.47 | 43.60 | 0.980× | pass |
| Peak RSS (MB) | 950.73 | 1188.80 | 1.250× | pass |
| Canonical artifact (MB) | 20.86 | 39.62 | 1.899× | pass, near threshold |
| **Load latency (ms, median of 9)** | **298.98** | **673.92** | **2.254×** | **ABOVE GATE** |
| Transitional total output (MB) | 33 | 73 | 2.212× | disclosure |

0.980× is parity, not a 2% improvement: the difference between arms is smaller
than either arm's own spread. RSS is reported as approximate — the candidate
arm spans 1105.1–1253.9 MB (12.5%), and the validator gates wall time only.

## Load: above the gate, and not because of this batch

The load ratio is **2.254×**, against a previously accepted **2.196×** at an
older head. Two separate questions, answered separately.

**Did this remediation slow loading?** No. Both binaries were pointed at the
*same 41,545,432-byte artifact* and interleaved, nine samples each:

| Binary | Median | Nodes loaded |
|---|---:|---:|
| `8bd76f39` (pre-remediation) | 682.74 ms | 12,669 |
| `c4f65972` (final) | 678.18 ms | 12,669 |

**0.993× (−4.6 ms)** — flat. Per-occurrence path normalization was the obvious
suspect, since it now runs on every occurrence during hydration; measurement
says it costs nothing detectable at this corpus size. That is a measured
answer, not a reassuring guess.

**Then why did the ratio move?** The base arm did. Base load measured 321.36 ms
in the fourth receipt and 298.98 ms here; the candidate also improved
(705.94 → 673.92 ms). Both arms got faster and the base got proportionally
faster, so the quotient rose. Absolute latencies are page-cache and
machine-state dependent and are not comparable across receipts; only
within-run ratios are.

Load per artifact byte is **1.166×**, against an artifact that is 1.899× larger
and for which the loader verifies content-addressed identity for every fact and
occurrence — work v1 did for none of them.

## Metadata load

`readGraphArtifactMetadata` is new in this PR, so **there is no base
counterpart and no ratio is defined**. Reporting one would mean inventing a
base API that never existed.

Measured on the candidate only, resolving `graph.json` to the canonical sibling:

| Mode | Median | Format resolved |
|---|---:|---|
| With the resolved-artifact size check | 166.48 ms | v2 |
| Without | 160.60 ms | v2 |

The new size check costs **+5.88 ms (1.037×)** and, in exchange, an oversized
canonical sibling is refused without being read at all.

## Independent confirmation of the load ratio

A gate decision resting on one measurement session is a gate decision resting
on one machine state, so the load comparison was repeated end to end in a
second session, interleaved, eleven samples per arm, behind the quiescence gate
(load 1.97 of a 4.0 limit).

| Session | Base median | Candidate median | Ratio |
|---|---:|---:|---:|
| 1 (n=9) | 298.98 ms | 673.92 ms | 2.254× |
| 2 (n=11) | 296.99 ms | 679.46 ms | 2.288× |

Both sessions are above the gate, and the two agree to within 1.5%. The
reportable figure is a band of **2.25×–2.29×**, not a single decimal that
implies more precision than the instrument has.

## Verdict

```
generation   0.980x   pass
RSS          1.250x   pass
artifact     1.899x   pass, near the 1.90x band
load         2.25x-2.29x   ABOVE THE 2.00x GATE (two sessions)
```

Three of four ratios pass. Load does not, and the previously accepted exception
was scoped to an older head, an older verification contract, and an older
measured value. It does not transfer, and it is not being carried forward here.

**A new explicit maintainer decision is required for `c4f65972` before this PR
can claim final-ready.** #706 owns load optimization and remains non-blocking
for the storage work itself.

Nothing in `maintainer-decision.md` has been changed by this receipt. The
CodeRabbit documentation finding stays open until that decision exists.
