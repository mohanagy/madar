# #705 artifact v2 cutover — performance receipt

Three-arm generation measurement for the artifact v2 cutover.

**Verdict: nothing this receipt can certify exceeds 2.00×. Generation wall time
against base is not certifiable on this host and is reported as such, not
estimated.**

## Purpose

B1 ([#657](https://github.com/mohanagy/madar/issues/657)) accepted two human-gated
exceptions against base `ee2115a2`: generation wall at 2.133× and load latency at
5.183×. This receipt asks the narrower question — what does **#705** add on top of
B1, and does anything cross 2.00× that B1 had not already surfaced.

Including B1's own candidate as a third arm is what makes that separable.
Comparing only base against this branch would charge B1's accepted cost to #705.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2` |
| B1 candidate binary | `c11ea269` |
| Candidate binary | this branch |
| Input | the repository at `ee2115a2`, root `.git` directory removed |
| Files indexed | 619 (identical for all three arms) |
| Command | `node <binary>/dist/src/cli/bin.js generate <input> --no-html` |
| Harness | `harness.mjs` in this directory |

## Attribution controls

Every run passed:

- `reason=no-cache` on every run, so no run used a warm SPI cache — the defect
  that invalidated three of B1's attempts;
- no base run produced `graph.madar` — the defect that invalidated two more;
- both v2 arms produced `graph.madar` on every run.

## Deterministic metrics

Byte-identical across runs, so 0% variability by construction.

| Metric | base | B1 | #705 | #705 vs base | #705 vs B1 |
|---|---:|---:|---:|---:|---:|
| Canonical artifact (B) | — | 46,743,024 | 47,111,377 | **1.800×** | 1.008× |
| `out/graph.json` (B) | 26,167,044 | 26,131,381 | **81** | — | 0.000× |
| Output directory (KB) | 37,472 | 83,088 | 57,932 | **1.546×** | **0.697×** |

**The harness reproduces B1's own ratios.** Measured here, B1 against base gives
1.786× canonical artifact and 2.217× output directory; B1's receipt recorded
1.778× and 2.182×. Agreement to about 1% on an independently written harness is
the reason the ratios below are trusted even though the absolutes are not (see
Unresolved).

**The cutover's measurable payoff is the transitional footprint.** B1 wrote both a
v2 artifact and a fresh 26 MB v1 mirror, and disclosed the resulting 2.217×
output-directory growth as a non-gate. #705 replaces that mirror with an 81-byte
tombstone: 1.546× of base, 0.697× of B1.

The canonical artifact is 1.800× the base v1 graph — the multigraph retains
relationships the collapsed model discarded. Adding #705 to B1 moves it by 0.8%.

## Generation wall time

Eight runs per non-base arm across two independent batches (one on an earlier
fixture that wrongly excluded `.gitignore`, one on the corrected fixture). The two
batches agree closely, which is why they are reported together.

| Arm | Runs (s) | Reading |
|---|---|---|
| base | 74.5, 83.3, 173.4, 210.3 | bimodal — **not certifiable** |
| B1 | 250.3, 251.1, 251.3, 266.0 | ~251 s, tight |
| #705 | 171.8, 173.2, 174.6, 210.0 | ~173 s, one outlier |

**#705 against B1: 0.690×.** Both arms are stable, interleaved, counterbalanced,
and reproduced across two batches with different fixtures. #705 generates faster
than the candidate whose 2.133× was accepted.

**#705 against base: not certifiable.** The base arm is bimodal — two runs at
74–83 s and two at 173–210 s. The fast runs are the first run of each batch, and
the pattern reproduced across both batches, so it is a property of this host under
sustained load rather than of the binary. A median under those conditions reflects
how many runs landed in each regime, so no ratio against base is offered.

No estimate is substituted. An earlier draft of this receipt derived a figure from
B1's accepted ratio; that is removed, because deriving a gate result from another
receipt's number is not a measurement.

## Unresolved

The base artifact measures 26.17 MB here against B1's recorded 20.78 MB on the
same revision, command and repository state, and the same host — B1's measurement
worktrees are still present locally with dists built 15 Aug, so the earlier
"slower machine" explanation in this receipt was wrong and has been removed. A
`.gitignore` exclusion bug in the first harness was found and fixed; it changed
nothing material, so it was not the cause either. The absolute discrepancy is
unexplained.

It does not affect the conclusions: all three arms share one input, and the
B1-against-base ratios reproduce B1's recorded ratios to about 1%.

## Not measured

- **Peak RSS.** Both instrumented rounds were interrupted before writing a
  report. B1 measured 1.024×, and #705 removes mirror writing rather than adding
  memory work, so no regression is expected — but this receipt does not show it.
- **Load latency.** #705 changes which artifact is selected, not the loader, so
  B1's accepted 5.183× stands unchanged. Not re-measured.

## Limitations

- Single host, single OS, single Node version.
- Sustained-load throttling on this host makes long batches non-stationary; the
  base arm is where it shows.
- Absolutes are not comparable with B1's receipt. Ratios within this receipt are,
  and are corroborated by reproducing B1's own ratios.
