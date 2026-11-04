# 008 3D characters and textures

Two answers to two questions:

- "Can it make a 3D character from a reference image?" Yes: rigged, textured and animated, for Godot 4 and Unreal 5,
  in four styles, from the developer's own pictures or from an image model they configure. No paid service is part
  of it.
- "Do our 3D artifacts have textures and colour?" Yes: every character gets a base colour, ORM and normal map from its
  references, and props bake theirs from their materials with `dcc/blender/bake_textures.py`. The vintage radio is the
  worked example: walnut, grille cloth, bakelite and brass.

## The pipeline

```
reference images ──► character_check_references ──► character_build (Blender) ──► character_install
(yours, or your           cut-outs at one scale,       mesh, textures, skeleton,      Godot: scene + headless check
 image model's)           problems in plain words      animations, FBX + GLB,         Unreal: SK_ + T_ import
                                                       contracts, preview
```

Agent tools (MCP): `character_reference_guide`, `character_styles`, `character_check_references`,
`character_sample_references`, `character_image_model`, `character_generate_references`, `character_build`,
`character_install`. The `character-3d` skill walks a developer through them; the app recipe "New 3D character from
a reference" starts it.

## Reference images

`src/character/reference.ts` holds the guide and the checker.

| What | Asked for |
| --- | --- |
| How many | Two at the least (front, side); three for a good result (front, side, back); a three-quarter view optional |
| Angles | Front square on; side a true 90° profile (nose direction stated); back square on; straight-on camera, no perspective |
| Pose | A-pose: arms 30–45° from the body with a gap at the armpits, legs slightly apart, empty hands |
| Background | One plain colour the character does not wear, or a transparent PNG; soft even light, no floor shadow |
| Quality | Character at least 700 px tall (1024+), sharp, same outfit and proportions in every view, no text |

The checker separates the character from the background (alpha, or the border colour), splits a turnaround sheet into
views, and checks each one:

- resolution and framing (nothing cut off);
- background uniformity and contrast;
- sharpness and symmetry;
- arms apart and legs apart, read from the silhouette's runs at chest and knee height.

Across views it checks that front and side exist, that the scale matches, and that the side is really a profile. It
writes each view cropped and scaled to 1024 px tall, background transparent, with `references.json`.

## Image models (bring your own)

`src/character/imagegen.ts` talks to three kinds of API. The developer picks one with `character_image_model`; the
key stays in an environment variable they set (the config file stores only the variable's name).

| Provider | API | Notes |
| --- | --- | --- |
| `openai` | `POST /images/generations`, `/images/edits` (OpenAI or any compatible server) | default model `gpt-image-1`, key in `OPENAI_API_KEY` |
| `gemini` | `POST /models/<model>:generateContent` with `responseModalities: ["IMAGE"]` | default `gemini-2.5-flash-image`, key in `GEMINI_API_KEY` |
| `a1111` | `POST /sdapi/v1/txt2img` or `img2img` (AUTOMATIC1111 or Forge started with `--api`) | free and local; `model` picks the checkpoint |

The prompt asks for a turnaround sheet that follows the guide (three views, orthographic, A-pose, plain white
background) with words that suit the chosen style; a sketch of the developer's can steer it (`edits`, inline image,
or `img2img`). The result goes through the same checker as uploaded images.

## The build

`dcc/blender/character/build_character.py` runs headless (a Blender executable, or a Python with the `bpy` module via
`HARNESS_BLENDER_PYTHON`):

1. **Shape:** a visual hull. The front, side and back silhouettes are extruded through a voxel grid and intersected.
   Each horizontal slice is rounded per region (a superellipse), and arms are kept about as deep as they are wide.
2. **Style:**
   - voxel keeps the cubes;
   - lowpoly remeshes, smooths and decimates to about 1,400 triangles, flat shaded;
   - toon is smooth at about 9,000 triangles;
   - retro is about 800 triangles with a 128 px texture.
