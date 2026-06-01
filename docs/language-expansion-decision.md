# Language expansion decision

**Recommendation: defer.** Broader language expansion should wait until **TypeScript/Node proof** is stronger and the current Python/Go first-pass support is backed by clearer benchmark or fixture evidence.

## Why defer

Python and Go already have useful first-pass support, but broad parity across more languages is expensive. The near-term roadmap still gets more leverage from **TypeScript/Node framework depth** than from starting new language tracks early.

## Evidence gates

Do not expand the main roadmap for broader language support until these **evidence gates** are met:

1. stronger **TypeScript/Node proof** through more public benchmark rows and shipped framework-depth improvements;
2. concrete **benchmark or fixture evidence** that the existing Python/Go first-pass support answers real user questions reliably;
3. repeated user demand for a specific language gap, not just general requests for “more languages”;
4. a clear maintenance story for fixtures, docs, and regression coverage after the feature lands.

## Decision buckets

### Near-term

- Keep investing in **TypeScript/Node framework depth**.
- Allow conservative fixes or depth improvements for **Python** and **Go** when they are source-visible, fixture-backed, and tied to a real retrieval/workflow question.

### Parked

- Broader **Python** or **Go** framework parity beyond the current first-pass semantics.
- New semantic expansion tracks for **Rust** or **Java**.
- Any roadmap move that would spread maintainer time away from current TypeScript/Node proof work before the evidence gates are met.

### Out of scope

- **Claiming broad parity** across Python, Go, Rust, Java, and TypeScript **without supporting receipts**.
- Starting language work only because a parser exists.
- Treating tree-sitter coverage alone as proof of workflow readiness.

## What this means publicly

- Make **no broad parity claim** until the relevant receipts exist.
- Keep public copy explicit that Python and Go are useful first-pass support, not broad parity.
- Keep Java and Rust framed as extractor coverage, not a near-term product commitment.
- Revisit language expansion only after the evidence gates are satisfied.
