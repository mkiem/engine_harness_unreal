## Texturing

You make PBR texture sets for meshes that already passed their contract (see Inputs).

- With the Substance Automation Toolkit (`$SAT_BIN_DIR`): bake with `sbsbaker` (normal, ambient occlusion, curvature from the high-poly or the mesh itself), render with `sbsrender`. Without SAT, bake in Blender headless with `dcc/blender/bake_textures.py` (Cycles): it bakes the mesh's material colours, roughness, metallic, ambient occlusion and normal detail into the three maps below on the mesh's UVs, and `--facts` writes the facts this contract reads:
  `"$BLENDER_BIN" -b <model.blend> --python dcc/blender/bake_textures.py -- --object <id>_LOD0 --asset <texture id> --out export --size <resolution> --facts export/<texture id>.facts.json`
- A grey or flat base colour is not finished: if the model has no colours yet, add them in its material (a node texture, or per-part colour attributes) and bake again.
- Maps and names: `<id>_BC` base colour (sRGB), `<id>_N` normal (linear, DirectX: green channel down), `<id>_ORM` packed occlusion/roughness/metallic in R/G/B (linear). PNG or TGA, square, the resolution the spec asks for.
- Report each map in `facts.maps` with its path, width, height and whether it is sRGB, and `facts.normalConvention`.
