---
name: story-and-dialogue
description: Writing the story and every line of dialogue with a beginner - premise, story beats, characters' voices, the ending - and wiring it into the game with flags, events, a boss and an ending screen. Load it for the story phase or whenever dialogue or story events are written or changed.
---

# Story and dialogue

Goal: a story the first playable can tell in 20 minutes, from a hook to an ending, told through what people say.

## Shape the story (one question at a time)

1. **Premise**: who wants what, and what stands in the way? One or two sentences. Offer three takes that fit the concept.
2. **Beats**: three to six moments the player lives through, such as: the hook (something goes wrong), the call (someone
   asks for help), the journey (the wild area), the twist (it's not what it seemed), the climax (the boss), the ending.
3. **Ending**: what changes for the world and the hero? For a first playable, a satisfying ending with a hint of more.

Record `concept.story.premise`, `concept.story.beats` (a list) and `concept.story.ending` with `studio_design_update`.

## Write the dialogue

`data/dialogue.json`: each key is a list of lines, shown one per box. Lines must fit the box: **at most about 60
characters**, two short sentences at most. Write in the character's voice (from **character-design**): the elder is
slow and kind, the kid is excited, the villain is smug. Each NPC should say something useful (a hint, a direction) or
something that builds the world, ideally both. Avoid walls of exposition: three lines per NPC is plenty.

## Make the story happen in the game

Anything beyond a simple line belongs in an **event** (a conversation with choices, a quest, a recruit, a cutscene, a
boss): load **events-and-cutscenes** and write it in `data/events.json`, then give the NPC `"event": "<id>"`. Plan
quests in `data/quests.json` (each stage's text is what the player reads in the Quests menu).

Story progress is stored as **flags** (true/false names like `met_elder`). Simple NPCs without events use, in
`maps/maps.json`:

- `"sets": "met_elder"`: talking sets the flag.
- `"dialogue_after": {"met_elder": "elder_again", "beat_boss": "elder_thanks"}`: what they say changes as the story moves.
- `"only_if"` / `"hide_if"`: someone appears or leaves (the bridge guard leaves once `beat_boss`).
- A warp with `"requires": "met_elder"` and `"locked": "gate_closed"` stays shut until then (and says why).
- The boss: `"role": "battle"`, `"enemies": [...]`, `"after": "boss_defeated"` (dialogue on returning to the map), and
  `"ending": true` to end the first playable: then `ending` in `data/dialogue.json` plays, then "The End".

Map the beats to these: hook = the first NPC's lines; call = `sets` a flag; journey = a warp gated on that flag; climax =
the boss; ending = the `ending` lines. `studio_check` warns when a flag is waited for but never set.

## Check it

`studio_check`; `studio_test_event` for each event and each branch of its choices; then play from New Game to the end with the developer (`godot_run` with `window: true`), reading every
line. Fix lines that are too long or say the same thing twice.

## Done when

Premise, three or more beats and an ending are in the design, the game can be finished (a battle with `"ending": true`),
and the developer has read the dialogue in the game. Mark the phase done.
