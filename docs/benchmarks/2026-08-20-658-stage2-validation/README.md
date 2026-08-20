# #658 Stage 2 validation evidence — 2026-08-20

Evidence for the V1–V3 and E1 remediation of the independent `HOLD-STAGE3` at
`ba3fb9f1`. Every JSON file here is generated; none is hand-edited.

## Regenerating

```bash
# Historical correction: audits the checkpoint's published claim.
npm run verify:integrity-receipts -- \
  --baseline-ref dccf00cf95b3d0ba043f71197815307060b5a4f8 \
  --candidate-ref ba3fb9f17a2a3aa7bbb9f91bd8262770a139ce9e \
  --out docs/benchmarks/2026-08-20-658-stage2-validation/receipt-dccf00cf-vs-ba3fb9f1.json

# Current remediation overhead: what V1-V3 cost.
npm run verify:integrity-receipts -- \
  --baseline-ref ba3fb9f17a2a3aa7bbb9f91bd8262770a139ce9e \
  --out docs/benchmarks/2026-08-20-658-stage2-validation/receipt-ba3fb9f1-vs-final.json

# Current-head corpus receipts. Explicitly not a qualification.
npm run verify:integrity-receipts -- --corpus-only \
  --out docs/benchmarks/2026-08-20-658-stage2-validation/current-corpus-receipt.json
```

The command resolves each ref itself, builds it in a throwaway worktree from its
own pinned lockfile, and refuses a dirty tree. Nothing has to be prepared by
hand, which is the property that makes these numbers evidence rather than
assertions.

## Files

| file | what it establishes |
|---|---|
| `receipt-dccf00cf-vs-ba3fb9f1.json` | Corrects the checkpoint's published performance claim |
| `receipt-ba3fb9f1-vs-final.json` | What the V1–V3 validation costs |
| `current-corpus-receipt.json` | Corpus, equation, retention, hazards at the remediation head |
| `superseded-receipt-0fb93df0.json` | The earlier receipt, retained, not overwritten |
| `invalidated-attempts.md` | Exactly why each superseded number cannot be used |

## Reading the performance numbers honestly

**The effect is smaller than the noise.** In the historical correction, a single
arm's five samples span roughly 655–728 ms on the src-only corpus — about 11%.
The ratios being compared differ by low single-digit percentages. That is why
three independent measurements of the same two heads produced three different
answers: the checkpoint's `0.993x` / `1.070x`, the reviewer's `0.988x` /
`0.994x`, and this runner's `1.014x` / `1.020x`.

None of those is a lie and none is precise. The correct reading is that
`dccf00cf → ba3fb9f1` is indistinguishable from no change at this sample size.
The receipts record every raw sample and both counterbalanced session orders so
that judgement can be checked rather than taken on trust.

**What was fixed rather than re-measured.** The earlier comparison let each arm
extract its own input and compared the build times, which measures two
extractions as though they were one. Input is now extracted once under a
declared authority, handed byte-identically to both arms, and any session whose
arms disagree on the input checksum is discarded and recorded as invalidated.
Arms run in separate processes with counterbalanced order, because sharing a
process let the first arm warm the JIT for the second.

**Gate.** Any wall-time or peak-RSS ratio above `2.00x` is a `HUMAN_GATE`. The
formal final #658 performance against `31ad2168` belongs to Stage 5 and is not
measured here.

## Extraction modes

`legacy` is measured. `spi` and `auto` are not, and no receipt is fabricated for
them: the extraction handed to the normalized boundary in those modes is
assembled inside `generate()` by unexported merge and node-precedence logic, so
a standalone runner would measure a reimplementation rather than production.
Measuring them requires exporting that assembly, which is outside #658.

Corpus scope and extraction mode are recorded as separate fields throughout.
Conflating them is how one run's breadth was previously published as another
run's mode.

## Corpus growth

The corpus is larger than earlier receipts record because this remediation added
source and test files. Counts are only comparable alongside their inventory
checksum, which every receipt carries.
