---
name: character-3d
description: Making a rigged, textured, animated 3D character for Unreal or Godot from reference images - the developer's own drawings or photos, or images from an image model they set up - in one of four styles (voxel, low-poly, toon, retro). Load it when someone wants a 3D character, a 3D hero or enemy, or to turn a drawing into a 3D model.
---

# 3D characters from reference images

Goal: a character the developer recognises from their references, rigged and animated (idle, walk, run, attack), with
textures (base colour, ORM, normal), in their engine: Godot 4, Unreal 5, or both. Nothing here is a paid service:
Blender builds the model, and pictures come from the developer or from an image model they configure themselves.

## 1. Choose the engine and the style

Ask which engine (Godot, Unreal or both) and show the styles with `character_styles`:

- **voxel**: visible cubes, chunky and readable. Art direction: `studio_art_style` `voxel-worlds`.
- **lowpoly**: faceted, flat-shaded, a small palette (about 1,400 triangles). `faceted-low-poly`.
- **toon**: smooth, cel-shaded with an ink outline in Godot (about 9,000 triangles). `anime-cel-3d`.
- **retro**: very few polygons, a tiny crisp texture, PS1-era (about 800 triangles). `low-resolution-3d`.

If the game already has an art direction (the design's art bible), pick the style that matches it and say why.

## 2. Get reference images

Show the guide with `character_reference_guide` and explain it in your own words. The essentials:

- **How many:** two at the least (front and side), three for a good result (front, side, back). A three-quarter view is
  welcome for judging the result but is not used for the shape.
- **Angles:** front facing the camera; side a true 90-degree profile (ask which way the nose points); back straight on.
  Straight-on camera, no perspective, the same scale in every view, feet on one line.
- **Pose:** an A-pose, arms 30 to 45 degrees from the body with a clear gap at the armpits, legs slightly apart, hands
  empty. Arms touching the body get built into the torso.
- **Background and light:** one plain colour the character does not wear (white or light grey), or a transparent PNG;
  soft, even light; no floor shadows.
- **Quality:** the character at least 700 pixels tall (1024 or more), sharp, the same outfit in every view, no text.

Three ways to get them:

1. **Their own images** (drawings, paintings, renders, photos of a figure): `character_check_references` with one file
   per view, or a `sheet` with the views side by side. Only use images the developer made or has the rights to use.
2. **An image model they configure**: `character_image_model` shows the setup. They choose the provider: an
   OpenAI-compatible images API, Google Gemini, or a free local Stable Diffusion (AUTOMATIC1111 or Forge with `--api`).
   Keys stay in an environment variable they set themselves; never ask them to paste a key into the chat. Paid APIs
   cost them money: say so and ask before each generation. Then `character_generate_references` with a description
   and the style, optionally from a sketch of theirs (`fromImage`). Show them the sheet; image models vary, so generate
   again or adjust the description if the check fails or they do not like it.
3. **The sample** to try the pipeline first: `character_sample_references`.

Read every check result aloud in plain words. Fix errors (✗) before building: a new image is better than a workaround.
Warnings (!) are worth fixing but can be accepted.

## 3. Build

`character_build` with the name, style, engine and height in metres (a human about 1.8, a child 1.2, a giant 3).
Blender must be installed (`harness_setup_check` shows it). It takes up to a minute. Then:

- Show the preview (it sits beside the references) and ask: does it look like them? Compare the silhouette, colours,
  proportions. Common fixes: a better side view (shape front to back), arms further from the body (arms merged), a
  plainer background (ragged edges), a back view (a guessed back).
- Contract problems listed by the build are real: fix them before installing.
- The shape comes from silhouettes, so faces and fingers stay simple; that suits these four styles. For a detailed
  hero, the build is a blockout to refine in Blender (the .blend is saved beside the exports).

## 4. Put it in the engine

`character_install` with `engine` `godot` or `unreal`:

- **Godot** gets `res://characters/<name>/<Name>.tscn`: instance it in a level; `play("walk")` switches animation; the
  scene applies the style (toon shading and outline; crisp pixels for voxel and retro). The install loads it headless
  and reports bones, animations and textures; read that back. Then open the game with `godot_run` so they can see it.
- **Unreal** imports `SK_<Name>` with its skeleton and animations, and the `T_<Name>` textures, into
  `/Game/Characters/<Name>` through the open editor. Then make a material instance of the project's master material
  with the textures (a toon material for the toon style) with `unreal_python`, and drop the character in the level.

The skeleton uses Godot's humanoid bone names (Hips, Spine, Chest, Neck, Head, LeftUpperArm, ...), so Godot's
retargeting works directly; in Unreal, retarget other animations with an IK Rig on those bones.

## Afterwards

Record the character in the design (`studio_design_update`, the `characters` list) with its style and model path, and
keep the references with the project: they are the source a rebuild starts from.
