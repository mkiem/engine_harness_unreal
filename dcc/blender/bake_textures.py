"""Bake a mesh's materials into a PBR texture set on its UVs, to the texture contract:

    blender -b model.blend --python dcc/blender/bake_textures.py -- --object SM_VintageRadio_LOD0 --asset T_VintageRadio \
        --out export/ --size 2048 [--facts export/T_VintageRadio.facts.json] [--apply] [--save model.blend]

Writes <asset>_BC.png (base colour, sRGB), <asset>_ORM.png (ambient occlusion, roughness, metallic in R, G, B; linear)
and <asset>_N.png (tangent-space normal, DirectX: green down; linear) with Cycles, from whatever the object's
materials say: each Principled BSDF's Base Color, Roughness, Metallic and Normal inputs, linked to textures, attributes
or procedural nodes, or plain values. Several materials bake into the one set, so a recipe can colour each part with
its own material and still deliver one material slot. --facts writes the texture facts the contract reads; --apply
replaces the object's materials with one material (named after the first slot) that uses the baked maps, so a GLB
export and previews show them; --save saves the .blend afterwards.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import bpy  # type: ignore[import-not-found]
import numpy as np

INPUTS = {"base": "Base Color", "roughness": "Roughness", "metallic": "Metallic"}


def principled(material):
    if not material or not material.node_tree:
        return None
    return next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)


def new_image(name: str, size: int, colour_data: bool):
    image = bpy.data.images.get(name) or bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    if image.size[0] != size:
        image.scale(size, size)
    image.colorspace_settings.name = "sRGB" if colour_data else "Non-Color"
    return image


class Rewire:
    """Temporarily routes one input of every material's Principled BSDF into an emission shader, for an EMIT bake."""

    def __init__(self, materials, image):
        self.materials, self.image, self.undo = materials, image, []

    def emit(self, socket_name: str | None) -> None:
        for material in self.materials:
            tree = material.node_tree
            output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None)
            if output is None:
                output = tree.nodes.new("ShaderNodeOutputMaterial")
            target = tree.nodes.new("ShaderNodeTexImage")
            target.image = self.image
            tree.nodes.active = target
            created = [target]
            if socket_name is not None:
                bsdf = principled(material)
                emission = tree.nodes.new("ShaderNodeEmission")
                created.append(emission)
                source = bsdf.inputs[socket_name] if bsdf else None
                if source is not None and source.is_linked:
                    tree.links.new(source.links[0].from_socket, emission.inputs["Color"])
                else:
                    value = source.default_value if source is not None else (0.8, 0.8, 0.8, 1.0)
                    emission.inputs["Color"].default_value = tuple(value) if hasattr(value, "__len__") else (value, value, value, 1.0)
                previous = output.inputs["Surface"].links[0].from_socket if output.inputs["Surface"].is_linked else None
                tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
                self.undo.append((tree, output, previous))
            self.undo.append((tree, created, None))

    def restore(self) -> None:
        for tree, thing, previous in reversed(self.undo):
            if isinstance(thing, list):
                for node in thing:
                    tree.nodes.remove(node)
            elif previous is not None:
                tree.links.new(previous, thing.inputs["Surface"])
        self.undo = []


