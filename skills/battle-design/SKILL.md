---
name: battle-design
description: Designing how fights work and feel with a beginner - commands, skills, enemies per area, encounter rates and bosses - and putting them in the game's data, checked by simulation. Load it for the battle phase or when adding or changing enemies, skills, encounters or a boss.
---

# Battle design

Goal: battles that feel the way the developer wants, with enemies that suit each area and a boss worth beating.

## How battles work in the template (explain it simply)

Turn-based: each round, everyone acts in order of speed (`spd`). Heroes choose Attack, Skill (costs MP), Item, Defend
(halves damage taken until their next turn) or Run (not in boss fights). Damage comes from `data/formulas.json`:
`physical` = (attack x power - defence / 2) x a random 0.9-1.1, `magic` uses `mag`. Winning gives XP (levels raise
stats by `growth`) and gold, and maybe an item drop.

## The conversation (one question at a time)

1. **Feel.** Quick and snappy (most fights 2-3 rounds), or tactical (5+ rounds, skills matter)? Recommend quick for a
   first game. Record in `systems.battle`.
2. **Danger.** How often do wild battles happen? (`rate` in `data/encounters.json`: 0.08 relaxed, 0.12 classic,
   0.18 tense; there are always at least 4 steps between battles.)
3. **Enemies per area.** For each region, two to four enemy kinds that fit its mood. Offer ideas that match the setting
   (a cosy forest: mushrooms, squirrels with acorns, a grumpy badger) and give each a *gimmick*: hits hard but slow,
   fast and fragile, casts magic, heals friends, high defence (use magic).
4. **The boss.** Who, where, why, and what makes it special (a lot of HP, a strong attack, comes with helpers).

## Into the data

- `data/enemies.json`: `name`, `frame` (picture in `art/enemies.png`; paint new ones with `studio_paint`, see
  **art-direction**), `level`, `stats`, `skills`, `xp`, `gold`, optional `drop` `{item, chance}`. Start from the
  template's enemies and scale: next area's enemies about 1.5x the HP and attack of the last.
- Enemy skills come from `data/skills.json`, like the heroes' (`bite`: physical, power 1.3).
- `data/encounters.json`: a zone per area, `rate` and `groups` (lists of enemy ids; a group of two or three weak
  enemies is often more fun than one strong one). A map uses a zone with `"encounters": "<zone>"` in `maps/maps.json`,
  and only tiles with `encounters: true` in the legend (tall grass `"`) trigger them.
- **A boss** is an NPC with `"role": "battle"` and `"enemies": ["boss_id"]` in `maps/maps.json`, standing where the
  player must pass. Add `"ending": true` if beating it finishes the first playable. See **godot-rpg-template** for flags.

## Check it

`studio_check`, then `studio_simulate_battle` for every new group at the level the player will be when they meet it
(estimate: about 3 battles per level early on). The verdicts: ordinary battles **easy** to **fair**, the toughest group
in an area **fair** to **hard**, bosses **hard** at the expected level and **fair** one level higher. Tune and simulate
again (see **playtest-and-balance**). Then play a few battles with the developer and ask how they feel.

## Done when

The battle feel is described in the design, there are at least four kinds of enemy, battles have been simulated, and
the developer likes how fights feel. Mark the phase done.
