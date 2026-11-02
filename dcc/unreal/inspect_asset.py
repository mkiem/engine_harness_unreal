"""Report Blueprint and level-placement facts for the harness contract. Run inside the editor (Python console, the
Unreal MCP server's run-python tool, or a commandlet):

    py dcc/unreal/inspect_asset.py blueprint /Game/Props/VintageRadio/BP_VintageRadio
    py dcc/unreal/inspect_asset.py placement /Game/Maps/Apartment BP_VintageRadio

Prints the `facts` JSON for the asset record. Untested here against a live editor.
"""
from __future__ import annotations

import json
import sys

import unreal  # type: ignore[import-not-found]


def blueprint_facts(path: str) -> dict:
    blueprint = unreal.EditorAssetLibrary.load_asset(path)
    generated = blueprint.generated_class()
    default = unreal.get_default_object(generated)
    components = sorted({component.get_class().get_name() for component in default.get_components_by_class(unreal.ActorComponent)})
    parent = blueprint.get_editor_property("parent_class")
    interfaces = [entry.get_editor_property("interface").get_name() for entry in blueprint.get_editor_property("implemented_interfaces")] \
        if hasattr(blueprint, "implemented_interfaces") else []
    status = blueprint.get_editor_property("status") if hasattr(blueprint, "status") else None
    compiled = status is None or status in (unreal.BlueprintStatus.BS_UP_TO_DATE, unreal.BlueprintStatus.BS_UP_TO_DATE_WITH_WARNINGS)
    return {"objectPath": path, "parentClass": parent.get_name() if parent else "", "components": components,
            "interfaces": [name.removesuffix("_C") for name in interfaces], "compiled": bool(compiled)}


def placement_facts(map_path: str, actor_class: str) -> dict:
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level(map_path)
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
    matches = [actor for actor in actors if actor.get_class().get_name().removesuffix("_C") == actor_class]
    if not matches:
        raise SystemExit(f"no {actor_class} in {map_path}")
    actor = matches[0]
    location, rotation = actor.get_actor_location(), actor.get_actor_rotation()
    package = actor.get_package().get_name() if actor.get_package() else ""
    return {"map": map_path, "actorClass": actor_class, "location": [location.x, location.y, location.z],
            "rotation": [rotation.roll, rotation.pitch, rotation.yaw],
            "actorFile": package if "__ExternalActors__" in package else None}


if __name__ == "__main__":
    kind, *rest = sys.argv[1:]
    print(json.dumps(blueprint_facts(rest[0]) if kind == "blueprint" else placement_facts(rest[0], rest[1]), indent=2))
