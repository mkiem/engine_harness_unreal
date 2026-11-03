---
name: mechanic-design
description: Turning a "what if the game had..." idea into a mechanic that works - finding how real games do it in the bundled Gameplay Atlas (280 mechanics), writing a mechanic card (loop, trade-offs, levers), building the smallest prototype, and keeping or cutting it by an observable playtest question. Load it whenever the developer wants a new feature, twist, minigame or system, or is unsure what would make the game special.
---

# Designing a mechanic

A **mechanic** is one loop of player action, constraint and feedback: "cast, wait for the bite, strike within the
window, reel in". Beginners describe features ("I want fishing!"); the job is to find the loop inside, keep it small, and
find out quickly whether it is fun. The bundled **Gameplay Atlas** by loopyhop (used with permission) describes 280
mechanics from real games, each with a prototype plan. Start there instead of from a blank page.

## The steps

1. **Find it.** `studio_find_mechanic` with the developer's words ("fishing", "enemy telegraphs", "something cosy
   between battles"), or a group (`combat`, `command`, `progression`, `inventory`, `exploration`, `relationships`,
   `narrative`, `fishing`, `farming`, `cooking`, `puzzles`...). With no arguments it lists every group.
2. **Show two or three.** Read the best matches with `studio_mechanic` and offer them in plain words: what the player
   does, what they weigh up, which games do it. Ask which feels right, or whether to mix two.
3. **Make the card.** `studio_mechanic` with `add: true` copies it into the design as a mechanic card (status `idea`).
   Then make it this game's own with `studio_design_update` (`mechanics` is a list; send the whole list):
   - rewrite the **loop** in this game's words ("Pip casts into the moon pond...");
   - choose each **lever** (`parameters[].value`): "Bite window: 0.6 s, generous, because the game is cosy";
   - keep the **prototype**'s first step, pitfall and playtest question, adapted to this game.
4. **Prototype only the first step.** Build the smallest version that answers the playtest question, in the
   template's style (data first; new behaviour where it belongs: battle rules in `BattleLogic`, map actions in
   `overworld.gd`, story in events). Set the card's `status` to `prototyping`. Run `studio_check`.
5. **Playtest the question.** Have the developer play it (`godot_run`, `window: true`) and watch for exactly what the
   question asks ("do players diagnose the reversed belt from the queue?"). Record the answer in
   `prototype.result`.
6. **Keep or cut.** `kept` when the answer is yes and it is fun; then grow it in small steps, watching the card's
   pitfall. `cut` is a good outcome too: the game is better without a feature that does not work; note why. The
   balance phase is not done while a card is still `idea` or `prototyping`.

## Rules of thumb

- **One mechanic at a time.** Finish (keep or cut) before starting another.
- The **pitfall** on each card is a scope trap that real developers fall into; say it out loud before building.
- **Combinations** on a card ("combines with puzzles: ...") are ideas for later; park them in `scope.later`.
- For **turn-based RPG battles**, the template already has: speed-based turn order, elements and weak points, enemy
  intent previews, charged attacks with interrupts, taunts, break shields, boss phases, statuses and focus-fire AI. Many
  atlas mechanics in `combat` and `command` are data in it already (see **battle-design**).
- Ideas with no template support yet (fishing, farming, cooking, relationships, crafting) are new code: estimate
  small, medium or large with the card's `scope` and tell the developer before starting.
- Respect the source: the atlas describes how real games work so we can learn from them. Design an original version;
  never copy a game's content.

## Mechanics already in the template, and their atlas cards

| In the template | Atlas card |
| --- | --- |
| Speed decides turn order; haste | `command-initiative-order` |
| Elements, weaknesses, resistances | `defense-resistance-counters` |
| Enemy intent shown before it acts | `combat-intent-preview` |
| Charged attacks and interrupting skills | `command-interrupt-action` |
| Taunt (Provoke) | `command-threat-redirection` |
| Break shields | `combat-posture-break` |
| Waystone fast travel | `exploration-fast-travel-network` |
| Story flags gating areas | `exploration-ability-gates` |
| Choices that change later events | `narrative-delayed-choice-consequences` |

Read a card before changing one of these systems, to tune its levers with its trade-offs in mind.
