"""End-to-end check of the Blender half of the pipeline with real Blender (the bpy module, or a Blender binary):

  recipe → .blend → export_static_prop.py (FBX + inspection facts) → result.json → `harness validate` against the
  vintage-radio plan's contract; then bake_textures.py bakes the recipe's coloured material into T_VintageRadio_BC,
  _ORM and _N, validated against the texture ticket's contract.

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


def distinct_colours(path: Path) -> int:
    """How many 4-bit-per-channel colour bins a baked map uses (a flat grey bake has one or two)."""
    import bpy as blender
    image = blender.data.images.load(str(path))
    pixels = list(image.pixels[:])
    bins = {(int(pixels[i] * 15), int(pixels[i + 1] * 15), int(pixels[i + 2] * 15)) for i in range(0, len(pixels), 4 * 211)}
    blender.data.images.remove(image)
    return len(bins)


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

    # Textures: bake the recipe's material (wood, cloth, bakelite, brass) into the texture set on the model's UVs.
    textures = work / "work" / "vintage-radio-texture"
    (textures / "export").mkdir(parents=True, exist_ok=True)
    blender.ops.wm.open_mainfile(filepath=str(blend))
    run_script(BLENDER / "bake_textures.py", "--object", "SM_VintageRadio_LOD0", "--asset", "T_VintageRadio",
               "--out", str(textures / "export"), "--size", "2048", "--ao-samples", "16",
               "--facts", str(textures / "export" / "T_VintageRadio.facts.json"))
    texture_facts = json.loads((textures / "export" / "T_VintageRadio.facts.json").read_text())
    colours = distinct_colours(textures / "export" / "T_VintageRadio_BC.png")
    print(f"T_VintageRadio_BC has {colours} distinct colour bins")
    if colours < 6:
        print("FAIL: the base colour is nearly flat; the recipe's colours did not bake")
        return 1
    (textures / "result.json").write_text(json.dumps({
        "status": "ready",
        "summary": "T_VintageRadio baked from the recipe's material with bake_textures.py",
        "assets": [{
            "id": "T_VintageRadio", "kind": "texture_set",
            "files": [{"path": f"export/{m['path']}", "role": "export"} for m in texture_facts["maps"].values()],
            "facts": {**texture_facts, "maps": {k: {**m, "path": f"export/{m['path']}"} for k, m in texture_facts["maps"].items()}},
            "provenance": {"method": "procedural", "tool": f"blender {blender.app.version_string}",
                           "recipe": "dcc/blender/bake_textures.py", "license": "proprietary"},
        }],
    }, indent=2))
    texture_check = subprocess.run(["node", str(ROOT / "src" / "cli.ts"), "validate", "--plan", str(ROOT / "examples" / "vintage-radio" / "plan.json"),
                                    "--ticket", "vintage-radio-texture", "--dir", str(textures)], capture_output=True, text=True, env={**os.environ})
    print(texture_check.stdout + texture_check.stderr)
    if texture_check.returncode != 0:
        return texture_check.returncode

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
