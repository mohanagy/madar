# Duplicated artifact validation — measured evidence, deferred to #706

CodeRabbit finding `3799113098`: `canonicalIsValid` reads and parses the whole
artifact on every classification, and callers classify repeatedly.

**The finding is real. It is deferred to #706 rather than fixed in #705.**

## Measurement

Full `JSON.parse` calls of the artifact payload, per operation, on a generated
workspace:

| Operation | Full parses |
|---|---:|
| `classifyWorkspaceGraph` | 1 |
| `loadGraph`, canonical requested | 2 |
| `loadGraph`, tombstone requested | 3 |
| `readGraphArtifactMetadata` | 2 |

The HTTP routes classify inside the request handler and then read the artifact
again to send it, so a `/graph.madar` request pays classification plus the send.

## Why it is not fixed here

It is a cost, not a correctness defect. The inconsistency that duplicated reads
*did* cause — metadata and freshness describing a different artifact than the
loader returned — was a separate finding and is fixed in this PR, with a
per-state agreement table. What remains is repeated work that produces the same
answer every time.

The suggested remedy, a process-global cache keyed on `mtimeMs + size`, is not
safe here. Same-size replacement, coarse filesystem timestamp resolution,
restored mtimes and network filesystems all defeat that key, and the failure
mode is serving a stale graph — the same class of defect as the MCP cache bug
fixed in this PR, reintroduced one layer down.

The safe designs all cross an operation boundary: a parsed and validated
artifact record threaded from selection into the loader, so the work happens
once per operation instead of once per caller. That is a change to the load
path's shape, which is exactly what **#706** owns.

Full validation must not be weakened to a header check to avoid the parse.
Corruption detection is the reason the classifier parses at all.

## Relationship to the accepted exception

The accepted default-load band already includes this cost; it was measured with
this duplication present. Removing it should improve the ratio, which is #706's
opportunity rather than a #705 obligation.
