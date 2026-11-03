---
name: items-and-economy
description: Designing what the player finds, buys and earns with a beginner - items, prices, shops, chests and rewards - so getting stronger feels good and money matters. Load it for the items phase or when adding items, shops, chests or changing prices or rewards.
---

# Items, shops and progression

Goal: a small set of useful items, shops that sell them, chests to find, and rewards that make every battle worth it.

## The conversation

1. **What does the player spend money on?** In the template: healing (`heal`) and MP (`mp`) items. Offer flavour
   names that fit the world ("Honey Bun" instead of Potion).
2. **How generous?** Tight (every potion counts) or relaxed (buy freely)? Recommend: an early battle pays for half a
   potion; the first shop visit can afford three or four.
3. **Where are the shops and chests?** One shop per town; a chest or two per wild area, ideally slightly off the main
   path to reward exploring; a better chest before the boss.

Record the economy in words in `systems.economy` and `systems.progression` with `studio_design_update`.

## Into the data

- **Consumables** in `data/items.json`: `effect` `heal` (HP), `mp`, `revive` (`revive_percent`), `cure` (`cures`: a
  list of statuses), `damage` (a bomb: `amount`, `element`, `target: "all_enemies"`), `buff` (gives a `status`); `price`,
  `about`.
- **Equipment**: `slot` (`weapon`, `armor`, `accessory`), `stats` (`{"atk": 7}`; negatives are fine, such as heavy
  armour's `spd: -1`), `users` (who can wear it), and extras that make choices interesting: a weapon `element`,
  `resist` (elements), `immune` (statuses), `crit`, a weapon `status` (`{"id": "poison", "chance": 0.2}`). Each
  character starts with `equipment` in `characters.json`; the pause menu's Equip page shows what changes, and
  "Optimize" picks the best.
- **Key items**: `"kind": "key"`: story objects (a lost charm, a gate key) given and checked by events.
- Shops: an NPC with `"role": "shop"` and `"stock": ["potion", "ether"]` in `maps/maps.json`. The shop shows a menu with
  prices; the player buys as many as they want.
- Chests: an NPC with `"role": "chest"`, `"item"` (and `"count"`) and/or `"gold"`, `"frame"` and `"open_frame"`
  (pictures in `art/npcs.png`). Each opens once.
- Rewards: each enemy's `xp`, `gold` and `drop` in `data/enemies.json`; the starting gold and items in
  `data/party.json`. Levelling speed is `xp_to_next` in `data/formulas.json`.

## Rules of thumb

- **Equipment tiers**: one tier per region. The first shop sells the starting tier and one upgrade; each new town adds
  a tier about +4 ATK/+4 DEF above the last, costing 4 to 6 battles of gold. Put one special piece in a chest off the
  main path (the sample's Flame Sword) and one as a quest reward (the Lucky Ring).
- Accessories are about choices, not numbers: poison immunity before the poison forest, fire resistance before the
  fire boss. Mention them in an NPC's line so the player knows they matter.
- Selling returns `sell_rate` (half) of the price, so old gear funds new gear.
- Price of the basic healing item = 2 to 3 typical battles of gold. Its `amount` should heal about 40% of a hero's HP at
  the level they'll buy it.
- A level every 3 to 4 battles early on, slowing later.
- Never let the player get stuck: losing returns to the title screen, and they continue from their last save, so early
  areas must be winnable without buying anything, and saving (in the Esc menu) should be mentioned early by an NPC.

Check: `studio_check`, then play: win three battles, visit the shop, open a chest. Ask the developer if money feels right.

## Done when

At least three items and one shop exist, and the developer is happy with prices and rewards. Mark the phase done.
