# Invalidated attempts and preserved prior evidence — V1/E1/M1 remediation

Nothing from the earlier rounds is deleted or overwritten. Each prior product
stays where it was generated, and this round adds a new one.

## Preserved, still valid for what they measured

| product | pair | result |
|---|---|---|
| `../2026-08-20-658-stage2-validation/receipt-dccf00cf-vs-ba3fb9f1.json` | `dccf00cf` → `ba3fb9f1` | 1.014× / 1.020× |
| `../2026-08-20-658-stage2-validation/receipt-ba3fb9f1-vs-final.json` | `ba3fb9f1` → `a135efca` | 1.000× / 0.999× |
| independent reviewer reproduction, `24ba54ef` review | `ba3fb9f1` → `a135efca` | 1.029× / 0.976× wall, 1.006× / 1.005× RSS |

Three independent measurements of `ba3fb9f1 → a135efca` now exist: this
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
