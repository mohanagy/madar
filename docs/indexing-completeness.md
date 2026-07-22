# Indexing completeness

A valid `graph.json` proves that Madar produced a readable graph artifact. It does **not** prove that every relevant source file was indexed.

Madar writes a separate, versioned completeness receipt for each generation:

- `indexing-manifest.json` is local-only and contains the schema-v2 `summary`, terminal `outcomes`, and source-safe `index_diagnostics` produced by the canonical JavaScript/TypeScript index.
- `indexing-manifest.share-safe.json` contains aggregate counts, reason buckets, and diagnostic counts. It omits paths, per-file outcomes, and diagnostic messages.

In a linked Git worktree these files live beside the external worktree-specific graph, not inside the checkout. `madar generate`, `madar doctor`, and `madar status` print the resolved local location or the relevant counts.

## What counts as an indexed file

An indexed file is a discovered `.ts`, `.tsx`, `.js`, or `.jsx` candidate for which the canonical compiler-backed index produced usable graph evidence. Publishing an unchanged already-current graph is whole-artifact reuse; Madar does not cache or merge per-file extraction fragments.

Each supported candidate, plus each recognized source-like file that Madar can report as unsupported, receives one terminal outcome outside Madar's hard-ignored artifact trees:

| Outcome | Meaning |
| --- | --- |
| `indexed` | Canonical indexing completed without a reported warning. |
| `indexed_with_warnings` | Usable canonical evidence was produced, but an index diagnostic may reduce coverage. |
| `skipped_by_policy` | Madar deliberately did not read the path, for example because it was sensitive, hidden, ignored, excluded by Git policy, or disabled by an option. |
| `unsupported` | Madar recognized the file as source-like, but it is outside the current JavaScript/TypeScript product scope and contributes no graph facts. |
| `failed` | Discovery, stat, or canonical indexing failed for a supported candidate. |

An unreadable or deliberately untraversed directory can have a directory outcome because Madar cannot safely claim individual file knowledge below it. Generated artifacts and dependency trees that Madar hard-ignores, such as `.git/`, `node_modules/`, and `out/`, are outside the candidate set and are not enumerated merely to inflate policy counts.

The aggregate state is:

- `complete` when every candidate is `indexed`;
- `partial` when usable evidence exists but at least one candidate has a warning, policy exclusion, unsupported capability, or failure;
- `failed` when failed or unsupported candidates exist and no candidate produced usable indexed evidence.

Policy exclusions are often intentional. They still make coverage partial because an answer must not silently assume those paths were inspected.

## Local audit and share-safe output

The local manifest is the authoritative audit surface when you need to see affected paths:

```bash
madar generate .
madar doctor
madar status
```

Reason buckets and `index_diagnostics` counts are stable machine-readable fields. Diagnostic messages remain local because compiler errors can contain source paths or source-derived text. The share-safe manifest retains the category and count without retaining that content.

Graph metadata and agent-facing evidence receive aggregate completeness only. They do not copy local outcome paths into shareable graph summaries or context-pack evidence.

## Strict generation

Strict mode fails generation when configured `failed` or `unsupported` counts are exceeded. A failed run writes `indexing-manifest.failed.json` and `indexing-manifest.failed.share-safe.json` before returning the error so CI and humans can inspect the exact reason. It does not replace the canonical manifest associated with the last successfully published graph, and a later successful run removes the failed-attempt files.

```bash
# Fail on any failed or unsupported candidate.
madar generate . --strict-indexing

# Permit up to one failure and three unsupported candidates.
madar generate . \
  --max-indexing-failed 1 \
  --max-indexing-unsupported 3
```

Supplying either threshold enables strict mode. Defaults are zero. Policy skips and indexed-with-warning outcomes remain visible but do not currently trigger the strict threshold.

## Effect on retrieval confidence

Madar compares uncertain local outcomes with the question and the workflow-owner paths selected for an answer. Relevant failures cap confidence more aggressively than warnings, policy skips, or unsupported files. Unrelated incomplete paths remain reported in aggregate but do not automatically lower an otherwise contained answer.

This is a containment signal, not proof that static analysis saw runtime-only behavior. A `complete` manifest means Madar accounted for its candidate set; it does not guarantee semantic perfection, dynamic runtime coverage, or a correct answer.
