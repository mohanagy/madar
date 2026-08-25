# #658 V1/E1/M1 remediation evidence — 2026-08-21

Evidence for the V1-01, V1-02, V1-03, E1-04 and M1-05 remediation of the
independent `HOLD-STAGE3` at `24ba54ef`. Every JSON file here is generated.

Prior evidence is preserved in `../2026-08-20-658-stage2-validation/`, not
replaced. See `invalidated-attempts.md` for what each earlier product measured
and why all of them are kept.

## Regenerating

```bash
npm run verify:integrity-receipts -- \
  --baseline-ref a135efca773f5b5f4690a7195e48ad5c44b18ef9 \
  --out docs/benchmarks/2026-08-21-658-v1-remediation/receipt-a135efca-vs-final.json

npm run verify:integrity-receipts -- --corpus-only \
  --out docs/benchmarks/2026-08-21-658-v1-remediation/current-corpus-receipt.json
```

The command resolves each ref itself, builds it in a throwaway worktree from its
own pinned lockfile, refuses a dirty tree, and cleans up on success, failure and
signal through one resource registry.

## Results

| | src-only | src-plus-tests-js-ts |
|---|---|---|
| wall ratio | 0.976× | 0.981× |
| RSS ratio | 1.000× | 1.006× |
| identical input | yes | yes |
| candidates both arms | 15,005 | 21,002 |
| invalidated sessions | 0 | 0 |

Corpus at the remediation head: 199 files / 15,005 candidates and 682 files /
21,002 candidates, both equations balancing, zero share-safety hazards, all five
planted control hazards detected, snapshot attached.

## Reading these numbers

**The effect is smaller than the noise, again.** A single arm's five samples
span 148–190 ms while the ratios differ by about 2%. The honest reading is that
total validation, closed schemas and record-identity rederivation cost nothing
detectable at this corpus size — not that they made anything faster. A ratio
below 1.0 here is measurement scatter, and reporting it as a speedup would be
the same error as reporting an earlier round's scatter as a regression.

**Two measurements of `ba3fb9f1 → a135efca` exist** and both are preserved:
this implementation's `1.000× / 0.999×` and the reviewer's independent `1.029×
/ 0.976×`. The noise band described above is what explains the difference
between them; it is an interpretation of those two measurements, not a third.

## Extraction modes

`legacy` is measured. `spi` and `auto` are not, and no receipt is fabricated for
them: the extraction handed to the normalized boundary in those modes is
assembled inside `generate()` by unexported merge and node-precedence logic, so
a standalone runner would measure a reimplementation rather than production.

## Local full suite

Not green. Repository-wide timeout failures are recorded on #710 and are not
addressed on this branch.

## Addendum — M1-05D-A / M1-05D-B / E1-05R remediation head

`receipt-a135efca-vs-ad62ff48.json` measures the head that remediates the
independent `HOLD-STAGE3` at `445ca154`. Nothing above is replaced; the earlier
receipts remain the evidence for the trees they measured.

```bash
npm run verify:integrity-receipts -- \
  --baseline-ref a135efca773f5b5f4690a7195e48ad5c44b18ef9 \
  --candidate-ref ad62ff488b68e7d1494ff0efd4d49f0f109b2655 \
  --out docs/benchmarks/2026-08-21-658-v1-remediation/receipt-a135efca-vs-ad62ff48.json
```

| | src-only | src-plus-tests-js-ts |
|---|---|---|
| wall ratio | 0.999× | 0.973× |
| RSS ratio | 1.007× | 0.998× |
| identical input | yes | yes |
| files | 199 | 690 |
| candidates both arms | 15,005 | 21,143 |
| invalidated sessions | 0 | 0 |

Both equations balance, share-safety hazards are zero, and all five planted
control hazards are detected. The file count rose from 682 to 690 because this
round added test and helper files; `src/` is byte-identical to `4148bb90`.

**Read this as no detectable cost, not a speedup.** A single arm's five samples
span 133–141 ms against medians near 950 ms, so a 0.1–2.7% ratio difference is
scatter. That reading has not changed across any round.

### Mutation evidence

Two consecutive complete matrices at this head, run with nothing else active:

```text
matrix A          caught 96 / uncaught 0 / skipped 0
matrix B          caught 96 / uncaught 0 / skipped 0
invocations       117 each (96 mutants, 21 baselines)
semantic digest   17633fb717be2d3dcf2989a671a9b2eb3227ba1d543bcf5585d383039223d014 (both)
```

The digest covers mutant and baseline identities, requested suites, expected
tests, observed and recomputed classifications, process-outcome classes and the
truth of each pre/mutated/post digest lifecycle. It deliberately excludes run
IDs, paths and timestamps, so two equivalent matrices agree without any claim
that their raw artifacts are byte-identical.

**The matrix is not safe to run concurrently with other test workers.** An
earlier partial run overlapped other vitest activity and three receipt-guard
mutants hit the harness's 300 s per-suite timeout, scoring SKIPPED; each was
`caught` on an isolated rerun. The new `process_outcome` evidence is what made
that diagnosable — `timed_out: true`, `duration_ms: 300015`, exit 143 — where
the old artifacts recorded exit status as null.
