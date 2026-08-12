# Release channels and checklist

Madar uses two release channels. `main` carries stable releases on npm's `latest` dist-tag, while `next` carries approved prereleases on the `next` dist-tag. Release versions and tags must match exactly: stable tags look like `v0.33.0`, and approved prerelease tags look like `v0.33.0-beta.1`, `v0.33.0-rc.1`, or `v0.33.0-next.1`.

## Install a release channel

Install the current stable release:

```bash
npm install -g @lubab/madar
```

Install the current beta / prerelease selected by the `next` dist-tag:

```bash
npm install -g @lubab/madar@next
```

Install an exact beta for reproducible testing:

```bash
npm install -g @lubab/madar@0.33.0-beta.1
```

## Branch policy

| Branch or change | Purpose | npm channel | Pull request policy |
| --- | --- | --- | --- |
| `main` | Stable releases only | `latest` | Receives stable promotion through a reviewed `next` → `main` pull request |
| `next` | Prerelease integration and qualification | `next` | Receives reviewed issue and roadmap pull requests |
| Issue branches | One focused issue or improvement | None | Branch from `next` and target `next` |
| Roadmap changes | Planned product work | None | Branch from `next` and target `next` |

In short, use `main` for stable releases, `next` for prereleases. Do not bypass the reviewed promotion pull request to move integration work directly onto `main`.

CI runs its six Ubuntu/macOS/Windows and Node 20/22 jobs for pushes to both long-lived branches and for pull requests. That is broad repository-level validation. Path-sensitive checks that remain single-lane are follow-up work, not cross-platform proof.

## Required release verification

Run the applicable commands from the repository root on the exact commit proposed for release:

```bash
npm ci
npm run release:verify
npm run registry:validate
npm run typecheck
npm run test:run
npm run test:coverage
npm run build
npm run verify:pack-parity
npm pack --dry-run
npm sbom --sbom-format cyclonedx > sbom.cdx.json
```

Run `npm run qualify:validate` when that script is present. Its failure is a release blocker; when it is absent, record that qualification was unavailable rather than presenting it as passed.

`npm run release:verify` locks the public package metadata, changelog version entry, and npm-visible README links before publish. `npm pack --dry-run` records the package boundary, and `sbom.cdx.json` is the checked supply-chain inventory snapshot. If the change touches packaging, installer behavior, or public MCP Registry metadata, keep those outputs with the release pull request. Review [`docs/security/mcp-threat-model.md`](./security/mcp-threat-model.md) before publishing changes that affect MCP installs, share-safe artifacts, prompt handling, or local file boundaries.

Any new public claim requires a reproducible artifact under `docs/benchmarks/suite/` and a matching update to `docs/claims-and-evidence.md` before the README or release notes can say it publicly. For an external announcement, copy the proof block and channel tracker from [`docs/launch-checklist.md`](./launch-checklist.md) into the release pull request or working notes before drafting copy.

## Beta preparation (10 steps)

