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
4. A playable game appears: a short but complete RPG to learn from and reshape. It has:
   - a village with an elder who gives you a quest, an inn, a shop and a blacksmith;
   - a meadow with a side quest;
   - a forest where a ranger joins you;
   - a boss with two phases;
   - an ending.

   Everything in it is a placeholder.
5. Phase by phase, the agent replaces the placeholders with their game: art, characters, maps, battles, items, story,
   menus, music. After each step it runs the game and says what to try.
6. The agent simulates every battle to tune difficulty, then plays the game through with them.
7. **Build and share**: a single `.exe` in `builds/windows/` to send to friends or put on itch.io.

Next time, open the game's folder and pick **Continue my game**: the agent reads the design and says what's next.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Skills | `skills/<name>/SKILL.md` | How to run each phase with a beginner (14 skills, below) |
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
| Story and dialogue | `story-and-dialogue`: premise, beats, dialogue, flags, the ending; `events-and-cutscenes`: every event command, quests, recruits, cutscenes, boss fights, with tested patterns |
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
| `studio_simulate_battle` | Each encounter group and story battle fought hundreds of times with the game's rules (equipment, elements, statuses, enemy AI, boss phases), for any party and level: win rate, rounds, HP left, a verdict |
| `studio_test_event` | A story event played without the screen in a given situation (flags, items, quests, members), with chosen answers: every line, every change, what stopped it |
| `studio_paint`, `studio_preview` | Pixel art from text grids into sprite sheets; an enlarged preview to look at |
| `studio_music`, `studio_sound` | Chiptune music from notes (melody, bass, drums); 18 sound effect presets |
| `studio_install_godot` | Godot 4.4.1 into Engine Harness's folder (about 60 MB) |
| `studio_export` | The Windows .exe (first time: the export templates, about 1 GB, with the developer's agreement) |

### The template

Everything a game contains is data; code is only needed for new kinds of behaviour. The template is a classic 16-bit
style RPG.

- **Party**: up to four members fight together, and the rest wait in reserve and earn half XP. Members join and leave
  through the story, taking their equipment with them.
- **Equipment**: weapon, armour and an accessory per member. Items can add stats (including negative ones), a weapon
  element, resistances, status immunities, extra critical hits, or a status on hit. The Equip menu compares stats and
  has an Optimize button.
- **Battles**:
  - turn order by speed, with critical hits, misses and evasion;
  - elements (weaknesses, resistances, absorbing);
  - 11 statuses: poison, sleep, stun, silence, blind, regen, attack and defence up and down, haste;
  - skills that hit one or every enemy, heal or buff one or every ally, revive, or cure;
  - consumables: heal, MP, revive, cure, bombs, buffs;
  - enemy AI rules (conditions, targeting, chances), and boss phases that change a boss's stats and tactics as its HP
    falls.
- **Story**: events are lists of commands, run from NPCs, from arriving on a map, or from stepping on a tile. They
  cover:
  - dialogue with speakers, choices and conditions;
  - flags, items, gold and quests;
  - recruits;
  - people who appear and leave;
  - cutscene moves;
  - inns, shops, story battles (which can be lost without game over, or end the game), warps and the ending.
- **Menus and saving**:
  - shops that buy and sell, showing what equipment changes;
  - inns with prices;
  - three save slots, with play time;
  - a pause menu with Items, Equip, Skills (healing outside battle), Status, Party, Quests and Save.

The data checks cover all of it in plain words:
- references between files, values the game understands, enemy AI and boss phases;
- maps: uneven rows, NPCs and triggers on walls, warps that bounce;
- story: event commands, quests, overlong lines, and story flags nothing sets.

A game that adds its own kinds of skills, items or event commands declares them, and the checks accept them.

## How it is tested

- `tests/studio.spec.ts`, `tests/skills.spec.ts`: project creation, data checks (including every RPG system and event
  command), design, phases, painting, music, and that every skill is well formed, covers its phase and names only real
  tools.
- The template's own `tools/self_test.tscn`, run by `studio_check`, with real Godot:
  - data references, formulas, levelling, equipment on and off, joining and leaving;
  - three-slot save round trips;
  - every encounter and story battle reaching an end;
  - the battle rules themselves: poison, immunity, sleep and waking, buffs wearing off, weakness, resistance, absorb,
    revive, boss phases;
  - every event run through each of its choices.
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
- Minigames, vehicles, day and night, and real-time (action) battles are not in the template; the agent builds them as
  new code when a game needs them, following the template's patterns.
