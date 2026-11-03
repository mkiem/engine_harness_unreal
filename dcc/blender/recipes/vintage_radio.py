"""Recipe: a 1940s tabletop valve radio, built procedurally, to the Unreal interchange contract.

    blender -b --python dcc/blender/recipes/vintage_radio.py -- --out SM_VintageRadio.blend

A worked example of what a Blender worker writes: a re-runnable script, real-world size in metres, one material slot,
UVs, three LODs under an FBX LOD group, and a convex collision hull named after the mesh. Export it afterwards with
export_static_prop.py. Run on Blender 5.2 headless (the bpy module) in this repository's end-to-end test.

It is coloured too: each part is painted into face-corner colour attributes (Paint: base colour; PBR: roughness and
metallic; Mask: which parts are wood and fabric), and the one material, MI_VintageRadio, reads them, adds a wood grain
to the walnut case and a woven bump to the grille cloth. bake_textures.py turns that into T_VintageRadio_BC, _ORM and
_N on the UVs.
"""
from __future__ import annotations

import argparse
import sys

import bpy  # type: ignore[import-not-found]

ASSET = "SM_VintageRadio"
MATERIAL = "MI_VintageRadio"
SIZE = (0.40, 0.22, 0.28)  # metres: width (X), depth (Y), height (Z)

# Linear colour, roughness, metallic, wood, fabric for each part.
WALNUT = ((0.19, 0.075, 0.03), 0.45, 0.0, 1.0, 0.0)
CLOTH = ((0.52, 0.40, 0.22), 0.9, 0.0, 0.0, 1.0)
BAKELITE = ((0.035, 0.018, 0.01), 0.28, 0.0, 0.0, 0.0)
BRASS = ((0.75, 0.52, 0.2), 0.32, 1.0, 0.0, 0.0)


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def select_only(objects: list) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def add_box(name: str, size: tuple[float, float, float], location: tuple[float, float, float]):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    return obj


