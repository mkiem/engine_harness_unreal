"""The ingest stage: import one asset that passed its source contract, with the project's fixed settings, and measure it
in the engine. Run by the harness through a headless commandlet:

    UnrealEditor-Cmd Game.uproject -run=pythonscript -script=dcc/unreal/import_pipeline.py -unattended -nullrhi

In a live editor, run it with unreal_run_script and --job <job.json>. From the commandlet, the job file path arrives
in HARNESS_INGEST_JOB. Either way the result goes to the job's `result` path as
{"objectPath", "facts", "violations"}. Needs the Python Editor Script Plugin. Untested here against a live editor.

Differences from the original sketch, on purpose:
- auto_generate_collision is off when the spec asks for UCX hulls, so a missing hull fails the check instead of being
  replaced silently by a generated box;
- LODs come from the FBX LOD group (import_mesh_lo_ds), not engine reduction, so the artist's LODs survive;
- materials and textures are never imported with a mesh; material instances are made by the Unreal worker, from the
  master material, so a stray FBX material can never become a project asset.
"""
from __future__ import annotations

import json
import os
import sys

import unreal  # type: ignore[import-not-found]


def violation(asset: str, rule: str, message: str) -> dict:
    return {"asset": asset, "rule": rule, "message": message}


def import_task(file: str, destination: str, options=None) -> unreal.AssetImportTask:
    task = unreal.AssetImportTask()
    task.filename = file
    task.destination_path = destination
    task.automated = True
    task.replace_existing = True
    task.save = True
    if options is not None:
        task.options = options
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return task


def ingest_static_mesh(job: dict) -> dict:
    spec, asset = job["spec"], job["asset"]
    req = spec["requires"]
    options = unreal.FbxImportUI()
    options.import_mesh = True
    options.import_as_skeletal = spec["kind"] == "skeletal_mesh"
    options.mesh_type_to_import = unreal.FBXImportType.FBXIT_SKELETAL_MESH if options.import_as_skeletal else unreal.FBXImportType.FBXIT_STATIC_MESH
    options.import_materials = False
    options.import_textures = False
    options.import_animations = False
    options.auto_compute_lod_distances = True
    data = options.static_mesh_import_data
    data.combine_meshes = True
    data.generate_lightmap_u_vs = bool(req.get("lightmapUv", True))
    data.auto_generate_collision = req.get("collision") == "engine"
    data.import_mesh_lo_ds = req.get("lods", 1) > 1
    data.normal_import_method = unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS
    task = import_task(job["file"], job["destination"], options)
    objects = task.get_editor_property("imported_object_paths") or []
    if not objects:
        return {"objectPath": f"{job['destination']}/{asset}", "facts": {}, "violations": [violation(asset, "ingest.import", "the importer produced no asset")]}
    path = str(objects[0]).split(".")[0]
    mesh = unreal.EditorAssetLibrary.load_asset(path)
    facts, problems = {}, []
    if isinstance(mesh, unreal.StaticMesh):
        subsystem = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
        facts["lods"] = subsystem.get_lod_count(mesh)
        facts["convexHulls"] = subsystem.get_convex_collision_count(mesh)
        facts["materialSlots"] = subsystem.get_number_materials(mesh)
        extent = mesh.get_bounds().box_extent
        facts["boundsCm"] = [round(extent.x * 2, 2), round(extent.y * 2, 2), round(extent.z * 2, 2)]
        if req.get("collision") == "ucx" and facts["convexHulls"] == 0:
            problems.append(violation(asset, "ingest.collision", f"{asset} imported without its UCX hulls; check that each is named UCX_{asset}_NN"))
        if facts["lods"] < req.get("lods", 1):
            problems.append(violation(asset, "ingest.lods", f"{asset} imported {facts['lods']} LODs, {req['lods']} required"))
        expected = req.get("approxSizeCm")
        if expected:
            for axis, (got, want) in enumerate(zip(facts["boundsCm"], expected)):
                if abs(got / want - 1) > req.get("sizeTolerance", 0.5):
                    problems.append(violation(asset, "ingest.size", f"{asset} is {got} cm along {'XYZ'[axis]} in the engine, expected about {want} cm"))
    return {"objectPath": path, "facts": facts, "violations": problems}


TEXTURE_SETTINGS = {
    "_BC": (True, "TC_DEFAULT"),
    "_E": (True, "TC_DEFAULT"),
    "_N": (False, "TC_NORMALMAP"),
    "_ORM": (False, "TC_MASKS"),
    "_O": (False, "TC_GRAYSCALE"),
}


def ingest_texture_set(job: dict, record_files: list[str]) -> dict:
    asset, destination = job["asset"], job["destination"]
    flip_green = job["spec"]["requires"].get("normalConvention") == "opengl"
    imported = []
    for file in record_files:
        task = import_task(file, destination)
        for object_path in task.get_editor_property("imported_object_paths") or []:
            path = str(object_path).split(".")[0]
            texture = unreal.EditorAssetLibrary.load_asset(path)
            for suffix, (srgb, compression) in TEXTURE_SETTINGS.items():
                if path.endswith(suffix):
                    texture.set_editor_property("srgb", srgb)
                    texture.set_editor_property("compression_settings", getattr(unreal.TextureCompressionSettings, compression))
                    if suffix == "_N" and flip_green:
                        texture.set_editor_property("flip_green_channel", True)
            unreal.EditorAssetLibrary.save_asset(path)
            imported.append(path)
    return {"objectPath": f"{destination}/{asset}", "facts": {"textures": imported}, "violations": [] if imported else [violation(asset, "ingest.import", "no texture imported")]}


def ingest_audio_event(job: dict) -> dict:
    """Wwise events reach the engine through the Wwise integration's reconcile; this checks the AkAudioEvent exists."""
    asset = job["asset"]
    matches = [str(path) for path in unreal.EditorAssetLibrary.list_assets("/Game", recursive=True) if str(path).split(".")[-1] == asset]
    if not matches:
        return {"objectPath": f"/Game/WwiseAudio/Events/{asset}", "facts": {}, "violations": [violation(asset, "ingest.wwise", f"no AkAudioEvent {asset} in the project; run Wwise reconcile or check SoundBank generation")]}
    return {"objectPath": matches[0].split(".")[0], "facts": {}, "violations": []}


def main() -> None:
    # In a live editor (unreal_run_script) the job comes as --job <path>; from the commandlet, in HARNESS_INGEST_JOB.
    job_path = sys.argv[sys.argv.index("--job") + 1] if "--job" in sys.argv[:-1] else os.environ.get("HARNESS_INGEST_JOB")
    if not job_path:
        raise SystemExit("pass --job <job.json> or set HARNESS_INGEST_JOB")
    with open(job_path, encoding="utf8") as source:
        job = json.load(source)
    kind = job["kind"]
    if kind in ("static_mesh", "skeletal_mesh"):
        result = ingest_static_mesh(job)
    elif kind == "texture_set":
        folder = os.path.dirname(job["file"]) if job.get("file") else ""
        files = sorted(os.path.join(folder, name) for name in os.listdir(folder) if name.startswith(job["asset"]))
        result = ingest_texture_set(job, files)
    elif kind == "audio_event":
        result = ingest_audio_event(job)
    else:
        result = {"objectPath": f"{job['destination']}/{job['asset']}", "facts": {}, "violations": [violation(job["asset"], "ingest.kind", f"{kind} is not ingested")]}
    with open(job["result"], "w", encoding="utf8") as out:
        json.dump(result, out, indent=2)


if __name__ == "__main__":
    main()
