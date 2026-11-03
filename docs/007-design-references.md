# 007 Design references: Gameplay Atlas and Game Art Style

Two references by **loopyhop** are bundled into the game studio with the author's permission:

- **Gameplay Atlas** (https://gameplayatlas.loopyhop.com): a field guide to 280 game mechanics in 28 groups.
- **Game Art Style** (https://gameartstyle.loopyhop.com): a visual atlas of 37 art styles.

They turn a beginner's vague wish ("something like Stardew", "make it look like the SNES") into concrete,
well-understood choices, each with a way to build it small and test it.

## What is bundled, and what is not

`catalog/loopyhop/`, rebuilt by `node scripts/import-loopyhop.ts`, holds:

- `mechanics.json`: every mechanic, with:
  - its rules and 4-step core loop;
  - the decisions the player weighs, and its design levers with their effects;
  - real game cases with sources and official pages, and how they compare;
  - combinations and related mechanics;
  - a walkthrough of one round;
  - prototype guidance: scope, first step, pitfall, playtest question.
- `art-styles.json`: every style, with its family, definition, three "what to look for" cues, its global
  art-direction prompt, and reference games with their official store pages.
- `NOTICE.md`: the permission and attribution. The studio tools credit loopyhop and link the source page in
  everything they show.

**Game screenshots are not bundled.** They belong to each game's rights holders, and loopyhop's permission cannot cover
them. References link to official pages instead.

## In the studio

| Tool | Does |
| --- | --- |
| `studio_find_mechanic` | Searches the atlas by the developer's words, group, tag or prototype size; with no arguments, lists the groups |
| `studio_mechanic` | A whole card; with `add: true` it becomes a mechanic card in the game's design (status `idea`) |
| `studio_art_styles` | Lists or searches the styles |
| `studio_art_style` | A whole style; with `apply: true` it becomes the game's art direction, written to `design/ART_DIRECTION.md` |

**Mechanic cards in the design** (`mechanics` in `design/game.json`, rendered in `GAME_DESIGN.md`). Each card has the
loop in the game's own words, the decisions, the levers with this game's values, and the prototype: first step,
pitfall, playtest question and its answer. A card's status moves from `idea` to `prototyping`, then to `kept` or `cut`.
The **mechanic-design** skill walks through it:
1. Find the mechanic in the atlas and offer two or three.
2. Make the card the game's own.
3. Prototype only the first step.
4. Playtest the question.
5. Keep or cut.

The concept phase asks for the game's twist as a card; the balance phase is not done while a card is still open.

**The art bible**:
- The design's `art` section gains `styleId`, `lookFor` (what every picture shows), `rules` (outline, shading,
  proportions, lighting, UI, motion), `avoid` (mistakes) and `paletteLocked`.
- `design/ART_DIRECTION.md` combines the style's art-direction prompt with this game's specifications (resolution,
  sprite sizes, palette, rules, mistakes), and is rewritten whenever the art section changes.
- Each game's `AGENTS.md` tells every session to follow it.
- With the palette locked, `studio_paint` warns about other colours (or snaps them with `snapToPalette`), and
  `studio_check` lists pictures that use colours outside the palette.
- The art phase asks for a style's cues and a locked palette.

## RPG features taken from the atlas

The template gained five mechanics from atlas cards. Each was built to the card's guidance, avoiding its pitfall:

| Card | In the template | The card's pitfall, and how it is avoided |
| --- | --- | --- |
| `combat-intent-preview` | Each enemy decides at the start of the round and the battle screen shows it ("Maul -> Aria"); `rules.json` `show_intent` | "A preview that disagrees with resolution breaks trust": the enemy does exactly what it showed, unless interrupted, broken or its target fell |
| `command-interrupt-action` | Skills with `"charge": 1` gather power for a turn first; `"interrupts": true` skills (Shield Bash, Pinning Shot), stun and sleep cancel them | "Show successful interruption differently from immunity": interrupted shows "Interrupted!"; `"uninterruptible"` enemies say they can't be |
| `command-threat-redirection` | The Taunt status (Aria's Provoke) pulls every single-target attack, and turns planned attacks toward the taunter | "Redirection should have durability consequences": the taunter takes every single hit, so it needs defence or healing |
| `combat-posture-break` | Enemies with a `shield` lose a point per weakness hit, critical hit or `breaks` skill; at zero they are Broken: they lose their next turn, their charge is cancelled, and they take 50% more damage until the shield returns | "A second health bar alone changes little": breaking cancels a charged attack and opens a damage window, so it changes what to attack with and when |
| `exploration-fast-travel-network` | `waystone` NPCs attune on touch, then travel to any other attuned waystone | "Dense nodes erase travel": the skill says at most one per region, reached on foot first |

The sample boss uses all of them:
- **Maul:** a telegraphed charged attack.
- **Interrupting:** Aria's Shield Bash, or Bram's Pinning Shot.
- **Taunt:** Aria's Provoke protects Pip.
- **Break:** a 7-point shield that fire attacks break.

It is simulated to "hard" at level 5 (about 57% wins) and comfortable at level 6. The self-test checks every new rule:
intent matches resolution, taunt redirects, charge waits and is interrupted, break and shield recovery.
