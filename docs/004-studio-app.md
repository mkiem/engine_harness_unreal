# 004 Studio app: Engine Harness, a goose fork for local game development

Game development happens on the developer's own computer: the agent builds in their open Blender, Unreal Editor or Godot project, and they playtest and say what to change. **Engine Harness** is that workstation in one install: a fork of [goose](https://github.com/aaif-goose/goose) (Apache-2.0) with game-dev tools, recipes and guidance built in, and the harness from this repository inside it.

## Install

Download `Engine Harness-win32-x64-setup.exe` from the repository's GitHub releases (tags `studio-v*`) or from the latest run of the **Studio app (Windows)** workflow, and run it. It installs per user, beside any goose install, and needs no administrator rights. The build is not code-signed yet, so Windows SmartScreen warns on first run: choose More info, then Run anyway.

On first launch, pick a model provider, open the **Set up my machine** recipe, and let it find Blender, Unreal and Godot and connect them.

## What is inside

| Piece | Where | Does |
| --- | --- | --- |
| The app | goose v1.57.0 + `distro/patches` | Chat, sessions, subagents, recipes, extension management, model providers |
| Game Harness extension | `src/mcp`, bundled as `resources/harness/harness-mcp.mjs` | Plans, conventions, asset contracts, shared file locks, machine setup, the Unreal and Godot bridges, the asset library |
| Unreal bridge | `src/unreal` (part of Game Harness) | Python in the open editor over Unreal's built-in remote execution: no plugin to compile; Play in Editor; the editor log |
| Godot bridge | `src/godot` (part of Game Harness) | Scenes read as text; GDScript checks and game runs through Godot's headless command line |
| Blender extension | [MCP for Blender](https://github.com/ahujasid/blender-mcp) 2.2.6 through the bundled `uvx`, telemetry off | Live scene access and Python in the open Blender |
| Recipes | `distro/recipes`, bundled in `resources/harness/recipes` | Start a new game, Continue my game, Set up my machine, New prop, Playtest and fix, New 2D character (Godot), Starter assets |
| DCC scripts | `dcc/`, bundled in `resources/harness/dcc` | Deterministic export, inspection and import, found by the agent through `harness_scripts` |

### How the harness runs inside the app

The payload (`npm run bundle`: one JavaScript file with every dependency, the DCC scripts, the recipes, the game templates and the game studio's skills) ships in `resources/harness`. At startup the app writes a `harness-mcp` launcher beside the Windows shims (`%LOCALAPPDATA%\Goose\bin`, on PATH for every extension) adds the recipes to `GOOSE_RECIPE_PATH`, and installs the studio's skills where goose reads them (see [006](006-game-studio.md)). The launcher runs the payload with Node.js found the way goose's bundled `npx.cmd` finds it: the portable Node.js goose keeps in `%LOCALAPPDATA%\Goose\node`, else a system Node.js 22+, else `npx.cmd` downloads the portable one. Electron's `RunAsNode` fuse stays off: the signed app executable is never usable as a general Node runtime.

### Kept apart from goose

Its own product and executable name, installer id (`com.engineharness.desktop`) and configuration root (`%APPDATA%\Engine Harness\goose`, through `GOOSE_PATH_ROOT`), so it installs and runs beside a stock goose. Auto-updates are off until Engine Harness has its own update feed; goose's feed would replace it with stock goose.

## How the fork is kept

A **patch queue** in this repository rather than a copy of goose:

- `distro/goose.lock.json` pins the upstream release (tag and commit).
- `distro/patches/*.patch` holds our changes, one commit each (about 60 KB in all).
- `distro/scripts/fork.sh [dir]` clones the pinned release, applies the patches on a `studio` branch, and commits the artwork that `distro/branding/make_icons.py` draws (icons and installer bitmaps are generated, not carried as binary patches).
- After committing in the fork, `distro/scripts/export-patches.sh [dir]` writes the branch back to `distro/patches`.

Rules for patches, so upgrades stay cheap: one concern per patch; add files rather than edit goose's; when editing, change as few lines as possible; update goose's own tests and snapshots in the same patch.

| Patch | Change | Verified |
| --- | --- | --- |
| 0001 | Bundled extensions: Game Harness and Blender on, Epic's UE 5.8 MCP plugin as an optional extension | Desktop typecheck and extension tests on Windows (CI) |
| 0002 | Game-development section in the system prompt; prompt snapshots updated | `cargo test -p goose --lib prompt_manager` (13 tests) and `test_all_platform_extensions` |
| 0003 | The harness payload in `resources/harness` and the `harness-mcp` launcher (`harnessLauncher.ts`, with tests) | Launcher tests and desktop typecheck on Windows (CI); install-and-launch smoke test (CI) |
| 0004 | Blender extension pinned to mcp-for-blender 2.2.6 with `DISABLE_TELEMETRY` | Desktop tests (CI) |
| 0005 | Branding, own installer id, updates off, own `GOOSE_PATH_ROOT`, NOTICE | Prompt tests; Windows installer build (CI) |
| 0006 | System prompt: run the setup check on first use or when a tool does not answer | Prompt tests |
| 0007 | System prompt: Godot scenes and scripts as text; offer starter assets with their licences | Prompt tests |
| 0008 | Install the game studio's skills into `<GOOSE_PATH_ROOT>/config/skills` at startup | Unit tests; Windows smoke test |
| 0009 | System prompt: people new to game development go through the game-studio skill | Prompt tests |

## The CI build

`.github/workflows/studio-windows.yml` runs on pushes and pull requests that touch the app, by hand, and on `studio-v*` tags:

1. **Harness tests** and the payload, with a smoke test of the bundled server.
2. **Blender end to end** with real Blender 5.2 (`dcc/tests/e2e_blender.py`) and **Godot end to end** with real Godot 4.4 (`scripts/e2e-godot.ts`).
3. **Asset sources**: real downloads from every library (`scripts/e2e-assets.ts`); informational, not a gate.
4. **goose backend** (`goose.exe`) and the **patched desktop app's typecheck and tests**, on Windows.
5. **Package**: Electron app with the payload, NSIS installer, portable zip.
6. **Smoke test**: a silent install on a clean runner, launching the app, and an MCP handshake through the `harness-mcp.cmd` the app wrote.
7. On a `studio-v*` tag, a GitHub prerelease with the installer and the zip.

## Next

- **Signing**: an Authenticode certificate (or Azure Trusted Signing, as goose uses) to remove the SmartScreen warning.
- **Update feed**: releases of this repository in the format goose's updater reads, then updates back on.
- **Default provider**: `init-config.yaml` with a chosen provider, once decided.
- **Game-dev panels** in the app: asset previews, contract results per asset, locks held, "playtest this".
- **macOS build** in CI (the launcher already has a macOS/Linux path).
