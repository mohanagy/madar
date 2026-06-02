# Design partners

Use this program when you want to turn one real Madar evaluation into a public, reproducible, share-safe receipt.

The goal is not to publish polished marketing. The goal is to capture what happened on one bounded repo/task cell, including cases where Madar was better, neutral, or worse.

## Share-safe boundary

- Do not include source paths.
- Do not include source code.
- Do not include secrets, internal project names, customer names, or full prompts copied from private repos.
- Do include coarse repo metadata such as repo size bucket, framework, agent runtime, task type, redacted command shapes, outcome, and caveats.
- Prefer links to `report.share-safe.json`, `madar handoff`, or short markdown notes over raw artifacts that expose local paths or source.

## Workflow

1. Pick one real repo and one bounded task (`explain`, `review`, `impact`, or a tightly scoped implementation check).
2. Capture the baseline first without Madar. Record the command shape, runtime, and the small set of metrics or observations you care about.
3. Run the same task with Madar using the documented setup for that agent/runtime.
4. Classify the result as `better`, `neutral`, or `worse`, then write down the caveats instead of smoothing them away.
5. Publish a share-safe receipt through the design-partner report issue template and update the tracker below.
6. If the receipt exposed a product gap, open a follow-up issue with the `design-partner` label plus the right existing issue-shape label such as `type:product`, `type:docs`, or `type:benchmark`.

At least one of the first ten tracked receipts should be `neutral` or `worse` if that is what the evidence says. The point is to learn from real workflows, not to publish success-only notes.

## Receipt template

Every public receipt should capture the same bounded fields:

```text
repo_size_bucket: 500-999 files
framework: NestJS + Prisma
agent: Claude Code
task_type: explain-runtime
baseline_commands:
  - claude "how does password reset enqueue the email job"
madar_commands:
  - madar generate . --spi --no-html
  - madar pack "how does password reset enqueue the email job" --task explain
result:
  outcome: better
  metrics_or_observations:
    - tool calls: 18 -> 6
    - wrong-file-edit risk: lower
caveats:
  - baseline already had cached context from earlier manual exploration
follow_up_issues:
  - #000
```

Use redacted or representative command shapes whenever the real command would reveal source paths or private prompt text.

## Public tracker

Track the first ten target receipts in this table. Keep the target rows stable and update `status`, `receipt issue`, and `follow-up issues` as evidence comes in.

| Slot | Repo size bucket | Framework / repo shape | Agent | Task type | Status | Receipt issue | Follow-up issues |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DP-01 | 500-999 files | NestJS service | Claude Code | explain-runtime | targeted | TBD | TBD |
| DP-02 | 500-999 files | Express API | GitHub Copilot CLI | review-diff | targeted | TBD | TBD |
| DP-03 | 1000-4999 files | Next.js app router | Cursor | explain-runtime | targeted | TBD | TBD |
| DP-04 | 1000-4999 files | Monorepo service + web | Codex CLI | impact-change | targeted | TBD | TBD |
| DP-05 | 5000+ files | Enterprise TypeScript monorepo | Claude Code | review-diff | targeted | TBD | TBD |
| DP-06 | 500-999 files | Prisma backend | Aider | explain-runtime | targeted | TBD | TBD |
| DP-07 | 100-499 files | Worker / queue service | OpenCode | impact-change | targeted | TBD | TBD |
| DP-08 | 1000-4999 files | Next.js + API routes | Gemini CLI | implement-check | targeted | TBD | TBD |
| DP-09 | 500-999 files | tRPC app | Cursor | explain-runtime | targeted | TBD | TBD |
| DP-10 | 500-999 files | Shared package workspace | GitHub Copilot CLI | review-diff | targeted | TBD | TBD |

## Turning receipts into follow-up issues

Use the receipt issue as the evidence anchor, then open a focused follow-up when the result points at a real product gap.

- Keep one follow-up issue per product gap.
- Add the `design-partner` label to every follow-up that came from a receipt.
- Pair it with the right existing issue-shape label such as `type:product`, `type:docs`, or `type:benchmark`.
- Link the follow-up issue back to the receipt issue and copy only the share-safe summary, not raw prompts or source.
- Keep failure cases visible. A `worse` outcome that produces a precise follow-up is more valuable than an over-smoothed `better` note.

## Related docs

- [Proof workflows](https://github.com/mohanagy/madar/blob/main/docs/proof-workflows.md)
- [Claims and evidence map](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md)
- [Getting started](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md)
