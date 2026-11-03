---
name: godot-rpg-template
description: The structure of the Godot 4 RPG every Engine Harness game starts from - where each piece of content and code lives, the data formats, and how to extend it safely. Load it before changing a game's data, maps, art files or scripts.
---

# The Godot RPG template

Everything a game contains is in plain files. Change content in data, not code. Run `studio_check` after any change.

## Content (data)

| File | Format |
| --- | --- |
| `data/game.json` | `title`, `tagline`, `tile_size` (16), sprite sheet paths (`tiles`, `hero_sprite`, `npc_sprites`, `enemy_sprites`), `npc_frames`, `enemy_frames`, `title_background`, `battle_background` (colours), `title_music`, `battle_music`, `ending_music`, `ui` (`panel`, `border`, `text`, `accent` colours, `corner`, `font` path, `font_size`) |
| `data/party.json` | `members` (character ids), `level`, `gold`, `items` (`{id: count}`), `map`, `position` `[x, y]` |
| `data/characters.json` | per id: `name`, `role`, `base` `{hp, mp, atk, def, mag, spd}`, `growth` (added per level, may be fractional), `skills` (ids known at start), `learns` `{"level": skill id}` |
| `data/enemies.json` | per id: `name`, `frame` (index in `art/enemies.png`), `level`, `stats` `{hp, mp, atk, def, mag, spd}`, `skills`, `xp`, `gold`, optional `drop` `{item, chance}` |
| `data/skills.json` | per id: `name`, `mp`, `power` (multiplier), `type` `physical` / `magic` / `heal`, `about` |
| `data/items.json` | per id: `name`, `effect` `heal` / `mp`, `amount`, `price`, `about` |
| `data/formulas.json` | maths as text, evaluated by Godot: `physical`, `magic`, `heal` (variables `atk`, `mag`, `def`, `level`, `power`, `variance` 0.9 to 1.1), `xp_to_next` (`level`), `run_chance` (`spd`); functions like `max`, `min` work |
| `data/encounters.json` | per zone: `rate` (chance per step on encounter tiles), `groups` (lists of enemy ids) |
| `data/dialogue.json` | per key: a list of lines, shown one at a time |

## Maps

- `maps/<id>.txt`: one character per tile, every row the same length.
- `maps/legend.json`: per character: `tile` (column in `art/tiles.png`), `solid` (blocks walking), `encounters`
  (random battles here), `name`. Add a character here before using it in a map.
- `maps/maps.json`: per map id: `name`, `file`, `music` (`res://audio/...wav`), `encounters` (zone id or `""`), `npcs`
  `[{id, x, y, frame, dialogue, role?, stock?}]` (`role` `inn` heals the party, `shop` sells `stock`), `warps`
  `[{x, y, to, to_x, to_y, requires?, locked?}]` (stepping on x,y moves to map `to` at to_x,to_y). Coordinates start at
  0,0 top left.

## Story events (all in an NPC's entry in maps/maps.json)

| Field | Effect |
| --- | --- |
| `sets: "met_elder"` | Sets that flag after the NPC has spoken |
| `dialogue_after: {"beat_alpha": "elder_after"}` | Says another dialogue once a flag is set (the last matching flag wins) |
| `only_if: "flag"` / `hide_if: "flag"` | The NPC is only there once a flag is set / is gone once it is set |
| `role: "battle"`, `enemies: [...]` | After talking, a fixed battle (a boss); no running away unless `no_run: false`. Winning sets `flag` (default `beat_<id>`) and the NPC disappears (unless `stay: true`); `after` is a dialogue shown on returning to the map |
| `"ending": true` on a battle NPC | Winning it shows the ending: the lines of `ending` in `data/dialogue.json`, "The End", then the title screen |
| `role: "chest"`, `item`, `count`, `gold` | Gives them once (flag `chest_<map>_<id>`); `open_frame` is the picture once opened. Chests need no dialogue |
| Warp `requires: "flag"`, `locked: "key"` | The warp stays shut, saying the `locked` dialogue, until the flag is set |

`studio_check` reports flags that something waits for but nothing sets. The sample game has all of these: the
elder's dialogue changes after the Great Wolf (a boss with `"ending": true`) in the meadow, next to a chest.

## Art and sound

- `art/tiles.png`: 16x16 tiles in **one row**; the legend's `tile` is the column. Add tiles by widening the image.
- `art/hero.png`: 2 columns (two walking frames) x 4 rows (facing down, left, right, up), 16x16 each.
- `art/npcs.png`: 16x16 frames in one row (`npc_frames` in game.json); an NPC's `frame` picks one.
- `art/enemies.png`: 32x32 frames in one row (`enemy_frames`); an enemy's `frame` picks one.
- `art/npcs.png` in the sample: frames 0-3 people, 4 a closed chest, 5 an open chest, 6 the Great Wolf.
- `audio/`: music `title`, `town`, `field`, `battle` (`.wav`, loops) and sounds `select`, `hit`, `heal`, `magic`,
  `levelup`, `victory`, `defeat`, `coin`, `cancel`, `item`, `door`, `encounter`, and a skill's own id (`fire.wav` plays
  for the skill `fire`, else `magic`/`hit`/`heal`). A missing sound is skipped quietly.
- Make art with `studio_paint` (text grids into a sheet frame) and look at it with `studio_preview`; make music with
  `studio_music` and sounds with `studio_sound`.
- New projects start with generated placeholders; `.studio/placeholders.json` tracks which are still untouched.

## Code

| Script | Does |
| --- | --- |
| `scripts/autoload/data.gd` (`Data`) | Loads every data file; `Data.formula(name, values)`; `Data.texture(path)` |
| `scripts/autoload/game_state.gd` (`Game`) | Party, inventory, gold, flags, position; stats per level; XP; save and load (`user://save.json`) |
| `scripts/autoload/router.gd` (`Router`) | Screen changes with a fade: `title()`, `overworld()`, `battle(enemy_ids)` |
| `scripts/autoload/sound.gd` (`Sound`) | `music(path)`, `play(name)` |
| `scripts/world/overworld.gd` | Builds the map from text, grid movement, NPC talk, inn, shop, warps, encounters, pause menu |
| `scripts/battle/battle_logic.gd` (`BattleLogic`) | All battle rules, no screens: turn order, actions, enemy AI, rewards |
| `scripts/battle/battle_scene.gd` | The battle screen and command menus |
| `scripts/ui/*.gd` | Title screen, dialogue box (`say(lines)`, `choose(question, options)`), pause menu, ending (built in code) |
| `tools/self_test.tscn`, `tools/sim_battle.tscn` | Data and systems self-test; battle simulator |

`Game.flags` is a dictionary for story progress ("met_elder": true); use it for events and gated doors.

## Extending safely

- Add content (a skill, an enemy, a map, an NPC) in data first; only touch code for new kinds of behaviour.
- For a new behaviour, add to the script that owns it (a new NPC `role` goes in `overworld.gd` `interact()`; a new
  skill `type` in `battle_logic.gd` `act()`); keep the rules in `BattleLogic` so the simulator stays truthful.
- Keep UI in code, like the existing screens, so scenes stay simple.
- After code changes: `godot_check`, then `studio_check` (it also plays the title screen, walks into a battle and shows
  the ending).
- Never remove the `--autotest` paths in the scenes: the checks depend on them.