3. **Colour:** the references are projected onto the mesh from the front, side and back. Each view is weighted by how
   squarely a surface faces it, and only where that view actually sees the surface: the outermost voxel per column,
   so a side view's arm is not painted onto the chest. The result is baked to the UVs with Cycles. Voxel, lowpoly and
   retro are quantized to a small palette.
4. **Textures:**
   - `T_<Name>_BC`: base colour, sRGB;
   - `T_<Name>_ORM`: baked ambient occlusion, the style's roughness, metallic 0; linear;
   - `T_<Name>_N`: flat, linear, DirectX.
5. **Skeleton:** 21 bones with Godot's `SkeletonProfileHumanoid` names (Hips, Spine, Chest, Neck, Head, shoulders,
   arms, hands, legs, feet, toes). It is placed from landmarks read off the silhouettes: crotch, neck, hand tips,
   knees and ankles. Skinning picks each vertex's limb by distance relative to the limb's thickness, then blends the
   two nearest bones.
6. **Animations:** procedural idle, walk, run and attack.
7. **Exports and preview:**
   - `SK_<Name>.fbx` for Unreal (FBX_SCALE_UNITS, all actions);
   - `<name>.glb` for Godot (actions as animations);
   - the `.blend`;
   - a preview rendered beside the references.

`src/character/index.ts` then measures the export with `inspect_export.py`, which now reports bones and animations and
measures skeletal meshes in their rest pose. It checks the mesh against the `skeletal_mesh` contract (triangle
budget, at least 20 bones, pivot at the base, applied transforms, UVs) and the textures against `texture_set`.

What it is not: the shape comes from silhouettes, so faces and fingers stay simple. That suits these four stylised
looks; for a detailed hero, the build is a blockout to refine in Blender.

## In the engines

- **Godot:** `res://characters/<name>/` gets the GLB and a `<Name>.tscn` with `character.gd`. The script plays
  idle/walk/run/attack (`play("walk")`) and applies the style: a two-band toon shader with an outline pass for toon,
  nearest-neighbour texture filtering for voxel and retro. `character_install` imports the project and loads the
  scene headless with `--character-check`, which reports bones, animations, textures and height.
- **Unreal:** `dcc/unreal/import_pipeline.py` imports `SK_<Name>` as a skeletal mesh with a new skeleton and its
  animations (reported back as facts), and the `T_<Name>` maps with the right sRGB and compression settings, into
  `/Game/Characters/<Name>`.

## Textures for props

`dcc/blender/bake_textures.py` bakes any mesh's materials into `<id>_BC`, `<id>_ORM` and `<id>_N` on its UVs. It
reads each Principled BSDF's Base Color, Roughness, Metallic and Normal inputs, whatever they are wired to: textures,
attributes, procedural nodes or plain values. Several materials bake into the one set, so a model can keep a single
material slot. `--facts` writes what the texture contract reads. `--apply` swaps in a material that uses the baked
maps, for GLB exports and previews.

The vintage radio recipe paints its parts into colour attributes: walnut case with a procedural grain, woven grille
cloth, bakelite dials, a brass plate. Its one material reads them. The Blender worker prompt now requires colour on
every model, and the texture worker prompt points at the bake.

## Tested

- `tests/character.spec.ts`:
  - the guide;
  - the sample sheet accepted;
  - arms touching, a cropped figure and a missing side view refused;
  - each image provider against a recorded request;
  - keys only from the environment;
  - paths, the Blender runner and the Godot install.
- `scripts/e2e-character.ts`, in CI with Blender 5.2 and Godot 4.4.1:
  - through the MCP server, builds the sample character in all four styles;
  - checks bones, animations, files and that the base colour is really coloured;
  - installs each into a Godot project; real Godot must see 21 bones, four animations, textures and 1.8 m of height.
- `dcc/tests/e2e_blender.py`: now also bakes `T_VintageRadio` at 2048 px from the coloured recipe and validates it
  against the plan's texture ticket.
