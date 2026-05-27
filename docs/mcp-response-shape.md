# MCP response shape

Madar MCP responses that guide agent exploration include an additive top-level `evidence` block:

```jsonc
{
  "evidence": {
    "pack_confidence": "high",
    "coverage": "complete",
    "missing_phases": [],
    "covered_workflow_owners": ["src/runtime/retrieve.ts"],
    "agent_directive": "answer_from_pack"
  }
}
```

## Fields

- `pack_confidence` — deterministic confidence band: `high`, `medium`, or `low`.
- `coverage` — deterministic coverage band: `complete`, `partial`, or `unknown`.
- `missing_phases` — runtime/explain workflow phases the slice did not cover when that signal exists.
- `covered_workflow_owners` — top files the pack or derived response accounts for.
- `agent_directive` — the load-bearing agent instruction: `answer_from_pack`, `verify_one_targeted_file`, or `explore_with_caution`.

## Deterministic mapping

1. Compute a confidence score from required evidence coverage, required semantic coverage, and relationship coverage.
2. Convert that score into `pack_confidence`:
   - `confidence >= 0.85` -> `high`
   - `confidence >= 0.50` and `< 0.85` -> `medium`
   - `confidence < 0.50` -> `low`
3. Convert retrieval coverage into `coverage`:
   - no missing required evidence and no missing required semantic categories -> `complete coverage`
   - coverage exists but some required evidence or semantic categories are missing -> `partial coverage`
   - no coverage signal is available -> `unknown coverage`
4. Derive `agent_directive` from those two bands:
   - `high` + `complete` -> `answer_from_pack`
   - `high` or `medium` with known (`complete` or `partial`) coverage -> `verify_one_targeted_file`
   - any `low` confidence or `unknown` coverage -> `explore_with_caution`

## Agent meaning

- `answer_from_pack` — answer from the pack snippets; at most one targeted verification read.
- `verify_one_targeted_file` — answer from the pack and verify with at most one specific supporting file.
- `explore_with_caution` — the pack is partial; at most one targeted `Glob` or `Grep` scoped to a single directory before answering.
