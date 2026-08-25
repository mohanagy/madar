# Invalidated attempts and preserved prior evidence — V1/E1/M1 remediation

Nothing from the earlier rounds is deleted or overwritten. Each prior product
stays where it was generated, and this round adds a new one.

## Preserved, still valid for what they measured

| product | pair | result |
|---|---|---|
| `../2026-08-20-658-stage2-validation/receipt-dccf00cf-vs-ba3fb9f1.json` | `dccf00cf` → `ba3fb9f1` | 1.014× / 1.020× |
| `../2026-08-20-658-stage2-validation/receipt-ba3fb9f1-vs-final.json` | `ba3fb9f1` → `a135efca` | 1.000× / 0.999× |
| independent reviewer reproduction, `24ba54ef` review | `ba3fb9f1` → `a135efca` | 1.029× / 0.976× wall, 1.006× / 1.005× RSS |

Two independent measurements of `ba3fb9f1 → a135efca` now exist: this
implementation's `1.000× / 0.999×` and the reviewer's `1.029× / 0.976×`. Neither
is selected as the truth and neither is deleted. They differ by low single
digits while a single arm's samples span roughly 11%, which is the same
noise-exceeds-effect conclusion the previous round recorded.

## New this round

`receipt-a135efca-vs-final.json` measures what the V1-01, V1-02 and V1-03
validation costs.

## Runner defects found and fixed while producing this evidence

- **Nested signal handlers leaked the candidate worktree.** Each helper
  installed its own SIGINT/SIGTERM handler that cleaned its own directory and
  called `process.exit`. Node runs listeners in registration order, so the
  outermost cleaned up and exited before any inner handler ran. Replaced by one
  registry and one coordinator.
- **The shared-input directory was removed outside a `finally`.** A throwing arm
  skipped the removal entirely.
- **A killed run left a mutation on disk.** A discovery run hit a wall-clock
  limit and was killed while blocked in a synchronous child; the restore handler
  queues behind that call and never ran. The surviving mutation disabled
  `assertCleanTree` and was invisible to a `git status` check because the file
  was untracked — git reported a new file, which is exactly what it was meant to
  be. It surfaced only because the next run found that suite already red and
  refused to score seven mutants against it. Restoration is now verified by
  re-reading each file, and the harness refuses to print any tally when a
  mutation survives.

## Invalidated qualification attempts — M1-05D remediation round

Kept, not deleted. Each measured something real; none of them measures the
frozen head, so none of them is final evidence.

### `ad62ff48` — superseded, complete

A full qualification passed here: 24-file manifest at 829/0/13, two matrices at
96 caught / 0 uncaught / 0 skipped with equal semantic digests
(`17633fb7…`), exact-ref receipt within budget, all gates. It is superseded
because a cleanup defect was found afterwards: `produceEvidenceMatrix` created
its scratch project before running the harness and returned the path only on
success, so a thrown invocation stranded the directory. Four were left behind,
two per arm.

### `6ef1e4dc` — superseded, complete

The same qualification passed again after that fix: manifest 830/0/13, two
matrices at 97/0/0 with equal semantic digests (`abdf0549…`), receipt within
budget, all gates. `receipt-a135efca-vs-6ef1e4dc.json` is retained here as the
product of that run.

It is superseded because its own cleanliness audit still reported three
stranded scratch projects. Those were produced by the mutant that deliberately
removes the helper's cleanup — one per matrix arm plus one manual verification.
The shipped code was correct; the *control* that detected the strand was
walking away from it.

### `8d239a08` — externally interrupted, INVALIDATED

Stopped by a process-group kill after the exact manifest passed (830/0/13) and
matrix A had begun. **Its partial manifest and matrix A numbers are not final
evidence and are not carried forward.**

The kill bypassed the harness's `exit`, SIGINT and SIGTERM restore hooks and
left a mutation on disk:

```text
scripts/lib/receipt-guards.mjs
assertDistinctArms:  if (baselineSha === candidateSha)  ->  if (false)
mutant:              M1: allow both arms to be the same commit
```

This is the second time a killed run has stranded a mutation, and the first
time nothing would have caught it. Residual detection compares against
originals captured *during* a run, so at startup the stale mutation would
simply have been adopted as the next run's pristine baseline, and every
attribution afterwards measured against a corrupted file.

The file was restored and verified by digest — disk and `HEAD` both
`228b67f0b744b9aad51daaef304caf750532b1ac0548e7238b88719def18fda4`, which also
matches the `pre_mutation_digest` recorded for that target in an earlier
invocation's `meta.json`.

The harness now refuses to start when any mutant target differs from its
committed form, before producing an artifact root.
