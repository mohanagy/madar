# Grader / runtime structural boundary

Normal Madar product-construction paths must not import, read, receive, or
**transitively reach** qualification grader truth.

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

```text
src/runtime/stdio/tools.ts                   -> src/infrastructure/compare.ts -> src/infrastructure/benchmark/runtime-proof.ts
src/runtime/stdio-server.ts                  -> src/runtime/stdio/tools.ts    -> ...
src/infrastructure/context-prompt-command.ts -> src/infrastructure/compare.ts -> ...
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

```text
compare.ts ------> prompt-pack.ts        (allowed)
prompt-pack.ts --> compare.ts            (impossible: prompt-pack.ts is a normal product root)
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
3. classify each ancestor, and permit only what
   [`grader-boundary.json`](./grader-boundary.json) exactly approves;
4. reject everything else.

Working outward avoids having to enumerate every normal CLI and MCP root, and it
cannot be defeated by a rename, an intermediate helper, or a re-export.

### Three exemption shapes, and no fourth

| Shape | Granularity | Reason code on failure |
|---|---|---|
| **Dedicated grader/benchmark module** | whole module | `GRADER_TRUTH_REACHABLE_FROM_NORMAL_PRODUCT` |
| **Mixed command router edge** | one edge: kind + specifier + destination + imported bindings | `UNAPPROVED_MIXED_ROUTER_GRADER_EDGE` |
| **Computed import** | one call site: path + kind + enclosing declaration + normalized expression | `COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED` |

**There is no file-wide exemption of any kind.** A whole-file allowance is
exactly the quiet widening this guard exists to prevent: one legitimate computed
import must not license arbitrary later ones in the same file, and a router that
must reach a command facade must not thereby be trusted to reach anything else.

### The anti-drift rule

No module under a `normal_product_roots` prefix may be a grader ancestor
**regardless of the allowlist**. The configuration validator refuses such an
entry outright, so a future violation inside product construction can only be
fixed by cutting the dependency, never by widening the exception list. A mixed
router may not be listed as a whole-module ancestor either.

A surplus allowance — an approved edge or call site that matches nothing in the
tree — is itself a failure. An unreviewed standing permission is not a smaller
problem than a missing one.

### What counts as an edge

`import type` is erased under `verbatimModuleSyntax` and is correctly *not* a
runtime edge. Dynamic `import()` and `require()` *are* edges — a lazily loaded
grader module is still reachable.

"Literal specifier" means every statically known form, not just a quoted string:
a backtick specifier with no substitutions parses as a
`NoSubstitutionTemplateLiteral`, which `ts.isStringLiteral` rejects, so a
template-literal import of the grader loader would otherwise have been a real
runtime edge the graph never saw. Parentheses and `as const` are unwrapped for
the same reason.

A **computed** specifier — `import(someVariable)` — cannot be resolved at all.
Each one must match an exact call-site allowance; changing an approved
expression breaks its fingerprint and fails until deliberately re-reviewed.
Today there are two, both in `src/runtime/semantic.ts`, loading the optional
`@huggingface/transformers` package and its project-local fallback — both
resolve outside `src/**`.

The compiler graph cannot represent a direct `readFileSync` of the grader JSON,
so a secondary textual control reports any `src/**` literal naming that file. A
regex import scan is never the authority.

## The mixed CLI process — what is and is not claimed

One `madar` binary hosts both ordinary product commands and the `compare`,
`benchmark` and `eval` grader commands, so `src/cli/main.ts` and
`src/cli/bin.ts` legitimately reach grader code.

**It would be false to claim that the madar CLI process has no transitive module
path to grader code, and that claim is not made here.** What is claimed:

- normal product-**construction** modules — retrieval, context compilation,
  prompt construction, MCP response building — have zero direct or transitive
  grader reachability;
- the shared CLI dispatcher carries only explicitly constrained edges to
  dedicated grader *command facades*, approved by kind, specifier, destination
  and imported bindings;
- it does not import the runtime-proof loader and does not name the grader data
  file — an edge straight into the loader is refused however it is justified;
- those routing edges do not pass grader truth into prompt or context
  construction, which is verified behaviourally rather than assumed (below);
- splitting the grader commands into a separate executable is **outside
  #660-A**.

The boundary protects **data flow and construction ownership**, not the physical
absence of grader module code from a mixed CLI process.

## Sequencing

`analyzeGraderSequencing` proves the ordering property inside the grader itself,
from the syntax tree rather than from a comment:

- every call that fixes the graded artifact on disk runs **before** the loader is
  consulted (7 such calls, all above the single load site);
- the loaded profile flows only into approved grading consumers
  (`matchBenchmarkRuntimeProofProfile`, `evaluateNativeAgentAnswerQualityReport`,
  `assessNativeAgentPromptContract`) and never back into an input arm.

## The runtime no-read proof

