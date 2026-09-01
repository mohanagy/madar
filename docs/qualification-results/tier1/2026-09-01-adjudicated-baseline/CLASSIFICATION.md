# Machine-adjudicated baseline v1 — superseded

**Status:** `superseded_relationship_predicate_unfaithful`
**Bytes:** preserved exactly as produced. Nothing in `run-a/` or `run-b/` is edited or
regenerated; this file is added alongside them.
**Result:** 0 pass / 8 fail / 0 invalid, semantic digest
`251824578ca4cb8daec7aba7435bde3a6d6842fdb6669f5f1b8b6e692c10c886`,
adjudication contract `9f88d294…` (version 1), at candidate `25b2b97f`.
**Superseded by:** [`../2026-09-01-relationship-baseline/`](../2026-09-01-relationship-baseline/)

## Why

This attempt introduced the machine-checkable adjudication contract and removed prose
adjudication entirely — corrections that are retained. Its **relationship predicate**,
however, was not faithful to the frozen clauses it claimed to decide. An independent review
found four defects; the maintainer then supplied the missing semantics exactly.

| Defect | Consequence |
| --- | --- |
| **relation kind ignored** | a `references` edge satisfied a clause that names a *call* |
| **direction ignored** | `compose → Hono.#dispatch` satisfied "the call **from** the dispatch entry point **into** compose" |
| **impact cardinality was any-one** | one constructor→SmartRouter edge satisfied a clause naming **three** router implementations |
| **relationship-level unresolved subjects not declared coherently** | the evaluator queried a synthetic `from->to` subject the contract never declared, so a relationship could never be declared unresolved even where the frozen clause permits it |

The relationship endpoints were also matched by label and symbol without resolving each edge
endpoint to a node record, so a same-named symbol in another file could satisfy a frozen
selector.

## What carried forward

Everything except the relationship predicate: the 17 one-to-one clause bindings with exact
clause hashes, typed absence semantics, the disjoint absence/unresolved vocabularies, the
270-channel evidence surface with its closure guard, symbol-extraction corrections, run
independence, and the absence of any prose heuristic.

## Comparability

Not comparable to the successor. The semantic digest covers the adjudication contract
identity, so a v1 result can never equal a v2 result even if every cell agreed. Its totals
happening to match proves nothing on its own.
