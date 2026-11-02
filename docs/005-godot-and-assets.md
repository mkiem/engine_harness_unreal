# 005 Godot and the starter asset library

## Godot 4 for 2D pixel-art games

Godot suits small 2D games, and suits an agent: scenes (`.tscn`) and scripts (`.gd`) are plain text, so the agent reads and writes them directly, and the harness answers scene questions from the file instead of a tool round trip per node. Godot itself is started only to validate scripts and run the game, through its own command line; no editor plugin is needed.

### Tools

| Tool | Does |
| --- | --- |
| `godot_status` | The Godot 4 executable found (`GODOT_BIN`, PATH, winget, Program Files, Steam, `/Applications`) and the open project |
| `godot_scene` | A scene as a compact node tree (`Hero (CharacterBody2D) [characters/hero.gd]`), or one node's properties |
| `godot_check` | `godot --headless --check-only --script` on the given scripts or every script outside `addons/`, four at a time, with file and line for each error |
| `godot_run` | Runs the project or a scene headless for a few seconds and reports runtime errors; or opens it in a window for the developer to play |
| `harness_setup_godot_project` | Pixel-art defaults in `project.godot`: nearest filtering, pixel snapping, a base resolution (320x180) scaled by whole numbers; keeps a backup |

`HARNESS_ENGINES=godot` makes the server offer only the Godot tools (with the shared ones), for the least context.

### Contracts

| Kind | Checked from | Rules |
| --- | --- | --- |
| `sprite_sheet` (`SPR_`) | the PNG itself | 8-bit non-interlaced, a whole grid of `frameSize` frames, at least `frames`, at most `maxColors` visible colours, hard alpha |
| `tileset` (`TS_`) | the PNG itself | the same, with `tileSize` and `minTiles` |
| `godot_scene` (`SCN_`) | the `.tscn` in the project | root type, required node types, a script on the root, every `res://` resource it uses exists |

Domains: `sprite` (pixel art) and `godot` (scenes and scripts), with presets and prompts. `pixelCharacterPlan` (example in `examples/pixel-hero`) plans a character as sprite sheet → scene → QA; the **New 2D character (Godot)** recipe walks through it in the app.

### Measured tool cost

`node scripts/tool-budget.ts` measures the tool definitions an agent receives (JSON, about 4 characters per token):

| Group | Tools | ~Tokens |
| --- | --- | --- |
| Shared (pipeline, locks, setup, assets) | 16 | ~2,600 |
| Unreal | 6 | ~910 |
| Godot | 5 | ~590 |

Our Unreal bridge is small because it passes Python through to the editor; third-party Unreal MCP servers with hundreds of tools cost far more. The larger saving with Godot is in the work itself: text scenes and compact GDScript, read and written directly. Measuring led to one fix: the contract tools took fully typed input whose JSON schema cost about 2,500 tokens per session; they now take loosely typed input checked in the handler, with the same error messages.

### Verified with real Godot

`scripts/e2e-godot.ts` (in CI, and run during development with Godot 4.4.1): a fresh project gets the pixel-art defaults; the pixel-hero plan runs through the orchestrator (the contract rejects a sprite sheet with soft alpha once, then passes); real Godot parses every script and runs the scene for 120 frames without errors; a planted syntax error is reported with its file and line.

## Starter asset library

Openly licensed assets, downloaded on demand into the developer's project, with the source, author and licence recorded beside every download (`asset.json`, `LICENSE.txt`) for the asset's provenance. Nothing is bundled in the installer: the app stays small, the assets stay current, and no marketplace content is redistributed.

| Source | Access | Licence | Good for |
| --- | --- | --- | --- |
| Kenney | search a curated list of kits, download the kit | CC0 | 16x16 pixel-art RPG tiles and characters, UI, sound effects, low-poly kits |
| Poly Haven | search, download at a resolution | CC0 assets | HDRIs, PBR textures, models |
| ambientCG | search, download a variant | CC0 | PBR materials |
| Godot Asset Library | search, download, install into `addons/` | per add-on, mostly MIT | dialogue systems, state machines, tools |
| Fab / Quixel Megascans | guide only | Fab licences, no redistribution | Unreal environments and props, with the developer's Epic account and the Fab plugin |
| Freesound | guide only | per sound | audio, with the CC0 filter |
| OpenGameArt | guide only | mixed | check each asset's licence |

Tools: `assets_sources`, `assets_search`, `assets_download`. Downloads go to `library/` in a Godot project and `ArtSource/Library/` in an Unreal project. The **Starter assets for my game** recipe proposes a short starter set for the developer's genre and downloads only what they agree to.

**Poly Haven terms.** The assets are CC0. For the API itself, Poly Haven's API page says commercial integrations need a custom licence, while its GitHub README says the API is free for any use with a "Powered by Poly Haven" credit. The harness sends a unique User-Agent and shows the credit; if Engine Harness is distributed commercially, confirm the terms with Poly Haven, or remove the source from `SOURCES` in `src/assets/library.ts`.

The asset sources are checked with real downloads in CI (`scripts/e2e-assets.ts`), because the development container cannot reach them.
