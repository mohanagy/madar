# Windows-head receipt — B1 at `cd033b7e`

Fifth and final receipt for PR #707. The four earlier ones are unmodified;
raw measurements are never overwritten.

This one exists because the fourth receipt's head was not the final head. Two
commits followed it, and one of them changed code inside the measured
generation path, so the gate was re-run rather than assumed.

## What forced a re-measurement

`4835a79e` fixed four Windows defects, one of which (`writeDurable`) sits in the
publication path that generation wall time measures. `cd033b7e` is test-only and
does not invalidate anything.

## A discarded run, and the harness gap it exposed

The first re-measurement attempt is archived at `runs.contaminated/` and
`sequence.contaminated.log`. It is not reported as a result.

While it was measuring, roughly 100 MB of CI logs were downloaded and unzipped
on the same machine. The base arm came out:

```
base       48.79  80.58  84.35   spread 49.9% of its own mean
candidate  76.56  77.12  72.58   spread  6.0%
```

`measure.sh` passed it. Its precondition refuses a competing `madar` or `vitest`
process and says nothing about general machine load, so the run cleared every
guard it had while becoming uninterpretable.

The failure mode worth recording is not that the data was noisy. It is that the
noise produced a **plausible** answer: a naive reading gives a generation ratio
of **1.059×**, which looks like an ordinary, reportable result. Nothing in the
ratio itself reveals that the base arm was measured across two different
machines-in-effect.

Two controls were added, both as new files so the frozen harness stays
byte-identical and the earlier receipts remain reproducible:

| File | Role |
|---|---|
| `quiesce-gate.sh` | refuses to start a measurement while 1-minute load exceeds a quarter of the core count |
| `validate-sequence.py` | refuses to report a ratio when either arm's spread exceeds 15% of its own mean |

`measure.sh` remains `7e8f51ca…` and `resolve-paths.mjs` remains `bb54880a…`.

The gate runs before **every** measurement rather than once at the start,
because the discarded run was quiet when it began and degraded three
measurements in — a start-of-run check would have passed it.

Run against the discarded data, the validator rejects it and withholds the
ratio.

## The valid run

Gate passed before each of the six measurements (load 2.10–3.56 against a 4.0
limit, 16 cores).

```
base       50.73  45.62  44.16   mean 46.84s   spread 14.0%   ok
candidate  45.01  46.00  43.27   mean 44.76s   spread  6.1%   ok
```

| Metric | Base | Candidate | Ratio | Verdict |
|---|---:|---:|---:|---|
| Generation wall (s) | 46.84 | 44.76 | 0.956× | parity |
| Peak RSS (MB) | 926.2 | 1139.9 | 1.231× | pass |
| Canonical artifact (MB) | 20.86 | 39.62 | 1.899× | pass, near threshold |
| Load latency (ms) | 321.36 | 705.94 | 2.197× | carried forward |
| Transitional total output (MB) | 33 | 73 | 2.212× | disclosure |

### What these numbers do not say

**0.956× is not a 4% improvement.** The base arm's spread (6.6 s) is larger than
the difference between the arms (2.1 s). This run supports parity, which is what
the three receipts jointly show (0.965×, 0.963×, 0.956×). Reading a speedup out
of it would be reading noise.

**Absolute times are not comparable across receipts.** Base generation was
27.58 s in the fourth receipt and 46.84 s here, because ambient machine load
differed. Only within-run ratios travel between receipts.

**RSS is the softest number in the table.** The candidate arm spans 1009.8 to
1213.2 MB — a 17.8% spread. `validate-sequence.py` gates wall time only, so
1.231× is reported as an approximate figure, not a precise one. It is well
inside the threshold either way.

**Load latency is carried forward, not re-measured.** `git diff
d18b1185..cd033b7e` touches no load-path file: not `graph-artifact.ts`, not
`serve.ts`, not `graph.ts`, not `canonical-json.ts`, not `semantic-identity.ts`.
The 2.197× exception recorded in `maintainer-decision.md` still describes this
head, and no new decision is required.

### Artifact size

1.899× against a 1.90× near-threshold band, effectively unchanged from the
1.903× recorded at `d18b1185`. The community integer per node added there is
still the last change to move this number. Anything adding a further per-node
field is measured against this, not against the older 1.894×.

Absolute sizes drift slightly between receipts (base mirror 20.78 → 20.86 MB)
because the corpus is the live repository and generation derives facts from git
history, which gains commits over time. Within a run both arms see identical
input, so the ratio is unaffected; across runs the absolute megabytes are not
comparable.

## Protected PR merge-result CI

Not "exact-head CI": GitHub checks out a merge commit, not the branch head.

Six lanes at `cd033b7e`, first attempt, run `31903135907`:

| Lane | Worker-start | Handshake | v0.32.1 tag object | Old-reader | Corpus audit | Test files |
|---|---|---|---|---|---|---|
| ubuntu 20 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 27.6 s | 234/234 |
| ubuntu 22 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 46.3 s | 234/234 |
| macos 20 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 31.7 s | 234/234 |
| macos 22 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 29.9 s | 234/234 |
| windows 20 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 101.5 s | 234/234 |
| windows 22 | 0 | 0 | `60266f23…` | 4/4 | 189 files, 81.9 s | 234/234 |

Both guards are shown executing, not merely absent: the old-reader proof reports
four tests run against the pinned tag object, and the corpus audit prints its
real file count on every lane.

### The corpus number was wrong

The audit is a **189-file** audit. It was documented, and reported by me, as a
400-file audit. `src/` holds 189 `.ts` files and never held 400, so the
`slice(0, 400)` was inert and the figure was wrong everywhere it was quoted.

It survived because the corpus size was *described* in a comment and never
*checked*. It is now asserted with a floor, verified by collapsing the scan to
three files and confirming the floor fails it.

### The Windows budget was not optional

The audit could not run on Windows at all before `4835a79e` — it died on a
malformed path — so every prior observation excluded the slowest platform. At
`4835a79e` Windows measured 81–86 s against a 90 s budget, 96% of the ceiling.
At `cd033b7e` Windows Node 20 measured **101.5 s**, which the old 90 s budget
would have failed outright. The raise to 180 s was necessary, not precautionary,
and is the first budget set with Windows data in it.

## History

| Head | Result |
|---|---|
| `d18b1185` | 4/6 — both Windows lanes failed 25 files identically, 0 worker signatures |
| `4835a79e` attempt 1 | 5/6 — Windows green; macOS 20 hit a pre-existing watcher flake |
| `4835a79e` attempt 2 | 6/6 |
| `cd033b7e` | 6/6, first attempt |

The macOS Node 20 failure was `watch > triggers rebuild when a followed symlink
media sidecar changes`. It is unchanged from `origin/next`; the `watch.ts` code
was byte-identical to `d18b1185`, which passed that same lane an hour earlier;
macOS Node 22 passed it in the same run; it passed 12/12 locally on Node 20; and
the three most recent commits touching that file on `next` are all timing
stabilisations, including one for this exact assertion. It was not modified —
it is pre-existing, outside #657, and in a file maintainers are actively
stabilising.

`origin/next` is green on Windows at this branch's base `ee2115a2`, so the 25
Windows failures were regressions from this branch and none of them were
inherited.
