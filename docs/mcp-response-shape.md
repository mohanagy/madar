# MCP response shape

`retrieve` returns one deterministic JSON envelope:

```json
{
  "schema": "madar.retrieve",
  "version": 1,
  "outcome": "evidence",
  "matched_nodes": [],
  "relationships": [],
  "boundaries": [],
  "metrics": {
    "selected_files": 0,
    "snippets": 0,
    "closure_passes": 0,
    "serialized_tokens": 0,
    "truncated": false
  }
}
```

## `matched_nodes`

Each evidence node contains:

- `node_id`
- `label`
- `node_kind`
- `source_file`
- `source_location`
- `line_number`
- `end_line_number`
- `source_domain`
- non-empty `provenance`
- canonical file `content_hash`
- an exact `snippet` when authenticated

Madar reads the local file, verifies its SHA-256 hash against the canonical graph, then extracts the exact graph-owned line range. It does not truncate or rewrite a returned snippet.

## `relationships`

Each relationship contains its graph edge id, source and target node ids, relation type, non-empty provenance, and source location when available.

Only relationships whose endpoints survive evidence authentication and output slicing are returned.

## `boundaries`

Boundary kinds:

- `missing`
- `disconnected`
- `unsupported`
- `stale`
- `unavailable`
- `corrupt`
- `truncated`

Every boundary names a subject and can include a detail. Boundaries can accompany a useful evidence result.

## `outcome`

`outcome` is `evidence` whenever at least one authenticated node survives. Otherwise it is the highest-priority terminal source state: `corrupt`, `unavailable`, `stale`, `unsupported`, or `missing`.

## Bounds

- at most 12 source files
- at most 25 snippets
- zero or one directional closure pass
- at most 4,000 serialized `cl100k_base` tokens

The optional requested budget must be a positive integer. Its effective value is clamped between 256 and 4,000 tokens.
