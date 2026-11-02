"""Import a clip into Wwise, create its Play event with 3D attenuation, and generate SoundBanks, over WAAPI.

    pip install waapi-client
    python dcc/wwise/import_event.py --wav export/SFX_RadioStatic.wav --event Play_RadioStatic \
        --attenuation ATT_RadioStatic --max-distance-cm 1200 --loop --facts export/Play_RadioStatic.facts.json

Wwise Authoring must be open on the project with WAAPI enabled (User Preferences, Enable Wwise Authoring API).
Wwise distances are in game units; with the Unreal integration's default scaling one unit is one centimetre.
Writes the audio_event `facts` for the harness contract. Untested here against a live Wwise.
"""
from __future__ import annotations

import argparse
import json
import os

from waapi import WaapiClient  # type: ignore[import-not-found]

ACTOR_MIXER = "\\Actor-Mixer Hierarchy\\Default Work Unit"
EVENTS = "\\Events\\Default Work Unit"
ATTENUATIONS = "\\Attenuations\\Default Work Unit"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("WAAPI_URL", "ws://127.0.0.1:8080/waapi"))
    parser.add_argument("--wav", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--attenuation")
    parser.add_argument("--max-distance-cm", type=float)
    parser.add_argument("--bus", default="Master Audio Bus")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--soundbank", default="SB_Generated")
    parser.add_argument("--facts", required=True)
    args = parser.parse_args()
    sound_name = os.path.splitext(os.path.basename(args.wav))[0]

    with WaapiClient(url=args.url) as client:
        client.call("ak.wwise.core.undo.beginGroup")
        client.call("ak.wwise.core.audio.import", {
            "importOperation": "useExisting",
            "default": {"importLanguage": "SFX"},
            "imports": [{"audioFile": os.path.abspath(args.wav), "objectPath": f"{ACTOR_MIXER}\\<Sound SFX>{sound_name}"}],
        })
        sound_path = f"{ACTOR_MIXER}\\{sound_name}"
        client.call("ak.wwise.core.object.setProperty", {"object": sound_path, "property": "IsLoopingEnabled", "value": args.loop})
        if args.attenuation:
            client.call("ak.wwise.core.object.create", {"parent": ATTENUATIONS, "type": "Attenuation", "name": args.attenuation, "onNameConflict": "merge"})
            attenuation_path = f"{ATTENUATIONS}\\{args.attenuation}"
            if args.max_distance_cm:
                client.call("ak.wwise.core.object.setProperty", {"object": attenuation_path, "property": "RadiusMax", "value": args.max_distance_cm})
            client.call("ak.wwise.core.object.setReference", {"object": sound_path, "reference": "Attenuation", "value": attenuation_path})
            client.call("ak.wwise.core.object.setProperty", {"object": sound_path, "property": "3DSpatialization", "value": 2})
        client.call("ak.wwise.core.object.create", {
            "parent": EVENTS, "type": "Event", "name": args.event, "onNameConflict": "merge",
            "children": [{"name": "", "type": "Action", "@ActionType": 1, "@Target": sound_path}],
        })
        client.call("ak.wwise.core.object.create", {"parent": "\\SoundBanks\\Default Work Unit", "type": "SoundBank", "name": args.soundbank, "onNameConflict": "merge"})
        client.call("ak.wwise.core.soundbank.setInclusions", {
            "soundbank": f"\\SoundBanks\\Default Work Unit\\{args.soundbank}", "operation": "add",
            "inclusions": [{"object": f"{EVENTS}\\{args.event}", "filter": ["events", "structures", "media"]}],
        })
        client.call("ak.wwise.core.undo.endGroup", {"displayName": f"harness: {args.event}"})
        client.call("ak.wwise.core.project.save")
        generated = client.call("ak.wwise.core.soundbank.generate", {"soundbanks": [{"name": args.soundbank}], "writeToDisk": True})

    facts = {"wwisePath": f"{EVENTS}\\{args.event}", "clip": sound_name, "attenuation": args.attenuation,
             "maxDistanceCm": args.max_distance_cm, "bus": args.bus, "soundbankGenerated": generated is not None}
    with open(args.facts, "w", encoding="utf8") as out:
        json.dump(facts, out, indent=2)
    print(json.dumps(facts))


if __name__ == "__main__":
    main()
