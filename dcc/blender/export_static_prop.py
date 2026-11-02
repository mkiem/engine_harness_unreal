"""Export a static prop from Blender to the Unreal interchange contract, then inspect the export.

Run headless on the .blend a recipe built:

    blender -b SM_VintageRadio.blend --python dcc/blender/export_static_prop.py -- \
        --asset SM_VintageRadio --out export/SM_VintageRadio.fbx --facts export/SM_VintageRadio.facts.json

What it enforces before exporting (the harness contract checks the result again, from the file):
- every exported object has rotation and scale applied;
- the render mesh (or its LOD children) is named after the asset; collision hulls are UCX_/UBX_/USP_/UCP_<asset>_NN;
- the pivot sits at the bottom centre of the render mesh's bounds (or the world origin with --pivot origin);
- scene units are metric with unit scale 1.0, exported with FBX_SCALE_UNITS so 1 m arrives in Unreal as 100 cm.

Untested here against a live Blender: run it on Blender 3.6+ and fix what the contract reports.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

COLLISION = re.compile(r"^(UCX|UBX|USP|UCP)_(.+)_(\d{2})$")


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--facts", required=True)
    parser.add_argument("--pivot", choices=["base", "origin"], default="base")
    return parser.parse_args(argv)


def exported_objects(asset: str) -> tuple[list, list]:
    render, collision = [], []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        match = COLLISION.match(obj.name)
        if match and match.group(2) == asset:
            collision.append(obj)
        elif obj.name == asset or obj.name.startswith(f"{asset}_LOD"):
            render.append(obj)
    if not render:
        raise SystemExit(f"no render mesh named {asset} or {asset}_LOD<n> in the scene")
    return render, collision


def apply_transforms(objects: list) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def world_bounds(objects: list) -> tuple[Vector, Vector]:
    corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return low, high


def move_pivot(render: list, collision: list, pivot: str) -> None:
    """Moves everything so the chosen pivot point lands on the world origin, which becomes the asset's pivot in Unreal."""
    if pivot == "origin":
        return
    low, high = world_bounds(render)
    base = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    for obj in render + collision:
        obj.location -= base
    bpy.context.view_layer.update()
    for obj in render + collision:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def main() -> None:
    args = parse_args()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    render, collision = exported_objects(args.asset)
    apply_transforms(render + collision)
    move_pivot(render, collision, args.pivot)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in render + collision:
        obj.select_set(True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=args.out,
        use_selection=True,
        object_types={"MESH", "EMPTY"},
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        use_tspace=True,
        add_leaf_bones=False,
        bake_anim=False,
    )
    # Measure the file, not the scene: the facts must describe what Unreal will import.
    sys.argv = [sys.argv[0], "--", args.out, args.facts, "--asset", args.asset]
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "inspect_export.py"), encoding="utf8") as source:
        exec(compile(source.read(), "inspect_export.py", "exec"), {"__name__": "__main__"})


if __name__ == "__main__":
    main()
