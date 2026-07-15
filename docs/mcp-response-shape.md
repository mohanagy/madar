# MCP response shape

Madar responses that guide agent exploration include an additive top-level `evidence` block. The authoritative decision is `answerability.state`; `pack_confidence` and `agent_directive` remain compatibility projections for older consumers.

```jsonc
{
  "evidence": {
    "pack_confidence": "medium",
    "evidence_strength": {
      "level": "strong",
      "direct_selected_nodes": 3,
      "supporting_selected_nodes": 1,
      "selected_relationships": 2,
      "available_relationships": 3,
      "reasons": ["direct_evidence_with_relationship_support"]
    },
    "coverage": "partial",
    "coverage_detail": {
      "status": "partial",
      "required_obligations": ["evidence:primary", "evidence:structural"],
      "covered_obligations": ["evidence:primary"],
      "missing_obligations": ["evidence:structural"]
    },
    "answerability": {
      "state": "verify_targets",
      "answer_scope": "partial",
      "caveats": [],
      "missing_obligations": ["evidence:structural"],
      "verification_targets": [
        {
          "handle_id": "expand:explain:structural:auth",
          "evidence_class": "structural",
          "focus_files": ["src/auth/module.ts"],
          "focus_ranges": [],
          "reason": "verify missing evidence:structural"
        }
      ],
      "broad_search_fallback": "targeted_only"
    },
    "recovery": {
      "version": 1,
      "status": "partial",
      "budget": {
        "max_attempts": 2,
        "max_candidate_nodes": 64,
        "max_elapsed_ms": 750,
        "output_token_budget": 1200
      },
      "initial_state": "insufficient",
      "final_state": "verify_targets",
      "attempts": [],
      "improved": true
    },
    "missing_phases": [],
    "covered_workflow_owners": ["src/auth/service.ts"],
    "agent_directive": "verify_one_targeted_file"
  }
}
```

## Independent dimensions

- `evidence_strength` describes direct support, not answer completeness. `strong` requires direct selected evidence plus relationship or runtime-spine support; `moderate` has selected evidence without complete relationship support; `weak` has no usable selected evidence or a reliability cap.
- `coverage_detail` lists stable obligations. These can include `evidence:<class>`, `semantic:<category>`, `phase:<phase>`, `runtime:answer_containedness`, `discovery:<reason>`, and `indexing:<reason>`.
- `answerability` converts those independent facts into an agent action. It is not derived by lowering a score threshold.

The four answerability states mean:

- `ready`: answer from the pack.
- `ready_with_caveat`: answer from the pack and state `answerability.caveats`; no broad search is needed.
- `verify_targets`: continue from the pack and inspect only the listed expansion handle, file, or range.
- `insufficient`: the pack cannot support an answer. Follow `broad_search_fallback` exactly; only `allowed` permits one directory-scoped raw search, while `blocked` forbids source probing.

## Cumulative recovery

Incomplete explain retrieval runs at most two deterministic recovery attempts. Every pass keeps the originally selected node IDs, adds candidates from the current exact verification target, deduplicates candidates by node ID, and reruns the normal scorer and token-budgeted pack compiler over the cumulative set.

The default recovery budget is two attempts, 64 newly added expansion candidates (the retained original nodes do not consume that allowance), 750 ms measured between synchronous passes, and the request's output-token budget. A pass whose compiled result exceeds the output-token budget is rejected. A pass is otherwise accepted only when it improves answerability, reduces missing obligations, strengthens evidence at the same coverage, or adds selected relationship support. A higher numeric score alone cannot promote the result, and original selections keep priority over recovery candidates.

`recovery.status` reports `not_needed`, `improved`, `partial`, `exhausted`, `no_targets`, or `budget_exhausted`. Attempt records contain aggregate counts and timings. Prompts and source content are never included in recovery telemetry.

## Compatibility fields

- `pack_confidence`: `high` only for `ready` with strong evidence, `medium` for `ready_with_caveat` or `verify_targets`, and `low` for `insufficient` or a hard source-reliability failure.
- `coverage`: compact `complete`, `partial`, or `unknown` projection of `coverage_detail.status`.
- `agent_directive`: legacy projection: `answer_from_pack`, `verify_one_targeted_file`, or `explore_with_caution`.

New consumers must use `answerability.state` and exact `verification_targets`. They should not restart broad repository search because `pack_confidence` is `medium`, and they should not discard useful original evidence after a recovery attempt.
