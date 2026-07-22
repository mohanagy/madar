# Conceptual-query retrieval

Madar starts with deterministic lexical and graph retrieval. A question can still be conceptually clear while using different words from the repository, or its strongest literal match can be an isolated helper instead of the workflow center. Madar handles that case with one bounded repository-local recovery pass.

## When recovery runs

The recovery planner is considered when the first pass has one or more of these conditions:

- no strong explicit anchor;
- low connectivity among selected workflow evidence;
- required evidence or semantic coverage is missing.

An explicit path or symbol anchor is authoritative and does not trigger conceptual recovery. A trigger also does not guarantee broader retrieval: the planner must find at least two grounded repository terms, or one node grounded by multiple terms. An unrelated query with no repository vocabulary remains empty instead of falling back to a global hub.

## Repository-local vocabulary

The deterministic fallback derives terms from the graph that was already built for the repository:

- source paths and module names;
- exported symbol labels;
- graph community labels;
- framework roles and metadata.

It also normalizes common change-lifecycle language—such as edit, update, freshness, reconciliation, refresh, synchronization, and watching—before matching those concepts against repository-local terms. This is a fixed domain-neutral language family, not a mapping to Madar files or symbols.

It does not contain prompt-specific filename or symbol mappings. The vocabulary index is cached for the loaded graph, query terms and candidates are capped, and path searches use bounded depth, visits, and branching. Incident-neighbor reads are capped before ordering, including at high-degree graph hubs.

The planner promotes short structural paths that connect different query evidence. When it finds a coherent alternative, it can demote isolated literal matches that would otherwise consume the context budget. It runs at most one deterministic retry and keeps the original result unless the retry improves the condition that triggered recovery without regressing overall quality.

Semantic embeddings and reranking remain optional. They can still be requested on the asynchronous retrieval path, but conceptual recovery does not require an embedding model or another dependency.

## Retrieval plan output

`retrieve` and context-pack responses include `retrieval_plan`:

- `status`: `not_needed`, `recovered`, `kept_initial`, or `no_candidates`;
- `reasons`: the bounded triggers that were observed, with required-evidence and semantic-evidence gaps reported separately;
- `initial` and `final`: selected-node/file counts, direct and explicit anchors, workflow coherence, missing evidence, and token use;
- `attempts`: the fallback, vocabulary sources, expansion terms, candidate count, and whether the delivered result changed;
- `selected_fallback`: present only when a fallback changed the delivered result.

Very tight answer-ready serialization budgets retain a summary containing the status, reasons, selected fallback, and changed-result flag. They may omit detailed metrics and expansion terms before dropping workflow evidence.

The plan reports aggregate file changes instead of duplicating absolute paths or source content. Selected repository-relative paths remain in the normal context-pack nodes.

## Regression evaluation

The self-hosted regression fixture covers graph generation, automatic refresh, confidence scoring, install profiles, and impact direction. Tests measure expected-file recall, answerability, selected-file precision, token-budget compliance, and retrieval latency, with unrelated-keyword variants as negative controls. A separate search-index workflow checks that change-lifecycle normalization is domain-neutral, and a high-degree hub fixture verifies that neighbor scans remain capped.
