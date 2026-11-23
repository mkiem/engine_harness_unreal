# {{TITLE}}

{{PITCH}}

A playable 3D Godot 4 starter project created with Engine Harness, ready for 3D characters built with `character_build` and installed with `character_install`.

- `scenes/main.tscn` — sunlit 3D playground with a playable `Player` (`CharacterBody3D`), third-person `SpringArm3D` camera, and landmark.
- `scripts/player_controller.gd` — WASD/arrow movement, `Shift` to sprint, `Space` to jump, `F` to attack, `Q`/`E` or right-click drag to orbit the camera, and automatic loading of any character scene installed under `res://characters/`.
- `scripts/main.gd` — root scene script with `--autotest` verification support.
