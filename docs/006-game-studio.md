# 006 The game studio: from "I want to make a game" to a Windows .exe

Engine Harness makes a whole game *with* someone who has never made one. They decide what the game is; the agent
designs, draws, writes, composes, programs, tests and builds it with them, one question at a time, and keeps it
playable after every step. No other software is needed: Godot is installed on request, art is painted from text, music
is written from notes.

## How someone uses it

1. Install Engine Harness ([004](004-studio-app.md)) and open it on an empty folder.
2. Pick the recipe **Start a new game** (or just say "I want to make a game").
3. Answer about ten short questions (what kind of game, which games it should feel like, the setting, the hero...). Every
   question comes with options and a recommendation; "you choose" always works.
4. A playable game appears: a title screen, a village to walk, monsters in the meadow, a shop, an inn, a chest, a boss and
   an ending. Everything in it is a placeholder.
5. Phase by phase, the agent replaces the placeholders with their game: art, characters, maps, battles, items, story,
   menus, music. After each step it runs the game and says what to try.
6. The agent simulates every battle to tune difficulty, then plays the game through with them.
7. **Build and share**: a single `.exe` in `builds/windows/` to send to friends or put on itch.io.

Next time, open the game's folder and pick **Continue my game**: the agent reads the design and says what's next.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Skills | `skills/<name>/SKILL.md` | How to run each phase with a beginner (13 skills, below) |
| Studio tools | `src/mcp/server.ts` (`studio_*`) | Create, check, simulate, paint, compose, export |
| Template | `templates/godot-rpg/` | A complete, data-driven Godot 4 RPG every game starts from |
| Design document | `<game>/design/game.json`, `GAME_DESIGN.md` | The project's memory: every decision, and each phase's status |
| Phases | `src/studio/phases.ts` | The path from concept to build, each with checks against the real files |
| Recipes | `distro/recipes/new-game.yaml`, `continue-game.yaml` | One-click starts in the app |
| App integration | `distro/patches/0008`, `0009` | Installs the skills where goose reads them; tells the agent to use them |

### Skills

`game-studio` is the entry point: the twelve phases, how to work with a beginner (one question at a time, options with a
recommendation, explain each term once, show then ask, keep scope small), and when to load which skill.
`studio_next` names the skill for the current phase:

| Phase | Skill |
| --- | --- |
| Concept | `game-concept`: the interview, pillars, core loop, first playable goal |
| Project | `godot-rpg-template`: where everything lives, data formats, story events, extending safely |
| Art direction | `art-direction`: resolution, palette, style; painting sprites and tiles; using packs |
| Characters | `character-design`: party roles, personality, look, stats and skills |
| World and maps | `world-building`: regions, text maps, NPCs, warps |
| Battle system | `battle-design`: feel, enemies per area, encounters, bosses |
| Items and economy | `items-and-economy`: items, prices, shops, chests, rewards |
| Story and dialogue | `story-and-dialogue`: premise, beats, dialogue, flags, the ending |
| UI and menus | `ui-and-menus`: colours, pixel fonts, title screen, usability |
| Music and sound | `audio-and-music`: mood, writing music with notes, sound presets |
| Playtest and balance | `playtest-and-balance`: simulation bands, tuning table, guided playtest |
| Build and share | `build-and-share`: the .exe, the unknown-publisher warning, itch.io |

The app copies them into `<GOOSE_PATH_ROOT>/config/skills` at every start (`%APPDATA%\Engine Harness\goose\config\skills`
on Windows), replacing older copies of its own and leaving the user's skills alone. Outside the app, `install.ps1` and
`install.sh` copy them to `~/.agents/skills`, which goose, Claude Code and other agents read.

### Studio tools

| Tool | Does |
| --- | --- |
| `studio_new_project` | A new game from the template, with placeholder art and sound, its design and `AGENTS.md` |
| `studio_next` | Where the game stands: phases, the current checklist, the skill to load, the next step |
| `studio_design_read`, `studio_design_update` | Read and change the design; every decision logged with why |
| `studio_check` | Data references in plain words, scripts (real Godot), the self-test, and real runs of the title screen, a walk into a battle, and the ending |
| `studio_simulate_battle` | Each encounter group and boss fought hundreds of times with the game's rules: win rate, rounds, HP left, a verdict |
| `studio_paint`, `studio_preview` | Pixel art from text grids into sprite sheets; an enlarged preview to look at |
| `studio_music`, `studio_sound` | Chiptune music from notes (melody, bass, drums); 18 sound effect presets |
| `studio_install_godot` | Godot 4.4.1 into Engine Harness's folder (about 60 MB) |
| `studio_export` | The Windows .exe (first time: the export templates, about 1 GB, with the developer's agreement) |

### The template

Everything a game contains is data: party, characters, enemies, skills, items, formulas (as maths), encounters,
dialogue, text maps with a legend, NPCs, warps, story events, UI colours and font. Code is only for new kinds of
behaviour. Story events need no code: an NPC can set a flag, change what it says once a flag is set, appear or leave,
start a boss battle, end the game; chests give items once; warps can stay shut until a flag. The data checks catch broken
references, uneven maps, NPCs on walls, warps that bounce, pictures out of range and flags nothing sets.

## How it is tested

- `tests/studio.spec.ts`, `tests/skills.spec.ts`: project creation, data checks, design, phases, painting, music, and
  that every skill is well formed, covers its phase and names only real tools.
- `scripts/e2e-studio.ts` with real Godot, through the bundled payload as the app runs it: new game, concept, a painted
  monster, a boss theme and a spell sound, the full check (scripts, self-test, title, a walk into a battle won, the
  ending), every encounter group and the boss simulated, and a Windows .exe built. CI runs it on Linux and on Windows
  (job `studio-e2e`, which also keeps the built sample game as an artifact).
- The Windows smoke test installs the app, launches it, checks the skills landed in the app's skills folder, and creates
  a game through the installed launcher.

## Limits, honestly

- The guided path is a 2D turn-based RPG. Other genres are possible with the agent writing code, but without a template
  or phase checks yet; the concept skill says so.
- Painted art and written music are simple by design. For a richer look, the skills point to openly licensed packs
  (Kenney, CC0) and record their licences.
- Equipment, party members joining mid-game, status effects and minigames are not in the template; the agent builds them
  as new code when a game needs them.
