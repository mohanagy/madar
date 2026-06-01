# Impact-change workflow draft

## Partner shape

An anonymized maintainer wants to understand the likely **blast radius** before changing an auth boundary or shared runtime primitive.

## Workflow

1. Generate the graph locally.
2. Run `madar impact ...` or the equivalent compact impact prompt for the target symbol.
3. Turn the result into a short **change plan**: what files or communities look risky, what should be tested first, and what reviewer should be looped in.
4. Publish only the summarized outcome and the bounded receipt.

## What to publish

- The abstract change question.
- The predicted blast radius summary.
- The resulting change plan and validation focus.
- Any partner-approved note about whether the impact summary changed the rollout plan.

## What stays out

- Private file contents.
- Internal code names.
- Full raw prompts or answer transcripts.

## Safe interpretation

This loop shows how Madar can support impact planning on a real codebase, but it does not prove that every change plan will be perfect. The publishable evidence is the workflow note and the follow-up plan, not a universal promise.
