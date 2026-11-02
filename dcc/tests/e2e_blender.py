"""End-to-end check of the Blender half of the pipeline with real Blender (the bpy module, or a Blender binary):

  recipe → .blend → export_static_prop.py (FBX + inspection facts) → result.json → `harness validate` against the
  vintage-radio plan's contract.

    python dcc/tests/e2e_blender.py [work dir]          # needs `import bpy` to work in this Python

Exits non-zero, with the contract's violations, if any step or check fails.
"""
from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BLENDER = ROOT / "dcc" / "blender"


def run_script(path: Path, *args: str) -> None:
    """Runs a Blender script as `blender -b --python <path> -- <args>` would, inside this bpy."""
    saved = sys.argv
    sys.argv = [str(path), "--", *args]
    try:
        runpy.run_path(str(path), run_name="__main__")
    finally:
        sys.argv = saved


def main() -> int:
    import bpy  # noqa: F401  (fail early, with a clear error, when bpy is missing)

    work = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / ".harness" / "e2e-blender").resolve()
    ticket = work / "work" / "vintage-radio-model"
    (ticket / "export").mkdir(parents=True, exist_ok=True)
    (ticket / "recipe").mkdir(exist_ok=True)
    blend = ticket / "SM_VintageRadio.blend"
    fbx = ticket / "export" / "SM_VintageRadio.fbx"
    facts_path = ticket / "export" / "SM_VintageRadio.facts.json"

    recipe = ticket / "recipe" / "vintage_radio.py"
    recipe.write_text((BLENDER / "recipes" / "vintage_radio.py").read_text())
    run_script(recipe, "--out", str(blend))

    import bpy as blender
    blender.ops.wm.open_mainfile(filepath=str(blend))
    run_script(BLENDER / "export_static_prop.py", "--asset", "SM_VintageRadio", "--out", str(fbx), "--facts", str(facts_path))

    facts = json.loads(facts_path.read_text())
    print(json.dumps(facts, indent=2))
    result = {
        "status": "ready",
        "summary": "Vintage radio built from recipe/vintage_radio.py and exported with export_static_prop.py",
        "assets": [{
            "id": "SM_VintageRadio",
            "kind": "static_mesh",
            "files": [
                {"path": "export/SM_VintageRadio.fbx", "role": "export"},
                {"path": "SM_VintageRadio.blend", "role": "source"},
                {"path": "recipe/vintage_radio.py", "role": "recipe"},
            ],
            "facts": facts,
            "provenance": {"method": "procedural", "tool": f"blender {blender.app.version_string}",
                           "recipe": "recipe/vintage_radio.py", "license": "proprietary"},
        }],
    }
    (ticket / "result.json").write_text(json.dumps(result, indent=2))

    command = ["node", str(ROOT / "src" / "cli.ts"), "validate", "--plan", str(ROOT / "examples" / "vintage-radio" / "plan.json"),
               "--ticket", "vintage-radio-model", "--dir", str(ticket)]
    check = subprocess.run(command, capture_output=True, text=True, env={**os.environ})
    print(check.stdout + check.stderr)
    if check.returncode != 0:
        return check.returncode

    # The gate must also refuse the classic mistake: a hull named for the wrong mesh imports as visible geometry.
    blender.ops.wm.open_mainfile(filepath=str(blend))
    blender.data.objects["UCX_SM_VintageRadio_01"].name = "UCX_VintageRadio_01"
    blender.ops.wm.save_as_mainfile(filepath=str(blend))
    run_script(BLENDER / "export_static_prop.py", "--asset", "SM_VintageRadio", "--out", str(fbx), "--facts", str(facts_path))
    run_inspection = json.loads(facts_path.read_text())
    result["assets"][0]["facts"] = run_inspection
    (ticket / "result.json").write_text(json.dumps(result, indent=2))
    bad = subprocess.run(command, capture_output=True, text=True, env={**os.environ})
    print(bad.stdout + bad.stderr)
    if bad.returncode == 0 or "collision" not in bad.stdout:
        print("FAIL: the contract accepted a misnamed collision hull")
        return 1
    print("ok: the contract rejected the misnamed hull")
    return 0


if __name__ == "__main__":
    sys.exit(main())
