# Agent governance

Madar governance is intentionally small:

1. call `retrieve` once for a repository question, preserving the user's question
2. use only authenticated nodes, exact excerpts, and directed relationships as Madar evidence
3. state every returned evidence boundary
4. make focused source reads only where the result cannot carry the task
5. never convert a partial or unsupported path into a complete claim

The same rules apply to `madar query`, which is the CLI transport for the same retrieval contract.

Installed hooks and instruction files are guidance, not enforcement. A continuing conversation about existing evidence is not automatically a new repository question.

Share-safe reports must omit source content, source paths, repository identity, credentials, and local workstation paths.
