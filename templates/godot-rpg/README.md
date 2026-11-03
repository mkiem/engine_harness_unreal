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
| The heroes | `data/characters.json` | Stats and growth, skills they know and learn, starting equipment, weaknesses |
| The monsters | `data/enemies.json` | Stats, weaknesses and resistances, immunities, AI rules, boss phases, XP, gold, drops, picture |
| Skills and spells | `data/skills.json` | MP, power, type (physical, magic, heal, support), target, element, statuses caused or cured, revive |
| Items and equipment | `data/items.json` | Consumables (heal, MP, revive, cure, bombs, buffs), weapons, armour and accessories, key items |
| Status effects | `data/statuses.json` | Poison, sleep, stun, silence, blind, regen, stat ups and downs: what each does and for how long |
| Battle rules | `data/rules.json`, `data/formulas.json` | Party size, elements, criticals, weakness multipliers, sell price; damage, healing, XP as maths |
| Which monsters appear where | `data/encounters.json` | How often, and which groups |
| The starting party | `data/party.json` | Members, level, gold, items, starting map and spot |
| Story | `data/events.json`, `data/quests.json` | Conversations with choices, quests, recruits, cutscenes, boss fights, the ending |
| Simple lines | `data/dialogue.json` | Shopkeepers, signs, the ending text |
| Maps | `maps/*.txt` | One character per tile; `maps/legend.json` says what each character is |
| People, doors and places | `maps/maps.json` | NPCs (with their event, shop, inn, chest), warps, music, triggers, arrival events, battle backgrounds |
| Menus and text boxes | `data/game.json` `ui` | Colours, corners, font and text size |
| Pictures | `art/` | `tiles.png` (16x16 tiles in one row), `hero.png`, `npcs.png`, `enemies.png` |
| Music and sounds | `audio/` | `title`, `town`, `field`, `battle` music; `select`, `hit`, `heal`, `magic`, `levelup`, `victory` and other sounds |
| The game's design | `design/GAME_DESIGN.md` | What the game is, decided with Engine Harness |

The code is in `scripts/`: `autoload/` for data, game state (party, equipment, quests, saving), `world/` for the map
and story events, `battle/battle_logic.gd` for every battle rule and `battle/battle_scene.gd` for the battle screen,
`ui/` for the title, text box, pause menu and ending.

## Checks

- `tools/self_test.tscn`: checks every reference between data files, the formulas, levelling, equipment, the party, saving, the battle rules and every story event.
- `tools/sim_battle.tscn`: fights a battle many times and reports how hard it is.
- `tools/event_test.tscn`: plays a story event without the screen and reports what it said and changed.
- `scenes/ending.tscn`: the ending, shown after the battle marked `"ending": true` (the Great Wolf in the meadow).

Engine Harness runs both for you ("check my game", "is the wolf too hard?").
