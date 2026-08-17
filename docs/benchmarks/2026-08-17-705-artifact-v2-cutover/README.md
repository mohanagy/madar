# #705 artifact v2 cutover — performance receipt

Three-arm generation measurement for the artifact v2 cutover.

**Verdict: no metric this receipt can certify exceeds 2.00×. Generation wall time
against base is not certifiable on this host and is reported as such.**

## Purpose

B1 ([#657](https://github.com/mohanagy/madar/issues/657)) accepted two human-gated
exceptions against base `ee2115a2`: generation wall at 2.133× and load latency at
5.183×. This receipt asks a narrower question — what does **#705** add on top of
B1, and does anything cross 2.00× that B1 had not already surfaced.

Adding B1's own candidate as a third arm is what makes that separable. Comparing
only base against this branch would attribute B1's accepted cost to #705.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2` |
| B1 candidate binary | `c11ea269` |
| Candidate binary | this branch |
| Pinned input | the repository at `ee2115a2`, `.git` excluded |
| Command | `node <binary>/dist/src/cli/bin.js generate <input> --no-html` |
| Rounds | 4 per arm, interleaved, order counterbalanced per round |

Each run received its own copy of the input with no `out/` directory. Absolutes
here are **not comparable with B1's receipt**: the identical base binary measures
73–210 s on this host against B1's recorded 36.43 s, so this is a slower machine.
Only ratios within this receipt are meaningful.

## Attribution controls

All 12 runs passed:

- every run reported `reason=no-cache`, so no run used a warm SPI cache — the
  defect that invalidated three of B1's attempts;
- no base run produced `graph.madar` — the defect that invalidated two more;
- both v2 arms produced `graph.madar` on every run.

## Deterministic metrics

Byte-identical across runs, so 0% variability by construction.

| Metric | base | B1 | #705 | #705 vs base | #705 vs B1 |
|---|---:|---:|---:|---:|---:|
| Canonical artifact (B) | — | 47,308,099 | 47,676,452 | **1.792×** | 1.008× |
| `out/graph.json` (B) | 26,600,225 | 26,566,032 | **81** | — | 0.000× |
| Output directory (B) | 38,809,600 | 86,085,632 | 59,891,712 | **1.543×** | **0.696×** |

The canonical artifact is 1.792× the base v1 graph, consistent with B1's recorded
1.778× — the multigraph retains relationships the collapsed model discarded.

**The cutover's measurable payoff is the transitional footprint.** B1 wrote both a
v2 artifact and a fresh 26 MB v1 mirror, and disclosed the resulting 2.218×
output-directory growth as a non-gate. #705 replaces that mirror with an 81-byte
tombstone, bringing the directory to 1.543× of base and 0.696× of B1.

## Generation wall time

| Arm | Runs (s) | Median (s) | Spread |
|---|---|---:|---:|
| base | 73.5, 83.3, 174.6, 210.0 | 129.0 | **185.6%** |
| B1 | 250.3, 251.1, 251.2, 266.0 | 251.2 | 6.3% |
| #705 | 171.8, 174.3, 174.6, 221.9 | 174.5 | 29.1% |

**#705 against B1: 0.695×.** Both arms are stable and were interleaved, so this
comparison is sound. #705 generates faster than the candidate whose 2.133× was
accepted.

**#705 against base: not certifiable.** The base arm is bimodal — two runs at
73–83 s and two at 175–210 s — and its 185.6% spread is far outside the 15%
variability trigger B1 used. The two fast base runs are the first run of each
batch, which points at sustained-load throttling on this host rather than at the
binary. A base median under those conditions reflects how many runs landed in each
regime, so no ratio against it is reported as a gate result.

For orientation only, not as a gate: B1's accepted 2.133× against base combined
with the measured 0.695× implies roughly **1.48×** for #705 against base. That is
derived from another receipt's number, not measured here.

## Not measured

- **Peak RSS.** The round that carried RSS instrumentation was interrupted. B1
  measured 1.024×, and #705 removes mirror writing rather than adding memory
  work, so no regression is expected — but this receipt does not show it.
- **Load latency.** #705 changes which artifact is selected, not the loader, so
  B1's accepted 5.183× stands unchanged. Not re-measured.

## Limitations

- Single host, single OS, single Node version.
- Sustained-load throttling on this host makes long batches non-stationary; the
  base arm is the one that shows it.
- Absolutes are not comparable with B1's receipt. Ratios within this receipt are.
