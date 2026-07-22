# Indexing completeness

A readable `graph.json` is not enough by itself: Madar authenticates the graph's embedded index-build state before treating it as accepted. That state records the build id, source snapshot, generation policy, source-root identity, corpus counts, completeness summary, and exact supported-file failures.

`graph.json` is the authoritative completeness surface. Madar also attempts to write these derived diagnostics beside it:

- `indexing-manifest.json` contains the summary, terminal per-path outcomes, and canonical index diagnostics for local inspection.
- `indexing-manifest.share-safe.json` contains aggregate summary and diagnostic counts without paths, per-file outcomes, or messages.

Derived diagnostics are optional. Their absence or write failure does not block graph publication, and a manifest is used only when its build id matches the accepted graph. In a linked Git worktree, the graph and diagnostics live in that worktree's isolated external artifact directory rather than inside the checkout.

## What counts as supported completeness

The supported product scope is discovered `.ts`, `.tsx`, `.js`, and `.jsx` files. A supported file is indexed when the canonical compiler-backed index produces usable graph evidence for it.

Each discovered path can have one terminal outcome:

| Outcome | Meaning | Default effect on supported completeness |
| --- | --- | --- |
| `indexed` | Canonical indexing completed without a reported warning. | Successful. |
| `indexed_with_warnings` | Usable canonical evidence was produced with diagnostics. | Successful; warnings remain visible. |
| `failed` | A supported candidate could not be read or indexed into usable evidence. | Can make completeness partial or failed. |
| `unsupported` | A recognized source-like or non-code file is outside the JavaScript/TypeScript product scope and contributes no graph facts. | Informational. |
| `skipped_by_policy` | Madar deliberately omitted a path because of ignore, exclusion, sensitivity, or traversal policy. | Informational; safety exclusions are also reported separately. |

Hard-ignored generated artifacts and dependency trees such as `.git/`, `node_modules/`, and `out/` remain outside the supported candidate set. They are not enumerated merely to increase policy counts.

The embedded aggregate state is based only on supported indexing failures:

- `complete` when no supported file failed, including when unsupported files or policy skips exist;
- `partial` when some supported files produced evidence and at least one supported file failed;
- `failed` when every supported file failed.

This is a scoped claim: `complete` means the canonical index successfully handled its supported JavaScript/TypeScript candidates. It does not claim coverage for another language, intentionally excluded source, dynamic runtime behavior, or semantic perfection.

## Unchanged reuse and changed reconciliation

An unchanged CLI, watch, or MCP update accepts the existing authenticated graph after scanning the source catalog. It parses zero files and does not republish.

Every changed source, compiler-control, or policy update performs the same full canonical reconcile. Madar does not keep an AST, per-file extraction fact, dependency closure, or compiler session in memory or on disk.

## Local audit and share-safe output

Use the graph-backed command surfaces for the accepted build and the optional manifest when you need per-path diagnostics:

```bash
madar generate .
madar doctor
madar status
```

Canonical diagnostic messages remain local because they can contain source paths or source-derived text. The share-safe diagnostic file retains only aggregate categories and counts. If a derived file is missing or stale, the graph's embedded completeness remains authoritative.

## Strict publication thresholds

Default completeness keeps unsupported files and policy skips informational. Strict mode is an explicit additional publication policy: it can reject a candidate build when configured `failed` or `unsupported` counts exceed their thresholds.

```bash
# Reject any failed or unsupported outcome.
madar generate . --strict-indexing

# Permit up to one failed and three unsupported outcomes.
madar generate . \
  --max-indexing-failed 1 \
  --max-indexing-unsupported 3
```

Supplying either threshold enables strict mode; unspecified allowances default to zero. A rejected candidate does not advance `graph.json`. Madar does not publish failed-attempt manifests as an alternate authority.

## Effect on retrieval confidence

Agent-facing evidence reads completeness from the accepted graph. Relevant supported failures can lower coverage and answerability. Unsupported inventory, policy skips, and safety exclusions remain explicit context signals, but they do not automatically make an otherwise complete JavaScript/TypeScript index partial.

Completeness is still static evidence, not a runtime trace or a guarantee that every possible answer is present. When the task depends on unsupported or excluded evidence, the agent should state that limitation and verify the relevant source through an appropriate tool.
