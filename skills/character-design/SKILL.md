---
name: character-design
description: Designing the party and the main people of the world with a beginner - who they are, how they look, how they fight and grow - and putting them into the game's data and sprites. Load it for the characters phase or when adding or changing a character.
---

# Character design

Goal: two to four heroes the developer cares about, each with a personality, a look, a role in battle and a way to grow;
plus the key non-playable people (a mentor, a rival, the villain).

## The conversation

For each playable character, one question at a time, offering choices:

1. **Who are they, in one line?** ("A retired knight who is scared of chickens.")
2. **Battle role.** Explain the classic roles: *attacker* (high attack), *tank* (high defence and HP, protects),
   *mage* (magic damage, MP), *healer* (keeps the party alive), *speedster* (acts first). A first party of two or three
   works best: for example attacker + mage, or attacker + healer + mage.
3. **Personality and want.** What do they want, and what stops them? It drives their dialogue later.
4. **Look.** Colours (from the palette), one or two signature details (a red scarf, a giant hat). Keep it readable at 16x16:
   colour and silhouette carry it, not small details.
5. **Abilities.** Two starting skills and two or three learned later, matching the role.

Record each: `studio_design_update` with the full `characters` list (lists replace, so send all of them), e.g.
`{"id": "aria", "name": "Aria", "role": "Knight (attacker)", "personality": "...", "look": "...", "abilities": "...", "playable": true}`.
NPCs go in the same list with `"playable": false`.

## Into the game

- **Stats** in `data/characters.json`: `base` `{hp, mp, atk, def, mag, spd}` and `growth` per level. Start from the
  template's hero (hp 60, atk 12) and mage, and shape them to the role: a tank gets more hp and def and less spd; a mage
  low atk and def, high mag and mp; a healer moderate mag and the `heal` skill.
- **Skills** in `data/skills.json` (`power` multiplies the formula; `mp` cost; `type` physical, magic or heal), then list
  them in `skills` (start) and `learns` (`{"3": "frost"}` = learned at level 3).
- **Party** in `data/party.json`: `members` order is the battle order on screen.
- **Sprite:** the party leader walks on the map (`art/hero.png`, see **art-direction**). Paint each hero's look with
  `studio_paint`; NPC frames go in `art/npcs.png`. Battle shows heroes by name and HP, enemies by sprite.
- **Ids** are lower-case words (`aria`), the same in design and data.

Then `studio_check`, and `studio_simulate_battle` against the first area's enemies to see the new party still wins
(see **playtest-and-balance**). Play it and ask the developer how the characters feel.

## Done when

Every playable character in the design exists in `data/characters.json` with a role and a look, and the developer is
happy with them. Mark the phase done.
