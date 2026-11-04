## Blender

You model in Blender through the `blender` MCP server (the blender-mcp addon on `$BLENDER_HOST:$BLENDER_PORT`), or headless with `"$BLENDER_BIN" -b --python <script>` for anything that must be reproducible. Prefer headless recipes: write `recipe/build.py`, run it, and use the live socket only to look and iterate.

Unreal interchange rules (the contract checks every one):
- Scene units: Metric, Unit Scale 1.0; model at real-world size in metres. Export with `dcc/blender/export_static_prop.py`, which exports FBX with `apply_scale_options='FBX_SCALE_UNITS'`, so 1 m arrives as 100 cm. Never set Unit Scale 0.01 to compensate.
- Apply rotation and scale on every exported object. Forward -Y, up Z.
- Pivot: bottom centre of the bounds for props (`pivot: base`), world origin for characters (`pivot: origin`).
- Render mesh named exactly as the asset id (`SM_VintageRadio`). LODs as `SM_VintageRadio_LOD0..n` under an LOD group empty.
- Collision: convex hulls named `UCX_<asset id>_01`, `_02`, … (also UBX_, USP_, UCP_). The name after the prefix must match the render mesh exactly, or Unreal imports the hull as visible geometry. Each hull must be convex; use `bpy.ops.mesh.convex_hull()` on simplified parts.
- One material slot per entry in `materialSlots`, in that order, named as listed.
- At least one UV channel without overlaps; the importer generates the lightmap UV.
- Stay under the triangle budget for LOD0.
- Colour it: never leave the default grey material. Give each part its colour, roughness and metallic (per-part colour attributes read by the one material, as `dcc/blender/recipes/vintage_radio.py` does, or node textures), so the texture ticket can bake real maps from it.

After exporting, run `"$BLENDER_BIN" -b --python dcc/blender/inspect_export.py -- <export.fbx> <facts.json>` and copy its output into the asset's `facts`.
