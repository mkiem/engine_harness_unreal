---
name: playtest-and-balance
description: Making every fight as hard as intended and the first playable fun from start to end - battle simulation with studio_simulate_battle, reading the results, tuning numbers, and guided playtests with the developer. Load it for the balance phase, or whenever the developer says something is too hard, too easy, too slow or boring.
---

# Playtest and balance

Goal: from the first slime to the boss, every fight is in its intended range, levelling keeps pace, and a player who has
never seen the game can finish it.

## 1. Simulate every fight

`studio_simulate_battle` without `enemies` fights every encounter group and every story battle many times with the
game's real rules (equipment, elements, statuses, enemy AI, boss phases); with `enemies` and `level`, one group; with
`party`, the party the player will have then (members who joined later included, in their starting equipment). It reports win rate, rounds and HP left, and a verdict:

| Verdict | Meaning | Right for |
| --- | --- | --- |
| easy | always wins with most HP left | early wild battles |
| fair | wins, but it costs HP | most wild battles |
| hard | sometimes loses | an area's toughest group, bosses at the expected level |
| deadly | usually loses | nothing the player must fight at that level |

**Test at the level the player will be.** Estimate it: the party starts at `party.json` `level`; each level needs
`xp_to_next` XP (`data/formulas.json`); count the XP from the battles they'll have fought (about one battle per 8 steps
on encounter tiles). Simulate each area's groups at that level, and bosses at that level and one higher.

## 2. Tune, one change at a time

| Problem | Change |
| --- | --- |
| A group is deadly | Lower its `atk` (about 10%), or remove it from the area's `groups` |
| Battles drag on | Lower enemy `hp`, or raise skill `power` |
| Battles are over before they start | Raise enemy `hp` and `def` |
| Magic is useless / everything | Change skill `power` or the `magic` formula |
| Levels come too slowly | Raise enemy `xp`, or lower `xp_to_next` |
| Boss too hard at the expected level | Lower its `hp` first (keeps it exciting), then `atk` |
| Players can't afford healing | Raise enemy `gold` or lower item `price` |
| A status is too strong (whole party asleep) | Lower its `chance` or `turns`, or make the AI use it `once` |
| A boss is a pushover once you know its weakness | Raise its `resist`, or weaken its weakness with a phase that changes `ai` |
| The simulator wins but people struggle | The autopilot is a good player; leave a margin (fair, not easy, for regular fights) |

After each change, simulate the affected groups again; results are kept in `.studio/balance.json`. Record the important
decisions with `studio_design_update` ("Wolves hit 10% softer: deadly at level 1").

## 3. Playtest with the developer

Ask them to play from New Game to the ending (`godot_run`, `window: true`) and to say out loud whatever they think.
Ask afterwards, one at a time:

1. Was there a moment you didn't know where to go? (Add a hint to an NPC, or a sign.)
2. Was any fight annoying or too long? (Tune it.)
3. Did you ever run out of money or potions? (Economy.)
4. What was the best moment? What would make it better?

Write the answers in the design's `phases.balance.notes` and fix the top issues together. If the game crashes or
behaves oddly, reproduce it with `studio_check` and `godot_run` output, and fix it before anything else. For story
bugs ("the gate never opened"), replay the event with `studio_test_event` in the same situation.

## Done when

Every encounter group and boss has been simulated, each is in its intended range, and the developer has played the first
playable start to finish and is happy. Mark the phase done.
