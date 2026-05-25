# 2026-05-25 — FounderCommandCenter auth-flow contrast note

This note captures two real auth-flow compare outcomes from FounderCommandCenter:

- **Good run:** non-SPI graph, baseline **19 turns** → madar **4 turns**
- **Bad run:** earlier SPI graph, baseline **2 turns** → madar **19 turns**

The point is not to publish a flashy benchmark headline. The point is to document that Madar can still fail the product promise when the agent treats the pack as extra context and keeps exploring anyway.

## Why keep both runs

The good run showed the intended behavior: one context pack became the starting authority, follow-up exploration stayed narrow, and the answer completed with fewer turns.

The bad run showed the opposite failure mode: Madar added context, but the agent continued broad exploration and burned more turns than the baseline. That regression made it clear that **pack quality alone was not enough**. The install/profile guidance also had to push the agent toward a strict context-pack-first flow.

## What changed after the contrast

The fix direction for issue #314 is:

1. Tell installed agents to answer after one high- or medium-confidence pack instead of treating the pack as optional extra context.
2. Tell agents to expand only when `missing_context` / `missing_semantic` or diagnostics explicitly justify it, or when the user asks for deeper verification.
3. Record in compare/trace artifacts whether Madar **reduced exploration** or **only added context**.

That is why the current issue focuses on strict context-pack-first guidance and trace classification, not only on retrieval quality.

## Validation commands

```bash
npm run typecheck
npm run build
CI=1 npm run test:run
madar pack "How auth flow is working?" --task explain --why
madar compare "How auth flow is working?" --baseline-mode native_agent
```

Manual validation:

- install the strict Claude/Copilot/Cursor/Codex profile
- run the simple explain prompt
- confirm the agent uses one pack first
- confirm any extra exploration is explicitly justified and stays targeted

## Safe interpretation

The contrast shows a workflow problem, not a universal benchmark claim. This does not prove universal token reduction. One good run and one bad run are enough to justify stricter guidance and better trace reporting, but they do **not** prove universal token reduction.

## Unsafe claims

- "Madar always reduces turns on auth-flow prompts"
- "SPI is always worse"
- "Once a pack exists, verification is never needed"
- "A context pack automatically prevents broad exploration"
