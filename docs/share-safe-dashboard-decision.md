# Share-safe dashboard decision

**Recommendation: defer.** Madar already has a strong local report bundle for proof review: `graph.html`, `GRAPH_REPORT.md`, and `report.share-safe.json`. A hosted dashboard may become useful later, but it should not outrun the current local-first proof surface or introduce a cloud indexing assumption.

## What exists today

- `graph.html` gives a purely local HTML report for graph exploration.
- `GRAPH_REPORT.md` gives a local narrative summary that can be read directly or served locally.
- `report.share-safe.json` gives a sanitized artifact for sharing benchmark or compare receipts without exposing workstation paths.

That means the current default path is already: generate locally, inspect the local HTML report, and share only the receipt layer when someone else needs evidence.

## Option comparison

### Current default: local HTML report + share-safe receipts

- Strongest trust boundary.
- No raw source leaves the workstation by default.
- Works today with existing generated artifacts.

### Build later: hosted dashboard for share-safe artifacts only

- Could help teams compare many runs, annotate receipts, or review trendlines across repeated proofs.
- Must stay **share-safe artifacts only**.
- Must keep **no raw source**, **no prompt or answer uploads**, and **no cloud indexing assumption**.

### Reject now: dashboard that depends on raw repo ingestion

- Breaks the local-first trust model.
- Adds security and procurement burden before demand is proven.
- Competes with the current product promise instead of extending it.

## Why defer instead of build now

1. The current local HTML report path already covers single-run review well enough for the near term.
2. The open gap is proof depth and repeated user demand, not UI chrome.
3. A hosted dashboard would need artifact lifecycle, auth, sharing, and policy work that the repo cannot yet justify with measured demand.

## Revisit only if demand becomes explicit

Re-open the build discussion only when there is **explicit customer demand** for reviewing many share-safe artifacts together and the local HTML report path is clearly insufficient.

Good revisit signals:

- repeated design-partner asks for cross-run artifact review or sharing;
- stable share-safe schemas that can be aggregated without weakening redaction assumptions;
- a clear buyer need that cannot be met by `graph.html`, `GRAPH_REPORT.md`, and `report.share-safe.json`.

## Decision boundary

- **Build later** only for a dashboard that consumes share-safe artifacts and keeps the current trust boundary intact.
- **Reject now** any dashboard plan that assumes raw-source upload, prompt/answer upload, or default cloud indexing.
