# Proof workflows

Proof work must distinguish retrieval correctness, transport, model quality, and end-to-end agent behavior.

## Local retrieval check

Use the public surface for an ordinary repository check:

```bash
madar generate .
madar query "Trace authentication from the route to session persistence."
```

For the same accepted graph and normalized request, CLI `query`, direct application use, and MCP `retrieve` produce the same canonical bytes.

## Core Reset evaluators

The release-gating held-out and performance evaluators are development-only repository tooling, not public CLI commands:

```bash
npm run build
node tools/eval/core-reset/evidence-path-held-out.mjs \
  --contract tools/eval/core-reset/contracts/evaluation-contract.json \
  --receipt docs/core-reset/evidence/evidence-path-held-out.json
node tools/eval/core-reset/evidence-path-performance.mjs \
  --contract tools/eval/core-reset/contracts/evidence-path-performance-v2.json \
  --receipt docs/core-reset/evidence/evidence-path-performance.json
```

Their repositories, prompts, grading, expected evidence, query budgets, and query semantics are frozen. Thin Delivery may re-pin only the transport path from the old built CLI to the package bin.

The acceptance boundary includes:

- exact predecessor-deletion closure
- production file and line budgets
- pinned Documenso, Formbricks, and OpenStatus cases
- independently authenticated source, range, hash, and provenance grading
- 15,000-node, 30,000-edge p95 performance fixture
- package file-count and byte gates

See [`docs/core-reset/scorecard.md`](./core-reset/scorecard.md). Do not replace a frozen evaluator with a friendlier ad hoc demo.

## Transport evidence

A normally launched client transport receipt must separately show:

1. initialize
2. `tools/list` returning exactly `retrieve`
3. one forced `tools/call`

No injected MCP configuration, manual override, or direct JSON-RPC substitute proves the normal client path. A forced call proves transport only; natural selection and product preference are later gates.

## Honest interpretation

- A single good result is a case study, not a universal win.
- A failed activation says the integration did not engage; it is not a retrieval-speed result.
- A partial evidence result must preserve its boundary.
- Historical benchmark receipts remain valid for their named version and setup even when their recorded command no longer exists.
- Share-safe artifacts are best-effort redactions and must be reviewed before publication.
