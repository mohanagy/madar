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

**Three measurements of `ba3fb9f1 → a135efca` exist** and all are preserved:
this implementation's `1.000× / 0.999×`, the reviewer's independent `1.029× /
0.976×`, and the noise band that explains why they differ.

## Extraction modes

`legacy` is measured. `spi` and `auto` are not, and no receipt is fabricated for
them: the extraction handed to the normalized boundary in those modes is
assembled inside `generate()` by unexported merge and node-precedence logic, so
a standalone runner would measure a reimplementation rather than production.

## Local full suite

Not green. Repository-wide timeout failures are recorded on #710 and are not
addressed on this branch.
