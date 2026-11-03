---
name: events-and-cutscenes
description: Writing the game's story events with a beginner - conversations with choices, quests, people who join or leave the party, chests and rewards, locked paths, cutscenes where people move, boss fights and the ending - as data in data/events.json, tested with studio_test_event. Load it whenever story, quests, a recruit, a cutscene or a scripted battle is being made or changed.
---

# Events and cutscenes

Story happens in **events**: lists of commands in `data/events.json`, run one after another. No code is needed for
any of it. Events start from:

- an NPC with `"event": "<id>"` in `maps/maps.json` (talking to them);
- a map's `"on_enter": [{"event": "<id>", "once": true}]` (arriving there);
- a map's `"triggers": [{"x": 24, "y": 7, "event": "<id>", "once": true}]` (stepping on a tile);
- `"if": {conditions}` on a trigger or on_enter entry runs it only when they hold.

## Commands

| Command | Does |
| --- | --- |
| `{"say": ["line", "line"], "who": "Elder"}` | Text box, one line at a time, with the speaker's name. Lines of up to about 80 characters |
| `{"choice": "Will you help?", "options": [{"text": "Yes", "then": [...]}, {"text": "No", "then": [...]}]}` | The player picks; that option's commands run |
| `{"if": {...}, "then": [...], "else": [...]}` | Conditions: `flag`, `not_flag`, `item` (+`count`), `gold`, `member`, `quest` (+`stage` or `not_stage`); all must hold |
| `{"set": "flag"}` / `{"unset": "flag"}` | Story progress (saved with the game) |
| `{"give": "item", "count": 2}` / `{"take": "item"}` / `{"gold": 50}` | Rewards and payments (give and gold announce themselves) |
| `{"quest": "wolf", "stage": "start"}` | Starts or advances a quest from `data/quests.json`; `"done"` completes it |
| `{"join": "ranger", "level": 4}` / `{"leave": "ranger"}` | Party members come and go (equipment goes with them; up to `max_party` travel, the rest wait in reserve) |
| `{"hide": "npc_id"}` / `{"show": "npc_id"}` | Someone on the current map disappears or comes back (remembered) |
| `{"move": "npc_id" or "player", "path": ["up", "up", "left"]}` / `{"face": "player", "dir": "left"}` | Cutscene movement |
| `{"wait": 0.5}` `{"music": "res://audio/x.wav"}` `{"sound": "levelup"}` | Pacing and mood |
| `{"heal": true}` `{"inn": 10}` `{"shop": ["potion", "ether"]}` | Restore the party; an inn for a price; a shop |
| `{"battle": ["enemy", ...], "flag": "beat_x", "no_run": true, "background": "#3a1e1e", "then": [...], "lose": [...], "can_lose": false, "ending": false}` | A fixed battle. The event stops; winning sets `flag` and runs `then` back on the map; `can_lose: true` makes losing continue with `lose` instead of game over; `ending: true` shows the ending after `then` |
| `{"warp": "map", "x": 3, "y": 4}` | Moves the party to another map |
| `{"ending": true}` | The ending (the lines of `ending` in `data/dialogue.json`, then "The End") |
| `{"event": "other_id"}` / `{"end": true}` | Runs another event / stops here |

Quests live in `data/quests.json`: `{"id": {"name": "...", "stages": {"start": "what to do", "found": "...", "done": "..."}}}`.
The pause menu's Quests page shows each quest's current stage text, so write stages as instructions to the player.

## Patterns (the sample game has each one)

- **Quest giver who remembers**: an `if` ladder from the end backwards: `quest done?` thank them; `flag accepted?`
  remind them; else the request with a choice (`events.elder`).
- **Fetch quest**: the giver starts the quest and sets a flag; the item appears (an NPC with `"only_if"` that flag, whose
  event gives a key item and hides itself); the giver checks `{"item": ...}`, takes it, rewards (`events.kid`,
  `charm_spot`). Key items have `"kind": "key"` in items.json.
- **Recruit**: say, choice, `join`, `hide` the NPC (`events.bram`).
- **Locked path**: a warp with `"requires": "flag"` and `"locked": "dialogue key"`; the quest giver sets the flag.
- **Warning before danger**: a `once` trigger a few tiles before the boss (`wolf_warning`).
- **Boss and ending**: an NPC event that talks, then `battle` with `no_run`, `ending`, and `then` completing the quest.
- **Arrival**: `on_enter` with `once` for a line when the player first arrives (`forest_enter`).

## Working with the developer

1. Agree the beat in words first ("the elder asks for help; if you say yes, the gate opens and you get potions").
2. Write the event, and update the NPC or map entry that starts it.
3. **Test every branch** with `studio_test_event`. Set up the situation with `flags`, `items`, `quests`, `members`;
   pick options with `choices`. Check `Changes` and what stopped it. For example:
   `{"event": "kid", "flags": ["charm_quest"], "items": {"kid_charm": 1}}`.
4. `studio_check` (it catches unknown commands, missing items/enemies/quests, overlong lines, flags nothing sets).
5. Play it (`godot_run`, `window: true`) and read it together; fix pacing (split long speeches, add `wait`).

Keep events short and readable: a long story is many small events, not one huge one. Give every NPC something to say
after their part of the story is over (the `then` of the "already done" branch).
