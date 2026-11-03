---
name: ui-and-menus
description: Making the title screen, text boxes, menus and battle screen look like this game and easy to use, with a beginner - colours, font, title and tagline, layout tweaks. Load it for the UI phase or when changing how menus, text or the title screen look.
---

# Title screen, menus and UI

Goal: the game's screens feel like part of *this* game, and a new player understands them without help.

## What's there

All screens are built in code: title (`scripts/ui/main_menu.gd`), text box and choices (`dialogue_box.gd`), pause menu
with party, items and save (`pause_menu.gd`), battle screen (`scripts/battle/battle_scene.gd`), ending (`ending.gd`).
Their look comes from `data/game.json`:

```json
"title": "Fernvale Tales", "tagline": "A small adventure",
"title_background": "#1d2b53", "battle_background": "#1d2b53",
"ui": {"panel": "#181425e6", "border": "#c2c3c7", "text": "#fff1e8", "accent": "#ffa300", "corner": 2, "font": "", "font_size": 8}
```

`panel` is the box colour (the last two hex digits are opacity), `accent` the highlighted choice, `corner` the rounding
in pixels (0 for sharp retro boxes).

## The conversation

1. **Title and tagline.** Confirm the title; offer three taglines in the game's tone.
2. **Colours.** Propose two UI colour sets from the palette (see **art-direction**): for example "night box, cream text,
   gold highlight" or "parchment box, ink text, red highlight". Apply one, run the game, show the title and a dialogue.
3. **Font.** The default font is smooth; a pixel font looks much better at this resolution. Openly licensed pixel fonts:
   Kenney's fonts (CC0, `assets_search` "font"), or fonts from Google Fonts under the SIL Open Font License (Press Start
   2P, Silkscreen, VT323, Pixelify Sans). Put the `.ttf` in `fonts/`, set `"font": "res://fonts/<file>.ttf"` and a
   `font_size` the font is designed for (often 8 or 16). Record the font and its licence in the design's decisions.
4. **Background.** A colour, or ask whether they want a title picture: paint or import one, and add it to
   `main_menu.gd` as a `TextureRect` behind the menu (a small code change).

## Usability checks (do these with the developer)

- Every screen works with the keyboard alone: arrows, Enter/Space, Esc to go back.
- Text never runs out of its box (lines under about 60 characters; see **story-and-dialogue**).
- The highlighted choice is obvious (strong `accent` against `panel`).
- Numbers that matter (HP, MP, gold) are visible when they're needed.
- Changes to UI code: `godot_check`, then `studio_check`.

## Done when

The title screen shows the game's title and a tagline, the UI uses the game's colours (and font, if chosen), and the
developer has clicked through the title, a conversation, the pause menu and a battle. Mark the phase done.
