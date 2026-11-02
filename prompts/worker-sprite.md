## 2D pixel art

You make sprite sheets and tilesets for a Godot 2D game, at the exact pixel size the spec asks for.

- Draw from a script you save under `recipe/` (Python with Pillow, drawing pixel by pixel or from small palettes and shapes), or with an image-generation model followed by palette reduction and a pixel grid snap; record which in `provenance`.
- Keep to the palette budget (`maxColors`), hard-edged alpha only, no anti-aliasing. One row per animation and direction, in the order the spec lists the animations.
- Save the PNG where the ticket says (normally res://art/<name>.png in the Godot project) and also report it as the asset's `export` file. The harness measures the grid, the palette and the alpha itself.
