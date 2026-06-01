# Explain-flow workflow draft

## Partner shape

An **anonymized repo owner** with a medium-sized TypeScript/Node service wants a compact answer to “how does this request become a persisted session?” without sharing private source.

## Repeatable loop

1. Generate the local graph and run one bounded explain prompt.
2. Save only the shareable result summary and the command receipt.
3. Publish a short note that says whether the first pass answered the question cleanly or still needed targeted follow-up.

This is a **repeatable loop** because the same pattern can run on many partner repos with different code, while the public note stays bounded to the workflow shape and outcome summary.

## What to publish

- Task framing: explain one runtime flow.
- The local commands used.
- A short summary of whether the first answer was enough.
- Any partner-approved outcome note, without raw source or full prompt text.

## What stays out

- Raw source files.
- Full prompts or answer transcripts.
- Customer names, repo names, and internal identifiers.
