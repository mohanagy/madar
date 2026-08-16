# Review-fix-head receipt — B1 at `677ba81d`

Seventh receipt. Earlier receipts are unmodified.

## Why this run exists

The CodeRabbit re-review required two production fixes after the load exception
was accepted for `c4f65972`:

| Commit | Change | Invalidating category |
|---|---|---|
| `677ba81d` | discovery cache keyed on the resolved artifact and the byte bound | metadata loading |
| `677ba81d` | `GraphArtifactMetadata` gains `resolvedPath` | artifact/metadata loading |
| `677ba81d` | snapshot clears stale optional artifacts before repopulating | snapshot publication |

The recorded rule in `maintainer-decision.md` lists metadata loading in the
invalidating set, so the experiment was re-run rather than the acceptance being
assumed to carry. The production code head is now `677ba81d`, not `c4f65972`.

## Protocol

Base `ee2115a2`, candidate `677ba81d498c1d23dd74285e2515917df4448cc8`. Frozen
harness `7e8f51ca…`, resolver `bb54880a…`, six input worktrees recreated fresh
at the base SHA, counterbalanced `a1→b1→b2→a2→a3→b3`, quiescence gate before
every measurement, spread validator after. No base run produced a
`graph.madar`; semantic counts identical within each arm.

```text
base       43.60  44.81  45.37   mean 44.59s   spread 4.0%   ok
candidate  43.69  44.02  44.46   mean 44.06s   spread 1.7%   ok
```

## Results

| Metric | Base | Candidate | Ratio | At `c4f65972` | Gate |
|---|---:|---:|---:|---:|---|
| Generation wall (s) | 44.59 | 44.06 | 0.988× | 0.980× | pass |
| Peak RSS (MB) | 940.50 | 1269.97 | **1.350×** | 1.250× | pass |
| Canonical artifact (MB) | 20.86 | 39.62 | 1.899× | 1.899× | pass |
| **Load latency (ms, n=11)** | **308.85** | **696.64** | **2.256×** | 2.25–2.29× | accepted band |
| Transitional total output (MB) | 33 | 73 | 2.212× | 2.212× | disclosure |

**Load is 2.256×, inside the accepted 2.25×–2.29× range**, so the recorded
exception describes this head too. The head it names has changed and that is
recorded below; the accepted range has not.

Generation is parity again (0.988×, arms tighter than the difference).

## Peak RSS moved, and this is the honest reading

RSS went from 1.250× to 1.350×. It passes either way, but the number moved and
the reason matters more than the verdict.

| Head | Candidate mean | Arm spread | Ratio |
|---|---:|---:|---:|
| `d18b1185` | 1150.70 MB | — | 1.191× |
| `c4f65972` | 1188.80 MB | 12.5% | 1.250× |
| `677ba81d` | 1269.97 MB | **1.6%** | 1.350× |

The obvious suspect would be scoping the collision witnesses, since per-graph
factories can hold more than one witness map alive at once where a single
process-global map held one. **The commit ordering rules that out**: witness
scoping landed in `3e6a8299`, which is already inside `c4f65972`. Both of the
last two measurements are post-scoping, and the only production delta between
them adds one string field and a cache key. That cannot account for 80 MB.

What did change is measurement quality. The `c4f65972` candidate arm spanned
1105.1–1253.9 MB — a 12.5% spread — while this run spans 1256.6–1277.0 MB at
1.6%. The two ranges nearly touch. This is the tightest RSS measurement taken
across all seven receipts, so 1.350× is the better-supported estimate and
1.250× was probably optimistic noise rather than a regression having occurred
since.

RSS remains the least stable metric in this harness: the spread validator gates
wall time only, so RSS ratios are reported as approximate throughout. Anything
that needs RSS to be precise should measure it directly rather than lift a
figure from these receipts.

## Verdict

```text
generation   0.988x   pass
RSS          1.350x   pass (approximate; tightest RSS measurement so far)
artifact     1.899x   pass, near the 1.90x band
load         2.256x   inside the accepted 2.25x-2.29x exception
```

The accepted load exception carries to `677ba81d` because the measured value
falls inside the range that was accepted, not because acceptance was assumed to
travel. Identity and receipt verification remain mandatory, #705 is still
required before #657 completes or anything ships, and #706 still owns load
optimization.
