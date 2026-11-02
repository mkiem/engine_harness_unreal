#!/usr/bin/env bash
# Writes the studio branch of a fork back to distro/patches, one patch per commit. Run after committing in the fork.
#   distro/scripts/export-patches.sh [fork directory]        (default: ../goose-studio)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$here/goose.lock.json"
tag="$(sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p' "$lock")"
fork="${1:-$here/../../goose-studio}"
rm -f "$here"/patches/*.patch
# The generated artwork commit is recreated by fork.sh, so it is not exported.
artwork="$(git -C "$fork" log --format=%H --grep='^Engine Harness artwork' "$tag..studio" | head -1)"
end="studio"
if [ -n "$artwork" ]; then
  if [ "$(git -C "$fork" rev-parse studio)" != "$artwork" ]; then echo "commit after the artwork commit: rebase the artwork commit last first" >&2; exit 1; fi
  end="$artwork~1"
fi
git -C "$fork" format-patch --quiet --no-signature -o "$here/patches" "$tag..$end"
ls "$here/patches"