Because the CLI binary is mixed, the static guard alone cannot answer "does a
normal command read grader truth?" So that question is answered behaviourally.

[`scripts/lib/grader-boundary-runtime-proof.mjs`](../../scripts/lib/grader-boundary-runtime-proof.mjs)
snapshots the real grader data file, runs `madar prompt` and the MCP
`context_prompt` tool against truth, replaces the file with a schema-valid
profile carrying a sentinel, and re-runs both. It requires byte-identical output
and no sentinel anywhere in it, then restores the file and proves by digest and
mode that it went back.

Two preconditions stop the control being vacuous: the real grader loader must
**observe** the poison (otherwise "no sentinel appeared" is satisfied by a poison
nothing could read), and both arms must produce substantive prompt packs
(otherwise two identical failures would compare equal). Failures report
`GRADER_TRUTH_READ_DURING_NORMAL_PRODUCT_COMMAND`.

This is a focused control for the mixed router. It is **not** general dynamic
taint analysis.

## Running it

```bash
npm run verify:grader-boundary            # the static boundary check
npm run verify:grader-boundary-controls   # static check + falsifiability injections
npm run build
npm run verify:grader-boundary-runtime    # the behavioural no-read proof (needs dist/)
```

The static boundary and sequencing controls also run as
`tests/unit/grader-boundary.test.ts`, so they execute on every protected CI lane.

## Falsifiability

The injections mutate real production files, so they run outside the vitest
worker pool, restore by digest-verified byte snapshot of content **and** mode,
and never use `git checkout`/`reset`/`clean` — the worktree may legitimately
carry other uncommitted work.

Each control declares its own **premise**: the observable fact its injection was
supposed to create, checked before the verdict is read. Without it, a silently
no-op injection would look identical to a working control. The premise differs by
control type, and the three types verify different mechanisms:

- **graph-backed** controls (`G1`, `G2`, `G3`, `G7`, `G11`, `G12`, `G15`) assert
  a real compiler-resolved edge appeared in the module graph;
- **direct-read** controls (`G6`, `G16`) assert a textual data reference
  appeared, which the compiler graph cannot represent;
- **computed-import** controls (`G8`, `G9`, `G10`) assert the computed-site
  inventory changed, since those edges are invisible to the graph and are
  governed by the exact call-site allowance mechanism instead;
- **configuration** controls (`G18`, `G19`) assert the guard refused the
  configuration itself rather than the tree.

| Control | What it injects | Must be refused as |
|---|---|---|
| `G1` | direct grader import in a normal product module | `normal_product_root` |
| `G2` | transitive reach through a neutral helper | `normal_product_root`, chain names the helper |
| `G3` | grader truth behind an intermediate re-export | `normal_product_root`, chain names the re-export |
| `G4` | *(nothing)* legitimate dedicated ancestors | still accepted |
| `G6` | direct grader-data reference in product code | `direct_data_read_in_normal_product` |
| `G7` | backtick template specifier | `normal_product_root` |
| `G8` | a **third** computed import in an already-approved file | `computed_specifier_not_exactly_allowed` |
| `G9` | a changed expression at an approved computed site | `computed_specifier_not_exactly_allowed` |
| `G10` | a surplus computed allowance with no call site | `computed_allowance_unused` |
| `G11` | direct grader-loader import from the mixed router | `router_edge_into_grader_loader` |
| `G12` | a new transitive router edge via a helper | `router_edge_not_approved`, chain reported |
| `G13` | *(nothing)* the real compare/benchmark/eval edges | still accepted, matched one-for-one |
| `G14` | poisoned grader truth, normal commands run for real | output unchanged, no sentinel |
| `G15` | a widened binding set on an approved router edge | `router_edge_bindings_changed` |
| `G16` | grader-data reference in the mixed router | `direct_data_read_in_mixed_router` |
| `G17` | *(nothing)* computed sites vs allowances | matched one-for-one |
| `G18` | a file-wide computed allowance | `GRADER_BOUNDARY_CONFIG_INVALID` |
| `G19` | a whole-module allowance for a mixed router | `GRADER_BOUNDARY_CONFIG_INVALID` |
| `G0` | *(nothing)* post-injection state | tree restored, probes gone |

## What this does and does not prove

**Proves:** no normal product construction module can reach qualification grader
truth through the TypeScript module graph; the mixed CLI dispatcher carries only
exactly approved edges to grader command facades; every computed import is
approved at one exact call site; no `src/**` module outside the approved set
names the grader data file; expected evidence is consulted only after the graded
artifact is fixed; and normal product commands produce identical output when
grader truth is replaced by a poison the loader demonstrably observes.

**Does not prove:** that the madar CLI process contains no grader module code —
it legitimately does. Nor full product generalization, Tier 1 completion, or
release readiness. Removing qualification literals and task-phrase tuning from
production retrieval, and the forbidden-knowledge manifest and scanner that
enforce it, are owned by **#660-B**.