1. Create the issue or roadmap branch from current `next`; keep the change focused and do not branch release work from `main`.
2. Implement the change, add focused tests and fixtures, update user-facing documentation, and run the relevant local checks.
3. Open the pull request against `next`, obtain review, and wait for the full CI matrix. Treat any path-sensitive single-lane result as targeted evidence, not cross-platform proof.
4. Merge the reviewed change into `next`, then choose the next approved version such as `0.33.0-beta.1`, `0.33.0-rc.1`, or `0.33.0-next.1`.
5. On a short release-preparation branch from `next`, run `npm version 0.33.0-beta.1 --no-git-tag-version` (substituting the chosen version), verify both `package.json` and `package-lock.json`, and add the exact dated `CHANGELOG.md` section.
6. Review linked docs, examples, install flows, claims, and limitations. Do not change `docs/mcp-registry/server.json` merely to publish a prerelease; MCP Registry publication remains a separate explicitly scoped operation.
7. Run every command under [Required release verification](#required-release-verification), including mandatory qualification when available, and retain the pack and SBOM evidence.
8. Run manual CLI smoke checks, open the release-preparation pull request back to `next`, obtain review, merge it, and confirm the intended release commit is now contained in `origin/next`.
9. Create the exact `v<version>` tag on that merged commit and push only the tag. Approve the protected `npm-next` environment after reviewing the tag, commit, changelog, and validation plan. The workflow uses npm Trusted Publishing with OIDC and provenance; if that trust policy is unavailable, it fails without using a token or dropping provenance.
10. Confirm `@lubab/madar@<version>` resolves, `@lubab/madar@next` installs that exact version, `latest` did not move, both installed binaries pass the temporary-workspace smoke, and the GitHub release is marked as a prerelease with qualification and remediation notes.

The protected workflow runs `npm publish --tag next --access public --provenance` only after all gates pass. npm versions are immutable: remediate a bad beta by deprecating it, moving `next` back to a known-good prerelease, documenting the gap, and publishing a new prerelease number. Never move `latest` as part of prerelease remediation.

## Stable promotion (8 steps)

1. Select a qualified commit on `next`; confirm its beta feedback, known limitations, changelog, public claims, pack evidence, and launch checklist are ready for stable users.
2. Prepare the stable promotion commit on `next` with `npm version 0.33.0 --no-git-tag-version` (substituting the intended stable version), keep `package.json` and `package-lock.json` aligned, and convert the changelog entry into the exact dated stable section.
3. Run every command under [Required release verification](#required-release-verification), the manual CLI smoke checks below, and any present qualification command against that exact promotion commit.
4. Open the stable promotion as a reviewed `next` → `main` pull request. Do not recreate the changes on a main-based branch; the reviewed promotion is the audit trail for what graduates.
5. Wait for required review and CI, merge into `main`, and verify the merged commit is the reviewed content with no release-file drift.
6. Create and push the exact stable tag on the merged `main` commit. `.github/workflows/release.yml` rejects prerelease tags, revalidates the stable release, and creates the ordinary GitHub release.
7. From an authorized provenance-capable environment checked out at that exact tag, verify that the version is unpublished and run `npm publish --access public --provenance`. This publishes to npm's default `latest` dist-tag; never use `--tag next` for stable promotion.
8. Confirm the exact version and `latest` resolve, install and smoke-test the published package in a clean workspace, confirm the prerelease history and `next` status remain intentional, record channel status in the release notes, and then reopen `next` for the next prerelease cycle.

## Manual CLI smoke checks

Before publication, exercise the built CLI:

```bash
madar --version
madar generate .
madar claude install
madar codex install
```

Confirm `madar --version` prints the version about to be published, generation refreshes `out/graph.json`, and install commands write the expected project files and instructions. For Codex, confirm `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and this workspace's block in `~/.codex/config.toml` exist with `startup_timeout_sec = 180` and `tool_timeout_sec = 60`. Only in a trusted repository, restart or open a new session, use `/hooks` to review and trust the project hook, then use `/mcp` or `codex mcp list` to verify the local MCP server. Uninstall any agent profile enabled solely for the smoke test.

## Post-release verification

After publication, install the exact public version in a clean temporary workspace and repeat the relevant `madar --version` and `madar generate .` checks against the installed binary, not the repository checkout.

If stable package metadata should be published to the official MCP Registry, run the separate **Publish MCP Registry metadata** workflow only after npm confirms the matching public version. It uses GitHub OIDC, validates the checked-in manifest, and verifies the Registry API result. Neither npm release workflow mutates MCP Registry metadata.

Before posting to npm/GitHub directories, social/news sites, or videos/blogs, complete the copied proof-first checklist from [`docs/launch-checklist.md`](./launch-checklist.md). If anything is wrong after release, document it immediately and prepare a new version instead of silently relying on tribal knowledge.
