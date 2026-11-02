#!/usr/bin/env bash
# Recreates the studio fork of goose: clones the pinned release and applies distro/patches on a `studio` branch.
#   distro/scripts/fork.sh [destination]        (default: ../goose-studio next to this repository)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$here/goose.lock.json"
field() { node -e "process.stdout.write(require(process.argv[1])[process.argv[2]])" "$lock" "$1"; }
repo="$(field repository)"; tag="$(field tag)"; commit="$(field commit)"; branch="$(field branch)"
dest="${1:-$here/../../goose-studio}"

if [ -e "$dest" ]; then echo "$dest already exists; remove it or pass another destination" >&2; exit 1; fi
git clone --quiet --branch "$tag" --depth 50 "$repo" "$dest"
actual="$(git -C "$dest" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then echo "$tag is $actual, expected $commit; was the tag moved?" >&2; exit 1; fi
git -C "$dest" checkout --quiet -b "$branch"
shopt -s nullglob
patches=("$here"/patches/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  git -C "$dest" -c user.name="engine_harness_unreal" -c user.email="noreply@anthropic.com" am --quiet --3way "${patches[@]}"
fi
echo "Fork ready: $dest (branch $branch, $tag + ${#patches[@]} patch(es))"
