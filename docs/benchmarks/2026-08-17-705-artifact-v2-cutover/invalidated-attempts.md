# #705 — invalidated performance attempts

Kept so the accepted receipt can be read against what it replaced. None of these
numbers are averaged with, or used to adjust, any figure in
[`README.md`](./README.md).

## Attempt 1 — broken fixture filter

| Item | Value |
|---|---|
| Reported | generation 1.062×, load 1.012× against base |
| Fixture | a copy of `src/` only, 192 files |
| Invalidation | wrong corpus, and the load metric timed a whole `summary` command dominated by work shared by both arms, so the ratio was diluted to nothing |

## Attempt 2 — `.gitignore` excluded from the fixture

| Item | Value |
|---|---|
| Reported | artifact 1.792×, output directory 1.543×, `#705`/B1 wall 0.695× |
| Fixture | the repository at `ee2115a2`, copied with a filter that excluded any path containing `/.git` |
| Invalidation | the substring test also matched `.gitignore`, `.github` and `.gitattributes`; generation respects Git-ignore, so the copied input was not the stated input |
| Note | re-running on the corrected fixture reproduced the same numbers, so the defect did not move the result — but the receipt described an input that was never measured |

## Attempt 3 — non-quiescent back-to-back batches

| Item | Value |
|---|---|
| Reported | base generation median 129.0 s, spread 185.6%, declared "not certifiable" |
| Invalidation | nine generations were run back-to-back inside one driver process with no recovery gap, on a host running other agents' work; the base arm went bimodal at 74–83 s and 173–210 s |
| Resolution | the accepted receipt runs one generation per invocation with a gap between runs, which removed the bimodality entirely (base spread 0.8%) |

## Superseded claim about B1

Attempt 2's receipt stated that B1's accepted load ratio was **5.183×**. That
figure is from B1's *initial, pre-optimization* receipt and was superseded. The
accepted B1 load result is **2.256× within a 2.25×–2.29× band**, recorded in
`aeaad961` at final B1 head `677ba81d`. The correction is carried in
[`README.md`](./README.md).

Attempt 2's receipt also explained a base-artifact size difference as a slower
host. That was wrong: B1's measurement worktrees are present locally with dists
built 15 August, so B1 measured on this machine.
