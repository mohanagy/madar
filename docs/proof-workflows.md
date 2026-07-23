# Proof workflows

Proof work must distinguish retrieval correctness from model quality and end-to-end agent behavior.

## Retrieval correctness

Use the checked-in question set:

```bash
npm run build
node dist/src/cli/bin.js generate examples/demo-repo
node dist/src/cli/bin.js eval examples/demo-repo/out/graph.json \
  --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

`eval` checks graph-backed evidence against labeled expectations. The external runner may spend paid model tokens.

## Same-question comparison

`compare` runs one baseline and one Madar evidence arm for the same question and external model command:

```bash
node dist/src/cli/bin.js compare "How does login create a session?" \
  --graph examples/demo-repo/out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

Madar's arm uses the same `retrieve` implementation as MCP and `madar query`; comparison does not introduce another retrieval engine.

Reports are local artifacts. A share-safe report redacts known workstation paths and credentials, but it remains a best-effort artifact that must be reviewed before publication.

On Windows, external runner templates execute through `cmd.exe`; use a command compatible with that shell.

## Core Reset acceptance

The release-gating proof is frozen in the Core Reset design and receipts:

- exact predecessor-deletion closure
- production file and line budgets
- pinned Documenso, Formbricks, and OpenStatus held-out cases
- independent source/hash/provenance grading
- 15,000-node, 30,000-edge p95 performance fixture
- package file-count and packed-byte gates

See [`docs/core-reset/scorecard.md`](./core-reset/scorecard.md). Do not replace a frozen evaluator with a friendlier ad hoc demo.

## Agent activation

Retrieval quality and agent adoption are separate:

1. verify the installed host actually called `retrieve`
2. preserve the exact question and returned result
3. check whether the agent used authenticated evidence
4. record broad fallback reads separately
5. mark performance ineligible when attribution or answer gates fail

## Honest interpretation

- A single good row is a case study, not a universal win.
- A failed activation row says the integration failed to engage, not that retrieval was slower.
- A partial evidence result must keep its boundary.
- Historical receipts remain valid for their named version and setup even when current commands differ.