def add_dial(name: str, x: float) -> object:
    width, depth, height = SIZE
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.022, depth=0.018,
                                        location=(x, -depth / 2 - 0.006, height * 0.22), rotation=(1.5708, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    return obj


def paint(obj, part) -> None:
    """Writes a part's colour, roughness, metallic and wood/fabric masks into face-corner colour attributes."""
    colour, roughness, metallic, wood, fabric = part
    for name, value in (("Paint", (*colour, 1.0)), ("PBR", (roughness, metallic, 0.0, 1.0)), ("Mask", (wood, fabric, 0.0, 1.0))):
        attribute = obj.data.color_attributes.new(name, "FLOAT_COLOR", "CORNER")
        for item in attribute.data:
            item.color = value


def radio_material():
    """MI_VintageRadio: the painted attributes, with a walnut grain and a woven grille cloth."""
    material = bpy.data.materials.new(MATERIAL)
    if bpy.app.version < (5, 0, 0):
        material.use_nodes = True  # always on from Blender 5
    tree = material.node_tree
    nodes, links = tree.nodes, tree.links
    bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")

    def mix_rgba(blend="MIX"):
        node = nodes.new("ShaderNodeMix")
        node.data_type = "RGBA"
        node.blend_type = blend
        pick = lambda sockets, name: next(socket for socket in sockets if socket.name == name and socket.type == "RGBA")
        return node, pick(node.inputs, "A"), pick(node.inputs, "B"), pick(node.outputs, "Result")

    def attribute(name):
        node = nodes.new("ShaderNodeVertexColor")
        node.layer_name = name
        split = nodes.new("ShaderNodeSeparateColor")
        links.new(node.outputs["Color"], split.inputs["Color"])
        return node, split

    paint_node, _ = attribute("Paint")
    _, pbr = attribute("PBR")
    _, mask = attribute("Mask")
    coords = nodes.new("ShaderNodeTexCoord")

    # Walnut grain: stretched, distorted bands, darker in the late wood.
    grain = nodes.new("ShaderNodeTexWave")
    grain.wave_type = "BANDS"
    grain.bands_direction = "Z"
    grain.inputs["Scale"].default_value = 9.0
    grain.inputs["Distortion"].default_value = 6.0
    grain.inputs["Detail"].default_value = 3.0
    links.new(coords.outputs["Object"], grain.inputs["Vector"])
    shade = nodes.new("ShaderNodeMapRange")
    shade.inputs["To Min"].default_value = 0.62
    links.new(grain.outputs["Fac"], shade.inputs["Value"])
    darker, darker_a, darker_b, darker_out = mix_rgba("MULTIPLY")
    darker.inputs["Factor"].default_value = 1.0
    links.new(paint_node.outputs["Color"], darker_a)
    links.new(shade.outputs["Result"], darker_b)
    wood, wood_a, wood_b, wood_out = mix_rgba()
    links.new(mask.outputs["Red"], wood.inputs["Factor"])
    links.new(paint_node.outputs["Color"], wood_a)
    links.new(darker_out, wood_b)
    links.new(wood_out, bsdf.inputs["Base Color"])
    links.new(pbr.outputs["Red"], bsdf.inputs["Roughness"])
    links.new(pbr.outputs["Green"], bsdf.inputs["Metallic"])

    # Grille cloth: a fine weave as a bump, on the fabric only (and a faint one in the wood grain).
    threads = []
    for direction in ("X", "Z"):
        thread = nodes.new("ShaderNodeTexWave")
        thread.wave_type = "BANDS"
        thread.bands_direction = direction
        thread.wave_profile = "SIN"
        thread.inputs["Scale"].default_value = 70.0
        links.new(coords.outputs["Object"], thread.inputs["Vector"])
        threads.append(thread)
    weave = nodes.new("ShaderNodeMath")
    weave.operation = "MULTIPLY"
    links.new(threads[0].outputs["Fac"], weave.inputs[0])
    links.new(threads[1].outputs["Fac"], weave.inputs[1])
    height = nodes.new("ShaderNodeMath")
    height.operation = "MULTIPLY"
    links.new(weave.outputs["Value"], height.inputs[0])
    links.new(mask.outputs["Green"], height.inputs[1])
    grain_height = nodes.new("ShaderNodeMath")
    grain_height.operation = "MULTIPLY_ADD"
    links.new(grain.outputs["Fac"], grain_height.inputs[0])
    grain_height.inputs[1].default_value = 0.15
    links.new(height.outputs["Value"], grain_height.inputs[2])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    bump.inputs["Distance"].default_value = 0.002
    links.new(grain_height.outputs["Value"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return material


def build_lod0():
    width, depth, height = SIZE
    body = add_box("body", SIZE, (0, 0, height / 2))
    bevel = body.modifiers.new("bevel", "BEVEL")
    bevel.width = 0.012
    bevel.segments = 3
    # The speaker grille: a shallow inset panel on the front face.
    grille = add_box("grille", (width * 0.62, 0.006, height * 0.46), (0, -depth / 2 - 0.002, height * 0.60))
    dials = [add_dial("dial_left", -width * 0.22), add_dial("dial_right", width * 0.22)]
    # A brass name plate between the dials.
    plate = add_box("plate", (width * 0.2, 0.004, height * 0.07), (0, -depth / 2 - 0.001, height * 0.22))
    parts = [body, grille, *dials, plate]
    select_only(parts)
    bpy.ops.object.convert(target="MESH")  # applies the bevel
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for part, look in ((body, WALNUT), (grille, CLOTH), (dials[0], BAKELITE), (dials[1], BAKELITE), (plate, BRASS)):
        paint(part, look)
    select_only(parts)
    bpy.ops.object.join()
    lod0 = bpy.context.active_object
    lod0.name = f"{ASSET}_LOD0"

    material = radio_material()
    lod0.data.materials.clear()
    lod0.data.materials.append(material)

    select_only([lod0])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    return lod0


def build_lod(source, level: int, ratio: float):
    copy = source.copy()
    copy.data = source.data.copy()
    copy.name = f"{ASSET}_LOD{level}"
    bpy.context.collection.objects.link(copy)
    decimate = copy.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = ratio
    select_only([copy])
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    return copy


def build_collision():
    """One convex hull around the body: a box is the cheapest hull that blocks the player."""
    width, depth, height = SIZE
    hull = add_box(f"UCX_{ASSET}_01", (width, depth + 0.012, height), (0, -0.003, height / 2))
    select_only([hull])
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    hull.display_type = "WIRE"
    return hull


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="the .blend to save")
    args = parser.parse_args(argv)

    clear_scene()
    lod0 = build_lod0()
    lods = [lod0, build_lod(lod0, 1, 0.5), build_lod(lod0, 2, 0.2)]
    # Blender's FBX exporter writes an empty with fbx_type = LodGroup as an FBX LOD group, which Unreal imports as LODs.
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    group = bpy.context.active_object
    group.name = ASSET
    group["fbx_type"] = "LodGroup"
    for lod in lods:
        lod.parent = group
    build_collision()
    bpy.ops.wm.save_as_mainfile(filepath=args.out)
    triangles = sum(len(poly.vertices) - 2 for poly in lod0.data.polygons)
    print(f"built {ASSET}: LOD0 about {triangles} triangles, saved {args.out}")


if __name__ == "__main__":
    main()
