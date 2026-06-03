# Launch checklist

Use this checklist as the reusable template for any meaningful public release, benchmark milestone, or adoption push. Copy the proof block and channel tracker into the release PR, release notes draft, or other working notes for the specific launch. The rule is simple: **start from a receipt, not from category language**. If you cannot point to a dated artifact with proof and caveats, do not publish the post yet.

## Required proof block

Every external post, listing update, or launch draft should start with this block in working notes before you touch public copy:

- **Release or milestone**: the exact version, benchmark bundle, or proof artifact you are announcing.
- **Primary audience**: who this is for right now (for example, Claude/Cursor/Codex/Copilot users on medium-to-large TypeScript/Node repos).
- **Task type**: explain, implement, review, impact, install/onboarding, design-partner proof, or release/distribution.
- **What actually changed**: factual shipped surfaces only; no future-tense roadmap padding.
- **Proof links**: one primary dated receipt plus supporting links.
- **Caveats**: what the proof does **not** mean yet.
- **Local trust boundary**: whether the flow is local-first, share-safe, or otherwise bounded.
- **Next action**: the exact command, doc, or follow-up the reader should use next.

Minimum metadata before posting externally:

- GitHub tag / release note exists for release announcements.
- npm version, README links, and package metadata match the surface you are describing.
- `docs/claims-and-evidence.md` is updated if the post uses a new public claim.
- Any MCP Registry or directory listing change points to the same current local-first install flow.

## Channel tracker

Track every public surface explicitly. Do not rely on "we probably updated that already."

| Surface | Update required before posting | Proof link required | Caveats included | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| GitHub repo metadata | README, pinned links, social preview, and docs index reflect the current proof-first story | README + claims/evidence map | yes | pending | release owner |
| GitHub release notes / tag | release entry matches shipped version and links to proof artifacts | CHANGELOG + dated artifact | yes | pending | release owner |
| npm package metadata | version, description, keywords, and npm README links match the shipped surface | npm package page + README | yes | pending | release owner |
| MCP Registry | `docs/mcp-registry/server.json` and registry-facing docs point to the same local install path | registry metadata + install docs | yes | pending | release owner |
| Awesome MCP | listing text uses a concrete receipt instead of category hype | dated artifact + launch draft | yes | pending | adoption owner |
| Awesome agent tooling / directories | directory snippet matches shipped agents and install docs | compatibility matrix + quickstarts | yes | pending | adoption owner |
| Reddit | post starts with one measured receipt and one clear caveat | dated artifact + launch draft | yes | pending | adoption owner |
| Hacker News | only post when there is a technical write-up or strong benchmark-backed note | dated artifact + technical write-up | yes | pending | adoption owner |
| Lobsters | same bar as Hacker News: technical write-up first, not generic launch copy | dated artifact + technical write-up | yes | pending | adoption owner |
| demo video | terminal/demo recording shows the exact shipped flow and links back to proof docs | video outline + proof docs | yes | pending | adoption owner |
| blog post | before/after write-up ties story to measured receipts and limits | dated artifact + claims/evidence map | yes | pending | adoption owner |

## Benchmark-backed launch draft

Start from [#469](https://github.com/mohanagy/madar/issues/469), not from "new AI coding tool" messaging. The public benchmark suite bundle is:

- [`docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md`](./benchmarks/suite/results/2026-05-31T12-00-00/summary.md)
- [`docs/benchmarks/suite/README.md`](./benchmarks/suite/README.md)
- [`docs/claims-and-evidence.md`](./claims-and-evidence.md)

Suggested short launch post draft:

> If you use Claude/Cursor/Codex/Copilot on a medium-to-large TypeScript/Node repo, Madar now has a public multi-repo benchmark receipt instead of a one-off launch claim.
>
> In the current warm-cache suite bundle (#469), the published `ts-small`, `nestjs-mid`, and `ts-monorepo-large` rows cover `explain-runtime`, `implement`, `review`, and `impact`. On the explain rows, baseline input tokens drop from `530/570/610` to `360/400/440` with Madar, and to `320/360/400` on the SPI rows. On the implement rows, the SPI arm records `validation pass 3/3`, `wrong-file edits 0`, and `rework 0`, while the baseline rows still show `validation pass 2/3` plus rework / human intervention.
>
> Caveats: this is still a repo-specific TypeScript-heavy bundle, not a single-number cross-repo headline. Python and Go fixtures are wired for future receipts, but the latest published bundle still measures the three current TypeScript shapes.
>
> Receipts: `docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md`, `docs/benchmarks/suite/README.md`, and `docs/claims-and-evidence.md`.

## Guardrails for launch copy

- **Do not post generic "new open-source tool" messages.**
- Lead with the strongest dated receipt, not with the category.
- If the best proof is mixed, say that directly and link the caveat.
- Do not turn per-repo spread into a single blended headline.
- Do not imply hosted control-plane, cloud indexing, or broad language parity work that the repo does not prove today.
- If there is no concrete receipt for the claim, the launch surface is not ready yet.
