# 003 Task plan

Milestones in order. Each ends with something a person can run and a check that proves it. M0 is in this repository; the rest are the plan.

## M0: Core and simulated pipeline (done)

- Domain model, plan check, orchestrator, pools, locks (memory, Perforce, Git LFS), contract gate, run store and recovery.
- Presets for five domains, machine profiles, worker and router prompts.
- Executors: simulated, generic agent CLI, goose. Ingest: simulated and commandlet.
- DCC scripts: Blender export and inspection, Unreal import and inspection, Wwise import, audio synth.
- **Check:** `npm run check` (37 TypeScript tests, Python tests). `npm run demo` runs the vintage radio end to end; planted mistakes (a misnamed hull, a ×100 export, a hot audio master) are caught and fixed in one revision each.

## M1: One real DCC, end to end (Blender)

1. Run `dcc/blender/export_static_prop.py` and `inspect_export.py` on Blender 3.6, 4.2 LTS and 4.3; fix API differences; add fixture `.blend` files and a CI job that runs them headless (`blender -b`).
2. A Blender worker on Claude Code or goose builds `SM_VintageRadio` from `recipe/build.py`, through `blender-mcp` for viewing and headless bpy for the build.
3. Add `harness validate` to the worker loop (it already exists as a command) and measure first-try contract pass rate.
4. Render a turntable preview (`role: preview`) for review gates.
- **Check:** the model ticket passes its contract on a real export; the triangle, size, pivot and collision facts match a manual inspection in Blender.

## M2: Unreal ingest and the Unreal worker

1. Run `import_pipeline.py` through `UnrealEditor-Cmd` on UE 5.4 and 5.5 with the Python Editor Script Plugin; confirm `import_mesh_lo_ds`, collision and bounds checks; add a test project in a separate repository.
2. Choose and pin an Unreal MCP bridge (several community plugins exist; evaluate on Blueprint creation, Python execution and saving), and record its tool names in the Unreal prompt.
3. Master prop material and `BPI_Interactable` in the test project; `inspect_asset.py` facts verified against the editor.
4. Decide Interchange versus FbxImportUI for UE 5.5+.
- **Check:** `BP_VintageRadio` built by the worker compiles, is placed in a World Partition map with its own external actor file, and passes its contract.

## M3: Audio and texturing, and the tool-host daemon

1. Build `tools/mcp-servers/wwise-waapi-mcp` (the audio preset names it): a small MCP server over WAAPI exposing import, object create/set, SoundBank generate and a query tool. Or adopt a maintained one if it exists by then.
2. Replace RMS with integrated LUFS (ITU-R BS.1770) in the audio contract.
3. Texture worker on SAT (`sbsbaker`, `sbsrender`) with a Blender-bake fallback; a texture inspection script reading resolution and colour space from the files.
4. **Tool-host daemon**: a process on each workstation that registers its profile (pools, DCCs online via `harness probe`), pulls assignments for its pools from the central orchestrator, and runs them locally. The orchestrator becomes machine-independent (the super-agent "separate compute from execution environments").
- **Check:** the full vintage radio on real tools across two machines (an art workstation for Blender/Wwise, a build machine for Unreal), with Perforce locks visible in `p4 opened`.

## M4: Triggers, Threads and the Watchdog

1. Sources in the dsh-superagent shape: Perforce changelists and review comments (Swarm), CI and cook failures, Jira/Linear tickets, Slack threads. A deterministic gate first, then the Router.
2. Subscriptions per asset: a comment on `SM_VintageRadio` (in Swarm, Slack or the panel) reaches the ticket that owns it, without re-planning.
3. Re-planning: a changed brief yields a new plan revision; tickets whose specs did not change keep their delivered assets.
4. Watchdog session: checks each running worker's log and DCC state on a schedule, restarts a hung DCC, and reports drift.
- **Check:** a reviewer's Slack reply "make the dials brass" reaches the texture ticket, which revises and re-delivers; the Blueprint ticket reruns because its input changed.

## M5: Scale and quality

- More templates beside `propPlan`: characters (skeletal mesh, animation blueprint), environment kits (modular pieces, HISM placement), VFX (Niagara).
- Generative asset sources (text-to-3D, text-to-audio, material generation) as worker tools with provenance and licence capture, gated by the same contracts.
- A VLM-based visual check on previews (silhouette, style match), advisory only, beside the human review.
- Cost and time tracking per ticket; plan-level budgets.

## M6: DSH bundle and panel

- Package the orchestrator as a DeepSeek Harness bundle: a DSH Executor Session per assignment, the studio Sources as DSH Sources, and a panel that lists only what waits for a person.
- Keep the CLI and the goose / Claude Code executors for teams that do not run DSH.

## Risks

| Risk | Mitigation |
| --- | --- |
| LLM-driven bpy modelling produces low-quality meshes | Contracts keep bad meshes out; templates and kitbash libraries for structure; generative sources (M5); human review for hero assets |
| MCP bridges for Unreal and Wwise are young and change | Bridges are behind presets; the deterministic stages (inspection, ingest) use stable editor Python and WAAPI directly |
| DCC licences and GPUs live on artist machines | The tool-host daemon (M3) runs work where the tools are, within each machine's pool sizes |
| Binary merge conflicts | Host-held exclusive locks mirrored to Perforce or Git LFS; locks held until done |
| Noise for the team | Following dsh-superagent: speak only when a person must act; one question at a time; review gates only where the plan asks |