def bake(obj, kind: str, image, socket: str | None = None, samples: int = 1) -> None:
    scene = bpy.context.scene
    scene.cycles.samples = samples
    materials = [slot.material for slot in obj.material_slots if slot.material]
    if kind == "EMIT" and socket is None:
        raise ValueError("an emit bake needs a socket")
    rewire = Rewire(materials, image)
    rewire.emit(socket if kind == "EMIT" else None)
    try:
        bake_settings = scene.render.bake
        bake_settings.margin = max(4, image.size[0] // 128)
        bake_settings.use_clear = True
        bake_settings.target = "IMAGE_TEXTURES"
        if kind == "NORMAL":
            bake_settings.normal_space = "TANGENT"
            bake_settings.normal_r, bake_settings.normal_g, bake_settings.normal_b = "POS_X", "NEG_Y", "POS_Z"  # DirectX
        bpy.ops.object.bake(type=kind)
    finally:
        rewire.restore()


def save(image, path: str) -> None:
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--object", required=True, help="the mesh to bake (LOD0)")
    parser.add_argument("--asset", required=True, help="the texture set's id, such as T_VintageRadio")
    parser.add_argument("--out", required=True, help="the folder for the maps")
    parser.add_argument("--size", type=int, default=2048)
    parser.add_argument("--ao-samples", type=int, default=32)
    parser.add_argument("--facts")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--save")
    args = parser.parse_args(argv)

    obj = bpy.data.objects[args.object]
    if not obj.data.uv_layers:
        raise SystemExit(f"{obj.name} has no UVs; unwrap it first")
    materials = [slot.material for slot in obj.material_slots if slot.material]
    if not materials:
        raise SystemExit(f"{obj.name} has no material to bake")
    if bpy.app.version < (5, 0, 0):  # node materials are always on from Blender 5
        for material in materials:
            material.use_nodes = True
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    obj.hide_render = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(args.out, exist_ok=True)
    size = args.size

    base = new_image(f"{args.asset}_BC", size, True)
    bake(obj, "EMIT", base, INPUTS["base"])
    rough = new_image(f"{args.asset}_R_tmp", size, False)
    bake(obj, "EMIT", rough, INPUTS["roughness"])
    metal = new_image(f"{args.asset}_M_tmp", size, False)
    bake(obj, "EMIT", metal, INPUTS["metallic"])
    ao = new_image(f"{args.asset}_AO_tmp", size, False)
    bake(obj, "AO", ao, samples=args.ao_samples)
    normal = new_image(f"{args.asset}_N", size, False)
    bake(obj, "NORMAL", normal, samples=1)

    # Pack ORM: R occlusion, G roughness, B metallic.
    orm = new_image(f"{args.asset}_ORM", size, False)
    def read(image):
        values = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(values)
        return values
    packed = np.ones(size * size * 4, dtype=np.float32)
    packed[0::4], packed[1::4], packed[2::4] = read(ao)[0::4], read(rough)[0::4], read(metal)[0::4]
    orm.pixels.foreach_set(packed)

    paths = {}
    for key, image in (("BaseColor", base), ("ORM", orm), ("Normal", normal)):
        suffix = {"BaseColor": "_BC", "ORM": "_ORM", "Normal": "_N"}[key]
        path = os.path.join(args.out, f"{args.asset}{suffix}.png")
        save(image, path)
        paths[key] = path
    for image in (rough, metal, ao):
        bpy.data.images.remove(image)

    facts = {
        "maps": {key: {"path": os.path.basename(path), "width": size, "height": size, "srgb": key == "BaseColor"} for key, path in paths.items()},
        "normalConvention": "directx",
    }
    if args.facts:
        with open(args.facts, "w", encoding="utf8") as out:
            json.dump(facts, out, indent=2)

    if args.apply:
        name = materials[0].name
        baked = bpy.data.materials.new(f"{name}__baked")
        if bpy.app.version < (5, 0, 0):
            baked.use_nodes = True
        tree = baked.node_tree
        bsdf = principled(baked)
        colour = tree.nodes.new("ShaderNodeTexImage")
        colour.image = base
        tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
        packed_node = tree.nodes.new("ShaderNodeTexImage")
        packed_node.image = orm
        split = tree.nodes.new("ShaderNodeSeparateColor")
        tree.links.new(packed_node.outputs["Color"], split.inputs["Color"])
        tree.links.new(split.outputs["Green"], bsdf.inputs["Roughness"])
        tree.links.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
        normal_node = tree.nodes.new("ShaderNodeTexImage")
        normal_node.image = normal
        # Blender reads OpenGL normals; flip the DirectX green channel back for the preview material.
        flip = tree.nodes.new("ShaderNodeSeparateColor")
        tree.links.new(normal_node.outputs["Color"], flip.inputs["Color"])
        invert = tree.nodes.new("ShaderNodeMath")
        invert.operation = "SUBTRACT"
        invert.inputs[0].default_value = 1.0
        tree.links.new(flip.outputs["Green"], invert.inputs[1])
        join = tree.nodes.new("ShaderNodeCombineColor")
        tree.links.new(flip.outputs["Red"], join.inputs["Red"])
        tree.links.new(invert.outputs["Value"], join.inputs["Green"])
        tree.links.new(flip.outputs["Blue"], join.inputs["Blue"])
        map_node = tree.nodes.new("ShaderNodeNormalMap")
        tree.links.new(join.outputs["Color"], map_node.inputs["Color"])
        tree.links.new(map_node.outputs["Normal"], bsdf.inputs["Normal"])
        users = [o for o in bpy.data.objects if o.type == "MESH" and any(s.material in materials for s in o.material_slots)]
        for user in users:
            user.data.materials.clear()
            user.data.materials.append(baked)
        for material in materials:
            if material.users == 0:
                bpy.data.materials.remove(material)
        baked.name = name

    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=args.save)
    print("TEXTURES_BAKED " + json.dumps({"asset": args.asset, "size": size, "maps": {k: os.path.basename(v) for k, v in paths.items()}}))


if __name__ == "__main__":
    main()
