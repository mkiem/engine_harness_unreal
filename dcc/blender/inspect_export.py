"""Measure a mesh export the way the harness contract reads it: re-import the file into an empty scene and report facts.

    blender -b --factory-startup --python dcc/blender/inspect_export.py -- export/SM_X.fbx facts.json --asset SM_X

Writes the `facts` object of an AssetRecord (see src/contracts/index.ts MeshFacts): triangles of LOD0, LOD count,
bounds and pivot offsets in centimetres, render and collision mesh names, material slots, UV channels, and whether
transforms are applied. Untested here against a live Blender.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

COLLISION = re.compile(r"^(UCX|UBX|USP|UCP)_")
LOD = re.compile(r"_LOD(\d+)$")


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("export")
    parser.add_argument("facts")
    parser.add_argument("--asset", required=True)
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if args.export.lower().endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=args.export, use_custom_normals=True)
    else:
        bpy.ops.import_scene.gltf(filepath=args.export)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    # The FBX importer may append .001 to clashing names; compare on the base name.
    name = lambda obj: re.sub(r"\.\d{3}$", "", obj.name)  # noqa: E731
    collision = [obj for obj in meshes if COLLISION.match(name(obj)) or COLLISION.match(name(obj).upper())]
    render = [obj for obj in meshes if obj not in collision]
    lod0 = [obj for obj in render if not LOD.search(name(obj)) or LOD.search(name(obj)).group(1) == "0"]
    lods = {int(LOD.search(name(obj)).group(1)) for obj in render if LOD.search(name(obj))}

    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    for obj in lod0:
        mesh = obj.evaluated_get(depsgraph).to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        obj.evaluated_get(depsgraph).to_mesh_clear()

    corners = [obj.matrix_world @ Vector(corner) for obj in (lod0 or render) for corner in obj.bound_box]
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    # The re-imported scene is in metres (the importer undoes FBX_SCALE_UNITS); the contract speaks centimetres.
    cm = 100.0 * bpy.context.scene.unit_settings.scale_length
    base = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    applied = all(
        all(abs(v) < 1e-4 for v in obj.rotation_euler) and all(abs(s - 1) < 1e-4 for s in obj.scale)
        for obj in meshes if obj.parent is None or obj.parent.type != "EMPTY"
    )
    slots: list[str] = []
    for obj in lod0:
        for slot in obj.material_slots:
            if slot.material and slot.material.name not in slots:
                slots.append(re.sub(r"\.\d{3}$", "", slot.material.name))
    facts = {
        "triangles": triangles,
        "lods": max(1, len(lods)),
        "boundsCm": [round((high[i] - low[i]) * cm, 3) for i in range(3)],
        "pivotFromBaseCm": [round(-base[i] * cm, 3) for i in range(3)],
        "pivotFromOriginCm": [0.0, 0.0, 0.0],
        "meshNames": [name(obj) for obj in render],
        "collisionNames": [name(obj) for obj in collision],
        "materialSlots": slots,
        "uvChannels": min((len(obj.data.uv_layers) for obj in lod0), default=0),
        "transformsApplied": applied,
    }
    with open(args.facts, "w", encoding="utf8") as out:
        json.dump(facts, out, indent=2)
    print(json.dumps(facts))


if __name__ == "__main__":
    main()
