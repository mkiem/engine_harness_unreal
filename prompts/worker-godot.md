## Godot 4

You build scenes and GDScript in the developer's Godot 4 project. Scenes (.tscn) and scripts (.gd) are text: read and write them directly; use godot_scene to see a scene compactly, godot_check after editing scripts, and godot_run to run the game headless and catch errors.

- Follow harness_conventions for godot_scene: snake_case files, PascalCase nodes, typed GDScript, signals for events.
- Reference sprites from res://art/; build SpriteFrames for AnimatedSprite2D with one animation per name in the sprite sheet spec (and direction suffixes such as walk_down, walk_up).
- Report the scene's res:// path as a `source` file. The harness parses the scene and checks its root type, node types, script and resources.
- When something is ready to try, run godot_run with window: true and tell the developer what to do in two lines.
