# Release checklist

Use this checklist when preparing a new `madar` release. Preparation and approval stay explicit; the tag-triggered workflow preserves the final publication order and evidence.

> Thin Delivery implementation under Core Reset issue #602 is not release authorization. Do not publish npm, create a GitHub Release, or publish MCP Registry metadata from that phase; this checklist applies only after a separately authorized release begins.

## 1. Prepare the release commit

1. Update the package version without creating a pre-merge tag. For this beta, run `npm version 0.40.0-beta.3 --no-git-tag-version`.
2. Review `package.json` and `package-lock.json` to confirm the new version is correct.
3. Update `CHANGELOG.md` with the user-visible changes in the release.
4. Make sure any linked docs, examples, install flows, and `docs/mcp-registry/server.json` reflect the new behavior.
5. Any new public claim requires a reproducible artifact under `docs/benchmarks/suite/` and a matching update to `docs/claims-and-evidence.md` before the README or release notes can say it publicly.
6. If this release will be announced outside the repo, copy the proof block and channel tracker from [`docs/launch-checklist.md`](./launch-checklist.md) into the release PR, release notes draft, or other working notes before drafting external copy.

## 2. Run the required verification commands

From the repository root:

```bash
npm ci
npm run release:verify
npm run registry:validate
npm run typecheck
npm run build
npm run test:run
npm pack --dry-run
npm sbom --sbom-format cyclonedx --package-lock-only > sbom.cdx.json
```

`npm run release:verify` locks the public package metadata, changelog version entry, and npm-visible README links before publish so repository/documentation drift is caught in one pass.

If the change touches packaging, installer behavior, or public MCP Registry metadata, keep the `npm pack --dry-run` output with the release notes or pull request for easy review. Keep the generated `sbom.cdx.json` alongside the release PR or release notes as the checked supply-chain inventory snapshot for that version. Review [`docs/security/mcp-threat-model.md`](./security/mcp-threat-model.md) before publishing changes that affect MCP installs, share-safe artifacts, prompt handling, or local file boundaries.

## 3. Run manual CLI smoke checks

These checks verify that the published surface still matches the docs and changelog:

```bash
madar --version
madar generate .
madar install claude
madar install codex
madar query "trace the release path"
```

Recommended follow-up checks:

- confirm `madar --version` prints the version you are about to publish
- confirm `madar generate .` completes and refreshes `out/graph.json`
- confirm fresh install, idempotent reinstall, and uninstall produce zero repository-byte changes
- confirm Claude Code has a supported per-project local registration outside the repository
- for Codex, confirm the workspace-hashed block in `~/.codex/config.toml` or `$CODEX_HOME/config.toml` has exact command `madar`, args `["mcp"]`, workspace `cwd`, `startup_timeout_sec = 180`, and `tool_timeout_sec = 60`
- confirm initialize plus `tools/list` advertises only the tools capability and exactly one `retrieve` tool, with no resources or prompts
- uninstall with `madar install claude --uninstall` and `madar install codex --uninstall`

## 4. Publish and tag

After the verification steps are green:

1. Configure the npm package's trusted publisher for GitHub Actions workflow filename `release.yml`, repository `mohanagy/madar`, and no environment. The workflow uses GitHub OIDC and contains no registry token or no-provenance fallback. If trusted publishing or provenance is unavailable, stop before publication.
2. Push and merge the verified release commit so the published README links already exist on the target release branch (`main` for stable releases, `next` for prereleases).
3. Create and push `vX.Y.Z` at that exact merged release commit. Never tag the pre-merge release branch. For `0.40.0-beta.3`, `.github/workflows/release.yml` requires the tag commit to equal the protected remote `next` tip and then reruns every release gate before it runs `npm publish --tag next --access public --provenance`. The matching GitHub prerelease must target that exact commit, never `main`. Stable releases use `npm publish --access public --provenance` under their separately reviewed release workflow.
4. The workflow verifies the exact npm version, immutable shasum and integrity, `next` dist-tag, unchanged `latest` dist-tag, Trusted Publishing provenance, and registry signatures before creating the GitHub prerelease. A hyphenated version is never marked latest. If publication succeeds but a later verification is interrupted, rerun the same workflow: it verifies the existing exact artifact rather than attempting to overwrite it.
5. If this release is also authorized to update the public MCP Registry, run the **Publish MCP Registry metadata** GitHub Actions workflow with that `vX.Y.Z` tag only after npm confirms the package is public. It uses GitHub OIDC (no registry secret), verifies the published package has `mcpName: "io.github.mohanagy/madar"`, publishes the checked-in manifest, and verifies the Registry API result. npm prerelease publication alone does not authorize this separate dispatch.
6. Before posting on npm/GitHub directories, social/news sites, or videos/blogs, complete the copied proof-first launch checklist from [`docs/launch-checklist.md`](./launch-checklist.md) so every public surface starts from a dated receipt plus caveats.

## 5. Post-release verification

After the package is live:

1. Confirm the new version appears on npm.
2. Install the released version in a clean shell and re-run:

```bash
madar --version
madar generate .
madar install claude
madar install codex
```

3. Verify the README, changelog, and install docs still describe the released behavior accurately.
4. If anything is wrong, document the gap immediately and prepare a follow-up patch release instead of silently relying on tribal knowledge.
5. Record the completed channel statuses in the release PR, release notes draft, or other working notes you copied from [`docs/launch-checklist.md`](./launch-checklist.md) so distribution work stays explicit without mutating the canonical template.
