---
name: build-and-share
description: Turning the game into a Windows .exe the developer can send to friends - export with studio_export, testing the build, and how to share it (zip, itch.io). Load it for the build phase or whenever the developer wants to share or publish their game.
---

# Build and share

Goal: a Windows program of the game that runs on a computer without Godot or Engine Harness, and a way to share it.

## Build

1. `studio_check` first: build only a game that checks out.
2. `studio_export`. The first time it needs Godot's export templates: a one-time download of about 1 GB (about 200 MB
   is kept). Ask the developer before downloading, then call `studio_export` with `installTemplates: true`.
3. The result is `builds/windows/<game>.exe`, one file with everything inside. Ask the developer to run it (double
   click) and play a minute: title, walk, a battle, save, quit, continue.

Windows may warn that the program is from an "unknown publisher" (it is not code-signed). That's expected for homemade
games: "More info", then "Run anyway". Explain this to the developer and to anyone they share with.

## Share

- **With friends**: zip `builds/windows/<game>.exe` (right click, "Send to", "Compressed folder") and send it.
- **On itch.io** (free, popular for small games): create an account, "Upload new project", kind "Downloadable", upload
  the zip, choose a price (free is fine), add screenshots and a short description (the pitch from the design). Offer to
  write the page text with them.
- **Credits**: if any asset was CC-BY (see the design's decisions), list it on the page and in the game's ending text.
- **Save files** live in `%APPDATA%\Godot\app_userdata\<game>\save.json` on the player's computer.

## After sharing

Ask what friends said, and turn it into the next goals: `studio_design_update` with `scope.later`, or a new round of
**playtest-and-balance**. Every phase being done is not the end: suggest the next region, a new party member or a
sidequest from `scope.later`, and go through world, battle, story and balance again for it.

## Done when

`builds/windows/` has the .exe and the developer has run it. Mark the phase done and celebrate: they made a game.
