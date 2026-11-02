#!/usr/bin/env bash
# Writes the studio branch of a fork back to distro/patches, one patch per commit. Run after committing in the fork.
#   distro/scripts/export-patches.sh [fork directory]        (default: ../goose-studio)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$here/goose.lock.json"
tag="$(node -e "process.stdout.write(require(process.argv[1]).tag)" "$lock")"
fork="${1:-$here/../../goose-studio}"
rm -f "$here"/patches/*.patch
git -C "$fork" format-patch --quiet --no-signature -o "$here/patches" "$tag..studio"
ls "$here/patches"
