# Graph PR B1 — artifact v2 performance receipt

Paired base-versus-candidate generation and load measurement for #657 (Graph PR B1).

**Verdict: two formal gates exceed 2.00× and require a human decision.**

## Purpose

Establish whether the semantic multigraph and artifact v2 stay within the approved
2× steady-state envelope for generation wall time, peak RSS, load latency, and
canonical artifact size.

## Identities

| Item | Value |
|---|---|
| Base binary | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Candidate binary | `c11ea269dd29d5fb12c0ba402b0d6991610e1b6c` |
| Pinned input (all six roots) | `ee2115a2465c86306735494f526dca8baf0383bc` |
| Node / npm | v22.22.3 / 12.0.2 |
| Lockfile SHA-256 | `0144eb0ddf92f78c69f10089d0e0414485594966ff5be4f36f655c7aa5cff53e` |
| Harness SHA-256 | `7e8f51cad68183674698b747aa971a0a859b79005eadccb4d1bcafcf5284fdc4` |
| Path resolver SHA-256 | `bb54880aa80184903d3bc0b8e186eac80bdcb70a5ce4fc8a6f37d9c7096d0cff` |
| Command | `node <binary>/dist/src/cli/bin.js generate <input> --no-html` |
| Run order | `a1 → b1 → b2 → a2 → a3 → b3` (counterbalanced, pre-registered) |

Each of the six runs used its own pinned input worktree, so each resolved to a
distinct scoped output directory. Output and cache paths were resolved by calling
the **tested binary's own** `resolveMadarWorkspace`, never by globbing.

## Raw runs

| Run | Arm | Wall (s) | Peak RSS (MB) | graph.madar (MB) | v1 mirror (MB) | Output dir (MB) |
|---|---|---:|---:|---:|---:|---:|
| a1 | base | 35.82 | 1002.4 | — | 20.78 | 33 |
| b1 | candidate | 77.69 | 1369.3 | 39.35 | 20.85 | 72 |
| b2 | candidate | 78.32 | 1448.7 | 39.35 | 20.85 | 72 |
| a2 | base | 37.42 | 1358.8 | — | 20.78 | 33 |
| a3 | base | 36.43 | 1375.6 | — | 20.78 | 33 |
| b3 | candidate | 76.90 | 1391.3 | 39.35 | 20.85 | 72 |

## Formal gates

| Metric | Base median | Candidate median | Ratio | Verdict |
|---|---:|---:|---:|---|
| Generation wall (s) | 36.43 | 77.69 | **2.133×** | **exceeds 2.00× — human decision** |
| Peak RSS (MB) | 1358.80 | 1391.30 | 1.024× | pass |
| Load latency (ms) | 313.10 | 1622.94 | **5.183×** | **exceeds 2.00× — human decision** |
| Canonical artifact (MB) | 20.78 | 39.35 | 1.894× | pass (just below the 1.90× near-threshold band) |

Within-arm variability: wall 4.4% base / 1.8% candidate; load 9.3% / 6.3%;
artifact 0.0% / 0.0%. Peak RSS base range is 27.5%, driven by a1 at 1002 MB
against 1359 and 1376 MB — RSS still passes by a wide margin, so no additional
pair was run for it. The §14 additional-pair trigger is scoped to wall time,
which is well inside 15%.

## Disclosure — transitional total footprint

| Metric | Base | Candidate | Ratio |
|---|---:|---:|---:|
| Total output directory (MB) | 33 | 72 | 2.182× |

This is **not** a formal gate. B1 deliberately writes both `graph.madar` and a
fresh v1 `graph.json` mirror; the mirror is temporary and #705 removes it. It is
reported here rather than folded into the canonical artifact figure.

## Load-latency decomposition

Process-isolated, five samples per arm after one unrecorded warm-up, alternating.
This measures parser and loader latency; it does not control the OS page cache
and is not a cold-disk figure.

| Phase | ms |
|---|---:|
| Read bytes | 4.6 |
| UTF-8 decode | 29.7 |
| Parse + validate | 152.3 |
| **Graph rebuild** | **1388.7** |
| Full load | 1541.0 |

**Parsing v2 is not the problem.** Parse-and-validate costs 152 ms against a base
whose *entire* load is 313 ms. Ninety percent of the candidate cost is graph
rebuild: re-deriving `SemanticFactId` for all 17,940 facts and re-verifying the
receipt by rebuilding it in full and comparing.

## Semantic stability

Identical within each arm across all three runs.

| Arm | Nodes | Relationships | Occurrences | Unresolved admissions | Matrix sum | Communities |
|---|---:|---:|---:|---:|---:|---:|
| base | 12562 | 17835 links | — | — | — | 5615 |
| candidate | 12562 | 17940 facts | 17964 | 0 | 17940 | 5609 |

The candidate retains **105 more relationships** than the base on the same input.
That is the multigraph preserving facts the collapsed model discarded, and it is
part of why the candidate does more work.

## Attribution controls

All six runs passed:

- no base run produced a `graph.madar` (the failure that invalidated the earlier attempts);
- every candidate run produced `graph.madar`, a v1 mirror, and a sidecar;
- every counted file's mtime fell inside its run window;
- all six output directories and cache scopes were distinct;
- SPI cache reported `reason=no-cache` on each run;
- input worktrees remained source-clean.

## Invalidated earlier attempts

Archived, excluded from every median, and never averaged with accepted runs:

| Attempt | Reported | Invalidation reason |
|---|---|---|
| old-A1 | 27.97 s / 921.5 MB / madar 36.51 MB | harness globbed the wrong scoped output directory; a base run cannot produce `graph.madar` |
| old-B1 | 76.46 s / 1359.0 MB | same wrong-directory attribution |
| old-B2 | (partial) | same harness defect |
| old-A1 (first sweep) | 42.60 s | warm SPI cache |
| old-A1 (second sweep) | 24.28 s | warm SPI cache (24 s versus ~90 s cold) |

The preliminary 1.96× canonical-artifact figure came from comparing the candidate
artifact against the **candidate's own mirror**. The correct base comparison gives
1.894×.

## Historical references

Context only, not part of the gate: 403.34 s wall, 841.5 MB RSS, 20.30 MB artifact.
The measured base artifact of 20.78 MB is consistent. The measured base wall of
36.43 s differs sharply from 403.34 s; that reference was taken under different
host and corpus conditions and is not comparable.

## Limitations

- Single host, single OS, single Node version.
- Load latency is process-isolated parser latency, not cold-disk I/O.
- Peak RSS is `/usr/bin/time -l` maximum resident set size in bytes.
- The base arm has no v2 artifact to load, so the load comparison is v1-loader
  against v2-loader by construction, not the same code path on two inputs.
