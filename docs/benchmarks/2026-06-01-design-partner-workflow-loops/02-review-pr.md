# Review-PR workflow draft

## Partner shape

An anonymized engineering team wants a second review surface for one pull request before human approval.

## Workflow

1. Generate the local graph for the repo.
2. Run `madar review-compare ... --yes` or capture the compact `pr_impact` payload for the diff.
3. Save the share-safe artifact bundle.
4. Compare that bounded diff evidence with another reviewer, then write down the **human follow-up** that was still required.

## What to publish

- The question the team asked of the diff.
- The saved **share-safe artifact** path or receipt reference.
- Which risks overlapped with the human review.
- Which follow-up still needed a person or another tool.

## What stays out

- Private diff contents.
- Full prompt/answer logs.
- Reviewer identities or customer names.

## Why this matters

This loop gives a reusable workflow note for review mode without pretending Madar replaces the reviewer. The publishable artifact is the workflow shape plus the follow-up summary, not the private code review itself.
