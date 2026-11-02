"""Recipe: a 1940s tabletop valve radio, built procedurally, to the Unreal interchange contract.

    blender -b --python dcc/blender/recipes/vintage_radio.py -- --out SM_VintageRadio.blend

A worked example of what a Blender worker writes: a re-runnable script, real-world size in metres, one material slot,
UVs, three LODs under an FBX LOD group, and a convex collision hull named after the mesh. Export it afterwards with
export_static_prop.py. Run on Blender 5.2 headless (the bpy module) in this repository's end-to-end test.
"""
from __future__ import annotations

import argparse
import sys

import bpy  # type: ignore[import-not-found]

ASSET = "SM_VintageRadio"
MATERIAL = "MI_VintageRadio"
SIZE = (0.40, 0.22, 0.28)  # metres: width (X), depth (Y), height (Z)


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


def build_lod0():
    width, depth, height = SIZE
    body = add_box("body", SIZE, (0, 0, height / 2))
    bevel = body.modifiers.new("bevel", "BEVEL")
    bevel.width = 0.012
    bevel.segments = 3
    # The speaker grille: a shallow inset panel on the front face.
    grille = add_box("grille", (width * 0.62, 0.006, height * 0.46), (0, -depth / 2 - 0.002, height * 0.60))
    dials = [add_dial("dial_left", -width * 0.22), add_dial("dial_right", width * 0.22)]
    parts = [body, grille, *dials]
    select_only(parts)
    bpy.ops.object.convert(target="MESH")  # applies the bevel
    bpy.ops.object.join()
    lod0 = bpy.context.active_object
    lod0.name = f"{ASSET}_LOD0"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    material = bpy.data.materials.new(MATERIAL)
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
