---
name: audio-and-music
description: Choosing the game's musical mood with a beginner and making its music and sound effects - written from notes with studio_music and studio_sound, or taken from openly licensed packs. Load it for the audio phase or when making or changing music or sounds.
---

# Music and sound

Goal: a track for each kind of place (title, town, field, battle, and maybe a boss and an ending) and a sound for every
action, all in one mood.

## The conversation

1. **Mood.** Name three moods that fit the concept ("cosy and bouncy", "melancholy and dreamy", "heroic and bright")
   and the games they sound like. Record `audio.mood` and the list of tracks in `audio.tracks`.
2. **Make or take?** Writing it here makes chiptune music (square and triangle waves, like 8-bit and 16-bit consoles) that
   fits pixel art well. Openly licensed music and sound packs (Kenney's audio packs are CC0; `assets_search` "audio",
   "music") are another option. CC-BY needs a credit.

## Writing music with studio_music

A track is a few **voices** played together: a melody, a bass, maybe drums. Notes are written like `C4 E4 G4:2 R` (a
note name and octave, `:beats` for length, `R` for a rest). Practical guide:

- **Tempo**: calm town 80-100, walking field 110-130, battle 140-170, boss 160-180.
- **Key and mood**: major (C major: C D E F G A B) sounds happy; minor (A minor: A B C D E F G) sad or tense. Stay in one
  key; end phrases on the key's root note (C in C major, A in A minor).
- **Melody**: square or pulse wave, octave 4-5, short phrases of 4 or 8 beats that repeat with a small change.
- **Bass**: triangle wave, octave 2-3, one note per beat or two, on the chord roots (in C major: C, F, G, A minor).
- **Drums**: `noise` wave: `C2:0.5` is a low thump (kick), `C6:0.5` a bright hiss (hi-hat); with `R` between.
- Make every voice the same total length in beats (8, 16 or 32) so the loop is seamless. Music loops automatically.

Example, a town loop at 96 BPM (16 beats):

```json
{"file": "town", "tempo": 96, "voices": [
  {"notes": "E4 G4 C5 G4 A4:2 G4:2 F4 A4 C5 A4 G4:4", "wave": "pulse", "volume": 0.18},
  {"notes": "C3:2 C3:2 F2:2 F2:2 F2:2 F2:2 G2:2 G2:2", "wave": "triangle", "volume": 0.25},
  {"notes": "C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5 C2:0.5 R:1.5", "wave": "noise", "volume": 0.1}
]}
```

Where music plays: each map's `music` in `maps/maps.json`, and `title_music`, `battle_music`, `ending_music` in
`data/game.json`. A boss can have its own battle music only with a small code change in `battle_scene.gd`.

## Sound effects with studio_sound

Presets: select, confirm, cancel, hit, critical, miss, magic, fire, ice, heal, levelup, victory, defeat, coin, item, door,
step, encounter. The game plays `audio/<name>.wav` for select, hit, heal, magic, levelup, victory, defeat, coin, cancel,
item, door and encounter, and a skill's own sound when a file with the skill's id exists (`studio_sound` name `fire`,
preset `fire`). Custom sounds take `voices` like music, at a high tempo (480-900) for short blips.

## Check it

Play the game with the developer and listen in each place. Too loud or harsh: lower `volume`, use triangle instead of
square. Repetitive: make the loop longer (32 beats) with a second phrase.

## Done when

The mood is in the design, the four placeholder tracks (title, town, field, battle) are replaced, and the developer
likes how the game sounds. Mark the phase done.
