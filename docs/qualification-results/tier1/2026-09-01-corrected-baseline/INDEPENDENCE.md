# Run independence — how it was established, not asserted

Both arms report `0 pass / 8 fail / 0 invalid` with semantic digest
`0c45822d53a8dd9e94fc1e5d75b1d631d32ec3bda3f86d05b60d897ce1ee6051`.

Identical results are what a deterministic subset should produce. The question this
file answers is the other one: did they get there by executing twice, or by one arm
reading the other's output?

## What is shared, and what is not

| Artefact | Shared? |
| --- | --- |
| Bare clone mirror (`.qualification-cache/*.git`) | **yes** — immutable, and every checkout is identity-verified against the pinned SHA and every `cited_blobs` digest |
| Prepared target worktree | no — `work-corrected-run-a/targets/…` vs `work-corrected-run-b/targets/…`, each `rm -rf`'d and re-cloned |
| `out/graph.madar` | no — regenerated per arm inside that arm's worktree |
| Pack artifacts | no — produced per arm |
| Evaluator results | no — separate `--out` directories |

`scripts/qualify-tier1.mjs` has no code path that reads another arm's output
directory. `run_independence` in each `result.json` records the worktree, graph
artifact digest, clone-cache status and per-cell artifact digest for that arm.

## The positive evidence

Seven of the eight cells produced **different raw Pack bytes** between the arms.
Across all eight artifacts the complete set of differing leaves is:

```
.governance.graph_freshness.generated_at
.governance.graph_freshness.generated_ms
.governance.graph_freshness.graph_modified_at
.governance.graph_freshness.graph_modified_ms
.governance.graph_freshness.graph_version
.evidence.recovery.attempts[0].elapsed_ms
.pack.recovery.attempts[0].elapsed_ms
```

Timestamps and elapsed times — exactly, and only, where two independent executions
must differ. Every evidence-bearing field is identical.

## The one cell with identical bytes

`plan-unstorage-add-driver@unstorage` is byte-identical between the arms. That is
permitted — two independent runs of a deterministic cell may agree exactly — but it
is only permitted if it happened by execution, so it is checked rather than assumed.

It is identical because its artifact carries **no volatile field at all**: its
recovery attempts have no `elapsed_ms`, and its shape omits the
`graph_freshness` timestamp subfields. There is nothing in it that could differ.

The decisive check is its siblings. `arch-unstorage-driver-seam` and
`neg-unstorage-absent-encryption` run against the **same prepared target**, from the
same graph identity digest `acb77534251573f3`, and both produced **different** bytes
between the arms:

| Cell (unstorage target) | run A | run B | identical |
| --- | --- | --- | --- |
| `plan-unstorage-add-driver` | `76186a492d6e2353` | `76186a492d6e2353` | yes |
| `arch-unstorage-driver-seam` | `a44536fa637130db` | `d2f4d1f14ad155e9` | no |
| `neg-unstorage-absent-encryption` | `12b0df498cd268b3` | `85cd933f110b07e6` | no |

If run B had reused run A's prepared target, graph, or results, all three would be
identical. Two of the three differ, so the unstorage target was cloned, generated and
packed again in run B. The identical cell is a property of that artifact's content,
not of a shared result.
