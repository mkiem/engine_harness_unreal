"""Build a rigged, textured, animated 3D character from reference views, in one of four styles, for Unreal and Godot.

    blender -b --factory-startup --python dcc/blender/character/build_character.py -- \
        --refs characters/hero/reference --name Hero --style toon --out characters/hero/build [--height 1.8]

The reference views come from src/character/reference.ts: front, side and (optionally) back cut-outs with transparent
backgrounds, all scaled to the same height. No paid service or machine-learning model is involved:

1. Shape: the silhouettes are extruded through a voxel grid and intersected (a visual hull), and each horizontal
   slice is rounded into ellipses, since bodies are round rather than boxy.
2. Style: voxel (the blocks themselves), lowpoly (remeshed, decimated, flat-shaded facets), toon (smooth, for a
   cel-shading material) or retro (very few polygons and a tiny texture, like early 3D consoles).
3. Colour: the reference images are projected onto the model from the front, sides and back, and baked into a base
   colour texture (quantized to a small palette for the blocky styles), with ORM (ambient occlusion, roughness,
   metallic) and normal maps beside it.
4. Rig: a humanoid skeleton with Godot's humanoid bone names is fitted to landmarks found in the silhouettes (neck,
   shoulders, hands, crotch, knees, feet), and the mesh is skinned to it.
5. Animation: idle, walk, run and attack cycles are keyed procedurally.
6. Export: SK_<Name>.fbx for Unreal (metres arrive as centimetres), <name>.glb for Godot, the .blend, turntable
   renders beside the references, and build.json with what was made.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy  # type: ignore[import-not-found]
import numpy as np
from mathutils import Quaternion, Vector  # type: ignore[import-not-found]

STYLES = {
    # grid: voxels from feet to head; round: superellipse exponent per slice; triangles: decimation target;
    # texture: base colour size; closest: nearest-neighbour textures; palette: colours after quantizing (0 = keep).
    "voxel": {"grid": 40, "round": 3.0, "triangles": 0, "texture": 256, "closest": True, "palette": 24, "smooth": False, "roughness": 0.9},
    "lowpoly": {"grid": 96, "round": 2.2, "triangles": 1400, "texture": 256, "closest": False, "palette": 20, "smooth": False, "roughness": 0.85},
    "toon": {"grid": 120, "round": 2.0, "triangles": 9000, "texture": 1024, "closest": False, "palette": 0, "smooth": True, "roughness": 1.0},
    "retro": {"grid": 80, "round": 2.2, "triangles": 800, "texture": 128, "closest": True, "palette": 48, "smooth": True, "roughness": 0.9},
}

ANIMATIONS = ("idle", "walk", "run", "attack")


# ---- reading the references ---------------------------------------------------------------------------------------

def load_view(path: str) -> np.ndarray:
    """An RGBA float array, row 0 at the top (the head), from a PNG Blender can read."""
    image = bpy.data.images.load(path, check_existing=False)
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(height, width, 4)[::-1]


def area_resample(mask: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """The fraction of filled pixels in each cell of a rows x cols grid laid over the mask (box filter)."""
    h, w = mask.shape
    integral = np.zeros((h + 1, w + 1), dtype=np.float64)
    integral[1:, 1:] = np.cumsum(np.cumsum(mask, axis=0), axis=1)
    ys = np.linspace(0, h, rows + 1).round().astype(int)
    xs = np.linspace(0, w, cols + 1).round().astype(int)
    total = integral[ys[1:, None], xs[None, 1:]] - integral[ys[:-1, None], xs[None, 1:]] - integral[ys[1:, None], xs[None, :-1]] + integral[ys[:-1, None], xs[None, :-1]]
    size = (ys[1:] - ys[:-1])[:, None] * (xs[1:] - xs[:-1])[None, :]
    return total / np.maximum(size, 1)


# ---- shape ------------------------------------------------------------------------------------------------------------

def visual_hull(views: dict, style: dict, height_m: float, side_facing: str) -> tuple[np.ndarray, dict]:
    """Voxels inside every silhouette: occupancy[z, x, y] with z = 0 at the feet."""
    rows = style["grid"]
    px = height_m / views["front"].shape[0]  # metres per reference pixel
    voxel = height_m / rows
    front_w = views["front"].shape[1]
    side_w = views["side"].shape[1]
    nx = max(2, round(front_w * px / voxel))
    ny = max(2, round(side_w * px / voxel))
    flip = lambda grid: grid[::-1]  # noqa: E731  (image rows top-down -> z bottom-up)
    front = flip(area_resample(views["front"][..., 3] > 0.5, rows, nx)) > 0.5
    side = flip(area_resample(views["side"][..., 3] > 0.5, rows, ny)) > 0.5
    if side_facing == "right":
        side = side[:, ::-1]  # image left->right is back->front; grid y runs front (-Y) to back (+Y)
    hull = front[:, :, None] & side[:, None, :]
    if "back" in views:
        back = flip(area_resample(views["back"][..., 3] > 0.5, rows, nx)) > 0.5
        hull &= back[:, ::-1][:, :, None]
    hull = round_slices(hull, style["round"])
    grid = {"voxel": voxel, "nx": nx, "ny": ny, "rows": rows, "x0": -nx * voxel / 2, "y0": -ny * voxel / 2, "px": px}
    return hull, grid


def round_slices(hull: np.ndarray, exponent: float) -> np.ndarray:
    """Rounds every horizontal slice: each connected region keeps only the cells inside the superellipse fitted to its
    box. Regions off to the side (arms) are made about as deep as they are wide, since a side view cannot tell an
    arm's depth from the body behind it."""
    out = np.zeros_like(hull)
    rows, nx, ny = hull.shape
    centre_x = nx / 2
    for z in range(rows):
        slab = hull[z]
        if not slab.any():
            continue
        labels = np.zeros(slab.shape, dtype=np.int32)
        count = 0
        regions = []
        for sx, sy in zip(*np.nonzero(slab)):
            if labels[sx, sy]:
                continue
            count += 1
            stack = [(sx, sy)]
            labels[sx, sy] = count
            cells = []
            while stack:
                cx, cy = stack.pop()
                cells.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ax, ay = cx + dx, cy + dy
                    if 0 <= ax < nx and 0 <= ay < ny and slab[ax, ay] and not labels[ax, ay]:
                        labels[ax, ay] = count
                        stack.append((ax, ay))
            regions.append(np.array(cells))
        central = min(range(len(regions)), key=lambda i: abs(regions[i][:, 0].mean() - centre_x))
        for i, cells in enumerate(regions):
            x0, y0 = cells.min(axis=0)
            x1, y1 = cells.max(axis=0)
            a = (x1 - x0 + 1) / 2
            b = (y1 - y0 + 1) / 2
            cxm, cym = (x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2
            if i != central and len(regions) > 1:
                b = min(b, a * 1.15)
                cym = cells[:, 1].mean() + 0.5
            dx = (cells[:, 0] + 0.5 - cxm) / max(a, 0.5)
            dy = (cells[:, 1] + 0.5 - cym) / max(b, 0.5)
            keep = np.abs(dx) ** exponent + np.abs(dy) ** exponent <= 1.0
            if not keep.any():
                keep[np.argmin(dx ** 2 + dy ** 2)] = True
            out[z, cells[keep, 0], cells[keep, 1]] = True
    return out


def voxel_mesh(hull: np.ndarray, grid: dict, name: str):
    """A mesh with one quad per exposed voxel face, vertices shared."""
    v = grid["voxel"]
    verts: list[tuple[float, float, float]] = []
    index: dict[tuple[int, int, int], int] = {}
    faces: list[tuple[int, int, int, int]] = []

    def vid(i: int, j: int, k: int) -> int:
        key = (i, j, k)
        if key not in index:
            index[key] = len(verts)
            verts.append((grid["x0"] + i * v, grid["y0"] + j * v, k * v))
        return index[key]

    padded = np.pad(hull, 1)
    # (axis offset in z, x, y order, face corners as (x, y, z) unit offsets, counter-clockwise from outside)
    sides = [
        ((0, 1, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
        ((0, -1, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
        ((0, 0, 1), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
        ((0, 0, -1), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
        ((1, 0, 0), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
        ((-1, 0, 0), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
    ]
    rows, nx, ny = hull.shape
    for (dz, dx, dy), corners in sides:
        neighbour = padded[1 + dz:1 + dz + rows, 1 + dx:1 + dx + nx, 1 + dy:1 + dy + ny]
        for z, x, y in zip(*np.nonzero(hull & ~neighbour)):
            faces.append(tuple(vid(x + cx, y + cy, z + cz) for cx, cy, cz in corners))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def select_only(objects) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def apply_modifier(obj, kind: str, **settings) -> None:
    mod = obj.modifiers.new(kind.lower(), kind)
    for key, value in settings.items():
        setattr(mod, key, value)
    select_only([obj])
    bpy.ops.object.modifier_apply(modifier=mod.name)


def triangles(obj) -> int:
    return sum(len(poly.vertices) - 2 for poly in obj.data.polygons)


def shape(hull: np.ndarray, grid: dict, style_name: str, style: dict, name: str, target: int):
    obj = voxel_mesh(hull, grid, name)
    if style_name == "voxel":
        return obj
    v = grid["voxel"]
    apply_modifier(obj, "REMESH", mode="VOXEL", voxel_size=v * 0.9, adaptivity=0.0)
    apply_modifier(obj, "SMOOTH", factor=0.6, iterations={"lowpoly": 6, "toon": 14, "retro": 8}[style_name])
    if target and triangles(obj) > target:
        apply_modifier(obj, "DECIMATE", decimate_type="COLLAPSE", ratio=max(0.01, target / triangles(obj)))
    return obj


# ---- colour -----------------------------------------------------------------------------------------------------------

def visibility(obj, hull: np.ndarray, grid: dict) -> None:
    """Which reference views can see each vertex, as a colour attribute (R front, G sides, B back): a view only
    colours the surface its camera sees first, so an arm drawn over the body in the side view does not paint the body."""
    v = grid["voxel"]
    rows, nx, ny = hull.shape
    occupied_x = hull.any(axis=1)  # [z, y]
    occupied_y = hull.any(axis=2)  # [z, x]
    xs = np.arange(nx)
    ys = np.arange(ny)
    x_max = np.where(occupied_x, np.max(np.where(hull, xs[None, :, None], -1), axis=1), -1)
    x_min = np.where(occupied_x, np.min(np.where(hull, xs[None, :, None], nx), axis=1), nx)
    y_min = np.where(occupied_y, np.min(np.where(hull, ys[None, None, :], ny), axis=2), ny)
    y_max = np.where(occupied_y, np.max(np.where(hull, ys[None, None, :], -1), axis=2), -1)
    # Where the front view shows the arms apart from the body, the side view shows the arms over the body: there it
    # only colours the arms, never the body behind them.
    body_band = {}
    for z in range(rows):
        filled = np.nonzero(occupied_y[z])[0]
        if not len(filled):
            continue
        breaks = np.nonzero(np.diff(filled) > 1)[0]
        starts = np.concatenate([[filled[0]], filled[breaks + 1]])
        ends = np.concatenate([filled[breaks], [filled[-1]]])
        if len(starts) >= 3:
            centre = nx / 2
            k = min(range(len(starts)), key=lambda i: 0 if starts[i] <= centre <= ends[i] else min(abs(starts[i] - centre), abs(ends[i] - centre)))
            body_band[z] = (starts[k], ends[k])
    attr = obj.data.color_attributes.new("visible", "FLOAT_COLOR", "POINT")
    tolerance = 2.0
    values = np.zeros((len(obj.data.vertices), 4), dtype=np.float32)
    for i, vert in enumerate(obj.data.vertices):
        gx = (vert.co.x - grid["x0"]) / v
        gy = (vert.co.y - grid["y0"]) / v
        gz = int(np.clip(vert.co.z / v, 0, rows - 1))
        ix = int(np.clip(gx, 0, nx - 1))
        iy = int(np.clip(gy, 0, ny - 1))
        side = gx >= x_max[gz, iy] + 1 - tolerance if vert.co.x >= 0 else gx <= x_min[gz, iy] + tolerance
        band = body_band.get(gz)
        if band and band[0] - 1 <= gx <= band[1] + 2:
            side = False
        front = gy <= y_min[gz, ix] + tolerance
        back = gy >= y_max[gz, ix] + 1 - tolerance
        values[i] = (float(front), float(side), float(back), 1.0)
    attr.data.foreach_set("color", values.ravel())


def projection_material(views: dict, grid: dict, height_m: float, side_facing: str, closest: bool):
    """An emission material that colours every point from the reference view facing it most directly."""
    mat = bpy.data.materials.new("projection")
    if bpy.app.version < (5, 0, 0):
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    links.new(emit.outputs[0], out.inputs[0])
    coords = nodes.new("ShaderNodeTexCoord")
    xyz = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coords.outputs["Object"], xyz.inputs[0])
    geometry = nodes.new("ShaderNodeNewGeometry")
    normal = nodes.new("ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Normal"], normal.inputs[0])
    seen = nodes.new("ShaderNodeVertexColor")
    seen.layer_name = "visible"
    seen_by = nodes.new("ShaderNodeSeparateColor")
    links.new(seen.outputs["Color"], seen_by.inputs[0])
    # Not seen by any view (a hidden spot): fall back to whichever views face it.
    unseen = None
    px = grid["px"]

    def math(op: str, a, b=None, c=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = op
        for socket, value in zip(node.inputs, (a, b, c)):
            if value is None:
                continue
            if isinstance(value, (int, float)):
                socket.default_value = value
            else:
                links.new(value, socket)
        return node.outputs[0]

    def vmath(op: str, a, b=None, scale=None):
        node = nodes.new("ShaderNodeVectorMath")
        node.operation = op
        links.new(a, node.inputs[0])
        if b is not None:
            links.new(b, node.inputs[1])
        if scale is not None:
            links.new(scale, node.inputs["Scale"])
        return node.outputs[0]

    def sample(view: str, coordinate, sign: float):
        """Samples a view at u = (sign * coordinate + width/2) / width, v = z / height; returns colour and alpha."""
        image = bpy.data.images.load(views[view + "_path"], check_existing=True)
        width_m = views[view].shape[1] * px
        u = math("MULTIPLY_ADD", coordinate, sign / width_m, 0.5)
        v = math("MULTIPLY", xyz.outputs["Z"], 1.0 / height_m)
        combine = nodes.new("ShaderNodeCombineXYZ")
        links.new(u, combine.inputs[0])
        links.new(v, combine.inputs[1])
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.extension = "EXTEND"
        tex.interpolation = "Closest" if closest else "Linear"
        links.new(combine.outputs[0], tex.inputs[0])
        return tex.outputs["Color"], tex.outputs["Alpha"]

    def gate(visible):
        """1 where the view sees the point, 0.02 where it does not (so hidden spots still get some colour)."""
        return math("MULTIPLY_ADD", visible, 0.98, 0.02)

    # Each view is weighted by how squarely the surface faces it horizontally (fourth power: one view dominates, so
    # colours do not average into ghosts); surfaces facing up or down follow their horizontal tilt.
    flat = math("ADD", math("SQRT", math("ADD", math("POWER", normal.outputs["X"], 2.0), math("POWER", normal.outputs["Y"], 2.0))), 1e-3)
    hx = math("DIVIDE", normal.outputs["X"], flat)
    hy = math("DIVIDE", normal.outputs["Y"], flat)

    def weight(component, positive: bool, alpha, visible, extra=None):
        w = math("MAXIMUM", math("MULTIPLY", component, 1.0 if positive else -1.0), 0.0)
        w = math("POWER", w, 4.0)
        if extra is not None:
            w = math("ADD", w, extra)
        return math("MULTIPLY", math("MULTIPLY", w, alpha), gate(visible))
    side_sign = -1.0 if side_facing == "right" else 1.0
    front_c, front_a = sample("front", xyz.outputs["X"], 1.0)
    side_c, side_a = sample("side", xyz.outputs["Y"], side_sign)
    w_front = weight(hy, False, front_a, seen_by.outputs[0])
    side_extra = None
    terms = [(front_c, w_front)]
    if "back" in views:
        back_c, back_a = sample("back", xyz.outputs["X"], -1.0)
        terms.append((back_c, weight(hy, True, back_a, seen_by.outputs[2])))
    else:
        # No back view: the back takes its colours from the sides.
        side_extra = math("POWER", math("MAXIMUM", hy, 0.0), 4.0)
    side_w = math("POWER", math("ABSOLUTE", hx), 4.0)
    if side_extra is not None:
        side_w = math("ADD", side_w, side_extra)
    w_side = math("MULTIPLY", math("MULTIPLY", side_w, side_a), gate(seen_by.outputs[1]))
    terms.append((side_c, w_side))
    total = None
    colour = None
    for c, w in terms:
        scaled = vmath("SCALE", c, scale=w)
        colour = scaled if colour is None else vmath("ADD", colour, scaled)
        total = w if total is None else math("ADD", total, w)
    inverse = math("DIVIDE", 1.0, math("ADD", total, 1e-4))
    links.new(vmath("SCALE", colour, scale=inverse), emit.inputs["Color"])
    return mat


def unwrap(obj) -> None:
    select_only([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake(obj, material, kind: str, size: int, name: str, colorspace: str = "sRGB", samples: int = 1):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    image = bpy.data.images.new(name, size, size, alpha=False)
    image.colorspace_settings.name = colorspace
    target = material.node_tree.nodes.new("ShaderNodeTexImage")
    target.image = image
    material.node_tree.nodes.active = target
    obj.data.materials.clear()
    obj.data.materials.append(material)
    select_only([obj])
    bpy.ops.object.bake(type=kind, margin=4, use_clear=True)
    material.node_tree.nodes.remove(target)
    return image


def quantize(image, colours: int) -> None:
    """Reduces the baked colours to a small palette (k-means), for the blocky styles' flat colour areas."""
    if colours <= 0:
        return
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    rgb = pixels.reshape(-1, 4)[:, :3]
    rng = np.random.default_rng(7)
    sample = rgb[rng.choice(len(rgb), min(len(rgb), 20000), replace=False)]
    centres = sample[rng.choice(len(sample), colours, replace=False)]
    for _ in range(10):
        nearest = np.argmin(((sample[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
        for k in range(colours):
            members = sample[nearest == k]
            if len(members):
                centres[k] = members.mean(axis=0)
    labels = np.empty(len(rgb), dtype=np.int64)
    for start in range(0, len(rgb), 65536):
        chunk = rgb[start:start + 65536]
        labels[start:start + 65536] = np.argmin(((chunk[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
    pixels.reshape(-1, 4)[:, :3] = centres[labels]
    image.pixels.foreach_set(pixels)


def save_png(image, path: str) -> None:
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()


def textures(obj, hull: np.ndarray, views: dict, grid: dict, height_m: float, args, style: dict, out: str, asset: str) -> dict:
    """Base colour (projected from the references), ORM (baked occlusion, the style's roughness, no metal) and a flat
    normal map, named for the texture contract: T_<Name>_BC, _ORM, _N."""
    unwrap(obj)
    visibility(obj, hull, grid)
    size = style["texture"]
    projection = projection_material(views, grid, height_m, args.side_facing, style["closest"])
    colour = bake(obj, projection, "EMIT", size, f"{asset}_BC")
    quantize(colour, style["palette"])
    paths = {"BC": os.path.join(out, f"{asset}_BC.png"), "ORM": os.path.join(out, f"{asset}_ORM.png"), "N": os.path.join(out, f"{asset}_N.png")}
    save_png(colour, paths["BC"])
    plain = bpy.data.materials.new("occlusion")
    if bpy.app.version < (5, 0, 0):
        plain.use_nodes = True
    occlusion = bake(obj, plain, "AO", size, f"{asset}_AO", "Non-Color", samples=16)
    ao = np.empty(size * size * 4, dtype=np.float32)
    occlusion.pixels.foreach_get(ao)
    ao = ao.reshape(-1, 4)
    orm = np.ones_like(ao)
    orm[:, 0] = 0.35 + 0.65 * ao[:, 0]
    orm[:, 1] = style["roughness"]
    orm[:, 2] = 0.0
    orm_image = bpy.data.images.new(f"{asset}_ORM", size, size, alpha=False)
    orm_image.colorspace_settings.name = "Non-Color"
    orm_image.pixels.foreach_set(orm.ravel())
    save_png(orm_image, paths["ORM"])
    flat = np.tile(np.array([0.5, 0.5, 1.0, 1.0], dtype=np.float32), size * size)
    normal_image = bpy.data.images.new(f"{asset}_N", size, size, alpha=False)
    normal_image.colorspace_settings.name = "Non-Color"
    normal_image.pixels.foreach_set(flat)
    save_png(normal_image, paths["N"])

    # The material engines read: base colour, roughness and metallic from ORM (G, B: glTF's own packing), normal map.
    mat = bpy.data.materials.new(f"M_{args.name}")
    if bpy.app.version < (5, 0, 0):
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bc = nodes.new("ShaderNodeTexImage")
    bc.image = bpy.data.images.load(paths["BC"])
    bc.interpolation = "Closest" if style["closest"] else "Linear"
    links.new(bc.outputs["Color"], bsdf.inputs["Base Color"])
    orm_tex = nodes.new("ShaderNodeTexImage")
    orm_tex.image = bpy.data.images.load(paths["ORM"])
    orm_tex.image.colorspace_settings.name = "Non-Color"
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(orm_tex.outputs["Color"], split.inputs[0])
    links.new(split.outputs[1], bsdf.inputs["Roughness"])
    links.new(split.outputs[2], bsdf.inputs["Metallic"])
    n_tex = nodes.new("ShaderNodeTexImage")
    n_tex.image = bpy.data.images.load(paths["N"])
    n_tex.image.colorspace_settings.name = "Non-Color"
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(n_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = style["smooth"]
    return {k: os.path.basename(v) for k, v in paths.items()}


# ---- rig ----------------------------------------------------------------------------------------------------------------

def landmarks(views: dict, height_m: float, side_facing: str) -> dict:
    """Joint positions (metres, Blender axes: X to the character's left, -Y forward, Z up) from the silhouettes."""
    front = views["front"][..., 3] > 0.5
    side = views["side"][..., 3] > 0.5
    rows, width = front.shape
    px = height_m / rows
    cx = width / 2
    z_of = lambda row: height_m * (1 - row / rows)  # noqa: E731

    def central_run(mask_row: np.ndarray, centre: float) -> tuple[int, int] | None:
        filled = np.nonzero(mask_row)[0]
        if not len(filled):
            return None
        breaks = np.nonzero(np.diff(filled) > 1)[0]
        starts = np.concatenate([[filled[0]], filled[breaks + 1]])
        ends = np.concatenate([filled[breaks], [filled[-1]]])
        best = min(range(len(starts)), key=lambda i: 0 if starts[i] <= centre <= ends[i] else min(abs(starts[i] - centre), abs(ends[i] - centre)))
        return int(starts[best]), int(ends[best])

    # Crotch: walking up the centre line from the feet, the first filled pixel.
    column = front[:, int(cx) - 2:int(cx) + 3].any(axis=1)
    crotch_row = rows * 0.53
    for row in range(rows - 1, int(rows * 0.3), -1):
        if column[row]:
            crotch_row = row
            break
    # Neck: the narrowest central run between 8% and 30% from the top.
    widths = []
    for row in range(int(rows * 0.08), int(rows * 0.3)):
        run = central_run(front[row], cx)
        widths.append((run[1] - run[0] if run else width, row))
    neck_row = min(widths)[1]
    shoulder_row = neck_row + rows * 0.04
    upper = front[int(shoulder_row):int(crotch_row + rows * 0.12)]
    filled_cols = np.nonzero(upper.any(axis=0))[0]
    left_tip_col, right_tip_col = filled_cols.max(), filled_cols.min()  # image right = character's left (+X)
    tip_row = lambda col: int(shoulder_row) + int(np.nonzero(upper[:, col])[0].mean())  # noqa: E731
    shoulder_run = central_run(front[int(shoulder_row + rows * 0.03)], cx) or (cx - 10, cx + 10)
    shoulder_half = (shoulder_run[1] - shoulder_run[0]) / 2 * px * 0.8
    knee_row = (crotch_row + rows) / 2
    ankle_row = rows * 0.95

    def leg_x(row: float, sign: int) -> float:
        runs_here = [central_run(front[int(row)], cx + sign * width * 0.2)]
        run = runs_here[0]
        return ((run[0] + run[1]) / 2 - cx) * px if run else sign * 0.1 * height_m

    def depth(row: float) -> float:
        filled = np.nonzero(side[int(min(rows - 1, row))])[0]
        if not len(filled):
            return 0.0
        mid = (filled.min() + filled.max()) / 2 - side.shape[1] / 2
        return (-mid if side_facing == "right" else mid) * px

    toe_cols = np.nonzero(side[int(rows * 0.97):].any(axis=0))[0]
    toe = ((toe_cols.max() if side_facing == "right" else toe_cols.min()) - side.shape[1] / 2) * px * (-1 if side_facing == "right" else 1) if len(toe_cols) else -0.12 * height_m
    z = {"crotch": z_of(crotch_row), "neck": z_of(neck_row), "shoulder": z_of(shoulder_row), "knee": z_of(knee_row), "ankle": z_of(ankle_row)}
    return {
        "z": z, "shoulder_half": shoulder_half,
        "hand": {+1: Vector(((left_tip_col - cx) * px, depth(tip_row(left_tip_col)), z_of(tip_row(left_tip_col)))),
                 -1: Vector(((right_tip_col - cx) * px, depth(tip_row(right_tip_col)), z_of(tip_row(right_tip_col))))},
        "hip_x": {+1: leg_x(crotch_row + rows * 0.08, +1), -1: leg_x(crotch_row + rows * 0.08, -1)},
        "knee_x": {+1: leg_x(knee_row, +1), -1: leg_x(knee_row, -1)},
        "ankle_x": {+1: leg_x(ankle_row, +1), -1: leg_x(ankle_row, -1)},
        "depth": depth, "rows": rows, "toe": toe, "height": height_m,
        "rows_of": {"crotch": crotch_row, "neck": neck_row, "shoulder": shoulder_row, "knee": knee_row, "ankle": ankle_row},
    }


def build_armature(marks: dict, name: str):
    """A humanoid skeleton with Godot's humanoid profile names, so Godot retargets it without a bone map."""
    z = marks["z"]
    d = marks["depth"]
    r = marks["rows_of"]
    h = marks["height"]
    hips_z = z["crotch"] + 0.04 * h
    chest_z = z["crotch"] + (z["neck"] - z["crotch"]) * 0.62
    spine_z = z["crotch"] + (z["neck"] - z["crotch"]) * 0.3
    head_top = h
    rows = marks["rows"]
    row_of = lambda height_z: rows * (1 - height_z / h)  # noqa: E731
    bones = {
        "Hips": ((0, d(row_of(hips_z)), hips_z), (0, d(row_of(spine_z)), spine_z), None),
        "Spine": ((0, d(row_of(spine_z)), spine_z), (0, d(row_of(chest_z)), chest_z), "Hips"),
        "Chest": ((0, d(row_of(chest_z)), chest_z), (0, d(r["neck"]), z["neck"]), "Spine"),
        "Neck": ((0, d(r["neck"]), z["neck"]), (0, d(r["neck"] - rows * 0.03), z["neck"] + 0.03 * h), "Chest"),
        "Head": ((0, d(r["neck"] - rows * 0.03), z["neck"] + 0.03 * h), (0, d(r["neck"] - rows * 0.03), head_top), "Neck"),
    }
    for sign, side in ((+1, "Left"), (-1, "Right")):
        shoulder = Vector((sign * marks["shoulder_half"], d(r["shoulder"]), z["shoulder"]))
        hand = marks["hand"][sign]
        elbow = shoulder.lerp(hand, 0.47)
        wrist = shoulder.lerp(hand, 0.86)
        bones[f"{side}Shoulder"] = ((sign * marks["shoulder_half"] * 0.25, shoulder.y, shoulder.z), tuple(shoulder), "Chest")
        bones[f"{side}UpperArm"] = (tuple(shoulder), tuple(elbow), f"{side}Shoulder")
        bones[f"{side}LowerArm"] = (tuple(elbow), tuple(wrist), f"{side}UpperArm")
        bones[f"{side}Hand"] = (tuple(wrist), tuple(hand), f"{side}LowerArm")
        hip = Vector((marks["hip_x"][sign] * 0.85, d(r["crotch"]), hips_z - 0.02 * h))
        knee = Vector((marks["knee_x"][sign], d(r["knee"]) - 0.01 * h, z["knee"]))
        ankle = Vector((marks["ankle_x"][sign], d(r["ankle"]), z["ankle"]))
        ball = Vector((ankle.x, min(marks["toe"] * 0.6, ankle.y - 0.04 * h), 0.02 * h))
        tip = Vector((ankle.x, min(marks["toe"], ball.y - 0.02 * h), 0.02 * h))
        bones[f"{side}UpperLeg"] = (tuple(hip), tuple(knee), "Hips")
        bones[f"{side}LowerLeg"] = (tuple(knee), tuple(ankle), f"{side}UpperLeg")
        bones[f"{side}Foot"] = (tuple(ankle), tuple(ball), f"{side}LowerLeg")
        bones[f"{side}Toes"] = (tuple(ball), tuple(tip), f"{side}Foot")
    data = bpy.data.armatures.new(f"{name}_Skeleton")
    rig = bpy.data.objects.new("Armature", data)
    bpy.context.scene.collection.objects.link(rig)
    select_only([rig])
    bpy.ops.object.mode_set(mode="EDIT")
    for bone_name, (head, tail, parent) in bones.items():
        bone = data.edit_bones.new(bone_name)
        bone.head = head
        bone.tail = tail
        if parent:
            bone.parent = data.edit_bones[parent]
            bone.use_connect = (Vector(data.edit_bones[parent].tail) - Vector(head)).length < 1e-4
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def segment_distance(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def skin(obj, rig, marks: dict) -> None:
    """Each vertex goes to the limb chain it is nearest to, measured against that limb's thickness (so the side of the
    body stays with the body, not the arm next to it), and is shared between the two nearest bones of that chain."""
    bones = {b.name: (np.array(b.head_local), np.array(b.tail_local)) for b in rig.data.bones}
    co = np.array([v.co for v in obj.data.vertices])
    h = marks["height"]
    chains = {
        "body": (["Hips", "Spine", "Chest"], 0.11),
        "head": (["Neck", "Head"], 0.075),
        "Left arm": (["LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand"], 0.045),
        "Right arm": (["RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand"], 0.045),
        "Left leg": (["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes"], 0.065),
        "Right leg": (["RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes"], 0.065),
    }
    distance = {name: segment_distance(co, *bones[name]) for name in bones}
    groups = {name: obj.vertex_groups.new(name=name) for name in bones}
    scores = np.stack([np.min([distance[b] for b in members], axis=0) / (radius * h) for members, radius in chains.values()])
    chosen = np.argmin(scores, axis=0)
    chain_list = list(chains.values())
    for i in range(len(co)):
        members = chain_list[chosen[i]][0]
        d = np.array([distance[b][i] for b in members])
        order = np.argsort(d)[:2]
        w = 1.0 / (d[order] + 0.01 * h) ** 4
        w /= w.sum()
        for k, idx in enumerate(order):
            groups[members[idx]].add([i], float(w[k]), "REPLACE")
    obj.parent = rig
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


# ---- animation --------------------------------------------------------------------------------------------------------

def animate(rig, marks: dict, fps: int = 24) -> list[str]:
    """Idle, walk, run and attack, keyed every other frame. Rotations are given in the rest pose's axes (X: sideways,
    Y: forward-back, Z: up) relative to the parent bone and converted to each bone's own axes."""
    scene = bpy.context.scene
    scene.render.fps = fps
    rest = {b.name: b.matrix_local.to_quaternion() for b in rig.data.bones}
    hips_rest = rig.data.bones["Hips"].matrix_local.to_3x3()
    h = marks["height"]
    arm_down = {}
    for side, sign in (("Left", 1), ("Right", -1)):
        bone = rig.data.bones[f"{side}UpperArm"]
        direction = (bone.tail_local - bone.head_local).normalized()
        relaxed = Vector((sign * 0.18, 0.0, -1.0)).normalized()
        arm_down[side] = direction.rotation_difference(relaxed)

    def rot(axis: tuple, degrees: float) -> Quaternion:
        return Quaternion(Vector(axis), math.radians(degrees))

    def pose(frame: int, rotations: dict, hips_offset: Vector) -> None:
        for name, world in rotations.items():
            pb = rig.pose.bones[name]
            q = rest[name].inverted() @ world @ rest[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        hips = rig.pose.bones["Hips"]
        hips.location = hips_rest.inverted() @ hips_offset
        hips.keyframe_insert("location", frame=frame)

    def cycle(t: float, name: str) -> tuple[dict, Vector]:
        s = math.sin(2 * math.pi * t)
        c = math.cos(2 * math.pi * t)
        r: dict = {}
        offset = Vector((0, 0, 0))
        down = lambda side, amount=1.0: Quaternion().slerp(arm_down[side], amount)  # noqa: E731
        if name == "idle":
            r["Chest"] = rot((1, 0, 0), 1.5 * s)
            r["Head"] = rot((0, 0, 1), 3 * math.sin(math.pi * t))
            for side in ("Left", "Right"):
                r[f"{side}UpperArm"] = down(side) @ rot((1, 0, 0), 2 * s)
                r[f"{side}LowerArm"] = rot((1, 0, 0), -8)
            offset = Vector((0, 0, -0.006 * h * (1 - c) / 2))
        elif name in ("walk", "run"):
            swing = 28 if name == "walk" else 42
            bend = 40 if name == "walk" else 70
            for side, phase in (("Left", 0.0), ("Right", 0.5)):
                ls = math.sin(2 * math.pi * (t + phase))
                r[f"{side}UpperLeg"] = rot((1, 0, 0), -swing * ls)
                r[f"{side}LowerLeg"] = rot((1, 0, 0), bend * max(0.0, -math.cos(2 * math.pi * (t + phase))))
                r[f"{side}Foot"] = rot((1, 0, 0), 10 * ls)
                r[f"{side}UpperArm"] = down(side) @ rot((1, 0, 0), swing * 0.8 * ls)
                r[f"{side}LowerArm"] = rot((1, 0, 0), -(15 if name == "walk" else 60))
            r["Chest"] = rot((0, 0, 1), 6 * s) @ rot((1, 0, 0), -4 if name == "walk" else -12)
            offset = Vector((0, 0, -(0.015 if name == "walk" else 0.035) * h * abs(math.cos(2 * math.pi * t))))
        elif name == "attack":
            wind = math.sin(math.pi * min(1.0, t / 0.35))
            strike = max(0.0, min(1.0, (t - 0.35) / 0.25))
            back = max(0.0, (t - 0.6) / 0.4)
            raise_angle = -110 * wind * (1 - strike) + 30 * strike * (1 - back)
            r["RightUpperArm"] = down("Right") @ rot((1, 0, 0), raise_angle)
            r["RightLowerArm"] = rot((1, 0, 0), -40 * wind * (1 - strike))
            r["LeftUpperArm"] = down("Left") @ rot((1, 0, 0), 10)
            r["Chest"] = rot((0, 0, 1), -20 * wind * (1 - strike) + 15 * strike * (1 - back))
            r["Spine"] = rot((1, 0, 0), 10 * strike * (1 - back))
        for bone in rig.pose.bones:
            r.setdefault(bone.name, Quaternion())
        return r, offset

    lengths = {"idle": 2.0, "walk": 1.0, "run": 0.66, "attack": 0.8}
    rig.animation_data_create()
    made = []
    for name in ANIMATIONS:
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        rig.animation_data.action = action
        frames = max(2, round(lengths[name] * fps))
        for frame in range(0, frames + 1, 2):
            rotations, offset = cycle(frame / frames, name)
            pose(frame + 1, rotations, offset)
        action.frame_range = (1, frames + 1)
        made.append(name)
    rig.animation_data.action = bpy.data.actions["idle"]
    for bone in rig.pose.bones:
        bone.rotation_quaternion = Quaternion()
        bone.location = Vector()
    return made


# ---- export and preview ---------------------------------------------------------------------------------------------

def export(obj, rig, args, out: str, asset: str) -> dict:
    files = {}
    select_only([obj, rig])
    if args.engine in ("unreal", "both"):
        files["fbx"] = os.path.join(out, f"{asset}.fbx")
        bpy.ops.export_scene.fbx(
            filepath=files["fbx"], use_selection=True, object_types={"ARMATURE", "MESH"}, apply_unit_scale=True,
            apply_scale_options="FBX_SCALE_UNITS", use_mesh_modifiers=False, mesh_smooth_type="FACE", use_tspace=True,
            add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
            bake_anim_force_startend_keying=True, path_mode="COPY", embed_textures=False,
        )
    if args.engine in ("godot", "both"):
        files["glb"] = os.path.join(out, f"{args.name.lower()}.glb")
        bpy.ops.export_scene.gltf(
            filepath=files["glb"], export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
            export_skins=True, export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
            export_image_format="AUTO",
        )
    return files


def render_previews(obj, rig, views: dict, out: str, name: str, height_m: float) -> str:
    """Front, three-quarter, side and back renders (rest pose) beside the front and side references, in one image."""
    rig.data.pose_position = "REST"
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 12
    scene.render.resolution_x = 320
    scene.render.resolution_y = 480
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"  # colours as painted, not the filmic look
    world = bpy.data.worlds.new("preview") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    cam_data = bpy.data.cameras.new("preview")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = height_m * 1.12
    cam = bpy.data.objects.new("preview", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    tiles = []
    for angle in (0, 45, 90, 180):
        a = math.radians(angle)
        cam.location = (math.sin(a) * 6, -math.cos(a) * 6, height_m / 2)
        cam.rotation_euler = (math.pi / 2, 0, a)
        path = os.path.join(out, f"render_{angle}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append(load_view(path))
    refs = [views["front"], views["side"]]

    def fit(img: np.ndarray, h: int = 480, w: int = 320) -> np.ndarray:
        rows = np.linspace(0, img.shape[0] - 1, int(h * 0.88)).astype(int)
        cols = np.linspace(0, img.shape[1] - 1, max(1, int(img.shape[1] * h * 0.88 / img.shape[0]))).astype(int)
        small = img[rows][:, cols]
        canvas = np.ones((h, w, 4), dtype=np.float32)
        y0 = (h - small.shape[0]) // 2
        x0 = max(0, (w - small.shape[1]) // 2)
        part = small[:, : w - x0]
        alpha = part[..., 3:4]
        canvas[y0:y0 + part.shape[0], x0:x0 + part.shape[1]] = part * alpha + canvas[y0:y0 + part.shape[0], x0:x0 + part.shape[1]] * (1 - alpha)
        canvas[..., 3] = 1
        return canvas

    sheet = np.concatenate([fit(r) for r in refs] + [fit(t) for t in tiles], axis=1)
    image = bpy.data.images.new(f"{name}_preview", sheet.shape[1], sheet.shape[0], alpha=True)
    image.pixels.foreach_set(sheet[::-1].ravel())
    path = os.path.join(out, f"{name.lower()}_preview.png")
    save_png(image, path)
    return path


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--refs", required=True, help="the folder with front.png, side.png [, back.png]")
    parser.add_argument("--name", required=True)
    parser.add_argument("--style", choices=sorted(STYLES), default="lowpoly")
    parser.add_argument("--out", required=True)
    parser.add_argument("--engine", choices=("unreal", "godot", "both"), default="both")
    parser.add_argument("--height", type=float, default=1.8, help="metres from the soles to the top of the head")
    parser.add_argument("--side-facing", dest="side_facing", choices=("right", "left"), default="right")
    parser.add_argument("--triangles", type=int, default=0, help="override the style's triangle budget")
    parser.add_argument("--no-preview", dest="preview", action="store_false")
    args = parser.parse_args(argv)

    style = dict(STYLES[args.style])
    target = args.triangles or style["triangles"]
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    views: dict = {}
    for view in ("front", "side", "back"):
        path = os.path.join(args.refs, f"{view}.png")
        if os.path.exists(path):
            views[view] = load_view(path)
            views[view + "_path"] = path
    if "front" not in views or "side" not in views:
        raise SystemExit("front.png and side.png are needed (check the references first)")
    views = {k: v for k, v in views.items()}
    asset = f"SK_{args.name}"
    hull, grid = visual_hull({k: v for k, v in views.items() if not k.endswith("_path")}, style, args.height, args.side_facing)
    if not hull.any():
        raise SystemExit("the silhouettes do not overlap: check that the views are the same character at the same scale")
    obj = shape(hull, grid, args.style, style, asset, target)
    tex = textures(obj, hull, views, grid, args.height, args, style, out, f"T_{args.name}")
    marks = landmarks(views, args.height, args.side_facing)
    rig = build_armature(marks, args.name)
    skin(obj, rig, marks)
    actions = animate(rig, marks)
    obj.name = asset
    obj.data.name = asset
    files = export(obj, rig, args, out, asset)
    blend = os.path.join(out, f"{args.name.lower()}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    preview = render_previews(obj, rig, views, out, args.name, args.height) if args.preview else ""
    dims = obj.dimensions
    report = {
        "name": args.name, "asset": asset, "style": args.style, "engine": args.engine, "heightM": args.height,
        "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "vertices": len(obj.data.vertices),
        "bones": len(rig.data.bones), "boneNames": [b.name for b in rig.data.bones], "animations": actions,
        "dimensionsM": [round(dims.x, 3), round(dims.y, 3), round(dims.z, 3)], "textures": tex,
        "files": {k: os.path.basename(v) for k, v in files.items()}, "blend": os.path.basename(blend),
        "preview": os.path.basename(preview), "views": [v for v in ("front", "side", "back") if v in views],
        "blender": bpy.app.version_string,
    }
    with open(os.path.join(out, "build.json"), "w", encoding="utf8") as handle:
        json.dump(report, handle, indent=2)
    print("CHARACTER_BUILT " + json.dumps(report))


if __name__ == "__main__":
    main()
