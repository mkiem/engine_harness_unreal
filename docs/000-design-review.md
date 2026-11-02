# 000 Design review: from the initial proposal to this design

The initial proposal had the right shape: a Router that splits a creative brief into domain tickets, workers with tool presets per DCC, a Blender-to-Unreal interchange contract, and a QA step. This document records what we kept, what we changed and why. The later documents describe the result.

## What we kept

- **Two levels.** A Router that plans and dispatches, and isolated workers that do the work, one domain each. This is the super-agent article's two-level architecture, and dsh-superagent's main Session and Executor Sessions.
- **Presets per domain** with only that domain's tools and MCP servers (`presets/*.json`), in the same shape as the proposal.
- **The interchange contract** as the main defence against multi-agent failure: UCX naming, centimetres, pivots, an automated import script.
- **The vintage radio** as the reference scenario (`examples/vintage-radio`).

## What we changed

| # | Initial proposal | Change | Why |
|---|---|---|---|
| 1 | Tickets "blocked by" other tickets | Tickets **consume assets**; an edge exists only where an asset crosses it (`consumes`), and the plan is checked as a DAG before anything runs (`src/core/plan.ts`) | A bare "blocked by" edge carries no contract. With assets as edges, every hand-off has a spec the producer promised and the consumer can rely on |
| 2 | Workers trusted to follow conventions | A **deterministic contract gate** (`src/contracts`) measures every delivered asset (triangles, bounds, collision names, pivots, WAV headers, loudness, loop seams, sRGB flags, test results) and sends violations back as a **revision** | An LLM's "ready" is a claim. Code checks it, cheaply and identically every time; the worker gets precise rule codes to fix. After `maxRevisions` a person is asked |
| 3 | Pipeline Ingest **Worker** (an agent) | Ingest is a **deterministic pipeline stage** (`src/ingest`, `dcc/unreal/import_pipeline.py`) that runs after the source contract passes | Importing with fixed settings must be identical for every asset. An agent adds variance and cost where none is wanted |
| 4 | `auto_generate_collision = True` alongside custom UCX | Off when the spec asks for UCX; the engine-side check fails a mesh imported without its hulls | Auto-generation hides the most common bug: a hull named for the wrong mesh imports as visible geometry and the box is generated silently |
| 5 | Blender unit scale 0.01 | Unit Scale **1.0**, model in metres, export with `apply_scale_options='FBX_SCALE_UNITS'` | 0.01 scene scale breaks physics, modifiers and rigging inside Blender. FBX_SCALE_UNITS gives the same centimetres in Unreal. The contract still catches a ×100 mistake and says so |
| 6 | Asset locks in the Router's description | A **LockManager** in host code takes every lock a ticket declares, all-or-nothing in sorted order, before launch, mirrored to **Perforce** (`p4 edit` + `p4 lock`) or **Git LFS** | A worker must never decide whether to respect a lock. All-or-nothing in sorted order rules out deadlock. Mirroring means artists working by hand see the agent's locks |
| 7 | Workers run whenever ready | **Tool pools** per machine (`profiles/*.json`: `blender: 2, unreal: 1`) | A DCC is not a stateless API: one live Unreal Editor holds one project; a blender-mcp socket serves one Blender. Ingest shares the Unreal pool, so it never saves packages under a live editor |
| 8 | Machine paths in presets (`D:/Project/...`) | Presets use `${VAR}`; **profiles** hold each machine's paths, pool sizes, lock backend and agent command | One preset runs on every artist's machine and on CI. Missing variables are reported before launch, not discovered mid-ticket |
| 9 | Imperative MCP calls build the asset | Workers write **recipe scripts** (`recipe/build.py`, `recipe/synth.py`), and procedural assets must name one in `provenance.recipe` | Reproducibility and review: a recipe can be re-run, diffed and fixed. Live sockets are for looking and iterating |
| 10 | (absent) | **Provenance** on every asset: method (procedural, generative, library, manual), tool, model, prompt, licence | Generated and library content carries licence terms; a studio must be able to answer "where did this come from" for every shipped asset |
| 11 | (absent) | **Human review** gates where the plan asks (`review: "human"`), and **Attention** for questions | Art direction needs sign-off before textures and Blueprints build on a mesh. Following dsh-superagent: ask one concrete question, and only when needed |
| 12 | "Gauntlet smoke test (PIE)" | **Automation tests** run headless (`-ExecCmds="Automation RunTests ...;Quit" -nullrhi`), reported as `test_result` facts; Gauntlet for packaged builds | Gauntlet orchestrates sessions; the checks themselves are automation or functional tests. Results are data the contract reads, not prose |
| 13 | `.bnk` SoundBanks | SoundBank generation stays, but the audio ingest checks the **AkAudioEvent** asset exists in the project | Recent Wwise UE integrations use auto-defined SoundBanks and reconcile assets; what Unreal needs is the event asset |
| 14 | A Router session that might do work | The Router only **plans**; the plan is checked and repaired in a bounded loop (`LlmPlanner`); scheduling is code | The super-agent article: the Router dispatches and stays light; work belongs to workers |
| 15 | Fork goose / DSH as the base | Keep a small **orchestrator core** of our own; use goose, Claude Code or DSH as the **Worker runtime** through one `Executor` port | See [001 Architecture](001-architecture.md#why-not-fork-goose-or-dsh-superagent) |

## Open questions we resolved with defaults

- **FBX or glTF?** FBX by default: Unreal's FBX path handles UCX collision and LOD groups the way the contract expects. glTF exports are accepted by the contract (`.glb`/`.gltf`) for teams using Interchange.
- **Interchange or FbxImportUI?** The import script uses `FbxImportUI` because its options map one-to-one to the contract. Moving to Interchange pipelines is a milestone task (M5).
- **Where does the material instance come from?** The Unreal worker makes it from the project's master material; ingest never imports FBX materials.
