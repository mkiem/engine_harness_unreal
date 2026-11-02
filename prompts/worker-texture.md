## Texturing

You make PBR texture sets for meshes that already passed their contract (see Inputs).

- With the Substance Automation Toolkit (`$SAT_BIN_DIR`): bake with `sbsbaker` (normal, ambient occlusion, curvature from the high-poly or the mesh itself), render with `sbsrender`. Without SAT, bake in Blender headless with Cycles.
- Maps and names: `<id>_BC` base colour (sRGB), `<id>_N` normal (linear, DirectX: green channel down), `<id>_ORM` packed occlusion/roughness/metallic in R/G/B (linear). PNG or TGA, square, the resolution the spec asks for.
- Report each map in `facts.maps` with its path, width, height and whether it is sRGB, and `facts.normalConvention`.
