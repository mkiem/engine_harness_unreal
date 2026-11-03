#!/usr/bin/env bash
# Sets up the Game Harness on macOS or Linux for goose: dependencies, a `harness-mcp` launcher on PATH, the recipes,
# and the game studio's skills in ~/.agents/skills (where goose, and other agents, read skills).
#   distro/install/install.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null || { echo "Node.js 22.18 or later is required" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "Node.js $(node --version) is too old; 22.18 or later is required" >&2; exit 1; }
(cd "$root" && npm ci --omit=dev --no-audit --no-fund)
bin="$HOME/.local/bin"
mkdir -p "$bin"
printf '#!/bin/sh\nexec node "%s/src/mcp/main.ts" "$@"\n' "$root" > "$bin/harness-mcp"
printf '#!/bin/sh\nexec node "%s/src/cli.ts" "$@"\n' "$root" > "$bin/harness"
chmod +x "$bin/harness-mcp" "$bin/harness"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH (for example in ~/.zshrc or ~/.bashrc)";; esac
skills="$HOME/.agents/skills"
mkdir -p "$skills"
for dir in "$root"/skills/*/; do name="$(basename "$dir")"; rm -rf "${skills:?}/$name"; cp -R "$dir" "$skills/$name"; done
echo "ok   game studio skills in $skills"
echo "Set GOOSE_RECIPE_PATH to include $root/distro/recipes (for example: export GOOSE_RECIPE_PATH=\"$root/distro/recipes\")"
command -v uvx >/dev/null && echo "ok   uvx" || echo "todo install uv (https://docs.astral.sh/uv/) for the Blender extension"
echo "Done: $bin/harness-mcp"
