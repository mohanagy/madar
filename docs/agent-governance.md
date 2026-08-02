# Agent governance

Madar governance is intentionally small:

1. call `retrieve` once for a repository question, preserving the user's question
2. use a `ready` dossier's obligations, flow, and authenticated evidence as Madar evidence
3. state every exact non-ready `missing`, `reason`, or `failure`
4. make focused source reads only for the named gap
5. never convert a non-ready result into a complete claim

The same rules apply to `madar query`, which is the CLI transport for the same retrieval contract.

Installed hooks and instruction files are guidance, not enforcement. A continuing conversation about existing evidence is not automatically a new repository question.

Share-safe reports must omit source content, source paths, repository identity, credentials, and local workstation paths.
