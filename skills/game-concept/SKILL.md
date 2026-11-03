---
name: game-concept
description: The concept interview that starts every game - what kind of game, what it should feel like, the setting, the core loop and a first playable goal - one question at a time, then creates the project. Load it when someone wants to start a new game or the concept phase is current.
---

# Concept: finding the game

Goal: in about ten short questions, turn "I want to make a game" into a clear, small, exciting plan, then create the
project so the developer can play something within minutes.

## The interview

Ask **one question at a time**, with two or three options and a recommendation. Accept any answer, including "you
choose". Keep a running summary and show it back every three or four answers.

1. **What kind of game?** Today's studio template is a 2D pixel-art RPG (towns, monsters, turn-based battles, levels),
   in the spirit of Final Fantasy, Dragon Quest and Pokémon. If they want something else (platformer, puzzle, 3D),
   say honestly that the RPG path is the fully guided one today, and that the RPG engine can carry many ideas (a
   monster-collecting game, a dungeon crawler, a story adventure with light battles). If they still want another
   genre, note it in `scope.later` and continue with what the template can do, or build it with them unguided.
2. **Which games should it feel like?** (Two or three titles; ask what they love about each.)
3. **Who is it for?** (Themselves, friends, kids, people who love old RPGs...)
4. **Where does it take place?** Offer three settings that fit their answers (a cosy forest village; a floating sky
   archipelago; a haunted seaside town).
5. **What is the tone?** (Funny, cosy, epic, spooky, bittersweet.)
6. **Who is the hero, in one line?** (The character-design phase fills in the rest.)
7. **What does the player do over and over?** Propose a core loop in one sentence for them to adjust, such as "explore
   a region, fight in its wild areas, level up, buy gear in town, beat the region's boss".
8. **What makes it special?** One twist (battles are short puzzles; the town grows as you help people; the hero is a
   retired villain). Look for it in the **Gameplay Atlas**: `studio_find_mechanic` with their words, read the best two
   or three with `studio_mechanic`, and describe each in a sentence ("in Stardew Valley you ..."). When they pick one,
   add it with `add: true`: it becomes the game's first mechanic card (see **mechanic-design**). Then turn the twist and
   their favourite things into **two or three pillars**: short rules every later decision is checked against
   ("Battles are over in under a minute").
9. **The first playable:** propose something finishable in a few sessions: "a village, one wild area, a dungeon and a
   boss; about 20 minutes of play". Put everything bigger in `scope.later`.
10. **The name.** Offer three title ideas; they pick or invent one.

## Recording it

Write the answers into the design as you go with `studio_design_update`, for example:

```json
{
  "pitch": "A cosy RPG about a retired villain making amends in the village they once terrorised.",
  "inspirations": ["Final Fantasy IV", "Stardew Valley"],
  "audience": "Friends who grew up with SNES RPGs",
  "pillars": ["Battles under a minute", "Every villager has a story", "Funny, never mean"],
  "concept": { "coreLoop": "...", "setting": "...", "tone": "..." },
  "scope": { "firstPlayable": "...", "later": ["A second region", "Fishing"] }
}
```

with `decision` and `why` in words.

## Creating the project

When the interview is done, summarise the concept in five lines and ask "shall I create the game?". Then
`studio_new_project` with the title, pitch, and the decisions as `design`. If Godot is missing, offer
`studio_install_godot` first (about 60 MB, nothing installed system-wide).

Then show it off: `godot_run` with `window: true`, and tell them: "Arrow keys walk, Enter talks, walk south out of town
into the tall grass to meet a monster." Explain that everything they see is a placeholder they will replace phase by
phase. Ask whether the concept phase feels done; if yes, mark it done and introduce art direction.
