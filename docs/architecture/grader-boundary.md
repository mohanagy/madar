# Grader / runtime structural boundary

Normal Madar product paths must not import, read, receive, or **transitively
reach** qualification grader truth.

Grader truth is [`docs/benchmarks/suite/runtime-proof.json`](../benchmarks/suite/runtime-proof.json) —
the per-row expected files, symbols and obligations used to grade a benchmark
answer — together with the production module that loads and interprets it.

## What was wrong

Before #660-A the separation was a **call-graph** property, not a structural one.

`buildMadarPromptPack` — the single builder behind normal `madar prompt`, the MCP
`context_prompt` tool, and the compare/benchmark arms — lived inside
`src/infrastructure/compare.ts`, which imports the runtime-proof loader. So the
grader loader sat in the TypeScript module graph of every normal MCP and CLI
prompt path:

```
src/runtime/stdio/tools.ts               -> src/infrastructure/compare.ts -> src/infrastructure/benchmark/runtime-proof.ts
src/runtime/stdio-server.ts              -> src/runtime/stdio/tools.ts    -> …
src/infrastructure/context-prompt-command.ts -> src/infrastructure/compare.ts -> …
```

No normal call reached the loader, but nothing structural stopped one from doing
so, and no test, lint rule or CI check would have noticed if one had. That gap
was recorded verbatim in
[`docs/qualification/evidence-categories.md`](../qualification/evidence-categories.md)
as an *"Open enforcement gap in E3"*.

## What #660-A changed

`buildMadarPromptPack` and the instruction helpers it needs moved to
[`src/infrastructure/prompt-pack.ts`](../../src/infrastructure/prompt-pack.ts), a
neutral owner that imports nothing from the benchmark or grader layers. The
dependency now runs one way only:

```
compare.ts ─────► prompt-pack.ts        (allowed)
prompt-pack.ts ──► compare.ts           (impossible: prompt-pack.ts is a normal product root)
```

`stdio/tools.ts` and `context-prompt-command.ts` import the neutral owner
directly, so none of them carries a grader module any more. `compare.ts`
re-exports the builder, so its established importers are unchanged.

This is a **dependency-boundary change, not a product-output change.**
`tests/unit/prompt-pack-parity.test.ts` compares prompt-pack output byte-for-byte
against a golden captured at the pre-change commit, across the normal, MCP,
compare, optional-field and narrow-budget shapes.

## How it is enforced

[`scripts/lib/grader-boundary.mjs`](../../scripts/lib/grader-boundary.mjs) builds
the **runtime** module graph of `src/**` from the TypeScript compiler's own
module resolution, then works **outward from the grader module**:

1. derive the seed — whichever `src/**` module names the grader data file;
2. compute every production ancestor that can transitively reach it;
3. permit only the exact, justified allowlist in
   [`grader-boundary.json`](./grader-boundary.json);
4. reject every other `src/**` ancestor.

Working outward avoids having to enumerate every normal CLI and MCP root, and it
cannot be defeated by a rename, an intermediate helper, or a re-export.

Two rules apply, and the second is the one that matters over time:

- **allowlist** — every grader ancestor must be an exact, justified entry;
- **denylist** — no module under a `normal_product_roots` prefix may be a grader
  ancestor **regardless of the allowlist**. The guard refuses such an entry
  outright, so a future violation inside product construction can only be fixed
  by cutting the dependency, never by widening the exception list.

`import type` is erased under `verbatimModuleSyntax` and is correctly *not* a
runtime edge. Dynamic `import()` and `require()` *are* edges — a lazily loaded
grader module is still reachable. "Literal specifier" means every statically
known form, not just a quoted string: a backtick specifier with no substitutions
parses as a `NoSubstitutionTemplateLiteral`, which `ts.isStringLiteral` rejects,
so ``import(`./benchmark/runtime-proof.js`)`` would otherwise have been a real
runtime edge the graph never saw. Parentheses and `as const` are unwrapped for
the same reason. Control **G7** injects exactly that shape.

A **computed** specifier — `import(someVariable)` — cannot be resolved at all,
so the edge it creates is invisible here. Rather than quietly ignore that, every
computed dynamic import surviving in `src/**` must be an explicit justified entry
in `allowed_computed_dynamic_imports`; an unlisted one fails the guard. Today
there are two, both in `src/runtime/semantic.ts`, loading the optional
`@huggingface/transformers` package and its project-local fallback — both resolve
outside `src/**`. Control **G8** proves a new one is refused.

The compiler graph cannot represent a direct `readFileSync` of the grader JSON,
so a secondary textual control reports any `src/**` literal naming that file. A
regex import scan is never the authority.

## Sequencing

`analyzeGraderSequencing` proves the ordering property inside the grader itself,
from the syntax tree rather than from a comment:

- every call that fixes the graded artifact on disk runs **before** the loader is
  consulted (7 such calls, all above the single load site);
- the loaded profile flows only into approved grading consumers
  (`matchBenchmarkRuntimeProofProfile`, `evaluateNativeAgentAnswerQualityReport`,
  `assessNativeAgentPromptContract`) and never back into an input arm.

## Running it

```bash
npm run verify:grader-boundary            # the boundary check
npm run verify:grader-boundary-controls   # boundary check + falsifiability injections
```

The boundary and sequencing controls also run as
`tests/unit/grader-boundary.test.ts`, so they execute on every protected CI lane.
The injections (`G1` direct import, `G2` transitive helper, `G3` re-export, `G6`
direct JSON read, `G7` backtick template specifier, `G8` computed specifier)
mutate real production files, so they run outside the vitest worker pool via the
`--self-test` flag, restore by verified byte snapshot, and never use
`git checkout`/`reset`/`clean`. Each one first asserts the injected edge is
actually present in the analyzed graph, so a no-op injection reports "the control
proves nothing" instead of passing.

## What this does and does not prove

**Proves:** no normal product construction module can reach qualification grader
truth through the TypeScript module graph; no `src/**` module outside the
approved set names the grader data file; expected evidence is consulted only
after the graded artifact is fixed.

**Does not prove:** full product generalization, Tier 1 completion, release
readiness, or the absence of qualification-repository knowledge in retrieval and
claims. Removing qualification literals and task-phrase tuning from production
retrieval, and the forbidden-knowledge manifest and scanner that enforce it, are
owned by **#660-B**.
