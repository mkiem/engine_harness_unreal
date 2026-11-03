# {{TITLE}}

{{PITCH}}

Made with Godot 4 and Engine Harness. Open this folder in Engine Harness and say "continue my game": it reads
`design/GAME_DESIGN.md`, knows what is done and what is next, and keeps building with you.

## Play it

Open `project.godot` in Godot 4 and press F5, or ask Engine Harness to run the game. Arrow keys move, Enter or
Space talks and confirms, Esc opens the menu and goes back.

## Where everything lives

| To change | Edit | Example |
| --- | --- | --- |
| The heroes | `data/characters.json` | Starting stats, growth per level, skills they know and learn |
| The monsters | `data/enemies.json` | Stats, XP and gold, items they drop, which picture (`frame`) |
| Skills and spells | `data/skills.json` | MP cost, power, physical / magic / heal |
| Items | `data/items.json` | What they restore, their price |
| Battle maths | `data/formulas.json` | `physical`, `magic`, `heal`, `xp_to_next`, `run_chance`, written as maths |
| Which monsters appear where | `data/encounters.json` | How often, and which groups |
| The starting party | `data/party.json` | Members, level, gold, items, starting map and spot |
| What people say | `data/dialogue.json` | Lines for each NPC |
| Maps | `maps/*.txt` | One character per tile; `maps/legend.json` says what each character is |
| NPCs, doors and exits | `maps/maps.json` | Who stands where, shops and inns, warps between maps, music |
| Pictures | `art/` | `tiles.png` (16x16 tiles in one row), `hero.png`, `npcs.png`, `enemies.png` |
| Music and sounds | `audio/` | `title`, `town`, `field`, `battle` music; `select`, `hit`, `heal`, `victory` sounds |
| The game's design | `design/GAME_DESIGN.md` | What the game is, decided with Engine Harness |

The code is in `scripts/`: `autoload/` for data, game state and saving, `world/overworld.gd` for the map,
`battle/battle_logic.gd` for the battle rules and `battle/battle_scene.gd` for the battle screen.

## Checks

- `tools/self_test.tscn`: checks every reference between data files, the formulas, levelling and saving.
- `tools/sim_battle.tscn`: fights a battle many times and reports how hard it is.

Engine Harness runs both for you ("check my game", "is the wolf too hard?").
