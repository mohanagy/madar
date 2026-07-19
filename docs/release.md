# Release checklist

Use this checklist when preparing a new `madar` release. It is intentionally manual: the goal is to keep each version easy to verify without hiding the release steps behind automation.

## 1. Prepare the release commit

1. Update the package version with `npm version <patch|minor|major>`.
2. Review `package.json` and `package-lock.json` to confirm the new version is correct.
3. Update `CHANGELOG.md` with the user-visible changes in the release.
4. Make sure any linked docs, examples, install flows, and `docs/mcp-registry/server.json` reflect the new behavior.
5. Any new public claim requires a reproducible artifact under `docs/benchmarks/suite/` and a matching update to `docs/claims-and-evidence.md` before the README or release notes can say it publicly.
6. If this release will be announced outside the repo, copy the proof block and channel tracker from [`docs/launch-checklist.md`](./launch-checklist.md) into the release PR, release notes draft, or other working notes before drafting external copy.

## 2. Run the required verification commands

From the repository root:

```bash
npm install
npm run release:verify
npm run registry:validate
npm run typecheck
npm run build
npm run test:run
npm pack --dry-run
npm sbom --sbom-format cyclonedx > sbom.cdx.json
```

`npm run release:verify` locks the public package metadata, changelog version entry, and npm-visible README links before publish so repository/documentation drift is caught in one pass.

If the change touches packaging, installer behavior, or public MCP Registry metadata, keep the `npm pack --dry-run` output with the release notes or pull request for easy review. Keep the generated `sbom.cdx.json` alongside the release PR or release notes as the checked supply-chain inventory snapshot for that version. Review [`docs/security/mcp-threat-model.md`](./security/mcp-threat-model.md) before publishing changes that affect MCP installs, share-safe artifacts, prompt handling, or local file boundaries.

## 3. Run manual CLI smoke checks

These checks verify that the published surface still matches the docs and changelog:

```bash
madar --version
madar generate .
madar claude install
madar codex install
```

Recommended follow-up checks:

- confirm `madar --version` prints the version you are about to publish
- confirm `madar generate .` completes and refreshes `out/graph.json`
- confirm install commands write the expected project files and instructions
- for Codex, confirm `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and this workspace's block in `~/.codex/config.toml` exist, and that it contains `startup_timeout_sec = 180` plus `tool_timeout_sec = 60`; only in a trusted repository, restart or open a new session, use `/hooks` to review/trust the project hook, then use `/mcp` or `codex mcp list` to verify the local MCP server
- uninstall any agent profile you enabled during the smoke test so the workspace returns to a clean state

## 4. Publish and tag

After the verification steps are green:

1. Push and merge the verified release commit so the published README links already exist on the target release branch (`main` for stable releases, `next` for prereleases).
2. Publish from that merged release commit:
   - stable releases: `npm publish --access public --provenance`
   - prereleases / `next`: `npm publish --tag next --access public --provenance`
   If the release environment does not support npm provenance attestations, rerun the same command without `--provenance`.
3. Create the matching Git tag if `npm version` did not already do so in your workflow.
4. After npm confirms the matching public version, run the **Publish MCP Registry metadata** GitHub Actions workflow with that `vX.Y.Z` tag. It uses GitHub OIDC (no registry secret), verifies the published package has `mcpName: "io.github.mohanagy/madar"`, publishes the checked-in manifest, and verifies the Registry API result.
5. Draft or publish the GitHub release notes from the changelog entry.
6. Before posting on npm/GitHub directories, social/news sites, or videos/blogs, complete the copied proof-first launch checklist from [`docs/launch-checklist.md`](./launch-checklist.md) so every public surface starts from a dated receipt plus caveats.

## 5. Post-release verification

After the package is live:

1. Confirm the new version appears on npm.
2. Install the released version in a clean shell and re-run:

```bash
madar --version
madar generate .
madar claude install
madar codex install
```

3. Verify the README, changelog, and install docs still describe the released behavior accurately.
4. If anything is wrong, document the gap immediately and prepare a follow-up patch release instead of silently relying on tribal knowledge.
5. Record the completed channel statuses in the release PR, release notes draft, or other working notes you copied from [`docs/launch-checklist.md`](./launch-checklist.md) so distribution work stays explicit without mutating the canonical template.
