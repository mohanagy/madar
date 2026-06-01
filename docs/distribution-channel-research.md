# Distribution channel research

**Recommendation: prioritize the current shipped installer surfaces first.** Madar already reaches the highest-leverage agent ecosystems through local installers and home-skill installs. Additional distribution channels may matter later, but they should not outrun proof/onboarding readiness or weaken the local trust boundary.

## What exists today

- Claude Code, Cursor, GitHub Copilot CLI, and Gemini CLI already have first-party install flows for local MCP or paired home-skill guidance.
- Codex CLI, Aider, and OpenCode already have context-pack-first install flows tied to repo-local instructions, hooks, or plugin wiring.
- The compatibility guide already distinguishes dedicated project installs from home-skill installs and tells users how to verify each path.
- Public MCP Registry metadata already exists today for the local server package, but it is metadata that points back to the same local-first install and runtime flow.

That means Madar already covers the main “agent is running locally against a repo I trust” path without needing a new marketplace, hosted relay, or raw-source ingestion service.

## Channel ranking

### Near-term: deepen the shipped local install surfaces

- Claude Code
- Cursor
- GitHub Copilot CLI
- Gemini CLI
- Codex CLI
- Aider
- OpenCode

Why this stays near-term:

- Highest adoption leverage comes from channels the repo already supports end to end.
- The work is mostly onboarding polish, docs work, verification guidance, and small packaging improvements inside existing installers.
- These channels already fit the current local trust boundary and do not require a new hosted distribution layer.

### Later: broader directory/listing expansion and agent-ecosystem adapters

- Broader directory/listing expansion beyond the existing MCP Registry metadata.
- Additional MCP directories or registry listings that point back to the existing local installers.
- Marketplace-style listing pages for ecosystems that can consume local MCP or home-skill installs without changing the product boundary.
- Lower-leverage agent ecosystems where Madar currently has only partial or skill-only support.

Why this stays later:

- These channels need clearer proof/onboarding readiness first, so listings convert from curiosity into successful installs.
- They also require extra packaging, docs work, and security work: polished metadata, screenshots/examples, install verification notes, trust-boundary language, and ongoing listing maintenance.
- A directory presence is a distribution multiplier only after the core proof path and install success rate are already strong.

### Avoid for now: channels that imply hosted custody or plugin-store churn

- Any channel that requires a Madar-hosted relay.
- Any channel that implies raw-source upload or source custody.
- Any plugin-store or extension-marketplace push that would create heavy review, signing, compatibility, or support burden before proof is strong.

Why this stays avoid:

- It expands the security and maintenance surface faster than it expands proof.
- It muddies the current promise that Madar is a local context/evidence layer, not a hosted control plane.
- It creates pressure to make marketplace-scale adoption claims before the repo has the proof/onboarding readiness to justify them.

## What new channel work would require

Treat every new distribution channel as more than a listing exercise:

- **Packaging:** stable install entrypoints, clean uninstall behavior, and reproducible verification steps.
- **Docs work:** a compatibility note, onboarding examples, and a clear “when to use this surface” explanation.
- **Security work:** explicit local trust boundary wording, permission scope review, and no hosted relay by default.

## Decision boundary

- Keep near-term effort on the already-shipped installers and their onboarding path.
- Revisit broader directory/listing expansion only after proof/onboarding readiness is clearly stronger.
- Avoid marketplace-scale adoption claims, no hosted relay assumptions, and any distribution path that requires source custody before Madar has stronger proof that the current local surfaces convert well.
