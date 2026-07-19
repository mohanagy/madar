## Summary

<!-- What changed and why? -->

## Testing

<!-- Paste commands or explain verification. -->

- [ ] `npm run test:run`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm pack --dry-run` (if packaging or install behavior changed)

## Core Reset contract

<!-- Complete this section for Core Reset work; otherwise write "Not applicable". -->

- RFC requirement:
- Parent issue:
- Removal-manifest IDs:
- Exit gate:
- Production LOC added:
- Production LOC removed:
- Net production LOC:
- Superseded paths deleted:

### Reset scope checks

- [ ] Not applicable, or this PR is governed by accepted RFC #577
- [ ] This replaces/removes an existing path, or has an approved reason to add one
- [ ] No permanent fallback or parallel implementation was added
- [ ] No evaluation-repository-specific production logic was added under `src/`
- [ ] Production does not import development-only evaluation tooling
- [ ] The removal manifest and scorecard were updated when applicable

## Checklist

- [ ] I updated docs for any user-visible change
- [ ] I added or updated tests when behavior changed
- [ ] This PR does not include private corpora, secrets, credentials, proprietary prompts, sensitive raw logs, or accidental generated artifacts
- [ ] I kept this PR focused on a single change or tightly related set of changes

## Related issues

<!-- Closes #123 -->
