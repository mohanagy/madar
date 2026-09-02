#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <local-repo-path-or-owner/repo> <sha> <destination>" >&2
  exit 2
fi

SOURCE=$1
SHA=$2
DEST=$3
TMP=$(mktemp -d "${TMPDIR:-/tmp}/madar-736-source.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

rm -rf "$DEST"
mkdir -p "$DEST"

if [[ -d "$SOURCE/.git" || -f "$SOURCE/.git" ]]; then
  REPO=$SOURCE
  git -C "$REPO" cat-file -e "${SHA}^{commit}"
else
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh is required when source is not a local repository path" >&2
    exit 2
  fi
  gh repo clone "$SOURCE" "$TMP/repo" -- --no-checkout --filter=blob:none >/dev/null
  REPO="$TMP/repo"
  if ! git -C "$REPO" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
    git -C "$REPO" fetch --depth=1 origin "$SHA"
  fi
fi

git -C "$REPO" archive "$SHA" | tar -x -C "$DEST"

# Preserve only the pinned revision identity needed by Madar. Do not expose
# repository history, refs, tags, future fixes, or pull-request merge commits
# to either evaluation arm.
mkdir -p "$DEST/.git"
printf '%s\n' "$SHA" > "$DEST/.git/HEAD"

printf 'snapshot=%s\nrevision=%s\n' "$DEST" "$SHA"
