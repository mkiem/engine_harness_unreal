---
name: godot-rpg-template
description: The structure of the Godot 4 RPG every Engine Harness game starts from - where each piece of content and code lives, every data format (party, equipment, skills, statuses, elements, enemy AI, events, quests, maps), and how to extend it safely. Load it before changing a game's data, maps, art files or scripts.
---

# The Godot RPG template

Everything a game contains is in plain files. Change content in data, not code. Run `studio_check` after any change.
The sample game in a new project (Fernvale: a village, a meadow, a forest, a recruit, two quests, a boss with two
phases, an ending) uses every feature below; read its files as examples.

## Content (data/)

| File | Format |
| --- | --- |
| `game.json` | `title`, `tagline`, `tile_size` (16), sprite sheets (`tiles`, `hero_sprite`, `npc_sprites`, `enemy_sprites`), `npc_frames`, `enemy_frames`, `title_background`, `battle_background`, `title_music`, `battle_music`, `ending_music`, `ui` (`panel`, `border`, `text`, `accent` colours, `corner`, `font`, `font_size`) |
| `rules.json` | `max_party` (4), `reserve_xp` (0.5), `elements` (["fire", "ice", "thunder", "holy"]), `hit_chance`, `crit_chance`, `crit_multiplier`, `weak_multiplier` (1.5), `resist_multiplier` (0.5), `spread_power` (0.75: hitting everyone is weaker per target), `sell_rate` (0.5) |
| `party.json` | `members` (starting character ids), `level`, `gold`, `items` (`{id: count}`), `map`, `position` `[x, y]` |
| `characters.json` | per id: `name`, `role`, `base` `{hp, mp, atk, def, mag, spd}`, `growth` (per level, may be fractional), `skills` (known at start), `learns` `{"level": skill}`, `equipment` `{weapon, armor, accessory}` (item ids), optional `weak` (elements) |
| `skills.json` | per id: `name`, `mp`, `type` (`physical`, `magic`, `heal`, `support`), `power` (multiplier), `target` (`enemy`, `all_enemies`, `ally`, `all_allies`, `self`, `ko_ally`; default from type), `element`, `status` `{id, chance}` (inflicted on hit, or given by a support skill), `cures` (status ids), `revive` + `revive_percent`, `about` |
| `items.json` | **Consumables**: `effect` (`heal`, `mp`, `revive`, `cure`, `damage`, `buff`), `amount`, `cures`, `status`, `target`, `element`, `price`, `about`. **Equipment**: `slot` (`weapon`, `armor`, `accessory`), `stats` `{atk: 3, ...}` (may be negative), `users` (character ids; empty = anyone), `element` (weapon), `resist` (elements), `immune` (statuses), `crit` (extra critical chance), `status` (weapon: `{id, chance}` on hit), `price`. **Key items**: `"kind": "key"` (story only; can't be sold or used) |
| `statuses.json` | per id: `name`, `about`, `text` ("%s is poisoned!"), `turns` (0 = until cured), and effects: `damage_percent` / `heal_percent` (each turn), `skip_turn` (+ `wake_on_hit`, `skip_text`), `no_skills`, `hit_chance` (multiplier), `stats` (multipliers, such as `{"atk": 1.3}`), `cancels` (opposites), `lasting` (stays after battle), `harmful`, `color` |
| `enemies.json` | per id: `name`, `frame`, `level`, `stats` `{hp, mp, atk, def, mag, spd, crit?, evade?}`, `skills`, `weak`/`resist`/`absorb` (elements), `immune` (statuses), `statuses` (start with), `element` (its attacks), `on_hit` `{id, chance}`, `ai` (rules, below), `phases` (below), `xp`, `gold`, `drops` `[{item, chance}]`, optional `scale` (sprite size) |
| `formulas.json` | maths as text: `physical`, `magic`, `heal` (variables `atk`, `mag`, `def`, `level`, `power`, `variance`), `xp_to_next` (`level`), `run_chance` (`spd`) |
| `encounters.json` | per zone: `rate` (chance per step on encounter tiles), `groups` (lists of enemy ids) |
| `dialogue.json` | per key: lines. Used by NPCs without events, locked warps (`locked`), and `ending` |
| `events.json` | story events: lists of commands. See the **events-and-cutscenes** skill |
| `quests.json` | per id: `name`, `stages` `{start: "...", ..., done: "..."}` (the text the player reads in the Quests menu) |

### Enemy AI and boss phases

`"ai"` is a list of rules tried in order; the first whose conditions hold (and whose `chance` roll passes) is used:
`{"skill": "bite" | "attack" | "defend", "chance": 0.4, "target": "random" | "weakest" | "strongest" | "caster",
"once": true, "if": {...}}`. Conditions: `hp_below`, `hp_above` (fractions of its HP), `turn_every`, `turn_at_least`,
`ally_hurt` (fraction), `ally_down`, `target_without` (status: only targets lacking it), `self_without` (status). End the
list with `{"skill": "attack"}` so it always does something. Without `ai`, an enemy uses an affordable skill 35% of
the time.

`"phases"`: `[{"below": 0.5, "say": "It howls with rage!", "stats": {"atk": 1.2}, "ai": [...], "skills": [...],
"statuses": ["atk_up"], "heal": 0}]`: each applies once when HP falls to that fraction.

## Maps (maps/)

- `<id>.txt`: one character per tile, every row the same length. `legend.json`: per character `tile` (column in
  `art/tiles.png`), `solid`, `encounters`, `name`.
- `maps.json`, per map: `name`, `file`, `music`, `encounters` (zone or ""), `battle_background` (colour or
  `res://...png`), `on_enter` `[{event, once, if?}]`, `triggers` `[{x, y, event, once, if?}]`, `warps`
  `[{x, y, to, to_x, to_y, requires?, locked?}]`, and `npcs`:
  `{id, x, y, frame, event?, dialogue?, dialogue_after?, sets?, only_if?, hide_if?, role?}` with roles `inn` (`price`),
  `shop` (`stock`; players buy, see what equipment changes, and sell at `sell_rate`), `chest` (`item`, `count`, `gold`,
  `open_frame`), `battle` (`enemies`, `flag`, `ending`). An NPC with an `event` runs it instead of dialogue and role.

## Art and sound

- `art/tiles.png` (16x16, one row), `art/hero.png` (2 frames x 4 directions), `art/npcs.png` (16x16 frames; the sample:
  0-3 villagers, 4-5 chest closed/open, 6 Great Wolf, 7 blacksmith, 8 ranger), `art/enemies.png` (32x32 frames: slime,
  bat, wolf, wisp, sporecap, toxic slime).
- `audio/`: music `title`, `town`, `field`, `battle` and sounds `select`, `confirm`, `cancel`, `hit`, `heal`, `magic`,
  `levelup`, `victory`, `defeat`, `coin`, `item`, `door`, `encounter`, plus a skill's own id when that file exists.
- Make art with `studio_paint`/`studio_preview`, music with `studio_music`, sounds with `studio_sound`.

## Code

| Script | Does |
| --- | --- |
| `autoload/data.gd` (`Data`) | Loads every data file; `Data.formula()`; `Data.texture()`; applies the UI theme |
| `autoload/game_state.gd` (`Game`) | Party, reserve, equipment (`equip`, `gear_traits`, `best_equipment`), stats, XP and level-ups, inventory, flags, quests, join/leave/swap, items and skills outside battle, 3 save slots |
| `autoload/router.gd` (`Router`) | Screen changes with a fade |
| `autoload/sound.gd` (`Sound`) | `music(path)`, `play(name, fallback)` |
| `battle/battle_logic.gd` (`BattleLogic`) | **All battle rules**: turn order by speed, `begin_turn`/`end_turn` (statuses), `act` (attack, skills, items, defend, run), targets and scopes, hit, critical, elements, statuses, revive, enemy AI, boss phases, rewards, the autopilot |
| `battle/battle_scene.gd` | The battle screen: menus, targets, damage numbers, status tags, level-up messages |
| `world/overworld.gd` | The map: movement, NPCs, inn, shop, chests, warps, triggers, encounters, and the host events run on |
| `world/event_runner.gd` (`EventRunner`) | Runs event commands; `EventRunner.test(conditions)` |
| `world/event_check.gd` (`EventCheck`) | Checks event commands against the data |
| `ui/*.gd` | Title (save slots), dialogue box (`say`, `choose`), pause menu (items, equip, skills, status, party, quests, save), ending |
| `tools/self_test.tscn` | Data references, formulas, levelling, equipment, party, saving, every battle ending, the battle rules, every event |
| `tools/sim_battle.tscn`, `tools/event_test.tscn` | The battle simulator (`studio_simulate_battle`) and event player (`studio_test_event`) |

## Extending safely

- Content first (a new status, skill, item, enemy, event): it is all data. New kinds of behaviour need code:
  a new item `effect` or skill `type` goes in `BattleLogic._apply` (and `Game.apply_restore` if it works outside battle),
  and its name in `rules.json` `extra_item_effects` / `extra_skill_types` so `studio_check` accepts it; a new event
  command in `EventRunner._do` and its `COMMANDS` list (the checks read that list); a new AI condition in
  `BattleLogic._rule_holds` and `rules.json` `extra_ai_conditions`.
- Keep rules in `BattleLogic` (never in the battle screen) so the simulator stays truthful.
- UI stays in code, like the existing screens.
- After code changes: `godot_check`, then `studio_check` (self-test, title, a walk into a battle, the ending).
- Never remove the `--autotest` paths in the scenes: the checks depend on them.
