# Hidden holdout policy

Contract version `1.0.0`, frozen 2026-08-12 for [#655](https://github.com/mohanagy/madar/issues/655).

## Why holdouts exist here

Everything in [`corpus.json`](./corpus.json) with `holdout_class: "open"` is visible to
whoever writes production retrieval and ranking rules. Open targets are still useful —
they catch regressions — but they cannot detect the failure mode this policy exists for:
production behaviour drifting toward the qualification corpus itself. Only a target the
rule author has never seen can measure that.

Naturalness and hiddenness are separate properties and neither substitutes for the other.
Every open target in this corpus is a real externally authored repository, which removes
the risk that the target was shaped around its own answer. It does not remove the risk that
production rules are shaped around the target once it is known.

## Classes

| Class | Meaning |
| --- | --- |
| `open` | Target, prompts, and truth live in this repository. Anyone may read them. Useful for regression detection; **worthless** as evidence of generalization. |
| `sealed` | Target, prompts, and truth are authored and held by someone who does not write production retrieval, ranking, or claim logic. The rule author never reads them before the sweep. |

## Rules for a sealed holdout

1. The target, the prompts, and the truth are authored by a person who has not written and
   will not write production retrieval, ranking, or claim logic during the evaluation window.
2. They live outside this repository. Nothing about them — no repository name, no path, no
   symbol, no prompt wording — is committed here, discussed in an issue, or pasted into a
   pull request.
3. The rule author receives the sweep result only: per-cell pass/fail and the scored
   dimensions. Never the answers, never the prompts, never the truth.
4. A sealed target is used at most **once per release line**. After a result is reported
   against it, it is burned: it becomes an open target or it is retired. Reusing a sealed
   target after its result is known makes it open in everything but name.
5. If a sealed cell fails, the holder may release the failing task to the rule author for
   diagnosis. That releases the target permanently.
6. The runner supports this today without new code: pass alternate manifests that live
   outside the checkout. The existing
   [`docs/benchmarks/suite/holdouts/README.md`](../benchmarks/suite/holdouts/README.md)
   documents the equivalent mechanism for the product benchmark suite.

## Current status: unsatisfied

**Madar has one author.** There is no second person to author or hold a sealed target, and
no meaningful sense in which a target can be hidden from the person who writes both the
production rules and the corpus. The `sealed-holdout-a` slot in `corpus.json` is therefore
marked `status: "unsatisfied"` rather than being filled with a self-selected target that
would look like a holdout and prove nothing.

The same limitation makes two other artifacts unavailable:

- the hidden acceptance test for `plan-unstorage-add-driver`
  (see `truth/plan-unstorage-add-driver.json`);
- blinded Tier 2 review (see `rubrics.json#/blinding/current_status`).

### Human action required

To satisfy this policy, a person other than the production-rule author must:

1. select and pin one real, permissively licensed TypeScript/Node repository not named
   anywhere in this repository;
2. author two to four task prompts and their independent truth for it, without reading
   Madar output;
3. author the hidden acceptance test for the bounded-implementation task;
4. hold all of it outside this repository and run the sweep themselves, returning only
   per-cell scores;
5. record their name and the seal date in the sweep receipt.

Until that happens, **no generalization claim may be made from this corpus**, and any
report derived from it must carry this exact line:

> sealed holdout unsatisfied; results measure regression only

## What must never happen

- A sealed target, prompt, path, or symbol must never appear in production retrieval,
  ranking, claim, or configuration code.
- A sealed target must never be added to the repository's test fixtures.
- A sealed slot must never be filled with a self-authored fixture workspace. That would
  satisfy neither naturalness nor hiddenness while appearing to satisfy both.
- A failing sealed cell must never be resolved by editing the sealed truth.
- The rule author must never request the sealed prompts "just to check whether they are
  fair". Fairness disputes are resolved by the holder retiring the task, not by disclosure.
