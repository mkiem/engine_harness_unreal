# engine_harness_unreal

An AI-native game development harness for Unreal Engine 5 and Godot 4. It turns a creative brief into a plan of domain tickets (Blender modelling, texturing, audio in Wwise, Unreal Blueprints and placement, QA), runs each ticket through an isolated agent worker that gets only its domain's tools, and accepts a hand-off between tickets only when the delivered asset passes a typed, measured contract.

It follows the two-level super-agent design of DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype): a light Router plans and dispatches, Workers do the work, and people are asked only when they must decide. It adds what a studio pipeline needs: tickets that depend on each other through assets, a deterministic contract gate, exclusive locks on binary files, and pools for scarce, stateful tools such as a live Unreal Editor.

```
brief ──▶ Router (plan) ──▶ Orchestrator ──▶ Workers (Blender · Texture · Audio · Unreal · QA)
                               ▲     │              │ result.json
                               │     └─ pools, locks│
                               └── contract gate ◀──┘ ──▶ ingest ──▶ review ──▶ consumers start
```

## Try it

Requires Node.js 22.18 or later (TypeScript runs directly, no build step).

```bash
npm install
```

```bash
npm run demo
```

The demo runs the vintage radio plan (`examples/vintage-radio/plan.json`) with simulated workers that make three classic mistakes on their first try: a collision hull named for the wrong mesh, a mesh exported at 100× scale, and a hot audio master. The contract rejects each, the workers revise, and the plan completes. Model and audio run in parallel; texturing waits for the mesh; the Blueprint waits for everything; QA runs last.

```bash
node src/cli.ts plan prop examples/vintage-radio/brief.json      # plan a prop from a structured brief
node src/cli.ts plan check examples/vintage-radio/plan.json      # check a plan and show its parallel waves
node src/cli.ts status --state .harness/demo                     # what each ticket is doing, what waits for a person
node src/cli.ts presets --profile profiles/workstation.example.json
```

`npm run check` runs the typecheck, the TypeScript tests and the Python tests.

## Engine Harness, the desktop app

Engine Harness packages all of this as a desktop app for Windows: a fork of goose with the harness, the Unreal and Godot bridges, the Blender connection, recipes and the starter asset library built in. See [004 Studio app](docs/004-studio-app.md) to install it.

## Make a game, even if you never have

Open Engine Harness on an empty folder and choose **Start a new game**. The game studio interviews you about the game you want, one question at a time, creates a playable Godot RPG (party and equipment, elements and status effects, enemy AI and boss phases, quests, recruits and cutscenes, shops, inns and save slots), and then works through it with you phase by phase: art, characters, maps, battles, items, story, menus, music, balance, and a Windows `.exe` to share. It paints pixel art, writes music, simulates every battle for difficulty and plays the game to check it, so nothing else needs installing. Ideas start from two bundled references by loopyhop: a Gameplay Atlas of 280 mechanics from real games and a Game Art Style atlas of 37 styles. See [006 The game studio](docs/006-game-studio.md).

## In an agent IDE (goose, Claude Code)

The harness also runs as an MCP server, so an agent working in your own Blender and Unreal can plan, check assets against their contracts and share file locks:

```bash
node src/mcp/main.ts
```

`distro/install/install.ps1` (Windows) or `distro/install/install.sh` puts it on your PATH as `harness-mcp`, adds the game-dev recipes to goose, and installs the game studio's skills in `~/.agents/skills`. `distro/` also holds the studio fork of goose as a patch queue; see [004 Studio app](docs/004-studio-app.md).

## Running real workers

1. Copy `profiles/workstation.example.json` to `profiles/<machine>.local.json` and set the paths for Blender, Wwise and Unreal, the pool sizes, the lock backend (Perforce or Git LFS) and the agent command.
2. `node src/cli.ts presets --profile profiles/<machine>.local.json` lists what is missing. `node src/cli.ts probe --profile ...` shows which DCC endpoints answer.
3. Run with an agent runtime:

