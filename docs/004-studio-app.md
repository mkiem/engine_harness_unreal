# 004 Studio app: a goose fork for local game development

Game development happens on the developer's own computer: the agent builds in their open Blender and Unreal Editor, and they playtest in Play in Editor and say what to change. The studio app is that workstation in one install: a fork of [goose](https://github.com/aaif-goose/goose) (Apache-2.0) with game-dev extensions, recipes and guidance built in, and the harness from this repository as its pipeline layer.

## Pieces

| Piece | Where | Does |
| --- | --- | --- |
| The app | goose fork, built from `distro/patches` | Chat, sessions, subagents, recipes, extension management, model providers |
| Game Harness extension | `src/mcp` in this repository, run as `harness-mcp` | Conventions, plans, contract validation, audio measurement, shared file locks |
| Blender extension | [blender-mcp](https://github.com/ahujasid/blender-mcp) through `uvx`, plus its addon inside Blender | Live scene access and Python in the open Blender |
| Unreal Editor extension | An editor MCP plugin in the game project (choice pending, see the task plan) | Actors, Blueprints, Python, Play in Editor |
| Recipes | `distro/recipes` | One-click workflows: New prop, Playtest and fix |
| DCC scripts | `dcc/` | Deterministic export, inspection and import, called by the agent |
| Installer | `distro/install` | Dependencies, the `harness-mcp` launcher, the recipe path, checks for uv and Blender |

## How the fork is kept

The fork lives as a **patch queue** in this repository rather than as a copy of goose:

- `distro/goose.lock.json` pins the upstream release (tag and commit).
- `distro/patches/*.patch` holds our changes, one commit each.
- `distro/scripts/fork.sh [dir]` clones the pinned release and applies the patches on a `studio` branch.
- After committing in the fork, `distro/scripts/export-patches.sh [dir]` writes the branch back to `distro/patches`.

This keeps the full flexibility of a fork (any file can change) while the repository holds only our diff, a few hundred lines instead of goose's 650 MB. Upgrading goose is: change the pin, run `fork.sh`, fix any patch that no longer applies, export. A GitHub fork can be made from the same patches at any time.

Rules for patches, so upgrades stay cheap: keep each patch to one concern; prefer adding files over editing goose's; when editing, change as few lines as possible; update goose's own tests and snapshots in the same patch.

## Patches so far

| Patch | Change | Verified |
| --- | --- | --- |
| 0001 | Bundled extensions: Game Harness (on), Blender (on), Unreal Editor (off until its plugin is installed) | JSON valid; applies to v1.57.0 |
| 0002 | Game-development section in the system prompt; the four prompt snapshots updated to match | Applies to v1.57.0; the prompt snapshot tests are run with `cargo test -p goose --lib prompt_manager` |

## Next patches

1. **Branding**: product name, icons, executable and installer names, updater repository (`ui/desktop/forge.config.ts`, `package.json`, desktop templates). Needs the product name. The name must not use "goose"; keep goose's licence and notices.
2. **Self-contained harness**: ship the harness inside the app's resources and run it with the app's own Node runtime (Electron with `ELECTRON_RUN_AS_NODE`), registered at startup with the resolved path, so users need neither Node nor the installer's launcher.
3. **First-run setup**: detect Blender, Unreal and Wwise installs and the game project; install the blender-mcp addon and the Unreal plugin; show what is missing, in the app instead of a terminal.
4. **Default provider**: `init-config.yaml` with the chosen model provider.
5. **Game-dev panels**: asset previews (turntables from Blender), the contract result per asset, locks held, and buttons for "playtest this" and "request a change".
6. **Windows build in CI**: a GitHub Actions workflow on a Windows runner that runs `fork.sh`, builds the desktop app and uploads the installer.

## Using it today, before the branded build

Stock goose plus this repository already gives the experience, with a manual setup:

1. Install goose desktop and pick a model provider.
2. Run `distro/install/install.ps1` (Windows) or `distro/install/install.sh` (macOS/Linux).
3. In goose, add the extensions from `distro/patches/0001-*.patch` by hand (Settings, Extensions): `harness-mcp` as a command-line extension, `uvx blender-mcp`, and the Unreal endpoint.
4. Install the blender-mcp addon in Blender and click Connect in its sidebar tab.
5. Open the "New prop" recipe, describe a prop, and playtest what it builds.

The studio build removes steps 1 and 3, and in time step 4.
