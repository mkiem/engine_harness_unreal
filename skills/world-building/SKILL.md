---
name: world-building
description: Designing the game's places with a beginner - regions, maps, towns, dungeons, who lives where and how places connect - and building them as text maps with NPCs, warps, music and encounters. Load it for the world phase or whenever a map is made or changed.
---

# World and maps

Goal: the places of the first playable (often a village, a wild area, a dungeon and a boss room), each with a mood, built
and walkable.

## Plan with the developer

1. **Regions.** Propose a short list of places for the first playable, in the order the player meets them, with a
   one-line description and mood each. Ask what to change. Record in `world.regions`
   (`{"id": "fernvale", "name": "Fernvale", "description": "...", "map": "town", "mood": "safe, warm"}`).
2. **The flow.** How does the player move from place to place, and what stops them going too early? (A bridge is
   out until the elder asks you to help; a door is locked until the key.) Gates use `Game.flags`.
3. **Each map:** what is there to find? Every map should have a reason to walk it: a person to meet, a chest, a view,
   a shortcut, a boss.

## Building a map

1. Draw it as text in `maps/<id>.txt`: every row the same length, borders solid. The template's characters
   (see `maps/legend.json`): `.` grass, `#` wall, `~` water, `T` tree, `"` tall grass (random battles), `=` path, `_`
   floor, `D` door, `^` roof, `*` flowers. Add a new tile by adding a column to `art/tiles.png` and an entry in
   `maps/legend.json` (`{"tile": 10, "solid": false, "encounters": false, "name": "sand"}`).
2. Add it to `maps/maps.json`:

```json
"forest": {
  "name": "Whisperwood", "file": "forest.txt", "music": "res://audio/field.wav", "encounters": "forest",
  "npcs": [{"id": "hermit", "x": 5, "y": 3, "frame": 1, "dialogue": "hermit"}],
  "warps": [{"x": 0, "y": 6, "to": "meadow", "to_x": 22, "to_y": 6}]
}
```

3. **Warps go both ways**: when map A has a warp to B, B needs one back, and each arrival spot must be walkable and
   *not* on a warp itself (or the player bounces). Put the arrival one step inside the map from the exit.
4. NPC `role`: `inn` (heals the party), `shop` (sells `stock`, a list of item ids), `chest` (gives `item` or `gold`
   once), `battle` (a boss, see **battle-design**); `dialogue` is a key in `data/dialogue.json` (write the lines, see
   **story-and-dialogue**, which also covers flags: people who appear later and doors that open later).
5. Encounter zones are in `data/encounters.json`; tall grass (or any tile with `encounters: true`) triggers them when
   the map names a zone (see **battle-design**).

Map sizes: the screen shows 20x11 tiles at 320x180. Towns 20-30 wide; wild areas 30-60; dungeon rooms 15-25. Leave paths
two tiles wide, and break up big empty spaces with trees, water and flowers.

## Check it

`studio_check` catches uneven rows, unknown characters, NPCs or warps on walls or outside the map, and warps to missing
maps. Then play it (`godot_run`, `window: true`) and ask the developer to walk it.

## Done when

At least two regions are designed, at least three maps exist, each region points to its map, and the developer has walked
them. Mark the phase done.
