#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-$HOME/Desktop/projects}
EXPECTED_PREFIX=a45f2562
FOUND=0

while IFS= read -r -d '' file; do
  if command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    digest=$(sha256sum "$file" | awk '{print $1}')
  fi
  printf '%s  %s\n' "$digest" "$file"
  if [[ "$digest" == "$EXPECTED_PREFIX"* ]]; then
    FOUND=1
    printf 'MATCH: reported checkpoint digest prefix %s\n' "$EXPECTED_PREFIX" >&2
  fi
done < <(find "$ROOT" -type f -path '*/scratchpad/checkpoint/FROZEN.md' -print0 2>/dev/null)

if [[ $FOUND -ne 1 ]]; then
  echo "No FROZEN.md matching reported SHA-256 prefix $EXPECTED_PREFIX found under $ROOT" >&2
  exit 1
fi
