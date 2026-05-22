# Release checklist

Use this checklist when preparing a new `madar` release. It is intentionally manual: the goal is to keep each version easy to verify without hiding the release steps behind automation.

## 1. Prepare the release commit

1. Update the package version with `npm version <patch|minor|major>`.
2. Review `package.json` and `package-lock.json` to confirm the new version is correct.
3. Update `CHANGELOG.md` with the user-visible changes in the release.
4. Make sure any linked docs, examples, or install flows reflect the new behavior.

## 2. Run the required verification commands

From the repository root:

```bash
npm install
npm run typecheck
npm run build
npm run test:run
npm pack --dry-run
```

If the change touches packaging or installer behavior, keep the `npm pack --dry-run` output with the release notes or pull request for easy review.

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
- uninstall any agent profile you enabled during the smoke test so the workspace returns to a clean state

## 4. Publish and tag

After the verification steps are green:

1. Push the release branch or merge commit.
2. Publish from the verified tree with `npm publish --access public` when you are ready.
3. Create the matching Git tag if `npm version` did not already do so in your workflow.
4. Draft or publish the GitHub release notes from the changelog entry.

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
