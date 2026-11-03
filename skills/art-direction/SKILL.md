---
name: art-direction
description: Choosing a game's look with a beginner (resolution, palette, style) and then making every sprite and tile in it - painted as pixel art with studio_paint, or taken from openly licensed packs. Load it for the art phase or whenever art is being made or changed.
---

# Art direction

Goal: a look the developer loves and can describe, then real art in it: tiles, hero, NPCs, enemies.

## 1. Agree the look (one question at a time)

1. **Resolution.** The game draws at 320x180 and scales up (a pixel stays crisp). Offer 320x180 (default, classic 16-bit
   feel) or 256x144 (chunkier, more retro). Changing it later means changing `project.godot` and the design.
2. **Palette.** A small fixed set of colours makes pixel art look coherent. Propose two or three palettes of 8 to 16
   colours that fit the setting and tone, each as hex codes with a name per colour ("moss #4ca048"). Openly usable
   palettes: PICO-8 (16), Sweetie 16, Endesga 32, Resurrect 64 (lospec.com lists them with licences); or a custom one.
3. **Style in words.** Two or three sentences: outline or no outline, how much shading, chunky or detailed, cute or
   grim ("Dark 1px outlines on characters, none on tiles; two shades per colour; round, friendly shapes").
4. **Make or take?** Painting everything here works and is unique to the game. Openly licensed packs (Kenney is CC0, see
   `assets_sources`) are faster and look professional; they can be recoloured to the palette later. Mixed is fine:
   take tiles, paint the characters.

Record all of it: `studio_design_update` with `art.palette`, `art.style`, `art.resolution`, `art.references`.

## 2. Make the art, one file at a time

Formats (from the template; keep these or the game draws garbage):

| File | Layout |
| --- | --- |
| `art/tiles.png` | 16x16 tiles in one row; `maps/legend.json` maps a map character to a column |
| `art/hero.png` | 2 columns (walk frames) x 4 rows (facing down, left, right, up), 16x16 each = 32x64 |
| `art/npcs.png` | 16x16 people in one row; set `npc_frames` in `data/game.json` to the count |
| `art/enemies.png` | 32x32 monsters in one row; set `enemy_frames`; each enemy's `frame` picks one |

Order: hero first (the developer sees it all the time), then the tiles of the first map, then the first enemies, then NPCs.

### Painting with studio_paint

Write the sprite as a grid, one character per pixel, with palette letters; `at` is the frame's [column, row] in the
sheet and `frame` its size (16x16 for tiles, the hero and NPCs; 32x32 for enemies). A grass tile as tile 0:

```json
{"file": "art/tiles.png", "at": [0, 0], "frame": [16, 16],
 "palette": {"g": "#4ca048", "d": "#296c36", "l": "#76c442"},
 "rows": ["gggggggggggggggg", "ggdgggggggglgggg", "..."]}
```

Pixel art rules that make a beginner's sprites look good:

- Use only the palette's colours; two or three shades per material (light from the top left).
- Characters: a dark outline (not pure black: the palette's darkest colour), a big head (about a third of the height),
  clear silhouette. Check the silhouette alone: is it readable?
- Tiles must tile: the left edge has to continue into the right edge, the top into the bottom. Avoid a lone bright
  pixel near an edge; scatter details in the middle.
- Walk frames: frame 2 moves the legs and bobs the body by one pixel. Left and right can mirror each other.
- Enemies get more detail and size (32x32) and a strong colour that differs from the ground they appear on.
- After each paint, open the preview the tool answers (`.studio/previews/...png`) and look at it; fix and repaint the
  frame before moving on. Then show it in the game (`godot_run` with `window: true`) and ask the developer.

### Using a pack

`assets_search` (for example "tiles", "rpg", "characters"), `assets_download` or `assets_import` a pack the developer has,
then copy or rearrange the needed frames into the template's sheets (a Python or Node script is fine for
cropping and arranging). Note the source and licence in the design's decisions; CC-BY packs need a credit in the game.

## Done when

`studio_next` shows no placeholder art left, the palette and style are recorded, and the developer says the game looks
like *their* game. Mark the phase done.
