# Team and enterprise offer

Madar stays an open-source, local-first product. The near-term paid offer is service work around adoption and proof, **not a hosted control plane**.

## Who this is for

- **Team evaluation:** small teams that want a bounded setup for one repo, one agent runtime, and one repeatable question or review workflow before they standardize on Madar internally.
- **Enterprise pilot:** engineering leadership, platform, or security teams that need a local-first evaluation packet they can review with procurement and internal security before broader rollout.

## Offer options

### Team evaluation

- Shared benchmark setup on a representative repo and task.
- Local install/profile wiring for the selected agent runtime.
- A first compare/review workflow receipt plus follow-up notes on what Madar changed and what it did not.

### Enterprise pilot

- Everything in the team evaluation package.
- An **internal proof report** built from local graph, pack, compare, and review artifacts for engineering leadership.
- A local-only **procurement/security note** covering the local-first trust boundary, telemetry posture, artifact sharing limits, and operator responsibilities.

## What paid support includes

### In scope

- **Shared benchmark setup** for one or more agreed repo/task cells.
- Local workflow calibration for `pack`, `compare`, `review-compare`, `handoff`, and `proof-report`.
- An **internal proof report** that leadership can review without exposing workstation paths by leaning on share-safe receipts.
- Local-only **policy templates** and procurement/security notes that explain how to evaluate Madar inside the existing trust boundary.

### Out of scope

- **Managed cloud hosting** or a managed SaaS control plane.
- Taking custody of your source code, prompts, or model credentials.
- Running a remote review/security service on your behalf.
- Guaranteeing benchmark wins, security findings, or universal productivity gains beyond the measured receipts.

## Local-first trust boundary

The offer must preserve the same **local-first trust boundary** as the product:

- your code and graph artifacts stay local unless you explicitly choose to share a sanitized receipt;
- benchmark/proof work should prefer `report.share-safe.json` and local markdown reports over raw artifact uploads;
- procurement/security notes should describe the actual boundary, including that Madar is **not a hosted control plane** and does not remove the need for local least-privilege review.

## Recommended pilot outputs

For most teams, a complete pilot ends with:

1. one verified benchmark setup on a representative repo;
2. one internal proof report for engineering leadership;
3. one procurement/security note or policy template the buyer can hand to internal reviewers;
4. one explicit follow-up list of what remains unmeasured.