```bash
node src/cli.ts run examples/vintage-radio/plan.json --executor agent --profile profiles/<machine>.local.json --ingest unreal
```

`--executor agent` runs any headless agent CLI from the profile (the example uses Claude Code). `--executor goose` writes a goose recipe per assignment (`profiles/goose.example.json`). The Blender, Unreal and Wwise scripts in `dcc/` have not yet been run against live tools; M1–M3 in the task plan cover that.

When a ticket waits for a person:

```bash
node src/cli.ts approve vintage-radio-model "silhouette reads well" --state .harness/vintage-radio
```

```bash
node src/cli.ts answer vintage-radio-audio "use the licensed library clip instead" --state .harness/vintage-radio
```

## Documentation

- [000 Design review](docs/000-design-review.md): what changed from the initial proposal, and why
- [001 Architecture](docs/001-architecture.md): the parts, the super-agent mapping, and why we wrap goose and DSH instead of forking them
- [002 Asset contract](docs/002-asset-contract.md): naming, every rule, Blender-to-Unreal conventions
- [003 Task plan](docs/003-task-plan.md): milestones M1–M6 and risks
- [004 Studio app](docs/004-studio-app.md): Engine Harness, the goose fork for local game development: install, what is inside, the patch queue, the Windows CI build
- [005 Godot and assets](docs/005-godot-and-assets.md): Godot 4 for 2D pixel-art games, measured tool cost, and the starter asset library
- [006 The game studio](docs/006-game-studio.md): making a whole game with a beginner: the skills, studio tools, template and design document
- [007 Design references](docs/007-design-references.md): loopyhop's Gameplay Atlas (280 mechanics) and Game Art Style (37 styles), bundled with permission: mechanic cards, the art bible, and the RPG features built from them
- [008 3D characters and textures](docs/008-3d-characters.md): rigged, textured, animated characters for Godot and Unreal from reference images (yours, or your own image model's) in four styles; baked PBR textures for every prop

## Layout

| Path | What |
| --- | --- |
| `src/core` | Model, plan check, orchestrator, pools, store, ports |
| `src/contracts` | Naming rules, per-kind contract checks, WAV measurement |
| `src/locks` | Lock manager; memory, Perforce and Git LFS backends |
| `src/presets` | Preset and profile schemas, variable resolution, tool allowlists |
| `src/executors` | Simulated, agent CLI and goose worker runtimes; worker prompt |
| `src/ingest` | Engine ingest stage (simulated, Unreal commandlet) |
| `src/planner` | Prop template planner and LLM planner |
| `src/mcp` | The harness as an MCP server for agent IDEs |
| `src/studio` | The game studio: design document, phases, project creation, art and music making |
| `src/character` | 3D characters: the reference guide and checker, image model adapters, the build and engine installs |
| `skills/` | The game studio's agent skills, one per phase |
| `templates/godot-rpg` | The Godot 4 RPG every studio game starts from |
| `catalog/loopyhop` | Gameplay Atlas and Game Art Style by loopyhop (with permission; no game screenshots) |
| `distro/` | The studio fork of goose (pinned release and patches), recipes, installers |
| `presets/` | One least-privilege worker preset per domain |
| `profiles/` | Example machine profiles |
| `prompts/` | Router, shared worker and per-domain prompts |
| `dcc/` | Scripts that run inside Blender, Unreal and Wwise, and an audio synth |
| `examples/vintage-radio` | The reference brief and its plan |

## License

[MIT](LICENSE). This repository copies no code from dsh-superagent (MIT) or goose (Apache-2.0).

The Engine Harness desktop app is built from goose with the patches in `distro/patches`: those builds include goose, which stays under the Apache License 2.0, with its LICENSE and notices kept and the changes described in `ENGINE_HARNESS_NOTICE.md`. Assets the starter library downloads keep their own licences, recorded beside each download.
